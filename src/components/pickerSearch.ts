/**
 * Pure matching used by the searchable address picker, ported 1:1 from
 * android/.../ui/components/PickerSearch.kt (cases in tests/picker-search.test.ts mirror PickerSearchTest.kt).
 *
 * Matching is case-, apostrophe-, diacritic- and prefix-insensitive:
 *  - apostrophes of every kind are dropped on both sides (via StreetKey);
 *  - quotes of every kind ("", «», „“) and "№" count as spaces, so `ТОВ "Літіз` finds «ТОВ «Літіз»» and
 *    `Школа 27` finds «Школа № 27»;
 *  - Latin and Cyrillic look-alike letters share one skeleton letter, so a Latin "16a" finds the Cyrillic "16А";
 *  - combining marks are stripped, so "ї" matches "і" and "й" matches "и";
 *  - a leading type word ("вул.", "пров.", "м.", "с.", "смт") is optional on both sides.
 *
 * Results are ranked: prefix first, then a match at the start of any word, then a plain substring. Inside
 * one rank the original order of the list is kept; houses put shorter keys first. An item may carry a
 * context text (a company's PDF row): it is searched only after every label match, and such a hit names
 * the piece of the context that matched (contextSnippet), so a row never shows without the typed words. A
 * context hit whose piece is just the name of an item already found by its label is left out (the other
 * companies of the row of «кафе "Аква"» add nothing to a search for «кафе»).
 */
import { HouseKey, StreetKey, TextNorm } from '../core/addressKeys';

export const NO_MATCH = -1;
export const PREFIX = 0;
export const WORD_PREFIX = 1;
export const CONTAINS = 2;

export type SearchKind = 'TEXT' | 'HOUSE';

/** Normalized form of one label or query: `full` with the type word, `core` without it. */
export interface SearchKey {
  readonly full: string;
  readonly core: string;
  readonly kind: SearchKind;
}

const MARKS = /\p{Mn}+/gu;
const SEPARATORS = /[-/,()"]/g;
const QUOTES = /["«»„“”‟‹›№]/g;

/** Type words that may open a street or settlement name, folded exactly like the labels are. */
const PREFIX_WORDS = [
  'вул', 'вулиця', 'пров', 'провулок', 'просп', 'проспект', 'пр-т', 'пр-к', 'б-р', 'бульвар', 'бульв', 'бул',
  'пл', 'площа', 'пр-д', 'проїзд', 'узв', 'узвіз', 'туп', 'тупик', 'наб', 'набережна', 'шосе', 'майдан', 'м-н',
  'м', 'с', 'смт', 'сел', 'селище', 'місто', 'село', 'район', 'р-н',
];

const fold = (raw: string): string => raw.normalize('NFD').replace(MARKS, '');
const foldWord = (word: string): string => TextNorm.skeleton(fold(word).toLowerCase());
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let leadingType: RegExp | null = null;
function leadingTypeRegex(): RegExp {
  if (leadingType === null) {
    const alternatives = Array.from(new Set(PREFIX_WORDS.map(foldWord)))
      .sort((a, b) => b.length - a.length)
      .map(escapeRegex)
      .join('|');
    leadingType = new RegExp(`^(?:${alternatives})(?:\\.\\s*|\\s+)`, 'u');
  }
  return leadingType;
}

export function keyOf(raw: string, kind: SearchKind = 'TEXT'): SearchKey {
  if (kind === 'HOUSE') {
    const k = HouseKey.of(fold(raw));
    return { full: k, core: k, kind };
  }
  const full = StreetKey.of(fold(raw).replace(QUOTES, ' ').replace(/\s+/g, ' ').trim());
  let core = full;
  // two passes so "м. вул. X" style double prefixes lose both words; never strip down to nothing
  for (let pass = 0; pass < 2; pass++) {
    const stripped = core.replace(leadingTypeRegex(), '');
    if (stripped.length > 0 && stripped !== core) core = stripped;
  }
  return { full, core, kind };
}

const isEmpty = (k: SearchKey): boolean => k.full.length === 0;
const wordForm = (core: string): string => ' ' + core.replace(SEPARATORS, ' ');

/** Rank of `candidate` for `query`. An empty query matches everything as PREFIX. */
export function rankKeys(query: SearchKey, candidate: SearchKey): number {
  if (isEmpty(query)) return PREFIX;
  if (isEmpty(candidate)) return NO_MATCH;
  if (candidate.full.startsWith(query.full)) return PREFIX;
  if (candidate.core.startsWith(query.core)) {
    // "вул ш" ranks "вул. Шевченка" above "пров. Шевченка"; plain "ш" treats the type word as absent
    return query.core === query.full || query.kind === 'HOUSE' ? PREFIX : WORD_PREFIX;
  }
  if (query.kind === 'TEXT' && wordForm(candidate.core).includes(wordForm(query.core))) return WORD_PREFIX;
  if (candidate.core.includes(query.core) || candidate.full.includes(query.full)) return CONTAINS;
  return NO_MATCH;
}

export function rank(query: string, label: string, kind: SearchKind = 'TEXT'): number {
  return rankKeys(keyOf(query, kind), keyOf(label, kind));
}

/** Separators of the pieces a context text is cut into for a snippet: rows first, then list items. */
const CONTEXT_PIECES = /[;\n]/;
const SNIPPET_MAX = 70;

const tidy = (s: string): string => s.replace(/\s+/g, ' ').trim();
const clip = (s: string): string => (s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX - 1).trimEnd() + '…' : s);

/**
 * Cuts at the commas outside quotes, so «Кафе "Ні пуху, ні пера"» stays one item. The PDF leaves quotes
 * unbalanced («ТОВ «Татнєфть-АЗС Україна, ПП «Лякун»», ТОВ "Агрофірма "Маяк"-), so there is no nesting: an
 * opening quote (or a straight one after a space) opens, a closing one (or a straight one after a letter) closes.
 */
function splitItems(piece: string): string[] {
  const out: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < piece.length; i++) {
    const ch = piece[i];
    if (ch === '«' || ch === '„' || ch === '“') quoted = true;
    else if (ch === '»' || ch === '”') quoted = false;
    else if (ch === '"') quoted = i === 0 || /[\s(]/.test(piece[i - 1]);
    else if (ch === ',' && !quoted) {
      out.push(piece.slice(start, i));
      start = i + 1;
    }
  }
  out.push(piece.slice(start));
  return out;
}

/**
 * The first piece of `context` (cut at ";", a long piece again at ",") that matches `query`, to show why an
 * item was found by its context; the clipped start of the context when the match spans pieces.
 */
export function contextSnippet(context: string, query: string): string {
  const q = keyOf(query);
  const pieces = context.split(CONTEXT_PIECES).map(tidy).filter((p) => p !== '');
  for (const piece of pieces) {
    if (rankKeys(q, keyOf(piece)) === NO_MATCH) continue;
    if (piece.length <= SNIPPET_MAX) return piece;
    const item = splitItems(piece).map(tidy).find((p) => p !== '' && rankKeys(q, keyOf(p)) !== NO_MATCH);
    return clip(item ?? piece);
  }
  return clip(tidy(context));
}

/** One search result: the item and, when only its context matched, the piece of the context that did. */
export interface PickerHit<T> {
  readonly item: T;
  readonly snippet: string | null;
}

/** Keys are computed once per list (966 streets), then every keystroke only compares strings. */
export class PickerIndex<T> {
  private readonly keys: SearchKey[];
  private readonly contexts: (string | null)[];
  private readonly contextKeys: (SearchKey | null)[];

  constructor(
    private readonly items: readonly T[],
    private readonly kind: SearchKind,
    label: (item: T) => string,
    context?: (item: T) => string | null | undefined
  ) {
    this.keys = items.map((it) => keyOf(label(it), kind));
    this.contexts = items.map((it) => context?.(it) || null);
    this.contextKeys = this.contexts.map((c) => (c === null ? null : keyOf(c, kind)));
  }

  search(query: string): T[] {
    return this.searchHits(query).map((h) => h.item);
  }

  /** Label matches by rank, then the items found only by their context, each with its snippet. */
  searchHits(query: string): PickerHit<T>[] {
    const q = keyOf(query, this.kind);
    if (isEmpty(q)) return this.items.map((item) => ({ item, snippet: null }));
    const hits: { index: number; rank: number; length: number; inContext: boolean }[] = [];
    for (let i = 0; i < this.items.length; i++) {
      const r = rankKeys(q, this.keys[i]);
      if (r !== NO_MATCH) {
        hits.push({ index: i, rank: r, length: this.keys[i].core.length, inContext: false });
        continue;
      }
      const ck = this.contextKeys[i];
      const c = ck === null ? NO_MATCH : rankKeys(q, ck);
      if (c !== NO_MATCH) hits.push({ index: i, rank: CONTAINS + 1 + c, length: this.keys[i].core.length, inContext: true });
    }
    hits.sort(
      this.kind === 'HOUSE'
        ? (a, b) => a.rank - b.rank || a.length - b.length || a.index - b.index
        : (a, b) => a.rank - b.rank || a.index - b.index
    );
    const found = hits.filter((h) => !h.inContext).map((h) => this.keys[h.index].full);
    const out: PickerHit<T>[] = [];
    for (const h of hits) {
      if (!h.inContext) {
        out.push({ item: this.items[h.index], snippet: null });
        continue;
      }
      const snippet = contextSnippet(this.contexts[h.index] ?? '', query);
      const k = keyOf(snippet, this.kind).full;
      if (found.some((f) => f === k || f.startsWith(k + ' '))) continue;
      out.push({ item: this.items[h.index], snippet });
    }
    return out;
  }
}

export function filterItems<T>(items: readonly T[], query: string, kind: SearchKind, label: (item: T) => string): T[] {
  return new PickerIndex(items, kind, label).search(query);
}
