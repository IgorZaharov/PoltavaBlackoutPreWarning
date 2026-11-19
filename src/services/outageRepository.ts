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
import { ensurePoeQueues, queuesFor, refreshQueuesIfDue } from './poeQueues';
import { QueueCatalogue, type QueueHint } from '../core/queueCatalogue';
import { NO_QUEUE_TEXT, findSettlementById, findStreetById, getRems, type PoeSettlementOption, type PoeStreetOption } from './poeAddressLookup';
import { PoeMapper, type AddressStatus, type NearbyOutage, type RegistryRow } from '../core/poeMapper';
import type { RegistryCache } from './outageStore';
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

/**
 * The card «Ремонти й пошкодження поруч» (spec/POE_API.md 8.10): today's registry rows of the
 * address's settlement. `fetchedMs` is the oldest branch answer used; `complete` is false when a branch
 * could not be asked on the last attempt (the card then shows the time of its data).
 */
export interface NearbySnapshot {
  items: NearbyOutage[];
  fetchedMs: number;
  complete: boolean;
}

/** The registry of a branch is asked at most this often (it is about 50 KB gzipped). */
export const NEARBY_TTL_MS = 10 * 60 * 1000;

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
  /** Today's active POE measures (ГАВ, ГОП ...), one per line, or null. */
  measures?: string | null;
  /** POE's info line of the house (`gav_message`), or null. */
  gavMessage?: string | null;
  /** Registry rows of the address's settlement for today; null for a queue only or before the first answer. */
  nearby?: NearbySnapshot | null;
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
  readonly measures: string | null;
  readonly gavMessage: string | null;
  readonly nearby: NearbySnapshot | null;

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
    this.measures = init.measures ?? null;
    this.gavMessage = init.gavMessage ?? null;
    this.nearby = init.nearby ?? null;
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

  /**
   * Start and end of the switching half-hour after the shown span (spec/OUTAGE_ENGINE.md 3.5): power comes
   * back somewhere inside it. Null when unknown or when the day is unclear. Mirrors OutageSnapshot.restoreWindow.
   */
  restoreWindow(): [LocalDateTime, LocalDateTime] | null {
    if (this.isUnclear) return null;
    const st = this.status();
    if (st.restoreUntil == null) return null;
    const span = st.currentSpan ?? st.nextSpan;
    return span ? [span.end, st.restoreUntil] : null;
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

/** Streets and settlements of the selected address, resolved from the POE address directory (a seam for tests). */
export interface AddressResolver {
  street(streetId: string): Pick<PoeStreetOption, 'nameUk' | 'allIds'> | undefined;
  /** Name and branches of a settlement (the nearby outages card); optional for tests that do not need it. */
  settlement?(settlementId: string): Pick<PoeSettlementOption, 'nameUk' | 'branchIds'> | undefined;
}

export const defaultAddressResolver: AddressResolver = {
  street: findStreetById,
  settlement: findSettlementById,
};

const parsedRegistry = new Map<number, { fetchedMs: number; rows: RegistryRow[] }>();
/** The last nearby card, keyed by address, the stored answers it used and the minute (the view asks every second). */
let nearbyCache: { key: string; value: NearbySnapshot | null } | null = null;
/** Registry rows are parsed once per stored answer, not on every snapshot. */
function parsedRows(registryId: number, cache: RegistryCache): RegistryRow[] {
  const hit = parsedRegistry.get(registryId);
  if (hit && hit.fetchedMs === cache.fetchedMs) return hit.rows;
  const rows = cache.rows.map((r) => PoeMapper.parseRegistryRow(r)).filter((r): r is RegistryRow => r !== null);
  parsedRegistry.set(registryId, { fetchedMs: cache.fetchedMs, rows });
  return rows;
}

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
    return this.snapshotOf(settings.queue || '', key, now, this.store.poweron(), settings.selectedAddressQuery ?? null);
  }

  /**
   * The snapshot of one non-primary subscription for the main view (spec/SUBSCRIPTIONS.md 9). The primary
   * goes through [snapshot]; another item has its own PowerOn status under its address key.
   */
  snapshotFor(item: Subscription, now: LocalDateTime = fromInstant(this.nowMs())): OutageSnapshot {
    const key = item.address ? subscriptionAddressKey(item.address) : null;
    const a = item.address;
    const query = a ? { remId: a.remSlug, settlementId: a.settlementId, streetId: a.streetId, house: a.house } : null;
    return this.snapshotOf(item.queue ?? '', key, now, key !== null ? this.store.poweronFor(key) : null, query);
  }

  /** Registry ids of every branch [address]'s settlement belongs to (its registry may list the outage). */
  private branchesOf(address: SelectedAddressQuery | null): number[] {
    if (!address) return [];
    const settlement = this.address.settlement?.(address.settlementId);
    const slugs = settlement && settlement.branchIds.length > 0 ? settlement.branchIds : [address.remId];
    const rems = getRems();
    const ids = slugs.map((s) => rems.find((r) => r.id === s)?.registryId).filter((x): x is number => x !== undefined);
    return [...new Set(ids)];
  }

  private nearbyOf(address: SelectedAddressQuery | null, now: LocalDateTime): NearbySnapshot | null {
    if (!address) return null;
    const branches = this.branchesOf(address);
    const minute = now - (now % 60_000);
    const key = `${address.settlementId}|${address.streetId}|${address.house}|${minute}|${branches.map((id) => `${id}=${this.store.registryMeta(id)}`).join(',')}`;
    if (nearbyCache !== null && nearbyCache.key === key) return nearbyCache.value;
    const value = this.buildNearby(address, branches, now);
    nearbyCache = { key, value };
    return value;
  }

  private buildNearby(address: SelectedAddressQuery, branches: number[], now: LocalDateTime): NearbySnapshot | null {
    const settlement = this.address.settlement?.(address.settlementId);
    if (!settlement) return null;
    const today = formatLocalDate(toLocalDate(now));
    const caches = branches
      .map((id) => [id, this.store.registry(id)] as const)
      .filter((p): p is readonly [number, RegistryCache] => p[1] !== null && p[1].date === today);
    if (caches.length === 0) return null;
    const rows = caches.flatMap(([id, c]) => parsedRows(id, c));
    const street = this.address.street(address.streetId)?.nameUk ?? '';
    return {
      items: PoeMapper.nearbyOutages(rows, settlement.nameUk, street, address.house, now),
      fetchedMs: Math.min(...caches.map(([, c]) => c.fetchedMs)),
      complete: caches.length === branches.length && caches.every(([, c]) => c.lastOk),
    };
  }

  /**
   * The registry rows of today that name each address's house, stored as its repair outages
   * (PoeMapper.registryRepairs). An address whose registries have no answer of today keeps what it had.
   */
  private saveRegistryRepairs(addresses: readonly SelectedAddressQuery[], now: LocalDateTime): void {
    const today = formatLocalDate(toLocalDate(now));
    for (const address of addresses) {
      const key = this.addressKey(address);
      const settlement = this.address.settlement?.(address.settlementId);
      if (key === null || !settlement) continue;
      const caches = this.branchesOf(address)
        .map((id) => [id, this.store.registry(id)] as const)
        .filter((p): p is readonly [number, RegistryCache] => p[1] !== null && p[1].date === today);
      if (caches.length === 0) continue;
      const rows = caches.flatMap(([id, c]) => parsedRows(id, c));
      const street = this.address.street(address.streetId)?.nameUk ?? '';
      this.store.saveRegistryRepairs(key, PoeMapper.registryRepairs(rows, settlement.nameUk, street, address.house));
    }
  }

  /**
   * Fetches the registry (E5) of every branch of [address]'s settlement, at most once per NEARBY_TTL_MS
   * unless [force]. A failure keeps the stored rows (spec/POE_API.md section 9).
   */
  private async refreshNearby(addresses: readonly SelectedAddressQuery[], nowMs: number, force: boolean): Promise<void> {
    const today = toLocalDate(fromInstant(nowMs));
    const day = formatLocalDate(today);
    for (const id of [...new Set(addresses.flatMap((a) => this.branchesOf(a)))]) {
      const cached = this.store.registry(id);
      const age = nowMs - (cached?.fetchedMs ?? 0);
      if (!force && cached && cached.date === day && cached.lastOk && age >= 0 && age < NEARBY_TTL_MS) continue;
      let r: Awaited<ReturnType<PoeClient['registry']>> | null = null;
      try {
        r = await this.poe.registry(id, today);
      } catch {
        r = null;
      }
      this.store.saveRegistry(id, day, r && r.kind === 'confirmed' ? r.raw : null, nowMs);
    }
  }

  private snapshotOf(q: string, key: string | null, now: LocalDateTime, poweron: PowerOnSnapshot | null, address: SelectedAddressQuery | null = null): OutageSnapshot {
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
      measures: this.store.measures(formatLocalDate(today)),
      gavMessage: key !== null ? this.store.gavMessage(key) : null,
      nearby: key !== null ? this.nearbyOf(address, now) : null,
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
    // registry rows naming the house, unless the per-house status already lists the same works
    const listed = key !== null ? this.store.registryRepairs(key).filter((r) => !repairs.some((o) => o.start === r.start && o.end === r.end)) : [];
    return inWindow([...planned, ...repairs, ...listed, ...emergencies], today);
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
        this.store.saveSite(res.siteState, nowMs);
        if (res.measuresKnown) this.store.saveMeasures(formatLocalDate(toLocalDate(fromInstant(nowMs))), res.notice ?? null);
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
      // the catalogue answers for "several connections" houses: load it first (in the browser; null elsewhere)
      if (polled?.status?.status.severalConnections) await ensurePoeQueues().catch(() => null);
      const target = polled?.status ? queueFromStatus(polled.status.status, query, settings.queue || null) : null;
      if (target !== null) {
        const queue = target.queue ?? '';
        const statusText = target.statusText;
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

    // The hourly-schedule catalogue from this repository's CI, at most once a week (spec/POE_API.md 8.11);
    // in the browser only, and without holding up the refresh
    if (typeof window !== 'undefined') void refreshQueuesIfDue().catch(() => 'FAILED');

    // The nearby outages card of the address the main view shows (the primary unless another is shown)
    const shownItem = subs ? subs.store.items.find((i) => i.id === shownId && i.id !== subs!.store.primaryId) ?? null : null;
    const shownAddress = shownItem?.address
      ? { remId: shownItem.address.remSlug, settlementId: shownItem.address.settlementId, streetId: shownItem.address.streetId, house: shownItem.address.house }
      : null;
    // The registries of every address's branches: their rows naming a house become its repair outages
    const addresses: SelectedAddressQuery[] = [];
    const addAddress = (a: SelectedAddressQuery | null | undefined) => {
      if (a && !addresses.some((x) => x.settlementId === a.settlementId && x.streetId === a.streetId && x.house === a.house)) addresses.push(a);
    };
    addAddress(shownAddress);
    addAddress(query);
    for (const item of subs?.store.items ?? []) {
      if (item.address) addAddress({ remId: item.address.remSlug, settlementId: item.address.settlementId, streetId: item.address.streetId, house: item.address.house });
    }
    if (addresses.length > 0) {
      try {
        await this.refreshNearby(addresses, nowMs, forceNetwork);
      } catch {
        // the card keeps its last rows
      }
      this.saveRegistryRepairs(addresses, fromInstant(nowMs));
    }
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
      if (polled?.status?.status.severalConnections) await ensurePoeQueues().catch(() => null);
      const target = polled?.status
        ? queueFromStatus(polled.status.status, { remId: a.remSlug, settlementId: a.settlementId, streetId: a.streetId, house: a.house }, item.queue)
        : null;
      if (target !== null) {
        const { queue, statusText } = target;
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
      if (fetch.kind === 'confirmed') {
        this.store.saveRepairs(key, fetch.status.repairs);
        this.store.saveGavMessage(key, fetch.gavMessage ?? null);
      }
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

/**
 * The queue (and no-queue text) an address gets from a confirmed per-house status, or null to leave it as it
 * is (mirrors OutageRepository.queueFromStatus). "Several connections" (spec/POE_API.md 8.11) never clears a
 * queue: an address that has one keeps it; one that has none takes the queue of POE's hourly-schedule catalogue
 * when it names one without doubt (QueueCatalogue.confident); otherwise the user picks it in the address dialog.
 */
export function queueFromStatus(
  status: Pick<AddressStatus, 'queue' | 'severalConnections'>,
  query: SelectedAddressQuery,
  current: string | null,
  hints: (q: SelectedAddressQuery) => readonly QueueHint[] = queuesFor
): { queue: string | null; statusText: string | null } | null {
  if (status.queue !== null) return { queue: status.queue, statusText: null };
  if (!status.severalConnections) return { queue: null, statusText: NO_QUEUE_TEXT };
  if (current !== null && current !== '') return null;
  let best: string | null = null;
  try {
    best = QueueCatalogue.confident(hints(query));
  } catch {
    best = null;
  }
  return { queue: best, statusText: null };
}
