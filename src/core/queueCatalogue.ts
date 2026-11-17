/**
 * Address -> queue from the POE hourly-schedule catalogue (poe_queues.json), mirrored from
 * android/.../core/QueueCatalogue.kt. Rules: spec/POE_API.md 8.11, golden cases:
 * spec/vectors/queue_catalogue.json. Pure: the entries are parsed by the data layer. A hint never
 * overrides the per-house status (E4); it fills in the queue when E4 says "several connections".
 */
import { HouseKey, StreetKey } from './addressKeys';
import { PoeMapper } from './poeMapper';

export type CatalogueKind = 'HOUSE' | 'RANGE' | 'STREET' | 'SETTLEMENT';
const KIND_ORDER: Record<CatalogueKind, number> = { HOUSE: 0, RANGE: 1, STREET: 2, SETTLEMENT: 3 };

export interface CatalogueEntry {
  queue: string;
  branch: string | null;
  row: number;
  settlement: string | null;
  /** Null = the whole settlement. */
  street: string | null;
  houses: readonly string[];
  ranges: readonly (readonly [number, number])[];
  /** "street" when the row lists the street without houses; "settlement" for a whole settlement. */
  whole: string | null;
}

export interface QueueHint {
  queue: string;
  kind: CatalogueKind;
  branch: string | null;
  row: number;
  exact: boolean;
}

const TYPE_PREFIX = /^\s*([\p{L}-]+)\.?\s*(.*)$/u;

/** The street name without a leading type word ("вул. Європейська", "вул.Європейська" -> "Європейська"). */
export function withoutType(name: string): string {
  const m = TYPE_PREFIX.exec(name);
  if (!m) return name.trim();
  return m[2].trim() !== '' && StreetKey.isTypeWord(m[1]) ? m[2].trim() : name.trim();
}

/** `full` key and its last word (after the last space or dot), see 8.11 step 2. */
export function streetKeys(name: string): [string, string] {
  const full = PoeMapper.streetKey(withoutType(name));
  const last = full.substring(Math.max(full.lastIndexOf(' '), full.lastIndexOf('.')) + 1);
  return [full, last];
}

export function lookup(
  entries: readonly CatalogueEntry[],
  settlement: string,
  branches: readonly string[],
  street: string,
  house: string
): QueueHint[] {
  const sk = PoeMapper.settlementKey(settlement);
  const [full, last] = street.trim() === '' ? ['', ''] : streetKeys(street);
  const hk = house.trim() === '' ? '' : HouseKey.of(house);
  const num = /^\d+$/.test(hk) ? Number(hk) : null;
  const hits: QueueHint[] = [];
  for (const e of entries) {
    if (e.settlement === null || PoeMapper.settlementKey(e.settlement) !== sk) continue;
    if (branches.length > 0 && (e.branch === null || !branches.includes(e.branch))) continue;
    if (e.street === null) {
      hits.push({ queue: e.queue, kind: 'SETTLEMENT', branch: e.branch, row: e.row, exact: true });
      continue;
    }
    if (full === '') continue;
    const [eFull, eLast] = streetKeys(e.street);
    const exact = eFull === full;
    if (!exact && eLast !== last) continue;
    let kind: CatalogueKind | null = null;
    // a street without a house number (POE lists no houses) matches the whole street only
    if (hk === '') kind = e.whole === 'street' ? 'STREET' : null;
    else if (e.houses.some((h) => HouseKey.of(h) === hk)) kind = 'HOUSE';
    else if (num !== null && e.ranges.some(([a, b]) => num >= a && num <= b)) kind = 'RANGE';
    else if (e.whole === 'street') kind = 'STREET';
    if (kind === null) continue;
    hits.push({ queue: e.queue, kind, branch: e.branch, row: e.row, exact });
  }
  hits.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      (a.exact ? 0 : 1) - (b.exact ? 0 : 1) ||
      (a.queue < b.queue ? -1 : a.queue > b.queue ? 1 : 0) ||
      a.row - b.row
  );
  const seen = new Set<string>();
  return hits.filter((h) => (seen.has(h.queue) ? false : (seen.add(h.queue), true)));
}

/**
 * The queue a refresh may fill in without asking (spec/POE_API.md 8.11 step 5): the best hint, when no other
 * queue has a hint of the same kind and exactness. Null when there is none or it is a tie.
 */
export function confident(hints: readonly QueueHint[]): string | null {
  const best = hints[0];
  if (!best) return null;
  return hints.slice(1).some((h) => h.kind === best.kind && h.exact === best.exact) ? null : best.queue;
}

export const QueueCatalogue = { lookup, streetKeys, withoutType, confident } as const;
