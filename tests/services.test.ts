/**
 * Tests of the web SERVICE layer that mirrors the Android logic: the schedule cache, the outage
 * repository on POE data with a fake clock and a fake POE site, and the alert planning. The POE client
 * itself is tested in tests/poe-client.test.ts.
 *
 * Run: tsx tests/services.test.ts
 */
import assert from 'node:assert/strict';
import { formatLocalDateTime, fromInstant, parseLocalDate, parseLocalDateTime, type LocalDateTime } from '../src/core/localTime';
import { EmergencyFetch, eventKey, type EmergencyEvent } from '../src/core/emergencyLedger';
import { makeOutage, type Span } from '../src/core/outageModels';
import { buildPlanned } from '../src/core/outageEngine';
import { PoeClient, PoeConfig, type PoeHttpResult, type PoeTransport } from '../src/services/poeClient';
import { DEFAULT_POE_URL, syncPoeSchedule } from '../src/services/poeScheduleSync';
import { StreetKey, HouseKey } from '../src/core/addressKeys';
import { createMemoryStorage } from '../src/services/storage';
import {
  KEY_STORE as SUB_KEY_STORE,
  SubscriptionRepository,
  decode as subDecode,
  encode as subEncode,
  randomId as subRandomId,
} from '../src/services/subscriptionStore';
import { SubscriptionSync } from '../src/services/subscriptionSync';
import {
  add as subAdd,
  setPrimary as setSubscriptionPrimary,
  makeSubscription,
  type LegacySettings,
  type SubscriptionAddress,
  type SubscriptionStore,
} from '../src/core/subscriptions';
import { ScheduleCache } from '../src/services/scheduleCache';
import { OutageStateStore } from '../src/services/outageStore';
import { OutageRepository, type AddressEvents, type AddressResolver } from '../src/services/outageRepository';
import {
  DEFAULT_SETTINGS,
  checkAndTriggerAdvanceAlert,
  checkAndTriggerGroupedAlerts,
  checkAndTriggerPlannedAlerts,
  clearNotifiedHistory,
  formatWhen,
  planPreWarnings,
  triggerEmergencyEventAlerts,
} from '../src/services/alertManager';
import { durationText, plannedAlertBody, translations } from '../src/services/i18n';
import type { UserSettings } from '../src/types';

const NBSP = ' ';
const dt = (s: string): LocalDateTime => parseLocalDateTime(s);

/** Epoch ms of a Kyiv wall-clock time in November 2026 (winter time, UTC+2). */
const kyivMs = (iso: string): number => Date.parse(`${iso}:00+02:00`.replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}):00(.*)$/, '$1:00$2'));

const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>) => void tests.push([name, fn]);

// -------------------------------------------------------------------------------------------------
// POE pages and per-house answers for the repository tests
// -------------------------------------------------------------------------------------------------

const QUEUE_IDS = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'];
const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

/**
 * A POE schedule fragment (spec/POE_API.md section 3) for [iso] where queue 2.2 is off in the half-hour
 * ranges [off22] (and switching in [sw22]); every other queue is on all day.
 */
function poePage(iso: string, off22: [number, number][], sw22: [number, number][] = []): string {
  const [y, m, d] = iso.split('-').map(Number);
  const rows = QUEUE_IDS.map((q) => {
    const cells = Array.from({ length: 48 }, (_, i) => {
      const s = q === '2.2' && off22.some(([a, b]) => i >= a && i < b) ? 2 : q === '2.2' && sw22.some(([a, b]) => i >= a && i < b) ? 3 : 1;
      return `<td class="gpv-c gpv-s${s}"></td>`;
    }).join('');
    return `<tr><td class="gpv-q">${q}</td>${cells}</tr>`;
  }).join('');
  return `<div class="gpvinfodetail">Графік на <b>${d} ${MONTHS[m - 1]} ${y} року</b><table class="gpv-table"><tbody>${rows}</tbody></table><p>Оновлено: ${d} ${MONTHS[m - 1]} ${y} 08:00</p></div>`;
}

// 23:00-24:00 is half-hour cells 46..48, 00:00-01:00 is cells 0..2, then the switching half-hour 01:00-01:30
const POE_PAGES: Record<string, string> = {
  '12-11-2026': poePage('2026-11-12', [[46, 48]]),
  '13-11-2026': poePage('2026-11-13', [[0, 2]], [[2, 3]]),
};

/** E4 answer for one house: an emergency 22:00-23:30 («пошкодження») or nothing; queue 2.2. */
function poeHouseAnswer(emergency: boolean): string {
  return JSON.stringify([
    emergency
      ? {
          fn_accident_message:
            'зареєстрована аварійна перерва в електропостачанні 12.11.2026 р. з 22 годин(и) 00 хвилин(и). Очікуваний час закінчення перерви в електропостачанні: 12.11.2026 р. о 23 годин(и) 30 хвилин(и).',
          message_type: 3,
          accident_str: '12.11.2026 22:00',
          accident_id: 4242,
          gav_message: 'Заживлено від ТП-1 та залучено до ГПВ (черга 2-2).',
          gp_qnum_1: '2',
          gp_qnum_2: '2',
          planned_message: null,
        }
      : {
          fn_accident_message: 'не зареєстровано перерв в електропостачанні',
          message_type: 0,
          accident_str: null,
          accident_id: null,
          gav_message: 'Заживлено від ТП-1 та залучено до ГПВ (черга 2-2).',
          gp_qnum_1: '2',
          gp_qnum_2: '2',
          planned_message: null,
        },
  ]);
}

test('schedule cache: yesterday tail, midnight rollover, tomorrow validity', () => {
  const cache = new ScheduleCache(createMemoryStorage());
  const cells = (ranges: [number, number][]) => Array.from({ length: 48 }, (_, i) => ranges.some(([a, b]) => i >= a && i < b));
  const d12 = parseLocalDate('2026-11-12');
  const d13 = parseLocalDate('2026-11-13');
  const d14 = parseLocalDate('2026-11-14');
  cache.saveSchedule('2.2', cells([[46, 48]]), cells([[0, 2]]), d12, 1);
  assert.equal(cache.hasValidTodayCache('2.2', d12), true);
  assert.equal(cache.hasTomorrowSchedule('2.2', d12), true);
  // after midnight the cached tomorrow table is promoted to today and yesterday is archived
  assert.deepEqual(cache.todayOffCells('2.2', d13), cells([[0, 2]]));
  assert.deepEqual(cache.yesterdayOffCells('2.2', d13), cells([[46, 48]]));
  assert.equal(cache.hasTomorrowSchedule('2.2', d13), false);
  // two days later nothing is valid, and the yesterday stamp no longer matches
  assert.equal(cache.hasValidTodayCache('2.2', d14), false);
  assert.equal(cache.yesterdayOffCells('2.2', d14), null);
  // a table shorter than 24 cells is not a cache
  cache.saveSchedule('1.1', [true, false], null, d13, 2);
  assert.equal(cache.todayOffCells('1.1', d13), null);
  cache.clear();
  assert.equal(cache.hasValidTodayCache('2.2', d13), false);
});

// -------------------------------------------------------------------------------------------------
// Outage repository (fake clock, fake ztoe, fake PowerOn)
// -------------------------------------------------------------------------------------------------

const SOBORNOSTI: AddressResolver = {
  // two spellings of the street in the POE directory, merged by StreetKey into one option
  street: (id) => (['1227174', '1227175'].includes(id) ? { nameUk: 'вул. Соборності', allIds: ['1227174', '1227175'] } : undefined),
};

/** The address key of a house on вул. Соборності, місто Полтава (spec/SUBSCRIPTIONS.md section 1). */
const addrKey = (house: string) => `11389|${StreetKey.of('вул. Соборності')}|${HouseKey.of(house)}`;

const settings22: UserSettings = {
  ...DEFAULT_SETTINGS,
  queue: '2.2',
  url: DEFAULT_POE_URL,
  selectedAddress: 'місто Полтава, вул. Соборності, буд. 37',
  selectedAddressQuery: { remId: 'poltavska', settlementId: '11389', streetId: '1227174', house: '37' },
};

function makeRepo(subscriptions?: () => { store: SubscriptionStore; master: boolean }) {
  const clock = { ms: kyivMs('2026-11-12T22:30') };
  const online = { value: true };
  /** The POE schedule pages are down (network error) while true. */
  const site = { down: false };
  /** Houses of вул. Соборності with an emergency; the per-house status fails while [fail]. */
  const poe = { offHouses: [] as string[], fail: false };
  const notified: { key: string; events: readonly EmergencyEvent[] }[] = [];
  const notifiedOther: AddressEvents[] = [];
  const queueWrites: [string | null, string | null][] = [];
  const ok = (body: string): PoeHttpResult => ({ kind: 'ok', body });
  const transport: PoeTransport = async (endpoint, _field, json) => {
    const req = JSON.parse(json);
    if (endpoint === PoeConfig.ADDRESS_STATUS) {
      if (poe.fail) return { kind: 'failed', reason: 'network' };
      return ok(poeHouseAnswer(poe.offHouses.includes(req.house)));
    }
    if (endpoint === PoeConfig.SCHEDULE) return site.down ? { kind: 'failed', reason: 'network' } : ok(POE_PAGES[req.date_in] ?? '');
    if (endpoint === PoeConfig.MEASURES) return site.down ? { kind: 'failed', reason: 'network' } : ok('[]');
    return ok('[]');
  };
  const client = new PoeClient(transport, () => clock.ms);
  const repo = new OutageRepository({
    schedule: new ScheduleCache(createMemoryStorage()),
    store: new OutageStateStore(createMemoryStorage()),
    poe: client,
    syncSchedule: (options) => syncPoeSchedule({ ...options, client, isOnline: () => online.value }),
    address: SOBORNOSTI,
    nowMs: () => clock.ms,
    notify: (_s, key, events) => void notified.push({ key, events }),
    subscriptions: subscriptions ?? (() => ({ store: { primaryId: null, items: [] }, master: true })),
    assignQueue: (_s, itemId, queue) => void queueWrites.push([itemId, queue]),
    notifyOther: (_s, other) => void notifiedOther.push(other),
  });
  return { repo, clock, online, site, poe, notified, notifiedOther, queueWrites };
}

test('repository: emergency + planned merge into one block, cells carry isPlanned and isEmergency', async () => {
  const { repo, poe, notified, queueWrites } = makeRepo();
  poe.offHouses.push('35', '37', '39');
  const out = await repo.refresh(settings22);

  assert.equal(out.siteState, 'AVAILABLE_WITH_TABLE');
  assert.equal(out.fetchStatus, 'SUCCESS');
  assert.equal(out.poweronOk, true);
  assert.deepEqual(out.events.map((e) => e.kind), ['START']);
  assert.equal(notified.length, 1);
  assert.equal(notified[0].key, repo.addressKey(settings22.selectedAddressQuery));
  assert.equal(notified[0].key, addrKey('37'));
  assert.deepEqual(queueWrites, [], 'POE confirms the stored queue 2.2: nothing is written');

  const snap = out.snapshot;
  assert.equal(snap.hasAddress, true);
  assert.equal(snap.plannedKnown, true);
  assert.equal(snap.tomorrowPublished, true);
  assert.equal(snap.isUnclear, false);
  assert.equal(snap.isStale, false);
  assert.equal(snap.site?.state, 'AVAILABLE_WITH_TABLE');
  assert.equal(snap.poweron?.ok, true);

  const st = snap.status();
  assert.equal(st.isOffNow, true);
  // emergency 22:00-23:30 touches the planned 23:00-01:00: one block until 01:00 (2 h 30 min from 22:30)
  assert.equal(st.countdownSeconds, 9000);
  assert.equal(st.nextSlotTime, '22:00 – 01:00');
  assert.equal(snap.featuredEmergency()?.kind, 'EMERGENCY');

  const slots = snap.slotsFor(snap.today);
  assert.equal(slots.length, 48);
  const at = (hhmm: string) => slots.find((s) => s.startTimeStr === hhmm)!;
  assert.deepEqual([at('21:30').isEmergency, at('21:30').isPlanned, at('21:30').status], [false, false, 'POWER_ON']);
  assert.deepEqual([at('22:00').isEmergency, at('22:00').isPlanned, at('22:00').status], [true, false, 'POWER_OFF']);
  assert.deepEqual([at('23:00').isEmergency, at('23:00').isPlanned], [true, true]);
  assert.deepEqual([at('23:30').isEmergency, at('23:30').isPlanned, at('23:30').status], [false, true, 'POWER_OFF']);
  assert.equal(slots[0].id, '2026-11-12_00:00_Q2.2');
  assert.equal(slots[47].endTimeStr, '24:00');
});

test('repository: a failed source keeps its previous data and never becomes "no outage"', async () => {
  const { repo, poe, site, online, clock, notified } = makeRepo();
  poe.offHouses.push('35', '37', '39');
  await repo.refresh(settings22);
  notified.length = 0;

  // both sources fail (the internet works, the sites do not answer)
  clock.ms = kyivMs('2026-11-12T22:40');
  site.down = true;
  poe.fail = true;
  const failed = await repo.refresh(settings22);
  assert.equal(failed.siteState, 'SITE_UNREACHABLE');
  assert.equal(failed.poweronOk, false);
  assert.deepEqual(failed.events, []);
  assert.equal(notified.length, 0);
  const snap = failed.snapshot;
  assert.equal(snap.isStale, true, 'cached schedule shown with a stale mark');
  assert.equal(snap.plannedKnown, true);
  assert.equal(snap.status().isOffNow, true, 'the emergency is still there');
  assert.equal(snap.featuredEmergency() !== null, true);
  assert.equal(snap.poweron?.ok, false);
  assert.equal(snap.poweron?.lastOkMs, kyivMs('2026-11-12T22:30'));
  assert.equal(snap.site?.lastSuccessMs, kyivMs('2026-11-12T22:30'));

  // no internet at all
  online.value = false;
  const offline = await repo.refresh(settings22);
  assert.equal(offline.siteState, 'NO_INTERNET');
  assert.equal(offline.snapshot.plannedKnown, true);

  // recovery: POE answers again WITHOUT the emergency -> it ends (END event), the planned block stays
  online.value = true;
  site.down = false;
  poe.fail = false;
  poe.offHouses.length = 0;
  clock.ms = kyivMs('2026-11-12T22:45');
  const ended = await repo.refresh(settings22);
  assert.deepEqual(ended.events.map((e) => e.kind), ['END']);
  assert.equal(ended.snapshot.featuredEmergency(), null);
  const next = ended.snapshot.status();
  assert.equal(next.isOffNow, false);
  assert.equal(next.nextSlotTime, '23:00 – 01:00');
  // the finished emergency stays listable today
  const rows = ended.snapshot.dayView(ended.snapshot.today).rows;
  assert.deepEqual(rows.map((r) => [r.outage.kind, r.status]), [['EMERGENCY', 'FINISHED'], ['PLANNED', 'UPCOMING']]);
});

test('repository: midnight rollover keeps the block over midnight whole (yesterday tail)', async () => {
  const { repo, site, clock } = makeRepo();
  await repo.refresh(settings22); // 12.11 22:30 caches 12.11 and 13.11
  clock.ms = kyivMs('2026-11-13T00:10');
  site.down = true; // site down after midnight
  const out = await repo.refresh(settings22);
  const snap = out.snapshot;
  assert.equal(snap.plannedKnown, true, 'tomorrow table was promoted to today');
  const st = snap.status();
  assert.equal(st.isOffNow, true);
  assert.equal(st.countdownSeconds, 50 * 60);
  const rows = snap.dayView(snap.today).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].continuesFromPrevDay, true);
  assert.equal(rows[0].durationMinutes, 120, 'real length of the whole 23:00-01:00 block');
  assert.equal(rows[0].inDayMinutes, 60);
  // POE: the switching half-hour after the block is the latest restore time
  assert.equal(st.restoreUntil !== null && formatLocalDateTime(st.restoreUntil), '2026-11-13T01:30');
  assert.equal(snap.slotsFor(snap.today).find((s) => s.startTimeStr === '01:00')?.isSwitching, true);
});

test('repository: no queue / no address / unclear states', async () => {
  const { repo, site } = makeRepo();
  const none = repo.snapshot({ ...DEFAULT_SETTINGS, queue: '', selectedAddressQuery: undefined });
  assert.equal(none.hasAddress, false);
  assert.equal(none.isUnclear, false);
  assert.equal(none.plannedKnown, true);
  assert.deepEqual(none.slotsFor(none.today).some((s) => s.status === 'POWER_OFF'), false);

  // a queue with nothing cached and nothing else known: grey
  site.down = true;
  const unclear = (await repo.refresh({ ...settings22, selectedAddressQuery: undefined })).snapshot;
  assert.equal(unclear.plannedKnown, false);
  assert.equal(unclear.isUnclear, true);
  assert.deepEqual(unclear.slotsFor(unclear.today), []);
  assert.equal(unclear.scheduleStatus().isUnclear, true);
  assert.equal(unclear.scheduleStatus().nextSlotTime, '--:-- - --:--');
});

test('repository: the address key survives a duplicate-street merge', () => {
  const { repo } = makeRepo();
  const a = repo.addressKey({ remId: 'poltavska', settlementId: '11389', streetId: '1227174', house: '37' });
  const b = repo.addressKey({ remId: 'poltavska', settlementId: '11389', streetId: '1227175', house: '№ 37' });
  assert.equal(a, b);
  assert.equal(a, addrKey('37'));
  assert.equal(repo.addressKey({ remId: 'poltavska', settlementId: '11389', streetId: '1227174', house: '  ' }), null);
  assert.equal(repo.addressKey(undefined), null);
});

// -------------------------------------------------------------------------------------------------
// Alerts (fake clock)
// -------------------------------------------------------------------------------------------------

const alertSettings: UserSettings = { ...DEFAULT_SETTINGS, queue: '2.2', notificationsEnabled: true, emergencyNotificationsEnabled: true };
const planned14to16 = () => buildPlanned(parseLocalDate('2026-11-13'), Array.from({ length: 48 }, (_, i) => i >= 28 && i < 32), null);

test('alerts: the plan is one alert per merged span with key planned_<ISO start>, never retroactive', () => {
  const plan = planPreWarnings(planned14to16(), dt('2026-11-13T13:00'), alertSettings);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].key, 'planned_2026-11-13T14:00');
  assert.equal(formatLocalDateTime(plan[0].fireAt), '2026-11-13T13:45');
  assert.equal(plan[0].durationMinutes, 120);
  assert.deepEqual(planPreWarnings(planned14to16(), dt('2026-11-13T13:50'), alertSettings), [], 'fireAt already passed');
  assert.deepEqual(planPreWarnings(planned14to16(), dt('2026-11-13T14:30'), alertSettings), [], 'the span has started');
  assert.deepEqual(planPreWarnings(planned14to16(), dt('2026-11-13T13:00'), { ...alertSettings, notificationsEnabled: false }), []);
});

test('alerts: fires once at fireAt with the engine text; never twice, never for a started span', () => {
  clearNotifiedHistory();
  const outages = planned14to16();
  const fired: string[] = [];
  const cb = (r: { message: string }) => void fired.push(r.message);
  assert.deepEqual(checkAndTriggerPlannedAlerts(outages, dt('2026-11-13T13:44'), alertSettings, 'uk', cb), []);
  const first = checkAndTriggerPlannedAlerts(outages, dt('2026-11-13T13:45'), alertSettings, 'uk', cb);
  assert.equal(first.length, 1);
  assert.equal(first[0].slotId, 'planned_2026-11-13T14:00');
  assert.equal(first[0].message, `Черга 2.2: відключення о 14:00 (через 15${NBSP}хв), орієнтовно до 16:00 (2${NBSP}год).`);
  assert.equal(first[0].title, translations.uk.plannedAlertTitle);
  assert.deepEqual(checkAndTriggerPlannedAlerts(outages, dt('2026-11-13T13:50'), alertSettings, 'uk', cb), [], 'deduped by key');
  assert.equal(fired.length, 1);

  // a late tick (throttled tab) still alerts while the outage has not begun; "starting now" within the 2 minute tolerance
  clearNotifiedHistory();
  const late = checkAndTriggerPlannedAlerts(outages, dt('2026-11-13T14:01'), alertSettings, 'en');
  assert.equal(late.length, 1);
  assert.ok(late[0].message.startsWith('Queue 2.2: outage is starting now, at 14:00'), late[0].message);
  clearNotifiedHistory();
  assert.deepEqual(checkAndTriggerPlannedAlerts(outages, dt('2026-11-13T14:05'), alertSettings, 'uk'), [], 'already started');
  assert.deepEqual(checkAndTriggerPlannedAlerts(outages, dt('2026-11-13T15:00'), alertSettings, 'uk'), [], 'in progress');
  clearNotifiedHistory();
  assert.deepEqual(checkAndTriggerPlannedAlerts(outages, dt('2026-11-13T13:50'), { ...alertSettings, notificationsEnabled: false }, 'uk'), []);
  clearNotifiedHistory();
});

test('alerts: consecutive slots, a repair next to them and an emergency are ONE span; stale emergencies never alert', () => {
  clearNotifiedHistory();
  const planned = planned14to16();
  const repair = makeOutage({ id: 'repair_x', kind: 'REPAIR', start: dt('2026-11-13T16:00'), end: dt('2026-11-13T17:00') });
  const emergency = makeOutage({ id: 'pw_x', kind: 'EMERGENCY', start: dt('2026-11-13T17:00'), end: dt('2026-11-13T18:00') });
  const stale = makeOutage({ id: 'pw_stale', kind: 'EMERGENCY', start: dt('2026-11-13T20:00'), end: dt('2026-11-13T21:00'), stale: true });
  const fired = checkAndTriggerPlannedAlerts([...planned, repair, emergency, stale], dt('2026-11-13T13:45'), alertSettings, 'uk');
  assert.equal(fired.length, 1);
  assert.ok(fired[0].message.includes('орієнтовно до 17:00 (3'), fired[0].message);
  const planOnly = planPreWarnings([stale], dt('2026-11-13T10:00'), alertSettings);
  assert.deepEqual(planOnly, []);
  clearNotifiedHistory();
});

test('alerts: legacy checkAndTriggerAdvanceAlert is engine based (one notification per continuous block)', () => {
  clearNotifiedHistory();
  const slots = Array.from({ length: 48 }, (_, i) => ({
    id: `s${i}`,
    startHour: Math.floor(i / 2),
    endHour: Math.floor((i + 1) / 2),
    startMinute: (i % 2) * 30,
    endMinute: ((i + 1) % 2) * 30,
    startTimeStr: '',
    endTimeStr: '',
    status: i >= 28 && i < 32 ? ('POWER_OFF' as const) : ('POWER_ON' as const),
  }));
  const sched = { dateStr: '2026-11-13', dayLabel: 'x', queue: '2.2', city: 'c', sourceUrl: '', lastUpdated: '', isUnclear: false, slots };
  // 13:44 is before the 15 minute window; 13:45 is inside it (the legacy clock is the schedule's date with the local time of day)
  assert.equal(checkAndTriggerAdvanceAlert(sched, alertSettings, 'uk', undefined, new Date(2026, 10, 13, 13, 44, 0)), null);
  const record = checkAndTriggerAdvanceAlert(sched, alertSettings, 'uk', undefined, new Date(2026, 10, 13, 13, 45, 0));
  assert.equal(record?.slotId, 'planned_2026-11-13T14:00');
  assert.equal(checkAndTriggerAdvanceAlert(sched, alertSettings, 'uk', undefined, new Date(2026, 10, 13, 13, 46, 0)), null, 'once per block');
  // emergency-flagged cells are not planned outages
  clearNotifiedHistory();
  const emergencyOnly = { ...sched, slots: slots.map((s) => (s.status === 'POWER_OFF' ? { ...s, isEmergency: true } : s)) };
  assert.equal(checkAndTriggerAdvanceAlert(emergencyOnly, alertSettings, 'uk', undefined, new Date(2026, 10, 13, 13, 45, 0)), null);
  clearNotifiedHistory();
});

const kyivAddr = (house: string): SubscriptionAddress => ({
  remSlug: 'poltavska',
  settlementId: '11389',
  streetId: '1227174',
  streetName: 'вул. Соборності',
  house,
  text: '',
});

test('alerts: one merged warning per queue and span for every address (spec/SUBSCRIPTIONS.md 8)', () => {
  clearNotifiedHistory();
  const store: SubscriptionStore = {
    primaryId: 'aaaa0001',
    items: [
      makeSubscription('aaaa0001', { address: kyivAddr('37'), queue: '2.2', queueSource: 'LOOKUP', createdAtMs: 1 }),
      makeSubscription('aaaa0002', { address: kyivAddr('39'), queue: '2.2', queueSource: 'LOOKUP', createdAtMs: 2 }),
      makeSubscription('aaaa0003', { queue: '1.1', createdAtMs: 3 }),
      makeSubscription('aaaa0004', { queue: '3.1', plannedAlerts: false, createdAtMs: 4 }),
    ],
  };
  const day = parseLocalDate('2026-11-13');
  const cells = (from: number, to: number) => Array.from({ length: 48 }, (_, i) => i >= from && i < to);
  const outagesFor = (queue: string | null) =>
    queue === '2.2' ? planned14to16() : queue === '1.1' ? buildPlanned(day, cells(28, 30), null) : queue === '3.1' ? planned14to16() : [];

  assert.deepEqual(checkAndTriggerGroupedAlerts(store, true, outagesFor, dt('2026-11-13T13:44'), alertSettings, 'uk'), []);
  const fired = checkAndTriggerGroupedAlerts(store, true, outagesFor, dt('2026-11-13T13:45'), alertSettings, 'uk');
  assert.deepEqual(
    fired.map((r) => r.message),
    [
      `Черга 1.1: відключення о 14:00 (через 15${NBSP}хв), орієнтовно до 15:00 (1${NBSP}год).`,
      `Соборності 37 · Соборності 39 (черга 2.2): відключення о 14:00 (через 15${NBSP}хв), орієнтовно до 16:00 (2${NBSP}год).`,
    ],
    'two addresses on queue 2.2 share one warning; the planned-off address on 3.1 gets none'
  );
  assert.deepEqual(fired.map((r) => r.slotId), ['planned_q1.1_2026-11-13T14:00_2026-11-13T15:00', 'planned_q2.2_2026-11-13T14:00_2026-11-13T16:00']);
  assert.deepEqual(checkAndTriggerGroupedAlerts(store, true, outagesFor, dt('2026-11-13T13:47'), alertSettings, 'uk'), [], 'never twice');

  // posting marked every member: after removing the primary the other address is not warned again
  const without = { primaryId: 'aaaa0002', items: store.items.filter((i) => i.id !== 'aaaa0001') };
  assert.deepEqual(checkAndTriggerGroupedAlerts(without, true, outagesFor, dt('2026-11-13T13:48'), alertSettings, 'uk'), []);

  // a warning recorded by 1.4.0 (the address-independent key planned_<start>) counts for every address
  // with a span starting then, on any queue (8.2), so nothing repeats right after the update
  clearNotifiedHistory();
  assert.equal(checkAndTriggerPlannedAlerts(planned14to16(), dt('2026-11-13T13:45'), alertSettings, 'uk').length, 1);
  assert.deepEqual(checkAndTriggerGroupedAlerts(store, true, outagesFor, dt('2026-11-13T13:46'), alertSettings, 'uk'), []);

  // the master switch silences everything
  clearNotifiedHistory();
  assert.deepEqual(checkAndTriggerGroupedAlerts(store, false, outagesFor, dt('2026-11-13T13:45'), alertSettings, 'uk'), []);
  // one address only: the 1.4.0 text
  const single = { primaryId: 'aaaa0001', items: store.items.slice(0, 1) };
  const one = checkAndTriggerGroupedAlerts(single, true, outagesFor, dt('2026-11-13T13:45'), alertSettings, 'en');
  assert.equal(one.length, 1);
  assert.ok(one[0].message.startsWith('Queue 2.2: outage at 14:00'), one[0].message);
  clearNotifiedHistory();
});

test('repository: emergencies are polled for every address that wants them, each with its own ledger', async () => {
  const store: SubscriptionStore = {
    primaryId: 'aaaa0001',
    items: [
      makeSubscription('aaaa0001', { address: kyivAddr('37'), queue: '2.2', queueSource: 'LOOKUP', createdAtMs: 1 }),
      makeSubscription('aaaa0002', { address: { ...kyivAddr('39'), text: 'місто Полтава, вул. Соборності, буд. 39' }, queue: '2.2', queueSource: 'LOOKUP', createdAtMs: 2 }),
      makeSubscription('aaaa0003', { address: kyivAddr('41'), queue: '2.2', queueSource: 'LOOKUP', createdAtMs: 3 }),
      makeSubscription('aaaa0004', { address: kyivAddr('35'), queue: '2.2', queueSource: 'LOOKUP', emergencyAlerts: false, createdAtMs: 4 }),
    ],
  };
  const master = { value: true };
  const { repo, poe, notified, notifiedOther } = makeRepo(() => ({ store, master: master.value }));
  poe.offHouses.push('35', '37', '39');
  const out = await repo.refresh(settings22);
  assert.deepEqual(out.events.map((e) => e.kind), ['START'], 'the primary as before');
  assert.equal(notified.length, 1);
  // 39 is in the outage list (35, 37, 39), 41 is not, 35 has its emergency switch off
  assert.deepEqual(out.otherEvents.map((o) => [o.itemId, o.addressKey, o.addressLine, o.events.map((e) => e.kind)]), [
    ['aaaa0002', addrKey('39'), 'місто Полтава, вул. Соборності, буд. 39', ['START']],
  ]);
  assert.equal(notifiedOther.length, 1);
  assert.equal(out.snapshot.poweron?.ok, true, 'the status line is the primary fetch');
  // its own ledger: the second refresh announces nothing new
  const again = await repo.refresh(settings22);
  assert.deepEqual(again.otherEvents, []);

  // a primary without a queue still fetches the POE tables for the other addresses
  const noQueue = makeRepo(() => ({ store, master: true }));
  const primaryNoQueue = await noQueue.repo.refresh({ ...settings22, queue: '' });
  assert.equal(primaryNoQueue.fetchStatus, null, 'the primary itself has no table to report');
  assert.ok(noQueue.repo.outagesFor('2.2', null).length > 0, 'queue 2.2 is cached for the other addresses');

  // the master switch stops polling the other addresses
  master.value = false;
  poe.offHouses.length = 0;
  const off = await repo.refresh(settings22);
  assert.deepEqual(off.otherEvents, [], 'no END for an address while the master is off');
});

test('repository: the address shown on the main view is polled whatever its switches, with its own status line (spec/SUBSCRIPTIONS.md 9)', async () => {
  const store: SubscriptionStore = {
    primaryId: 'aaaa0001',
    items: [
      makeSubscription('aaaa0001', { address: kyivAddr('37'), queue: '2.2', queueSource: 'LOOKUP', createdAtMs: 1 }),
      makeSubscription('aaaa0004', { address: kyivAddr('39'), queue: '3.1', queueSource: 'LOOKUP', plannedAlerts: false, emergencyAlerts: false, createdAtMs: 4 }),
    ],
  };
  const { repo, poe, notifiedOther } = makeRepo(() => ({ store, master: true }));
  poe.offHouses.push('35', '37', '39');
  const shown = store.items[1];
  assert.equal(repo.snapshotFor(shown).poweron, null, 'never polled yet: no status line');

  // not shown and both switches off: not polled at all
  await repo.refresh(settings22);
  assert.equal(repo.snapshotFor(shown).poweron, null);

  // shown: polled, its ledger and status are its own, but its switches still gate the notification
  const out = await repo.refresh(settings22, false, true, shown.id);
  assert.deepEqual(out.otherEvents, [], 'its emergency switch is off: no alert');
  assert.equal(notifiedOther.length, 0);
  const snap = repo.snapshotFor(shown);
  assert.equal(snap.poweron?.ok, true, 'its own status line');
  assert.equal(snap.queue, '3.1');
  assert.ok(snap.featuredEmergency() !== null, 'the emergency at 39 is on its main view');
  assert.equal(out.snapshot.poweron?.ok, true, 'the primary keeps its own status');
});

test('repository: an address shown on a widget is polled whatever its switches, without alerts (spec/SUBSCRIPTIONS.md 10)', async () => {
  const store: SubscriptionStore = {
    primaryId: 'aaaa0001',
    items: [
      makeSubscription('aaaa0001', { address: kyivAddr('37'), queue: '2.2', queueSource: 'LOOKUP', createdAtMs: 1 }),
      makeSubscription('aaaa0004', { address: kyivAddr('39'), queue: '3.1', queueSource: 'LOOKUP', plannedAlerts: false, emergencyAlerts: false, createdAtMs: 4 }),
    ],
  };
  const { repo, poe, notifiedOther } = makeRepo(() => ({ store, master: true }));
  poe.offHouses.push('35', '37', '39');
  const onWidget = store.items[1];

  const out = await repo.refresh(settings22, false, true, null, [onWidget.id]);
  assert.deepEqual(out.otherEvents, [], 'its emergency switch is off: no alert');
  assert.equal(notifiedOther.length, 0);
  const snap = repo.snapshotFor(onWidget);
  assert.equal(snap.poweron?.ok, true, 'polled: the widget has a fresh status');
  assert.ok(snap.featuredEmergency() !== null, 'the emergency at 39 reaches the widget');
});

const ev = (kind: EmergencyEvent['kind'], start: string, eta: string | null, extra: Partial<EmergencyEvent> = {}): EmergencyEvent => ({
  kind,
  entryId: 'pw_x',
  start: dt(start),
  eta: eta === null ? null : dt(eta),
  upcoming: false,
  earlyEnd: false,
  ...extra,
});

test('alerts: emergency and scheduled outages that join are one outage: only its start, its prolongation and its real end are announced', () => {
  clearNotifiedHistory();
  // scheduled 22:00-24:00 (the user is warned about it); emergencies around it
  const planned: Span[] = [{ start: dt('2026-11-13T22:00'), end: dt('2026-11-14T00:00'), mayContinue: false, kinds: new Set(['PLANNED']) }];
  const ctx = { plannedSpans: planned, plannedAlertsOn: true };
  const send = (events: EmergencyEvent[], now: string) => triggerEmergencyEventAlerts(events, 'zt_city|key|50', alertSettings, 'uk', dt(now), undefined, ctx);

  // an emergency starting inside the scheduled block and ending within it: nothing at all
  assert.equal(send([ev('START', '2026-11-13T22:30', '2026-11-13T23:30')], '2026-11-13T22:35').length, 0);
  // an emergency starting inside the block and lasting longer: one "restoration time changed" with its estimate
  const longer = send([ev('START', '2026-11-13T23:00', '2026-11-14T01:30')], '2026-11-13T23:05');
  assert.equal(longer.length, 1);
  assert.equal(longer[0].title, 'Змінився час відновлення');
  assert.match(longer[0].message, /01:30/);
  // the same, with "restoration time changes" turned off: nothing
  clearNotifiedHistory();
  assert.equal(triggerEmergencyEventAlerts([ev('START', '2026-11-13T23:00', '2026-11-14T01:30')], 'zt_city|key|51', { ...alertSettings, emergencyEtaAlerts: false }, 'uk', dt('2026-11-13T23:05'), undefined, ctx).length, 0);
  // an emergency ending while the scheduled block is on: no "restored", power is still off
  assert.equal(send([ev('END', '2026-11-13T19:30', '2026-11-13T23:00')], '2026-11-13T23:00').length, 0);
  // the same end after the block is over: announced
  assert.equal(send([ev('END', '2026-11-13T23:30', '2026-11-14T01:00')], '2026-11-14T00:40').length, 1);
  // an emergency before the block starts on its own: announced
  assert.equal(send([ev('START', '2026-11-13T19:30', '2026-11-13T21:00')], '2026-11-13T19:35').length, 1);
  clearNotifiedHistory();
});

test('alerts: no pre-warning for a scheduled block that starts while an emergency is on', () => {
  const planned = planned14to16();
  const emergency = makeOutage({ id: 'pw_2026-11-13T12:30', kind: 'EMERGENCY', start: dt('2026-11-13T12:30'), end: dt('2026-11-13T14:30') });
  assert.deepEqual(planPreWarnings([...planned, emergency], dt('2026-11-13T13:00'), alertSettings), [], 'power is already off at 14:00');
  const earlier = makeOutage({ id: 'pw_2026-11-13T12:00', kind: 'EMERGENCY', start: dt('2026-11-13T12:00'), end: dt('2026-11-13T13:20') });
  assert.equal(planPreWarnings([...planned, earlier], dt('2026-11-13T13:00'), alertSettings).length, 1, 'the emergency is over before 14:00');
});

test('alerts: restoration-time changes and restoration can be turned off for all addresses; the start always notifies', () => {
  clearNotifiedHistory();
  const now = dt('2026-11-13T17:35');
  const events = [ev('START', '2026-11-13T17:30', '2026-11-13T19:30'), ev('ETA_CHANGED', '2026-11-13T17:30', '2026-11-13T20:00'), ev('END', '2026-11-13T17:30', null)];
  const off = { ...alertSettings, emergencyEtaAlerts: false, emergencyEndAlerts: false };
  const fired = triggerEmergencyEventAlerts(events, 'zt_city|key|41', off, 'uk', now);
  assert.deepEqual(fired.map((r) => r.title), [fired[0]?.title], 'only the start');
  assert.equal(fired.length, 1);
  // a dropped follow-up is not replayed when the switch is turned on later
  assert.equal(triggerEmergencyEventAlerts(events, 'zt_city|key|41', alertSettings, 'uk', now).length, 0);
  clearNotifiedHistory();
  const onlyEnd = triggerEmergencyEventAlerts(events, 'zt_city|key|42', { ...alertSettings, emergencyEtaAlerts: false }, 'uk', now);
  assert.equal(onlyEnd.length, 2, 'start and end, no restoration-time change');
  clearNotifiedHistory();
});

test('alerts: emergency events use their own switch, dedupe keys and the Android texts', () => {
  clearNotifiedHistory();
  const now = dt('2026-11-13T17:35');
  const key = 'zt_city|key|37';
  const events = [ev('START', '2026-11-13T17:30', '2026-11-13T19:30'), ev('ETA_CHANGED', '2026-11-13T17:30', '2026-11-13T20:00'), ev('END', '2026-11-13T17:30', null)];
  assert.equal(eventKey(events[0], key), 'emerg_start_zt_city|key|37_2026-11-13T17:30');
  assert.equal(eventKey(events[1], key), 'emerg_change_zt_city|key|37_2026-11-13T17:30_2026-11-13T20:00');

  // the primary's gate is emergencyNotificationsEnabled (= master AND its emergency switch); the planned switch does not matter
  const off = { ...alertSettings, emergencyNotificationsEnabled: false, notificationsEnabled: true };
  assert.deepEqual(triggerEmergencyEventAlerts(events, key, off, 'uk', now), []);
  const onlyEmergency = { ...alertSettings, notificationsEnabled: false, emergencyNotificationsEnabled: true, selectedAddress: 'м. Житомир,\nвул. Київська, 37' };
  const fired = triggerEmergencyEventAlerts(events, key, onlyEmergency, 'uk', now);
  assert.deepEqual(fired.map((r) => r.slotId), events.map((e) => eventKey(e, key)));
  assert.equal(fired[0].title, 'Аварійне відключення');
  assert.equal(fired[0].message, 'Початок: 17:30. Орієнтовне відновлення: 19:30.\nм. Житомир, вул. Київська, 37');
  assert.equal(fired[1].title, 'Змінився час відновлення');
  assert.ok(fired[1].message.startsWith('Нове орієнтовне відновлення: 20:00.'));
  assert.equal(fired[2].title, 'Аварійне відключення завершено');
  assert.ok(fired[2].message.startsWith('Електропостачання за вашою адресою відновлено (початок був: 17:30).'));
  // never twice
  assert.deepEqual(triggerEmergencyEventAlerts(events, key, onlyEmergency, 'uk', now), []);

  clearNotifiedHistory();
  const upcoming = triggerEmergencyEventAlerts([ev('START', '2026-11-13T22:00', null, { upcoming: true })], key, onlyEmergency, 'en', now);
  assert.equal(upcoming[0].title, 'Emergency outage scheduled');
  assert.ok(upcoming[0].message.startsWith('Start: 22:00. Restoration time unknown.'));
  clearNotifiedHistory();
});

test('alerts: formatWhen and duration formatting', () => {
  const td = parseLocalDate('2026-11-13');
  assert.equal(formatWhen('uk', dt('2026-11-13T22:04'), td), '22:04');
  assert.equal(formatWhen('uk', dt('2026-11-14T01:00'), td), 'завтра 01:00');
  assert.equal(formatWhen('en', dt('2026-11-12T23:30'), td), 'yesterday 23:30');
  assert.equal(formatWhen('uk', dt('2026-11-20T08:05'), td), '20.11 08:05');
  assert.equal(durationText('uk', 120), `2${NBSP}год`);
  assert.equal(durationText('uk', 90), `1${NBSP}год 30${NBSP}хв`);
  assert.equal(durationText('en', 45), `45${NBSP}min`);
  assert.equal(
    plannedAlertBody('uk', '', '22:00', '24:00', 0, 120, true),
    `відключення розпочинається зараз, о 22:00, орієнтовно до 24:00 (2${NBSP}год), можливе продовження.`
  );
});

test('core: fromInstant gives the Kyiv wall clock', () => {
  assert.equal(formatLocalDateTime(fromInstant(Date.parse('2026-11-12T21:57:00Z'))), '2026-11-12T23:57');
  assert.equal(formatLocalDateTime(fromInstant(Date.parse('2026-07-01T21:30:00Z'))), '2026-07-02T00:30'); // summer time, UTC+3
});

// -------------------------------------------------------------------------------------------------
// Subscription store (mirrors SubscriptionRepositoryTest.kt)
// -------------------------------------------------------------------------------------------------

const SUB_ADDRESS: SubscriptionAddress = {
  remSlug: 'zhytomyr',
  settlementId: '16657',
  streetId: 'st_123',
  streetName: 'вул. Київська',
  house: '77',
  text: 'Житомирський РЕМ, м. Житомир, вул. Київська, буд. 77',
};

const subLegacy = (notif = true, emerg = true): LegacySettings => ({
  queue: '5.2',
  customQueueStatusText: null,
  selectedAddress: SUB_ADDRESS.text,
  remSlug: 'zhytomyr',
  settlementId: '16657',
  streetId: 'st_123',
  streetName: 'вул. Київська',
  house: '77',
  notificationsEnabled: notif,
  emergencyNotificationsEnabled: emerg,
});

const subIds = (...ids: string[]) => {
  let i = 0;
  return () => ids[i++];
};

test('subscriptions: absent store migrates once and writes both keys', () => {
  const storage = createMemoryStorage();
  const repo = new SubscriptionRepository(storage, () => 1000, subIds('k3f9x2qd', 'zzzzzzzz'));
  assert.equal(repo.read(), null);
  let legacyCalls = 0;
  const store = repo.ensureMigrated(() => {
    legacyCalls++;
    return subLegacy(false, false);
  });
  assert.equal(store.primaryId, 'k3f9x2qd');
  assert.equal(store.items.length, 1);
  assert.equal(repo.alertsMaster(), false);
  assert.notEqual(storage.getItem(SUB_KEY_STORE), null);
  const again = repo.ensureMigrated(() => {
    legacyCalls++;
    return subLegacy();
  });
  assert.deepStrictEqual(again, store);
  assert.equal(legacyCalls, 1);
  assert.equal(repo.alertsMaster(), false);
});

test('subscriptions: unreadable or other-version text migrates again', () => {
  for (const text of ['not json', '{"schemaVersion":2,"items":[]}', '[]', '']) {
    const storage = createMemoryStorage();
    storage.setItem(SUB_KEY_STORE, text);
    const repo = new SubscriptionRepository(storage, () => 1, subIds('abcd1234'));
    assert.equal(repo.read(), null, text);
    assert.equal(repo.ensureMigrated(() => subLegacy()).primaryId, 'abcd1234', text);
  }
});

test('subscriptions: encode/decode round trip keeps nulls', () => {
  const store: SubscriptionStore = {
    primaryId: 'aaaa0001',
    items: [
      makeSubscription('aaaa0001', {
        address: SUB_ADDRESS,
        queueSource: 'LOOKUP',
        queueStatusText: 'Не підлягає відключенням',
        createdAtMs: 1794500000000,
      }),
      makeSubscription('aaaa0002', { label: 'Дача', queue: '3.1', plannedAlerts: false }),
    ],
  };
  const text = subEncode(store);
  const json = JSON.parse(text);
  assert.ok('queue' in json.items[0] && json.items[0].queue === null, 'null fields are written explicitly');
  assert.equal(json.items[1].address, null);
  assert.deepStrictEqual(subDecode(text), store);
});

test('subscriptions: mutate writes only on success', () => {
  const storage = createMemoryStorage();
  const repo = new SubscriptionRepository(storage, Date.now, subIds('q1q1q1q1'));
  repo.ensureMigrated(() => subLegacy());
  const before = storage.getItem(SUB_KEY_STORE);
  const dup = repo.mutate((s) =>
    subAdd(s, makeSubscription('bbbb0001', { address: { ...SUB_ADDRESS, streetName: 'вулиця Київська' }, queue: '5.2' })),
  );
  assert.deepStrictEqual(dup, { ok: false, code: 'duplicate', existingId: 'q1q1q1q1' });
  assert.equal(storage.getItem(SUB_KEY_STORE), before);
  const ok = repo.mutate((s) => subAdd(s, makeSubscription('bbbb0002', { queue: '1.1' })));
  assert.equal(ok.ok, true);
  assert.deepStrictEqual(repo.store().items.map((s) => s.id), ['q1q1q1q1', 'bbbb0002']);
});

test('subscriptions: newItemId skips ids in use and randomId has the id shape', () => {
  const repo = new SubscriptionRepository(createMemoryStorage(), Date.now, subIds('aaaa0001', 'aaaa0001', 'BAD!', 'aaaa0002'));
  repo.ensureMigrated(() => subLegacy());
  assert.equal(repo.newItemId(), 'aaaa0002');
  for (let i = 0; i < 50; i++) assert.match(subRandomId(), /^[a-z0-9]{8}$/);
});

/** aaaa0001, aaaa0002, … (the migration on first use takes one id too, even for an empty store). */
const counterIds = () => {
  let n = 0;
  return () => `aaaa${String(++n).padStart(4, '0')}`;
};

test('subscription sync: first address becomes primary and is mirrored into the settings', () => {
  const sync = new SubscriptionSync(new SubscriptionRepository(createMemoryStorage(), () => 5, counterIds()));
  const empty = { ...DEFAULT_SETTINGS };
  assert.equal(sync.store(empty).items.length, 0, 'first launch migrates to an empty store');
  const added = sync.addFromLookup(empty, '5.2', undefined, SUB_ADDRESS.text, {
    remId: 'zhytomyr',
    settlementId: '16657',
    streetId: 'st_123',
    house: '77',
  });
  assert.equal(added.result.ok, true);
  assert.equal(added.settings.queue, '5.2');
  assert.equal(added.settings.selectedAddress, SUB_ADDRESS.text);
  assert.deepStrictEqual(added.settings.selectedAddressQuery, { remId: 'zhytomyr', settlementId: '16657', streetId: 'st_123', house: '77' });
  assert.equal(added.settings.alertsMaster, true);

  // a second (queue-only) item does not change the mirror
  const second = sync.addQueueOnly(added.settings, '3.1');
  assert.equal(second.result.ok, true);
  assert.equal(second.settings.queue, '5.2');
  // making it primary does
  const primary = sync.change(second.settings, (s) => setSubscriptionPrimary(s, 'aaaa0003'));
  assert.equal(primary.settings.queue, '3.1');
  assert.equal(primary.settings.selectedAddressQuery, undefined);
  assert.equal(primary.settings.selectedAddress, undefined);
});

test('subscription sync: a refused change keeps the settings', () => {
  const sync = new SubscriptionSync(new SubscriptionRepository(createMemoryStorage(), () => 5, counterIds()));
  const s1 = sync.addQueueOnly({ ...DEFAULT_SETTINGS }, '1.1').settings;
  const dup = sync.addQueueOnly(s1, '1.1');
  assert.equal(dup.result.ok, false);
  assert.equal(dup.settings, s1);
});

test('subscription sync: background lookup updates the primary queue and the mirror', () => {
  const sync = new SubscriptionSync(new SubscriptionRepository(createMemoryStorage(), () => 5, counterIds()));
  const legacy = {
    ...DEFAULT_SETTINGS,
    queue: '',
    customQueueStatusText: 'Не підлягає відключенням',
    selectedAddress: SUB_ADDRESS.text,
    selectedAddressQuery: { remId: 'zhytomyr', settlementId: '16657', streetId: 'st_123', house: '77' },
  };
  const r = sync.assignPrimaryQueue(legacy, '4.2', null, null);
  assert.equal(r.result.ok, true);
  assert.equal(r.settings.queue, '4.2');
  assert.equal(r.settings.customQueueStatusText, undefined);
  assert.equal(sync.store(r.settings).items[0].queue, '4.2');
});

test('subscription sync: clear forgets the store so the next start migrates again', () => {
  const storage = createMemoryStorage();
  const sync = new SubscriptionSync(new SubscriptionRepository(storage, () => 5, counterIds()));
  sync.addQueueOnly({ ...DEFAULT_SETTINGS }, '1.1');
  sync.clear();
  assert.equal(storage.getItem(SUB_KEY_STORE), null);
  assert.equal(sync.store({ ...DEFAULT_SETTINGS }).items.length, 0);
});

// -------------------------------------------------------------------------------------------------

async function main() {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (e) {
      failed++;
      console.error(`FAIL ${name}`);
      console.error(e instanceof Error ? (e.stack ?? e.message) : e);
    }
  }
  if (failed > 0) {
    console.error(`${failed} of ${tests.length} service tests failed`);
    process.exit(1);
  }
  console.log(`All ${tests.length} service tests passed`);
}

void main();
