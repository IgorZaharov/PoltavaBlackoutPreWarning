/**
 * One place that refreshes both sources and turns the stored state into a snapshot, ported from
 * android/.../data/repository/OutageRepository.kt. The main screen, the widget simulator and the
 * alert checks all go through it, so they cannot disagree about what is off and when
 * (spec/OUTAGE_ENGINE.md).
 *
 *  - `snapshot(settings, now)` is local only (no network): POE queue tables + repair works + the ledger.
 *  - `refresh(settings, force, notify)` fetches the POE tables and the per-house status of every address.
 *    A source that fails keeps its previous data and is reported as such; it never becomes "no outage".
 */
import { plannedSpans as plannedSpansOf } from '../core/outageEngine';
import type { Span } from '../core/outageModels';
import { plannedActive } from '../core/subscriptions';
import { HouseKey, StreetKey } from '../core/addressKeys';
import { reconcile, outages as ledgerOutages, type EmergencyEvent } from '../core/emergencyLedger';
import { fromInstant, formatLocalDate, toLocalDate, type LocalDate, type LocalDateTime } from '../core/localTime';
import { buildPlannedCells, dayView as engineDayView, inWindow, status as engineStatus, switchWindows } from '../core/outageEngine';
import { statusAt, type DayView, type Outage, type StatusInfo, type SwitchWindow } from '../core/outageModels';
import type { SiteState } from '../core/siteState';
import type { BlackoutSlot, SelectedAddressQuery, UserSettings } from '../types';
import { OutageStateStore, getOutageStateStore, type PowerOnSnapshot, type SiteSnapshot } from './outageStore';
import { ScheduleCache, getScheduleCache } from './scheduleCache';
import { PoeClient, type AddressStatusFetch } from './poeClient';
import { getPoeClient, syncPoeSchedule, type PoeFetchStatus, type ScheduleSyncOptions, type ScheduleSyncResult } from './poeScheduleSync';
import { NO_QUEUE_TEXT, findStreetById, type PoeStreetOption } from './poeAddressLookup';
import { triggerEmergencyEventAlerts } from './alertManager';
import { resolveLanguage } from './i18n';
import { addressKey as subscriptionAddressKey, alertOrder, displayLabel, type Subscription, type SubscriptionStore } from '../core/subscriptions';
import { getSubscriptionSync } from './subscriptionSync';

const p2 = (n: number): string => String(n).padStart(2, '0');
const hhmm = (minuteOfDay: number): string => `${p2(Math.floor(minuteOfDay / 60))}:${p2(minuteOfDay % 60)}`;

/** Legacy shape used by the existing main screen and widget simulator. */
export interface ScheduleStatusInfo {
  isBlackoutNow: boolean;
  countdownText: string;
  nextSlotTime: string;
  totalBlackoutHours: number;
  isUnclear: boolean;
}

export interface OutageSnapshotInit {
  now: LocalDateTime;
  queue: string;
  outages: readonly Outage[];
  /** Today's queue table is cached and still valid for today (or the address has no queue at all). */
  plannedKnown: boolean;
  tomorrowPublished: boolean;
  site: SiteSnapshot | null;
  poweron: PowerOnSnapshot | null;
  hasAddress: boolean;
  /** POE switching half-hours of the queue (spec/OUTAGE_ENGINE.md 3.5). */
  switching?: readonly SwitchWindow[];
}

/** Everything the screens, the widget simulator and alert checks need, derived from local state only. */
export class OutageSnapshot {
  readonly now: LocalDateTime;
  readonly queue: string;
  readonly outages: readonly Outage[];
  readonly plannedKnown: boolean;
  readonly tomorrowPublished: boolean;
  readonly site: SiteSnapshot | null;
  readonly poweron: PowerOnSnapshot | null;
  readonly hasAddress: boolean;
  readonly switching: readonly SwitchWindow[];

  constructor(init: OutageSnapshotInit) {
    this.now = init.now;
    this.queue = init.queue;
    this.outages = init.outages;
    this.plannedKnown = init.plannedKnown;
    this.tomorrowPublished = init.tomorrowPublished;
    this.site = init.site;
    this.poweron = init.poweron;
    this.hasAddress = init.hasAddress;
    this.switching = init.switching ?? [];
  }

  get today(): LocalDate {
    return toLocalDate(this.now);
  }

  dayView(date: LocalDate): DayView {
    return engineDayView(this.outages, date, this.now, undefined, this.switching);
  }

  status(): StatusInfo {
    return engineStatus(this.outages, this.now, undefined, this.switching);
  }

  /** The planned schedule is unknown and nothing else is known either: screens go grey. */
  get isUnclear(): boolean {
    return this.queue.trim() !== '' && !this.plannedKnown && !this.outages.some((o) => !o.stale && o.kind !== 'PLANNED');
  }

  /** True when the shown schedule comes from the cache because the site could not be refreshed. */
  get isStale(): boolean {
    return this.plannedKnown && this.queue.trim() !== '' && this.site !== null && this.site.state !== 'AVAILABLE_WITH_TABLE';
  }

  scheduleStatus(): ScheduleStatusInfo {
    if (this.isUnclear) {
      return { isBlackoutNow: false, countdownText: '--:--:--', nextSlotTime: '--:-- - --:--', totalBlackoutHours: 0, isUnclear: true };
    }
    const st = this.status();
    return {
      isBlackoutNow: st.isOffNow,
      countdownText: st.countdownText,
      nextSlotTime: st.nextSlotTime,
      totalBlackoutHours: this.dayView(this.today).totalOffMinutes / 60,
      isUnclear: false,
    };
  }

  /** The 48 cells of [date] in the shape the drum chart and widgets draw. Empty when unclear. */
  slotsFor(date: LocalDate): BlackoutSlot[] {
    if (this.isUnclear) return [];
    const view = this.dayView(date);
    const dateStr = formatLocalDate(date);
    return view.slots.map((s, i): BlackoutSlot => {
      const startMin = i * 30;
      const endMin = startMin + 30;
      const startStr = hhmm(startMin);
      return {
        id: `${dateStr}_${startStr}_Q${this.queue}`,
        startHour: Math.floor(startMin / 60),
        endHour: Math.floor(endMin / 60),
        startMinute: startMin % 60,
        endMinute: endMin % 60,
        startTimeStr: startStr,
        endTimeStr: endMin >= 1440 ? '24:00' : hhmm(endMin),
        status: s.off ? 'POWER_OFF' : 'POWER_ON',
        isEmergency: s.emergency,
        isPlanned: s.planned,
        isSwitching: s.switching,
      };
    });
  }

  /** The emergency outage to feature in the banner: active or overdue first, then the next upcoming one. */
  featuredEmergency(): Outage | null {
    const live = this.outages.filter((o) => o.kind === 'EMERGENCY' && !o.stale);
    const active = live.find((o) => {
      const st = statusAt(o, this.now);
      return st === 'ACTIVE' || st === 'OVERDUE';
    });
    if (active) return active;
    const upcoming = live.filter((o) => statusAt(o, this.now) === 'UPCOMING').sort((a, b) => a.start - b.start);
    return upcoming[0] ?? null;
  }
}

/** Emergency events of a subscription other than the primary (spec/SUBSCRIPTIONS.md 8.4). */
export interface AddressEvents {
  itemId: string;
  addressKey: string;
  /** Second line of the notification: the address text, or the label. */
  addressLine: string;
  events: readonly EmergencyEvent[];
  /** Its planned spans and whether it is warned about them (spec/NOTIFICATIONS.md 2.4a). */
  plannedSpans: readonly Span[];
  plannedAlertsOn: boolean;
}

export interface RefreshOutcome {
  siteState: SiteState | null;
  fetchStatus: PoeFetchStatus | null;
  poweronOk: boolean | null;
  /** Events of the primary (selected) address. */
  events: readonly EmergencyEvent[];
  /** The primary's planned spans and whether it is warned about them (spec/NOTIFICATIONS.md 2.4a). */
  plannedSpans: readonly Span[];
  plannedAlertsOn: boolean;
  /** Events of the other subscriptions that want emergency alerts. */
  otherEvents: readonly AddressEvents[];
  snapshot: OutageSnapshot;
}

/** Streets of the selected address, resolved from the POE address directory (a seam for tests). */
export interface AddressResolver {
  street(streetId: string): Pick<PoeStreetOption, 'nameUk' | 'allIds'> | undefined;
}

export const defaultAddressResolver: AddressResolver = {
  street: findStreetById,
};

export interface OutageRepositoryDeps {
  schedule?: ScheduleCache;
  store?: OutageStateStore;
  /** The POE client for the per-house status (default: the process-wide one). */
  poe?: PoeClient;
  /** Replaces the POE table refresh (tests). */
  syncSchedule?: (options: ScheduleSyncOptions) => Promise<ScheduleSyncResult>;
  address?: AddressResolver;
  /** The real instant in epoch milliseconds (tests pass a fake clock). */
  nowMs?: () => number;
  /** Delivers emergency events (default: the browser notification adapter in alertManager). */
  notify?: (
    settings: UserSettings,
    addressKey: string,
    events: readonly EmergencyEvent[],
    now: LocalDateTime,
    /** The address's planned spans and whether it is warned about them (spec/NOTIFICATIONS.md 2.4a). */
    planned?: { spans: readonly Span[]; alertsOn: boolean }
  ) => void;
  /** The subscription store and the master switch (default: the app-wide SubscriptionSync). */
  subscriptions?: (settings: UserSettings) => { store: SubscriptionStore; master: boolean };
  /** Writes a queue read from POE into a subscription (default: the app-wide SubscriptionSync). */
  assignQueue?: (settings: UserSettings, itemId: string | null, queue: string | null, statusText: string | null) => void;
  /** Delivers the events of another subscription (default: the browser notification adapter). */
  notifyOther?: (settings: UserSettings, other: AddressEvents, now: LocalDateTime) => void;
}

export class OutageRepository {
  private readonly schedule: ScheduleCache;
  private readonly store: OutageStateStore;
  private readonly poeOverride: PoeClient | null;
  private readonly syncSchedule: NonNullable<OutageRepositoryDeps['syncSchedule']>;
  private readonly address: AddressResolver;
  private readonly nowMs: () => number;
  private readonly notifyEvents: NonNullable<OutageRepositoryDeps['notify']>;
  private readonly subscriptions: NonNullable<OutageRepositoryDeps['subscriptions']>;
  private readonly assignQueue: NonNullable<OutageRepositoryDeps['assignQueue']>;
  private readonly notifyOther: NonNullable<OutageRepositoryDeps['notifyOther']>;

  constructor(deps: OutageRepositoryDeps = {}) {
    this.schedule = deps.schedule ?? getScheduleCache();
    this.store = deps.store ?? getOutageStateStore();
    this.poeOverride = deps.poe ?? null;
    this.syncSchedule = deps.syncSchedule ?? ((options) => syncPoeSchedule({ ...options, client: options.client ?? this.poe }));
    this.address = deps.address ?? defaultAddressResolver;
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.notifyEvents =
      deps.notify ??
      ((settings, addressKey, events, now, planned) => {
        triggerEmergencyEventAlerts(events, addressKey, settings, resolveLanguage(settings.language), now, undefined, {
          plannedSpans: planned?.spans,
          plannedAlertsOn: planned?.alertsOn,
        });
      });
    this.subscriptions =
      deps.subscriptions ??
      ((settings) => {
        const sync = getSubscriptionSync();
        return { store: sync.store(settings), master: sync.master(settings) };
      });
    this.assignQueue =
      deps.assignQueue ??
      ((settings, itemId, queue, statusText) => {
        const sync = getSubscriptionSync();
        if (itemId === null) sync.assignPrimaryQueue(settings, queue, statusText, null);
        else sync.assignItemQueue(settings, itemId, queue, statusText);
      });
    this.notifyOther =
      deps.notifyOther ??
      ((settings, other, now) => {
        triggerEmergencyEventAlerts(other.events, other.addressKey, settings, resolveLanguage(settings.language), now, undefined, {
          addressLine: other.addressLine,
          enabled: true,
          plannedSpans: other.plannedSpans,
          plannedAlertsOn: other.plannedAlertsOn,
        });
      });
  }

  private get poe(): PoeClient {
    return this.poeOverride ?? getPoeClient();
  }

  /** Stable key of the selected address; survives duplicate-street merges because it uses the canonical street key. */
  addressKey(query: SelectedAddressQuery | null | undefined): string | null {
    if (!query) return null;
    if (!query.house || query.house.trim() === '') return null;
    let streetName: string | undefined;
    try {
      streetName = this.address.street(query.streetId)?.nameUk;
    } catch {
      streetName = undefined;
    }
    return `${query.settlementId}|${StreetKey.of(streetName ?? query.streetId)}|${HouseKey.of(query.house)}`;
  }

  /** Local state only. [now] is the Kyiv wall clock. */
  snapshot(settings: UserSettings, now: LocalDateTime = fromInstant(this.nowMs()), key: string | null = this.addressKey(settings.selectedAddressQuery)): OutageSnapshot {
    return this.snapshotOf(settings.queue || '', key, now, this.store.poweron());
  }

  /**
   * The snapshot of one non-primary subscription for the main view (spec/SUBSCRIPTIONS.md 9). The primary
   * goes through [snapshot]; another item has its own PowerOn status under its address key.
   */
  snapshotFor(item: Subscription, now: LocalDateTime = fromInstant(this.nowMs())): OutageSnapshot {
    const key = item.address ? subscriptionAddressKey(item.address) : null;
    return this.snapshotOf(item.queue ?? '', key, now, key !== null ? this.store.poweronFor(key) : null);
  }

  private snapshotOf(q: string, key: string | null, now: LocalDateTime, poweron: PowerOnSnapshot | null): OutageSnapshot {
    const today = toLocalDate(now);
    const hasQueue = q.trim() !== '';
    return new OutageSnapshot({
      now,
      queue: q,
      outages: this.outagesFor(q, key, now),
      plannedKnown: !hasQueue || this.schedule.hasValidTodayCache(q, today),
      tomorrowPublished: hasQueue && this.schedule.hasTomorrowSchedule(q, today),
      site: this.store.site(),
      poweron,
      hasAddress: key !== null,
      switching: hasQueue
        ? switchWindows(today, this.schedule.todayCells(q, today), this.schedule.tomorrowCells(q, today), this.schedule.yesterdayCells(q, today))
        : [],
    });
  }

  /**
   * The outages of one queue and address key (either may be absent), local state only. One POE fetch
   * caches all 12 queues, so this works for every subscription (spec/SUBSCRIPTIONS.md 8.1).
   */
  outagesFor(queue: string | null, key: string | null, now: LocalDateTime = fromInstant(this.nowMs())): Outage[] {
    const today = toLocalDate(now);
    const q = (queue ?? '').trim();
    const planned =
      q !== ''
        ? buildPlannedCells(today, this.schedule.todayCells(q, today), this.schedule.tomorrowCells(q, today), this.schedule.yesterdayCells(q, today))
        : [];
    const emergencies = key !== null ? ledgerOutages(this.store.ledger(key), now) : [];
    const repairs = key !== null ? this.store.repairs(key) : [];
    return inWindow([...planned, ...repairs, ...emergencies], today);
  }

  /**
   * Refreshes the POE queue tables and the per-house status (emergency «пошкодження», repair works, the
   * house's queue) for the selected address and the other subscriptions.
   * A source that fails keeps its previous data and is reported as such; it never counts as "no outage".
   * [shownId] is the item the main view shows: it is polled whatever its switches (spec/SUBSCRIPTIONS.md 8.4).
   * [widgetIds] are the items the widgets show (section 10), polled the same way.
   */
  async refresh(
    settings: UserSettings,
    forceNetwork = false,
    notify = true,
    shownId: string | null = null,
    widgetIds: string[] = []
  ): Promise<RefreshOutcome> {
    const nowMs = this.nowMs();
    let siteState: SiteState | null = null;
    let fetchStatus: PoeFetchStatus | null = null;
    let subs: { store: SubscriptionStore; master: boolean } | null = null;
    try {
      subs = this.subscriptions(settings);
    } catch {
      subs = null;
    }

    // One request per day caches all 12 queues. A primary without a queue still fetches for the other
    // addresses, and an address whose queue is not known yet gets it from the per-house status.
    const primaryQueue = (settings.queue || '').trim();
    const anyQueue =
      primaryQueue !== '' || !!settings.selectedAddressQuery || (subs ? alertOrder(subs.store).some((i) => i.queue !== null || i.address !== null) : false);
    const fresh = nowMs - this.schedule.lastSyncMs() >= 0 && nowMs - this.schedule.lastSyncMs() < 4.5 * 60_000;
    if (anyQueue && (forceNetwork || !fresh)) {
      try {
        const res = await this.syncSchedule({ cache: this.schedule, nowMs });
        this.store.saveSite(res.siteState, nowMs, res.notice ?? null);
        if (primaryQueue !== '') {
          fetchStatus = res.status;
          siteState = res.siteState;
        }
      } catch {
        // keep the previous site state
      }
    }

    let poweronOk: boolean | null = null;
    let events: readonly EmergencyEvent[] = [];
    const query = settings.selectedAddressQuery;
    const key = this.addressKey(query);
    let current = settings;
    if (query && key) {
      const polled = await this.pollPoe(query, key, nowMs);
      poweronOk = polled?.ok ?? false;
      events = polled?.events ?? [];
      this.store.savePowerOn(poweronOk, nowMs);
      if (polled?.status) {
        const queue = polled.status.status.queue ?? '';
        const statusText = queue === '' ? NO_QUEUE_TEXT : null;
        if (queue !== (settings.queue || '') || statusText !== (settings.customQueueStatusText ?? null)) {
          // into the primary subscription, which is mirrored back into the settings
          try {
            this.assignQueue(settings, null, queue === '' ? null : queue, statusText);
            current = { ...settings, queue, customQueueStatusText: statusText ?? undefined };
          } catch {
            // the queue is read again on the next refresh
          }
        }
      }
      if (notify && events.length > 0 && (settings.emergencyNotificationsEnabled ?? true)) {
        const primaryItem = subs ? subs.store.items.find((i) => i.id === subs.store.primaryId) ?? null : null;
        this.notifyEvents(settings, key, events, fromInstant(nowMs), {
          spans: plannedSpansOf(this.outagesFor(settings.queue, key, fromInstant(nowMs))),
          alertsOn: subs && primaryItem ? plannedActive(subs.master, primaryItem) : settings.notificationsEnabled,
        });
      }
    }
    const otherEvents = subs ? await this.refreshOtherAddresses(settings, subs, key, nowMs, notify, shownId, widgetIds) : [];
    const primaryItem = subs ? subs.store.items.find((i) => i.id === subs.store.primaryId) ?? null : null;
    return {
      siteState,
      fetchStatus,
      poweronOk,
      events,
      plannedSpans: key ? plannedSpansOf(this.outagesFor(settings.queue, key, fromInstant(nowMs))) : [],
      plannedAlertsOn: subs && primaryItem ? plannedActive(subs.master, primaryItem) : settings.notificationsEnabled,
      otherEvents,
      snapshot: this.snapshot(current, fromInstant(this.nowMs())),
    };
  }

  /**
   * The per-house status for every other subscription that wants emergency alerts, plus the one the main view shows
   * (spec/SUBSCRIPTIONS.md 8.4): own request, own failure, own ledger, own status line.
   */
  private async refreshOtherAddresses(
    settings: UserSettings,
    subs: { store: SubscriptionStore; master: boolean },
    primaryKey: string | null,
    nowMs: number,
    notify: boolean,
    shownId: string | null,
    widgetIds: string[] = [],
  ): Promise<AddressEvents[]> {
    const out: AddressEvents[] = [];
    for (const item of subs.store.items) {
      const a = item.address;
      if (!a || item.id === subs.store.primaryId) continue;
      const alerts = subs.master && item.emergencyAlerts;
      // the shown item and the items on widgets are polled whatever their switches (spec/SUBSCRIPTIONS.md 10)
      if (!alerts && item.id !== shownId && !widgetIds.includes(item.id)) continue;
      const key = subscriptionAddressKey(a);
      if (key === primaryKey) continue;
      const polled = await this.pollPoe({ remId: a.remSlug, settlementId: a.settlementId, streetId: a.streetId, house: a.house }, key, nowMs);
      this.store.savePowerOnFor(key, polled?.ok ?? false, nowMs);
      if (polled?.status) {
        const queue = polled.status.status.queue;
        const statusText = queue === null ? NO_QUEUE_TEXT : null;
        if (queue !== item.queue || statusText !== item.queueStatusText) {
          try {
            this.assignQueue(settings, item.id, queue, statusText);
          } catch {
            // read again on the next refresh
          }
        }
      }
      if (!alerts || !polled || polled.events.length === 0) continue;
      const other: AddressEvents = {
        itemId: item.id,
        addressKey: key,
        addressLine: addressLine(item),
        events: polled.events,
        plannedSpans: plannedSpansOf(this.outagesFor(item.queue, key, fromInstant(nowMs))),
        plannedAlertsOn: plannedActive(subs.master, item),
      };
      out.push(other);
      if (notify) this.notifyOther(settings, other, fromInstant(nowMs));
    }
    return out;
  }

  /**
   * Asks POE about one house (E4) and saves the ledger and repair works under [key]. The street's merged
   * ids are tried in turn until POE answers for one. An unavailable answer leaves the ledger and the
   * repairs as they were (spec/POE_API.md section 9). Null only when it could not be built.
   */
  private async pollPoe(
    query: SelectedAddressQuery,
    key: string,
    nowMs: number
  ): Promise<{ ok: boolean; events: readonly EmergencyEvent[]; status: Extract<AddressStatusFetch, { kind: 'confirmed' }> | null } | null> {
    try {
      const cityId = Number(query.settlementId);
      if (!Number.isFinite(cityId) || !query.house || query.house.trim() === '') return null;
      const now = fromInstant(nowMs);
      const today = toLocalDate(now);
      const street = this.address.street(query.streetId);
      const ids = (street?.allIds ?? [query.streetId]).map(Number).filter(Number.isFinite);
      let fetch: AddressStatusFetch = { kind: 'unavailable', reason: 'unresolved' };
      for (const sid of ids) {
        fetch = await this.poe.addressStatus(cityId, sid, query.house, today);
        if (fetch.kind === 'confirmed') break;
      }
      const ledger = reconcile(this.store.ledger(key), PoeClient.emergencyFetch(fetch, today), now);
      this.store.saveLedger(key, ledger.entries);
      if (fetch.kind === 'confirmed') this.store.saveRepairs(key, fetch.status.repairs);
      return { ok: fetch.kind === 'confirmed', events: ledger.events, status: fetch.kind === 'confirmed' ? fetch : null };
    } catch {
      return null;
    }
  }
}

/** Second line of an emergency notification for [item] (spec/SUBSCRIPTIONS.md 8.4). */
export function addressLine(item: Subscription): string {
  const text = item.address?.text ?? '';
  return text.trim() !== '' ? text : displayLabel(item);
}

let defaultRepository: OutageRepository | null = null;
/** Process-wide repository on the default storage and network (used by the views and the alert checks). */
export function getOutageRepository(): OutageRepository {
  return (defaultRepository ??= new OutageRepository());
}
