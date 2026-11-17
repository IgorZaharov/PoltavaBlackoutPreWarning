/**
 * Pure mapping of Полтаваобленерго (POE) answers to outages, mirrored 1:1 from
 * android/.../core/PoeMapper.kt. Rules: spec/POE_API.md section 8, golden cases: spec/vectors/poe_api.json.
 *
 * Regexes spell out Java's ASCII-only \s, \S and \d so both platforms match the same text.
 */
import { atStartOfDay, formatLocalDateTime, localDateOf, localDateTimeOf, plusDays, type LocalDate, type LocalDateTime } from './localTime';
import { makeOutage, type EmergencyRecord, type Outage } from './outageModels';
import { HouseKey, StreetKey, TextNorm } from './addressKeys';

export const LABEL_EMERGENCY = 'Аварійна перерва';
export const LABEL_OTHER = 'Перерва в електропостачанні';
export const LABEL_REPAIR = 'Планові роботи';

export type RegistryKind = 'EMERGENCY' | 'REPAIR' | 'MIRROR';
export type RegistryMatch = 'CONFIRMED' | 'STREET' | 'NONE';

export interface TimeRange {
  readonly start: LocalDateTime;
  readonly end: LocalDateTime;
}

export interface AddressStatus {
  readonly messageType: number;
  readonly queue: string | null;
  readonly emergency: EmergencyRecord | null;
  readonly repairs: readonly Outage[];
  /** The house is off because of the hourly schedule (type 4, spec/POE_API.md 8.5): a mirror of E1, not an emergency. */
  readonly scheduleMirror: boolean;
  /** The answer names an outage that could not be read: the fetch counts as unavailable. */
  readonly unparsed: boolean;
  /** No queue because the address has several connections (section 8.5 step 6): unknown, not "no queue". */
  readonly severalConnections: boolean;
}

export interface StreetEntry {
  readonly street: string;
  readonly houses: readonly string[];
}

export interface Place {
  readonly settlement: string;
  readonly streets: readonly StreetEntry[];
  readonly freeText: readonly string[];
}

export interface RegistryRow {
  readonly id: string;
  readonly start: LocalDateTime;
  readonly end: LocalDateTime | null;
  readonly reason: string;
  readonly kind: RegistryKind;
  readonly places: readonly Place[];
}

const S = '[ \\t\\n\\x0B\\f\\r]'; // Java \s
const NS = '[^ \\t\\n\\x0B\\f\\r]'; // Java \S
const TIME = new RegExp(`^${S}*(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})${S}+(\\d{1,2}):(\\d{2})(?::\\d{2})?`);
const ETA = new RegExp(`(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})${S}*р\\.?${S}*о${S}*(\\d{1,2})${S}*годин${NS}*${S}*(\\d{1,2})${S}*хвилин`);
const PLANNED = new RegExp(
  `(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})${S}*р\\.?${S}*з${S}*(\\d{1,2})(?:[:.](\\d{2}))?(?:-?ї)?${S}*до${S}*(\\d{1,2})(?:[:.](\\d{2}))?(?:-?ї)?${S}*годин`
);
const BR = new RegExp(`<br${S}*/?>`, 'i');
const GROUP_BREAK = new RegExp(`<br${S}*/?>(?:${S}|,)*<br${S}*/?>`, 'i');
const TAG = /<[^>]*>/g;
const TD = /<td[^>]*>([\s\S]*?)<\/td>/gi;
const STREET_LINE = new RegExp(`^<b>([\\s\\S]+?)</b>${S}*(?:\\(б\\.${S}*([\\s\\S]*?)\\))?$`);
const SPACES = /[ \t\n\x0B\f\r ​]+/g;
const SETTLEMENT_TYPE = new RegExp(`^(?:місто|село|селище|смт\\.?|сщ\\.|м\\.|с\\.)${S}*`);
const BRACKET_TAIL = new RegExp(`${S}*\\([^)]*\\)${S}*$`);
const GLUED_ABBREVIATION = /^(\p{L}{1,6}\.)(?=\p{L})/u;
const DIGIT = /\d/;

// -------------------------------------------------------------------------------------------------
// Times (section 8.1 - 8.3)
// -------------------------------------------------------------------------------------------------

function dateTime(day: number, month: number, year: number, hour: number, minute: number, allow24: boolean): LocalDateTime | null {
  if (allow24 && hour === 24 && minute === 0) {
    const d = localDateOf(year, month, day);
    return d === null ? null : atStartOfDay(plusDays(d, 1));
  }
  return localDateTimeOf(year, month, day, hour, minute);
}

/** `DD.MM.YYYY HH:mm[:ss]` -> wall-clock time; anything impossible or else -> null. */
export function parseTime(raw: string | null | undefined): LocalDateTime | null {
  if (raw == null) return null;
  const m = TIME.exec(raw);
  if (!m) return null;
  return dateTime(+m[1], +m[2], +m[3], +m[4], +m[5], false);
}

/** Estimated end inside `fn_accident_message` (`... DD.MM.YYYY р. о HH годин(и) MM хвилин(и)`). */
export function parseEta(message: string | null | undefined): LocalDateTime | null {
  if (message == null || message.length === 0) return null;
  const at = message.indexOf('закінчення');
  const part = at >= 0 ? message.substring(at) : message;
  const m = ETA.exec(part);
  if (!m) return null;
  return dateTime(+m[1], +m[2], +m[3], +m[4], +m[5], true);
}

/** Future repair works of `planned_message`, in text order, exact duplicates removed. */
export function parsePlannedList(text: string | null | undefined): TimeRange[] {
  if (text == null || text.length === 0) return [];
  const out: TimeRange[] = [];
  for (const part of text.split(BR)) {
    const m = PLANNED.exec(part);
    if (!m) continue;
    const day = +m[1];
    const month = +m[2];
    const year = +m[3];
    const start = dateTime(day, month, year, +m[4], m[5] ? +m[5] : 0, true);
    const end = dateTime(day, month, year, +m[6], m[7] ? +m[7] : 0, true);
    if (start === null || end === null || !(end > start)) continue;
    if (!out.some((r) => r.start === start && r.end === end)) out.push({ start, end });
  }
  return out;
}

/** `gp_qnum_1` + `gp_qnum_2` -> `"4.2"`; anything outside 1..6 / 1..2 (both empty included) -> null. */
export function parseQueue(q1: string | null | undefined, q2: string | null | undefined): string | null {
  const a = (q1 ?? '').trim();
  const b = (q2 ?? '').trim();
  if (!/^[1-6]$/.test(a) || !/^[12]$/.test(b)) return null;
  return `${a}.${b}`;
}

// -------------------------------------------------------------------------------------------------
// Per-house status (section 8.5)
// -------------------------------------------------------------------------------------------------

function intOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : null;
  }
  return null;
}

function strOf(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(intOf(v) ?? v);
  return null;
}

/** Maps the first element of the per-house answer (E4) to outages. */
export function addressStatus(result: Readonly<Record<string, unknown>>, today: LocalDate): AddressStatus {
  const messageType = intOf(result['message_type']) ?? -1;
  const queue = parseQueue(strOf(result['gp_qnum_1']), strOf(result['gp_qnum_2']));
  const start = parseTime(strOf(result['accident_str']));
  const rawEta = parseEta(strOf(result['fn_accident_message']));
  const eta = start !== null && rawEta !== null && rawEta > start ? rawEta : null;

  let emergency: EmergencyRecord | null = null;
  let unparsed = false;
  let scheduleMirror = false;
  const message = (strOf(result['fn_accident_message']) ?? '').toLowerCase();
  const repairs = new Map<string, Outage>();

  const addRepair = (s: LocalDateTime, e: LocalDateTime) => {
    const id = `repair_${formatLocalDateTime(s)}`;
    const prev = repairs.get(id);
    if (prev === undefined || e > prev.end) {
      repairs.set(id, makeOutage({ id, kind: 'REPAIR', start: s, end: e, label: LABEL_REPAIR }));
    }
  };

  if (messageType === 0) {
    // nothing registered
  } else if (messageType === 2) {
    if (start !== null && eta !== null) addRepair(start, eta);
    else unparsed = true;
  } else if (messageType !== 3 && (message.includes('гпв') || message.includes('погодинн'))) {
    scheduleMirror = true;
  } else if (start !== null) {
    const id = intOf(result['accident_id']);
    emergency = {
      id: id !== null && id > 0 ? `poe_${id}` : `poe_${formatLocalDateTime(start)}`,
      start,
      estimatedEnd: eta,
      closedAt: null,
      label: messageType === 3 ? LABEL_EMERGENCY : LABEL_OTHER,
    };
  } else {
    unparsed = true;
  }

  const horizon = atStartOfDay(plusDays(today, 2));
  for (const r of parsePlannedList(strOf(result['planned_message']))) {
    if (r.start < horizon) addRepair(r.start, r.end);
  }
  const sorted = [...repairs.values()].sort((a, b) => a.start - b.start);
  const severalConnections = queue === null && message.includes('декілька підключень');
  return { messageType, queue, emergency, repairs: sorted, scheduleMirror, unparsed, severalConnections };
}

// -------------------------------------------------------------------------------------------------
// Branch registry (sections 8.6 - 8.9)
// -------------------------------------------------------------------------------------------------

export function classifyRegistryReason(reason: string | null | undefined): RegistryKind {
  const r = (reason ?? '').trim().toLowerCase();
  if (r.includes('авар')) return 'EMERGENCY';
  if (r.includes('гпв') || r.includes('графік')) return 'MIRROR';
  return 'REPAIR';
}

const stripTags = (s: string): string => s.replace(TAG, '');

function trimComma(s: string): string {
  const t = s.trim();
  return (t.endsWith(',') ? t.slice(0, -1) : t).trim();
}

export function parseRegistryRow(outText: string | null | undefined): RegistryRow | null {
  if (outText == null) return null;
  const cells = [...outText.matchAll(TD)].map((m) => m[1]);
  if (cells.length < 4) return null;
  const start = parseTime(TextNorm.decodeEntities(stripTags(cells[0])));
  if (start === null) return null;
  const end = parseTime(TextNorm.decodeEntities(stripTags(cells[1])));
  const reason = TextNorm.decodeEntities(stripTags(cells[3])).trim();
  return {
    id: `poe_reg_${formatLocalDateTime(start)}`,
    start,
    end,
    reason,
    kind: classifyRegistryReason(reason),
    places: parsePlaces(cells[2]),
  };
}

export function parsePlaces(html: string): Place[] {
  const out: Place[] = [];
  for (const group of TextNorm.decodeEntities(html).split(GROUP_BREAK)) {
    const lines = group
      .split(BR)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const settlement = trimComma(stripTags(lines[0]));
    if (settlement.length === 0) continue;
    const streets: StreetEntry[] = [];
    const freeText: string[] = [];
    for (const raw of lines.slice(1)) {
      const line = trimComma(raw);
      const m = STREET_LINE.exec(line);
      if (m) {
        const houses = (m[2] ?? '')
          .split(',')
          .map((h) => h.trim())
          .filter((h) => h.length > 0);
        streets.push({ street: m[1].trim(), houses });
        continue;
      }
      const text = trimComma(stripTags(line));
      if (text.length === 0) continue;
      freeText.push(text);
      const parts = text.split(',').map((p) => p.trim());
      if (parts.length >= 3 && DIGIT.test(parts[parts.length - 1])) {
        streets.push({ street: parts[parts.length - 2], houses: [parts[parts.length - 1]] });
      } else if (parts.length === 2 && parts[1].length > 0) {
        streets.push({ street: parts[1], houses: [] });
      }
    }
    out.push({ settlement, streets, freeText });
  }
  return out;
}

/** `м.Полтава`, `місто Полтава`, `Полтава` -> one key; a bracketed tail such as `(... ТГ)` is ignored. */
export function settlementKey(name: string): string {
  let s = TextNorm.decodeEntities(name).toLowerCase().replace(SPACES, ' ').trim();
  s = s.replace(SETTLEMENT_TYPE, '');
  s = s.replace(BRACKET_TAIL, '').trim();
  return StreetKey.of(s);
}

/** `вул.Дружби`, `вул. Дружби ` and `вул. Дружби (Леніна)` -> one key. */
export function streetKey(name: string): string {
  let s = TextNorm.decodeEntities(name).replace(SPACES, ' ').trim();
  s = s.replace(BRACKET_TAIL, '').trim();
  s = s.replace(GLUED_ABBREVIATION, '$1 ');
  return StreetKey.of(s);
}

/** Does a registry row name the address? Registry house lists are incomplete, see section 6. */
/**
 * Registry rows (8.7) that name the house itself (registryMatch CONFIRMED), as REPAIR outages of the
 * address (owner, 2026-11-17: a repair or fault listed for the house must reach the drum, the list and the
 * timer even when the per-house status says nothing). Rows without an end and ГПВ mirror rows are left out;
 * a row naming only the street never becomes an outage (registry lists are incomplete).
 */
export function registryRepairs(rows: readonly RegistryRow[], settlement: string, street: string, house: string): Outage[] {
  if (street.trim() === '' || house.trim() === '') return [];
  const out = new Map<string, Outage>();
  for (const row of rows) {
    if (row.kind === 'MIRROR' || row.end === null || !(row.end > row.start)) continue;
    if (registryMatch(row.places, settlement, street, house) !== 'CONFIRMED') continue;
    const id = `registry_${formatLocalDateTime(row.start)}_${formatLocalDateTime(row.end)}`;
    if (!out.has(id)) out.set(id, makeOutage({ id, kind: 'REPAIR', start: row.start, end: row.end, label: LABEL_REPAIR }));
  }
  return [...out.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

export function registryMatch(places: readonly Place[], settlement: string, street: string, house: string): RegistryMatch {
  const sk = settlementKey(settlement);
  const stk = streetKey(street);
  let streetSeen = false;
  for (const p of places) {
    if (settlementKey(p.settlement) !== sk) continue;
    for (const s of p.streets) {
      if (streetKey(s.street) !== stk) continue;
      if (s.houses.length > 0 && HouseKey.listContains(s.houses.join(', '), house)) return 'CONFIRMED';
      streetSeen = true;
    }
  }
  return streetSeen ? 'STREET' : 'NONE';
}

// ---------------------------------------------------------------------------------------------
// Nearby outages card (section 8.10)
// ---------------------------------------------------------------------------------------------

export type NearbyStatus = 'ACTIVE' | 'UPCOMING' | 'FINISHED';
const NEARBY_ORDER: Record<NearbyStatus, number> = { ACTIVE: 0, UPCOMING: 1, FINISHED: 2 };

export interface NearbyStreet {
  name: string;
  houses: string[];
  mine: boolean;
}

export interface NearbyOutage {
  id: string;
  kind: 'EMERGENCY' | 'REPAIR';
  start: LocalDateTime;
  end: LocalDateTime | null;
  reason: string;
  status: NearbyStatus;
  streets: NearbyStreet[];
  match: RegistryMatch;
}

/**
 * The registry rows of the address's settlement for the card «Ремонти й пошкодження поруч»
 * (display only: alerts and the timer come from the per-house status). Mirrors PoeMapper.nearbyOutages.
 */
export function nearbyOutages(
  rows: readonly RegistryRow[],
  settlement: string,
  street: string,
  house: string,
  now: LocalDateTime
): NearbyOutage[] {
  const sk = settlementKey(settlement);
  const userStreet = street.trim() === '' ? null : streetKey(street);
  const out: NearbyOutage[] = [];
  for (const row of rows) {
    if (row.kind === 'MIRROR') continue;
    const groups = row.places.filter((p) => settlementKey(p.settlement) === sk);
    if (groups.length === 0) continue;
    const merged = new Map<string, { name: string; houses: Map<string, string>; whole: boolean }>();
    for (const g of groups) {
      for (const s of g.streets) {
        const key = streetKey(s.street);
        const prev = merged.get(key) ?? { name: s.street.replace(SPACES, ' ').trim(), houses: new Map<string, string>(), whole: false };
        for (const h of s.houses) {
          const t = h.trim();
          const hk = HouseKey.of(t);
          if (t !== '' && !prev.houses.has(hk)) prev.houses.set(hk, t);
        }
        if (s.houses.length === 0) prev.whole = true;
        merged.set(key, prev);
      }
    }
    const streets: NearbyStreet[] = [...merged.entries()].map(([key, v]) => ({
      name: v.name,
      houses: v.whole ? [] : [...v.houses.values()],
      mine: userStreet !== null && key === userStreet,
    }));
    // only outages on the user's own street (owner, 2026-11-16)
    if (!streets.some((st) => st.mine)) continue;
    const status: NearbyStatus = now < row.start ? 'UPCOMING' : row.end !== null && now >= row.end ? 'FINISHED' : 'ACTIVE';
    const match: RegistryMatch = street.trim() !== '' && house.trim() !== '' ? registryMatch(row.places, settlement, street, house) : 'NONE';
    const item: NearbyOutage = { id: row.id, kind: row.kind, start: row.start, end: row.end, reason: row.reason, status, streets, match };
    const same = (a: NearbyOutage) =>
      a.id === item.id && a.kind === item.kind && a.end === item.end && JSON.stringify(a.streets) === JSON.stringify(item.streets);
    if (!out.some(same)) out.push(item);
  }
  return out.sort((a, b) => NEARBY_ORDER[a.status] - NEARBY_ORDER[b.status] || a.start - b.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const PoeMapper = {
  parseTime,
  parseEta,
  parsePlannedList,
  parseQueue,
  addressStatus,
  classifyRegistryReason,
  parseRegistryRow,
  parsePlaces,
  settlementKey,
  streetKey,
  registryMatch,
  registryRepairs,
  nearbyOutages,
} as const;
