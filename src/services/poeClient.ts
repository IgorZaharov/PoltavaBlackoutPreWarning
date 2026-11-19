/**
 * The Полтаваобленерго endpoints (spec/POE_API.md section 2), mirrored 1:1 from
 * android/.../data/poe/PoeClient.kt. Every call returns exactly one of a confirmed answer or
 * `Unavailable`; a failure is never turned into "no outage" (section 9). Network goes through a
 * `PoeTransport`; parsing is the pure core (poeSchedule.ts, poeMapper.ts).
 */
import { atStartOfDay, formatLocalDate, plusDays, type LocalDate } from '../core/localTime';
import { EmergencyFetch } from '../core/emergencyLedger';
import { PoeSchedule, type DayTable } from '../core/poeSchedule';
import { PoeMapper, type AddressStatus, type RegistryRow } from '../core/poeMapper';

/** Constants of spec/config.json (`poe`). */
export const PoeConfig = {
  BASE_URL: 'https://www.poe.pl.ua/customs/',
  /** Vite dev server proxy (vite.config.ts): POE sends no CORS headers for other origins. */
  DEV_PROXY_BASE: '/proxy-poe/customs/',
  SCHEDULE: 'newgpv-info.php',
  MEASURES: 'unloading-info.php',
  DIRECTORY: 'search-disconnection-cabinet.php',
  ADDRESS_STATUS: 'disconnectinforesult-cabinet.php',
  REGISTRY: 'disconnection-gavapi.php',
  CONNECT_TIMEOUT_MS: 8000,
  READ_TIMEOUT_MS: 8000,
  REGISTRY_READ_TIMEOUT_MS: 15000,
  ADDRESS_STATUS_TTL_MS: 60000,
} as const;

export type PoeHttpResult = { kind: 'ok'; body: string } | { kind: 'failed'; reason: string };

/** One POE request: POST <base><endpoint> with one form field whose value is a JSON string. */
export type PoeTransport = (endpoint: string, field: string, json: string, readTimeoutMs: number) => Promise<PoeHttpResult>;

/** PoeTransport over fetch(); never throws. */
export function fetchPoeTransport(baseUrl: string = PoeConfig.BASE_URL): PoeTransport {
  return async (endpoint, field, json, readTimeoutMs) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PoeConfig.CONNECT_TIMEOUT_MS + readTimeoutMs);
    try {
      const res = await fetch(baseUrl + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: new URLSearchParams({ [field]: json }).toString(),
        signal: ctrl.signal,
      });
      if (!res.ok) return { kind: 'failed', reason: `http_${res.status}` };
      return { kind: 'ok', body: await res.text() };
    } catch {
      return { kind: 'failed', reason: 'network' };
    } finally {
      clearTimeout(timer);
    }
  };
}

export type ScheduleFetch = { kind: 'ok'; table: DayTable } | { kind: 'unavailable'; reason: string };

export interface DirectoryOption {
  readonly id: number;
  readonly name: string;
}
export type DirectoryFetch = { kind: 'ok'; options: DirectoryOption[] } | { kind: 'unavailable'; reason: string };

export type AddressStatusFetch =
  | { kind: 'confirmed'; status: AddressStatus; gavMessage: string | null }
  | { kind: 'unavailable'; reason: string };

/** `raw` keeps each row's `out_text` so the rows can be stored and parsed again later. */
export type RegistryFetch = { kind: 'confirmed'; rows: RegistryRow[]; raw: string[] } | { kind: 'unavailable'; reason: string };

export interface PoeMeasure {
  readonly type: string;
  readonly beginHour: number;
  readonly beginMinute: number;
  readonly endHour: number;
  readonly endMinute: number;
  readonly reason: string | null;
  readonly note: string | null;
  readonly queueNumber: number | null;
}
export type MeasuresFetch = { kind: 'ok'; measures: PoeMeasure[] } | { kind: 'unavailable'; reason: string };

/** `DD-MM-YYYY` (spec/POE_API.md section 2, trap 1). */
export function formatPoeDate(date: LocalDate): string {
  const [y, m, d] = formatLocalDate(date).split('-');
  return `${d}-${m}-${y}`;
}

/** A JSON array answer, or null when the body is not one (error object, HTML, truncated). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function arrayOf(body: string): any[] | null {
  const t = body.trim();
  if (!t.startsWith('[')) return null;
  try {
    const v = JSON.parse(t);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const trimmedOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : null);
const intOr = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : dflt);

/** `село _` and empty names are rows without a real name (spec/POE_API.md section 4). */
export function isJunkName(name: string): boolean {
  const parts = name.trim().split(/\s+/);
  const rest = (parts.length >= 2 ? name.trim().substring(name.trim().indexOf(parts[1])) : parts[0] ?? '').trim();
  return name.trim().length === 0 || rest.length === 0 || [...rest].every((c) => c === '_' || c === '-');
}

export class PoeClient {
  private readonly statusCache = new Map<string, { at: number; value: Extract<AddressStatusFetch, { kind: 'confirmed' }> }>();

  constructor(
    private readonly transport: PoeTransport = fetchPoeTransport(),
    private readonly nowMs: () => number = () => Date.now()
  ) {}

  private post(endpoint: string, field: string, json: object, readTimeoutMs: number = PoeConfig.READ_TIMEOUT_MS): Promise<PoeHttpResult> {
    return this.transport(endpoint, field, JSON.stringify(json), readTimeoutMs);
  }

  // ---------------------------------------------------------------------------------------------
  // E1 schedule, E2 measures
  // ---------------------------------------------------------------------------------------------

  async schedule(date: LocalDate): Promise<ScheduleFetch> {
    const r = await this.post(PoeConfig.SCHEDULE, 'seldate', { date_in: formatPoeDate(date) });
    if (r.kind === 'failed') return { kind: 'unavailable', reason: r.reason };
    const table = PoeSchedule.parseDay(r.body, date);
    return table.kind === 'INVALID' ? { kind: 'unavailable', reason: table.reason ?? 'invalid' } : { kind: 'ok', table };
  }

  async measures(date: LocalDate): Promise<MeasuresFetch> {
    const r = await this.post(PoeConfig.MEASURES, 'seldate', { date_in: formatPoeDate(date) });
    if (r.kind === 'failed') return { kind: 'unavailable', reason: r.reason };
    const arr = r.body.trim().length === 0 ? [] : arrayOf(r.body);
    if (arr === null) return { kind: 'unavailable', reason: 'not_an_array' };
    const measures: PoeMeasure[] = [];
    for (const o of arr) {
      if (!isObject(o)) continue;
      const type = typeof o.unloadingtypename === 'string' ? o.unloadingtypename.trim() : '';
      if (type.length === 0) continue;
      measures.push({
        type,
        beginHour: intOr(o.beginhour, 0),
        beginMinute: intOr(o.beginminute, 0),
        endHour: intOr(o.endhour, 23),
        endMinute: intOr(o.endminute, 59),
        reason: trimmedOrNull(o.unloadingreasonname),
        note: trimmedOrNull(o.note),
        queueNumber: typeof o.unloading_queue_number === 'number' ? Math.trunc(o.unloading_queue_number) : null,
      });
    }
    return { kind: 'ok', measures };
  }

  // ---------------------------------------------------------------------------------------------
  // E3 address directory
  // ---------------------------------------------------------------------------------------------

  private async directory(op: string, cabinetId: number, cityId: number | null, streetId: number | null): Promise<DirectoryFetch> {
    const r = await this.post(PoeConfig.DIRECTORY, 'disconn', {
      operation_type: op,
      filial_id: String(cabinetId),
      city_id: cityId === null ? '' : String(cityId),
      street_id: streetId === null ? '' : String(streetId),
    });
    if (r.kind === 'failed') return { kind: 'unavailable', reason: r.reason };
    const arr = arrayOf(r.body);
    if (arr === null) return { kind: 'unavailable', reason: 'not_an_array' };
    const options: DirectoryOption[] = [];
    for (const o of arr) {
      if (!isObject(o)) continue;
      const id = typeof o.instance_id === 'number' ? o.instance_id : -1;
      const name = typeof o.instance_name === 'string' ? o.instance_name : '';
      if (id >= 0 && !isJunkName(name)) options.push({ id, name });
    }
    return { kind: 'ok', options };
  }

  cities(cabinetId: number): Promise<DirectoryFetch> {
    return this.directory('city', cabinetId, null, null);
  }

  streets(cabinetId: number, cityId: number): Promise<DirectoryFetch> {
    return this.directory('street', cabinetId, cityId, null);
  }

  buildings(cabinetId: number, cityId: number, streetId: number): Promise<DirectoryFetch> {
    return this.directory('building', cabinetId, cityId, streetId);
  }

  // ---------------------------------------------------------------------------------------------
  // E4 per-house status, E5 branch registry
  // ---------------------------------------------------------------------------------------------

  /** Queue, emergency and repair works of one house; answers are reused for 60 s per house. */
  async addressStatus(cityId: number, streetId: number, house: string, today: LocalDate): Promise<AddressStatusFetch> {
    const key = `${cityId}|${streetId}|${house}|${today}`;
    const cached = this.statusCache.get(key);
    if (cached !== undefined) {
      const age = this.nowMs() - cached.at;
      if (age >= 0 && age < PoeConfig.ADDRESS_STATUS_TTL_MS) return cached.value;
    }
    // `streerid` is POE's own spelling of the key (spec/POE_API.md section 2, trap 2)
    const r = await this.post(PoeConfig.ADDRESS_STATUS, 'disconn', { cityid: String(cityId), streerid: String(streetId), house });
    let result: AddressStatusFetch;
    if (r.kind === 'failed') result = { kind: 'unavailable', reason: r.reason };
    else {
      const first = arrayOf(r.body)?.[0];
      if (!isObject(first)) result = { kind: 'unavailable', reason: 'empty' };
      else {
        const status = PoeMapper.addressStatus(first, today);
        result = status.unparsed
          ? { kind: 'unavailable', reason: 'unparsed' }
          : { kind: 'confirmed', status, gavMessage: trimmedOrNull(first.gav_message) };
      }
    }
    if (result.kind === 'confirmed') this.statusCache.set(key, { at: this.nowMs(), value: result });
    return result;
  }

  async registry(registryId: number, date: LocalDate): Promise<RegistryFetch> {
    const r = await this.post(
      PoeConfig.REGISTRY,
      'disconngav',
      { filialid: String(registryId), date_in: formatPoeDate(date) },
      PoeConfig.REGISTRY_READ_TIMEOUT_MS
    );
    if (r.kind === 'failed') return { kind: 'unavailable', reason: r.reason };
    const arr = arrayOf(r.body);
    if (arr === null) return { kind: 'unavailable', reason: 'not_an_array' };
    const rows: RegistryRow[] = [];
    const raw: string[] = [];
    for (const o of arr) {
      const text = isObject(o) && typeof o.out_text === 'string' && o.out_text.trim() !== '' ? o.out_text : null;
      if (text === null) continue;
      raw.push(text);
      const row = PoeMapper.parseRegistryRow(text);
      if (row !== null) rows.push(row);
    }
    return { kind: 'confirmed', rows, raw };
  }

  /**
   * The emergency input of the ledger from an E4 answer. Records starting on or after the day after
   * tomorrow are dropped before the ledger sees them (spec/POWERON_API.md 5.3 applies to POE the same way).
   */
  static emergencyFetch(fetch: AddressStatusFetch, today: LocalDate): EmergencyFetch {
    if (fetch.kind === 'unavailable') return EmergencyFetch.Unavailable(fetch.reason);
    const horizon = atStartOfDay(plusDays(today, 2));
    const e = fetch.status.emergency;
    return EmergencyFetch.Confirmed(e !== null && e.start < horizon ? [e] : []);
  }
}
