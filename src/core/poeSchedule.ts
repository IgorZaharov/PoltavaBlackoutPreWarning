/**
 * Parses the POE schedule page fragment (`newgpv-info.php`, spec/POE_API.md section 3) into 12 queues
 * of 48 cells, mirrored 1:1 from android/.../core/PoeSchedule.kt. Pure text scanning, no DOM.
 * Golden cases: spec/vectors/poe_schedule.json. Regexes spell out Java's ASCII-only \s.
 */
import { localDateOf, type LocalDate } from './localTime';
import { OutageConfig, type ScheduleCell } from './outageModels';

export const POE_QUEUES = ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2'] as const;

export type DayTableKind = 'PUBLISHED' | 'NOT_PUBLISHED' | 'INVALID';

export interface DayTable {
  readonly kind: DayTableKind;
  /** Queue -> 48 cells; empty unless kind is PUBLISHED. */
  readonly queues: Readonly<Record<string, readonly ScheduleCell[]>>;
  /** `Оновлено: 15 листопада 2026 22:46` -> `15 листопада 2026 22:46`. */
  readonly stamp: string | null;
  /** Why the answer is INVALID: error_body, no_date, date_mismatch, no_table, bad_row, missing_queue. */
  readonly reason: string | null;
}

const MONTHS = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня', 'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];
const S = '[ \\t\\n\\x0B\\f\\r]';
const HEADER_DATE = new RegExp(`(\\d{1,2})${S}+(${MONTHS.join('|')})${S}+(\\d{4})`);
const ROW = new RegExp(`<td${S}+class="gpv-q"[^>]*>${S}*([0-9.]+)${S}*</td>([\\s\\S]*?)</tr>`, 'g');
const CELL = new RegExp(`<td${S}+class="([^"]*)"`, 'g');
const STAMP = new RegExp(`Оновлено:${S}*([^<]+)`);
const TABLE_MARK = 'class="gpv-table"';
const NO_OUTAGES_MARK = 'не застосов';

const table = (kind: DayTableKind, queues: Record<string, ScheduleCell[]> = {}, stamp: string | null = null, reason: string | null = null): DayTable => ({
  kind,
  queues,
  stamp,
  reason,
});
const invalid = (reason: string): DayTable => table('INVALID', {}, null, reason);

function cellOf(classes: string): ScheduleCell | null {
  const tokens = classes.split(' ').filter((t) => t.length > 0);
  if (!tokens.includes('gpv-c')) return null;
  if (tokens.includes('gpv-s2')) return 'OFF';
  if (tokens.includes('gpv-s3')) return 'SWITCHING';
  if (tokens.includes('gpv-s1')) return 'ON';
  return null;
}

/** Parses the answer for `date`. An empty body is "not published yet"; it is never "no outages". */
export function parseDay(html: string | null | undefined, date: LocalDate): DayTable {
  const body = (html ?? '').trim();
  if (body.length === 0) return table('NOT_PUBLISHED');
  if (body.startsWith('{') || body.startsWith('[')) return invalid('error_body');

  const tableAt = body.indexOf(TABLE_MARK);
  const head = tableAt >= 0 ? body.substring(0, tableAt) : body;
  const dm = HEADER_DATE.exec(head);
  if (!dm) return invalid('no_date');
  const headerDate = localDateOf(+dm[3], MONTHS.indexOf(dm[2]) + 1, +dm[1]);
  if (headerDate === null) return invalid('no_date');
  if (headerDate !== date) return invalid('date_mismatch');
  const sm = STAMP.exec(body);
  const stamp = sm && sm[1].trim().length > 0 ? sm[1].trim() : null;

  if (tableAt < 0) {
    if (!head.includes(NO_OUTAGES_MARK)) return invalid('no_table');
    const all: Record<string, ScheduleCell[]> = {};
    for (const q of POE_QUEUES) all[q] = new Array<ScheduleCell>(OutageConfig.SLOTS_PER_DAY).fill('ON');
    return table('PUBLISHED', all, stamp);
  }

  const endAt = body.indexOf('</table>', tableAt);
  const tbl = body.substring(tableAt, endAt < 0 ? body.length : endAt);
  const queues: Record<string, ScheduleCell[]> = {};
  for (const row of tbl.matchAll(ROW)) {
    const queue = row[1];
    if (!(POE_QUEUES as readonly string[]).includes(queue) || queue in queues) return invalid('bad_row');
    const cells: ScheduleCell[] = [];
    for (const c of row[2].matchAll(CELL)) {
      const cell = cellOf(c[1]);
      if (cell === null) return invalid('bad_row');
      cells.push(cell);
    }
    if (cells.length !== OutageConfig.SLOTS_PER_DAY) return invalid('bad_row');
    queues[queue] = cells;
  }
  if (Object.keys(queues).length !== POE_QUEUES.length) return invalid('missing_queue');
  const ordered: Record<string, ScheduleCell[]> = {};
  for (const q of POE_QUEUES) ordered[q] = queues[q];
  return table('PUBLISHED', ordered, stamp);
}

export const PoeSchedule = { QUEUES: POE_QUEUES, parseDay } as const;
