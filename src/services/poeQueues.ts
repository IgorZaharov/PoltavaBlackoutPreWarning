/**
 * The queue catalogue (poe_queues.json, spec/POE_API.md 8.11), mirrored from
 * android/.../data/poe/PoeQueues.kt: the bundled copy (public/poe_queues.json), replaced by the copy this
 * repository's CI keeps current (.github/workflows/poe-data.yml, job `queues`) when that one is newer, at
 * most once a week. Used when the per-house status says "several connections" and gives no queue, and for
 * the company search.
 */
import { QueueCatalogue, type CatalogueEntry, type QueueHint } from '../core/queueCatalogue';
import type { SelectedAddressQuery } from '../types';
import { findSettlementById, findStreetById } from './poeAddressLookup';

export const CATALOGUE_URL = 'https://raw.githubusercontent.com/IgorZaharov/PoltavaBlackoutPreWarning/main/poe_queues.json';
const CHECK_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
const CHECKED_KEY = 'poe_queues_checked_ms';

/** A company named in POE's hourly-schedule PDF (search by workplace): its queue and branch. */
export interface PoeCompany {
  name: string;
  queue: string;
  branch: string | null;
  row: number;
  settlement: string | null;
  /** The raw text of its row, so the company search also finds the words around a name. */
  rowText: string;
  /** Words people search for that the PDF does not use ("ЗОШ" for «Школа № 27»). */
  aliases: string;
}

export interface Catalogue {
  builtAt: string;
  sha256: string | null;
  entries: CatalogueEntry[];
  companies: PoeCompany[];
}

/** One company (name and town) with all its queues, for the picker. */
export interface CompanyChoice {
  /** name|town: unique in the list. */
  id: string;
  name: string;
  /** What the new entry is called: the name, with the town for a school or kindergarten («Школа № 27, Кременчук»). */
  label: string;
  town: string | null;
  queues: string[];
  /** Name and the words people search for that the PDF does not use: what the picker search matches first. */
  search: string;
  /** The texts of its PDF rows, searched after every name ("М'ясокомбінат" finds ТОВ «Ясні Зорі-Полтавщина»). */
  context: string;
}

export type CatalogueUpdate = 'UPDATED' | 'UP_TO_DATE' | 'FAILED';

let catalogue: Catalogue | null = null;
let loading: Promise<Catalogue | null> | null = null;
let checkedMs = 0;

type Json = Record<string, unknown>;
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function parseCatalogue(text: string): Catalogue | null {
  try {
    const root = JSON.parse(text) as Json;
    const entries: CatalogueEntry[] = (root.entries as Json[]).map((o) => ({
      queue: String(o.q),
      branch: strOrNull(o.branch),
      row: Number(o.row),
      settlement: strOrNull(o.settlement),
      street: strOrNull(o.street),
      houses: (o.houses as unknown[]).map(String),
      ranges: (o.ranges as unknown[][]).map((r) => [Number(r[0]), Number(r[1])] as const),
      whole: strOrNull(o.whole),
    }));
    const rowTexts = new Map<string, string>();
    for (const r of (root.rows as Json[] | undefined) ?? []) rowTexts.set(`${r.q}|${r.branch ?? ''}|${r.n}`, String(r.text ?? ''));
    const companies: PoeCompany[] = ((root.companies as Json[] | undefined) ?? []).map((o) => ({
      name: String(o.name),
      queue: String(o.q),
      branch: strOrNull(o.branch),
      row: Number(o.row),
      settlement: strOrNull(o.settlement),
      rowText: rowTexts.get(`${o.q}|${o.branch ?? ''}|${o.row}`) ?? '',
      aliases: typeof o.aliases === 'string' ? o.aliases : '',
    }));
    const sha = strOrNull((root.source as Json | undefined)?.sha256);
    return entries.length === 0 ? null : { builtAt: String(root.builtAt ?? ''), sha256: sha, entries, companies };
  } catch {
    return null;
  }
}

/** Tests set the catalogue directly; null clears it. */
export function usePoeQueues(value: Catalogue | null): void {
  catalogue = value;
}

export function currentCatalogue(): Catalogue | null {
  return catalogue;
}

/** Loads public/poe_queues.json once in the browser; resolves to null when it can not be loaded. */
export function ensurePoeQueues(): Promise<Catalogue | null> {
  if (catalogue !== null) return Promise.resolve(catalogue);
  if (loading !== null) return loading;
  if (typeof fetch !== 'function' || typeof window === 'undefined') return Promise.resolve(null);
  loading = fetch('/poe_queues.json')
    .then((r) => (r.ok ? r.text() : ''))
    .then((text) => {
      const parsed = parseCatalogue(text);
      if (parsed !== null && catalogue === null) catalogue = parsed;
      return catalogue;
    })
    .catch(() => null)
    .finally(() => {
      loading = null;
    });
  return loading;
}

/** The catalogue's queues for one address, best first (QueueCatalogue.lookup). Empty when not loaded or not listed. */
export function queuesFor(query: SelectedAddressQuery): QueueHint[] {
  if (catalogue === null) return [];
  const settlement = findSettlementById(query.settlementId);
  if (!settlement) return [];
  const street = findStreetById(query.streetId)?.nameUk ?? '';
  const branches = settlement.branchIds.length > 0 ? settlement.branchIds : [query.remId];
  return QueueCatalogue.lookup(catalogue.entries, settlement.nameUk, branches, street, query.house);
}

/**
 * Companies grouped by name and town with their queues, sorted by name (mirrors the Android picker): «Школа № 27»
 * of Кременчук and of Полтава are two entries.
 */
export function companyChoices(): CompanyChoice[] {
  const groups = new Map<string, PoeCompany[]>();
  for (const c of catalogue?.companies ?? []) {
    const id = `${c.name}|${c.settlement ?? ''}`;
    const g = groups.get(id);
    if (g) g.push(c);
    else groups.set(id, [c]);
  }
  return [...groups.entries()]
    .map(([id, rows]) => ({
      id,
      name: rows[0].name,
      label: rows[0].settlement !== null && rows.some((r) => r.aliases !== '') ? `${rows[0].name}, ${rows[0].settlement}` : rows[0].name,
      town: rows[0].settlement,
      queues: [...new Set(rows.map((r) => r.queue))].sort(),
      search: [rows[0].name, ...new Set(rows.map((r) => r.aliases).filter((t) => t !== ''))].join(' '),
      context: [...new Set(rows.map((r) => r.rowText).filter((t) => t !== ''))].join('; '),
    }))
    .sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
}

const browserStorage = (): Storage | undefined => (typeof window !== 'undefined' ? window.localStorage : undefined);

function readChecked(): number {
  try {
    const v = Number(browserStorage()?.getItem(CHECKED_KEY) ?? '0');
    return Number.isFinite(v) ? Math.max(v, checkedMs) : checkedMs;
  } catch {
    return checkedMs;
  }
}

function writeChecked(ms: number): void {
  checkedMs = ms;
  try {
    browserStorage()?.setItem(CHECKED_KEY, String(ms));
  } catch {
    // private window: the in-memory time stamp is enough for this tab
  }
}

/**
 * Downloads the CI copy when [force] or a week has passed since the last check (a day after a failed one); only a
 * newer `builtAt` replaces the one in use. Unlike Android the browser keeps no downloaded copy across reloads
 * (2 MB is too much for localStorage): a reload starts again from public/poe_queues.json.
 */
export async function refreshQueuesIfDue(
  force = false,
  nowMs: number = Date.now(),
  fetchText: (url: string) => Promise<string | null> = defaultFetchText
): Promise<CatalogueUpdate> {
  const last = readChecked();
  if (!force && nowMs - last >= 0 && nowMs - last < CHECK_EVERY_MS) return 'UP_TO_DATE';
  // a failed check is tried again after a day, a successful one after a week
  writeChecked(nowMs - CHECK_EVERY_MS + RETRY_AFTER_MS);
  await ensurePoeQueues();
  const text = await fetchText(CATALOGUE_URL).catch(() => null);
  const fetched = text ? parseCatalogue(text) : null;
  if (fetched === null) return 'FAILED';
  writeChecked(nowMs);
  const current = catalogue;
  if (current !== null && (fetched.builtAt <= current.builtAt || (fetched.sha256 !== null && fetched.sha256 === current.sha256))) {
    return 'UP_TO_DATE';
  }
  catalogue = fetched;
  return 'UPDATED';
}

async function defaultFetchText(url: string): Promise<string | null> {
  if (typeof fetch !== 'function') return null;
  const r = await fetch(url, { cache: 'no-cache' });
  return r.ok ? r.text() : null;
}
