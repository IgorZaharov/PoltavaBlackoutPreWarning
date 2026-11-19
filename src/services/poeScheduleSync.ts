/**
 * Refreshes the POE queue tables, mirrored from android/.../data/poe/PoeScheduleSync.kt: today and
 * tomorrow for all 12 queues in one request each, stored by ScheduleCache as three-state cells. A failure
 * never clears the cached schedule (spec/SITE_STATE.md); tomorrow keeps its cached table when only
 * tomorrow failed. Also holds the small helpers the views need (queue list, default URL, site check).
 */
import validUrlsList from '../../valid-urls.json';
import { atStartOfDay, fromInstant, parseLocalDate, toLocalDate, plusDays, formatLocalDate, type LocalDate, type LocalDateTime } from '../core/localTime';
import { POE_QUEUES } from '../core/poeSchedule';
import type { ScheduleCell } from '../core/outageModels';
import { SiteStateResolver, type SiteState } from '../core/siteState';
import type { DaySchedule, QueueOption } from '../types';
import { ScheduleCache, getScheduleCache } from './scheduleCache';
import { PoeClient, PoeConfig, fetchPoeTransport, type PoeMeasure } from './poeClient';

export const QUEUES: QueueOption[] = POE_QUEUES.map((id) => {
  const [g, s] = id.split('.').map(Number);
  return { id, group: g, subgroup: s, label: `Черга ${id}` };
});

/** The POE page users know; shown in Settings and checked against valid-urls.json. */
export const DEFAULT_POE_URL = 'https://www.poe.pl.ua/disconnection/power-outages/';

export const VALID_URLS: string[] = Array.isArray(validUrlsList) ? validUrlsList : [DEFAULT_POE_URL, 'https://example.com'];

export function isValidPoeUrl(url: string): boolean {
  const trimmed = (url || '').trim().replace(/\/+$/, '');
  if (!trimmed) return false;
  return VALID_URLS.some((valid) => valid.trim().replace(/\/+$/, '').toLowerCase() === trimmed.toLowerCase());
}

export type PoeFetchStatus = 'SUCCESS' | 'NO_INTERNET' | 'NO_QUEUES_FOUND';

export interface ScheduleSyncResult {
  status: PoeFetchStatus;
  siteState: SiteState;
  /** Active measures (ГАВ, СГАВ, ГОП ...) as one notice text, or null. */
  notice: string | null;
  /** E2 answered (so a null `notice` means "no measures today", not "unknown"). */
  measuresKnown?: boolean;
}

export interface ScheduleSyncOptions {
  client?: PoeClient;
  cache?: ScheduleCache;
  /** The real instant in epoch milliseconds (tests pass a fake clock). */
  nowMs?: number;
  /** The platform's verdict on the network (navigator.onLine in the browser). */
  isOnline?: () => boolean;
}

/** `ГАВ 08:54–23:59 (за розпорядженням НЕК «Укренерго»)`, one line per measure. */
export function noticeOf(measures: readonly PoeMeasure[]): string | null {
  if (measures.length === 0) return null;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return measures
    .map((m) => `${m.type} ${p2(m.beginHour)}:${p2(m.beginMinute)}–${p2(m.endHour)}:${p2(m.endMinute)}${m.reason ? ` (${m.reason})` : ''}`)
    .join('\n');
}

const defaultIsOnline = (): boolean => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true);

/** In the browser the dev server proxies POE (no CORS headers); in Node the site is asked directly. */
export function defaultPoeClient(): PoeClient {
  return typeof window !== 'undefined' ? new PoeClient(fetchPoeTransport(PoeConfig.DEV_PROXY_BASE)) : new PoeClient();
}

let sharedClient: PoeClient | null = null;
export function getPoeClient(): PoeClient {
  return (sharedClient ??= defaultPoeClient());
}
/** Tests and the dev server swap the process-wide client here. */
export function setPoeClient(client: PoeClient | null): void {
  sharedClient = client;
}

export async function syncPoeSchedule(options: ScheduleSyncOptions = {}): Promise<ScheduleSyncResult> {
  const client = options.client ?? getPoeClient();
  const cache = options.cache ?? getScheduleCache();
  const nowMs = options.nowMs ?? Date.now();
  const isOnline = options.isOnline ?? defaultIsOnline;
  const today = toLocalDate(fromInstant(nowMs));

  const todayFetch = await client.schedule(today);
  const tomorrowFetch = await client.schedule(plusDays(today, 1));
  const measures = await client.measures(today);
  const notice = measures.kind === 'ok' ? noticeOf(measures.measures) : null;
  const measuresKnown = measures.kind === 'ok';

  if (todayFetch.kind === 'ok') {
    if (todayFetch.table.kind !== 'PUBLISHED') return { status: 'NO_QUEUES_FOUND', siteState: 'AVAILABLE_NO_TABLE', notice, measuresKnown };
    let tomorrow: Record<string, readonly ScheduleCell[]> | null = null;
    if (tomorrowFetch.kind === 'ok') {
      tomorrow = tomorrowFetch.table.kind === 'PUBLISHED' ? tomorrowFetch.table.queues : null;
    } else {
      // only tomorrow failed: keep what is cached for it
      const kept: Record<string, readonly ScheduleCell[]> = {};
      let complete = true;
      for (const q of POE_QUEUES) {
        const cells = cache.tomorrowCells(q, today);
        if (cells === null) complete = false;
        else kept[q] = cells;
      }
      tomorrow = complete ? kept : null;
    }
    cache.saveAllCellsBatch(todayFetch.table.queues, tomorrow, today, nowMs);
    return { status: 'SUCCESS', siteState: 'AVAILABLE_WITH_TABLE', notice, measuresKnown };
  }
  const networkFailure = todayFetch.reason === 'network' || todayFetch.reason.startsWith('http_');
  if (networkFailure) {
    const state = SiteStateResolver.resolve('OTHER', false, isOnline());
    return { status: state === 'NO_INTERNET' ? 'NO_INTERNET' : 'NO_QUEUES_FOUND', siteState: state, notice, measuresKnown };
  }
  // POE answered, but not with a table we can read (error body, other date, changed layout)
  return { status: 'NO_QUEUES_FOUND', siteState: 'AVAILABLE_NO_TABLE', notice, measuresKnown };
}

export interface SiteVerificationResult {
  isChecking: boolean;
  isAvailable: boolean;
  hasData: boolean;
  status: PoeFetchStatus;
  messageUk: string;
  messageEn: string;
  siteState?: SiteState;
}

/**
 * The Settings site check: the URL must be in valid-urls.json, then today's POE table is read. A
 * diagnostic only: it never touches the schedule cache.
 */
export async function verifyPoeSite(url: string, client: PoeClient = getPoeClient(), nowMs: number = Date.now()): Promise<SiteVerificationResult> {
  const noQueues = (siteState: SiteState, isAvailable: boolean): SiteVerificationResult => ({
    isChecking: false,
    isAvailable,
    hasData: false,
    status: 'NO_QUEUES_FOUND',
    messageUk: 'На сайті не знайдено черг',
    messageEn: 'No queues found on site',
    siteState,
  });
  if (!defaultIsOnline()) {
    return {
      isChecking: false,
      isAvailable: false,
      hasData: false,
      status: 'NO_INTERNET',
      messageUk: 'Немає доступу до Інтернету',
      messageEn: 'No Internet access',
      siteState: 'NO_INTERNET',
    };
  }
  if (!isValidPoeUrl(url)) return noQueues('AVAILABLE_NO_TABLE', false);
  if (!url.toLowerCase().includes('poe.pl.ua')) return noQueues('AVAILABLE_NO_TABLE', true);
  const r = await client.schedule(toLocalDate(fromInstant(nowMs)));
  if (r.kind === 'ok' && r.table.kind === 'PUBLISHED') {
    return {
      isChecking: false,
      isAvailable: true,
      hasData: true,
      status: 'SUCCESS',
      messageUk: 'Сайт доступний',
      messageEn: 'Site reachable',
      siteState: 'AVAILABLE_WITH_TABLE',
    };
  }
  if (r.kind === 'unavailable' && (r.reason === 'network' || r.reason.startsWith('http_'))) return noQueues('SITE_UNREACHABLE', false);
  return noQueues('AVAILABLE_NO_TABLE', true);
}

/** Kyiv calendar parts of an instant (formerly in the ztoe parser). */
export function getKyivDateParts(date: Date = new Date()): { year: number; month: number; day: number; dateStr: string } {
  const dateStr = formatLocalDate(toLocalDate(fromInstant(date.getTime())));
  const [year, month, day] = dateStr.split('-').map(Number);
  return { year, month, day, dateStr };
}

function safeLocalDate(dateStr: string | undefined): LocalDate {
  try {
    return parseLocalDate(dateStr || '');
  } catch {
    return parseLocalDate(getKyivDateParts().dateStr);
  }
}

/** The day of a legacy DaySchedule and [now] read as its wall clock (used by the legacy alert checks). */
export function legacyClock(schedule: DaySchedule, now: Date = new Date()): { today: LocalDate; now: LocalDateTime } {
  const today = safeLocalDate(schedule.dateStr);
  return {
    today,
    now: (atStartOfDay(today) + ((now.getHours() * 60 + now.getMinutes()) * 60 + now.getSeconds()) * 1000) as LocalDateTime,
  };
}
