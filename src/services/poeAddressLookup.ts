/**
 * The address picker and the address re-check on Полтаваобленерго data, mirrored from
 * android/.../data/poe/PoeAddressLookup.kt: branches from spec/branches.json, settlements and streets
 * from the bundled snapshot (public/poe_directory.json), houses live from the address search (E3), the
 * queue from the per-house status (E4). Replaces the inherited ztoe lookup.
 */
import branchesJson from '../../spec/branches.json';
import { HouseKey, StreetKey } from '../core/addressKeys';
import { fromInstant, toLocalDate, type LocalDate } from '../core/localTime';
import type { SelectedAddressQuery } from '../types';
import { PoeDirectoryIndex } from './poeDirectory';
import { getPoeClient } from './poeScheduleSync';
import type { PoeClient } from './poeClient';

export const NO_QUEUE_TEXT =
  'Будинок не входить до жодної черги погодинних відключень (ГПВ). Аварійні та планові роботи за адресою відстежуються.';

export interface PoeBranchOption {
  /** Branch slug, stored as `remSlug`. */
  readonly id: string;
  readonly cabinetId: number;
  readonly registryId: number;
  readonly nameUk: string;
  readonly nameEn: string;
}

export interface PoeSettlementOption {
  /** POE city_id as text (ids are global; a settlement may belong to several branches). */
  readonly id: string;
  readonly nameUk: string;
  readonly branchIds: readonly string[];
}

export interface PoeStreetOption {
  readonly id: string;
  readonly settlementId: string;
  readonly nameUk: string;
  /** Every id of the spelling variants merged by StreetKey. */
  readonly allIds: readonly string[];
}

export interface PoeHouseLookupResult {
  house: string;
  /** Empty when unknown or when the house is in no queue. */
  queue: string;
  statusText?: string | null;
  addressLabel: string;
}

interface BranchRow {
  slug: string;
  cabinetId: number;
  registryId: number;
  nameUk: string;
  nameEn: string;
}

const BRANCHES: readonly BranchRow[] = (branchesJson as { branches: BranchRow[] }).branches;

let index: PoeDirectoryIndex | null = null;
let loading: Promise<PoeDirectoryIndex | null> | null = null;
let clientOverride: PoeClient | null = null;
const housesByStreet = new Map<string, PoeHouseLookupResult[]>();
const streetsBySettlement = new Map<string, PoeStreetOption[]>();
const streetById = new Map<string, PoeStreetOption>();

const client = (): PoeClient => clientOverride ?? getPoeClient();

/** Tests (and a later downloaded snapshot) set the index directly; null clears it. */
export function usePoeDirectory(value: PoeDirectoryIndex | null): void {
  index = value;
  housesByStreet.clear();
  streetsBySettlement.clear();
  streetById.clear();
}

export function usePoeLookupClient(value: PoeClient | null): void {
  clientOverride = value;
}

export function poeDirectory(): PoeDirectoryIndex | null {
  return index;
}

/** Loads public/poe_directory.json once in the browser; resolves to null when it can not be loaded. */
export function ensurePoeDirectory(): Promise<PoeDirectoryIndex | null> {
  if (index !== null) return Promise.resolve(index);
  if (loading !== null) return loading;
  if (typeof fetch !== 'function' || typeof window === 'undefined') return Promise.resolve(null);
  loading = fetch('/poe_directory.json')
    .then((r) => (r.ok ? r.text() : ''))
    .then((text) => {
      const parsed = PoeDirectoryIndex.fromJson(text);
      if (parsed !== null && index === null) usePoeDirectory(parsed);
      return index;
    })
    .catch(() => null)
    .finally(() => {
      loading = null;
    });
  return loading;
}

// -------------------------------------------------------------------------------------------------
// Branches, settlements, streets (local)
// -------------------------------------------------------------------------------------------------

export function getRems(): PoeBranchOption[] {
  return BRANCHES.map((b) => ({ id: b.slug, cabinetId: b.cabinetId, registryId: b.registryId, nameUk: b.nameUk, nameEn: b.nameEn }));
}

const branchBySlug = (slug: string | null | undefined): BranchRow | undefined => BRANCHES.find((b) => b.slug === slug);
const branchByCabinetId = (id: number): BranchRow | undefined => BRANCHES.find((b) => b.cabinetId === id);

function settlementOption(s: { id: number; name: string; branchCabinetIds: readonly number[] }): PoeSettlementOption {
  return {
    id: String(s.id),
    nameUk: s.name.trim(),
    branchIds: s.branchCabinetIds.map((id) => branchByCabinetId(id)?.slug).filter((x): x is string => x !== undefined),
  };
}

export function getSettlementsForRem(remId: string): PoeSettlementOption[] {
  const branch = branchBySlug(remId);
  if (!branch || index === null) return [];
  return index.settlementsOf(branch.cabinetId).map(settlementOption);
}

export function findSettlementById(settlementId: string): PoeSettlementOption | undefined {
  const id = Number(settlementId);
  if (!Number.isFinite(id) || index === null) return undefined;
  const s = index.settlement(id);
  return s ? settlementOption(s) : undefined;
}

/** Streets of a settlement with spelling variants merged (spec/ADDRESS_KEY.md), sorted by name. */
export function getStreetsForSettlement(settlementId: string): PoeStreetOption[] {
  const cached = streetsBySettlement.get(settlementId);
  if (cached) return cached;
  const id = Number(settlementId);
  if (!Number.isFinite(id) || index === null) return [];
  const groups = new Map<string, { id: number; name: string }[]>();
  for (const s of index.streetsOf(id)) {
    const key = StreetKey.of(s.name);
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  const merged = [...groups.values()]
    .map((g) => ({ id: String(g[0].id), settlementId, nameUk: g[0].name.trim(), allIds: g.map((s) => String(s.id)) }))
    .sort((a, b) => a.nameUk.toLowerCase().localeCompare(b.nameUk.toLowerCase(), 'uk'));
  streetsBySettlement.set(settlementId, merged);
  for (const o of merged) for (const sid of o.allIds) streetById.set(sid, o);
  return merged;
}

/** The option that holds [streetId] among its merged ids, searched in every settlement of the snapshot. */
export function findStreetById(streetId: string): PoeStreetOption | undefined {
  const cached = streetById.get(streetId);
  if (cached) return cached;
  const id = Number(streetId);
  if (!Number.isFinite(id) || index === null) return undefined;
  const settlement = index.settlements.find((s) => s.streets.some((st) => st.id === id));
  if (!settlement) return undefined;
  return getStreetsForSettlement(String(settlement.id)).find((o) => o.allIds.includes(streetId));
}

// -------------------------------------------------------------------------------------------------
// Houses (live, E3) and the queue of one house (E4)
// -------------------------------------------------------------------------------------------------

const LEADING = /^(\d+)(.*)$/;
/** `2` before `10`, `10` before `10а`, then the rest by text. */
export function compareHouses(a: string, b: string): number {
  const ma = LEADING.exec(a.trim());
  const mb = LEADING.exec(b.trim());
  if (ma && mb) {
    const na = BigInt(ma[1]);
    const nb = BigInt(mb[1]);
    if (na !== nb) return na < nb ? -1 : 1;
    return ma[2].toLowerCase() < mb[2].toLowerCase() ? -1 : ma[2].toLowerCase() > mb[2].toLowerCase() ? 1 : 0;
  }
  if (ma) return -1;
  if (mb) return 1;
  return a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0;
}

export function getHousesForStreet(streetId: string): PoeHouseLookupResult[] {
  return housesByStreet.get(streetId) ?? [];
}

/** Houses of every merged id of the street, from POE; null when POE could not be asked. */
export async function fetchHousesForStreet(remId: string, settlementId: string, streetId: string): Promise<PoeHouseLookupResult[] | null> {
  const street = findStreetById(streetId) ?? { id: streetId, settlementId, nameUk: '', allIds: [streetId] };
  const branch = branchBySlug(remId) ?? branchBySlug(findSettlementById(settlementId)?.branchIds[0]);
  const cityId = Number(settlementId);
  if (!branch || !Number.isFinite(cityId)) return null;
  const names = new Map<string, string>();
  let anyOk = false;
  for (const sid of street.allIds) {
    const n = Number(sid);
    if (!Number.isFinite(n)) continue;
    const r = await client().buildings(branch.cabinetId, cityId, n);
    if (r.kind === 'ok') {
      anyOk = true;
      for (const o of r.options) {
        const key = HouseKey.of(o.name);
        if (!names.has(key)) names.set(key, o.name.trim());
      }
    }
  }
  if (!anyOk) return null;
  const known = new Map(getHousesForStreet(street.id).map((h) => [HouseKey.of(h.house), h]));
  const houses = [...names.values()]
    .sort(compareHouses)
    .map((h) => known.get(HouseKey.of(h)) ?? { house: h, queue: '', statusText: null, addressLabel: '' });
  for (const sid of street.allIds) housesByStreet.set(sid, houses);
  housesByStreet.set(street.id, houses);
  return houses;
}

/** `місто Полтава, вул. Соборності, буд. 1` for the notification and the address line. */
export function addressLabel(query: SelectedAddressQuery): string {
  const settlement = findSettlementById(query.settlementId)?.nameUk ?? '';
  const street = findStreetById(query.streetId)?.nameUk ?? '';
  return [settlement, street, `буд. ${query.house.trim()}`].filter((s) => s.trim() !== '').join(', ');
}

/**
 * Asks POE for the queue of one house (E4). The street's merged ids are tried in turn until POE
 * answers for one. Null when POE could not be asked or did not know the house.
 */
export async function checkAddress(
  query: SelectedAddressQuery,
  today: LocalDate = toLocalDate(fromInstant(Date.now()))
): Promise<PoeHouseLookupResult | null> {
  const cityId = Number(query.settlementId);
  if (!Number.isFinite(cityId) || HouseKey.of(query.house) === '') return null;
  const street = findStreetById(query.streetId);
  const ids = (street?.allIds ?? [query.streetId]).map(Number).filter(Number.isFinite);
  for (const sid of ids) {
    const r = await client().addressStatus(cityId, sid, query.house, today);
    if (r.kind === 'confirmed') {
      const queue = r.status.queue ?? '';
      const result: PoeHouseLookupResult = {
        house: query.house,
        queue,
        statusText: queue === '' ? NO_QUEUE_TEXT : null,
        addressLabel: addressLabel(query),
      };
      const list = getHousesForStreet(street?.id ?? query.streetId);
      const key = HouseKey.of(result.house);
      const next = list.some((h) => HouseKey.of(h.house) === key)
        ? list.map((h) => (HouseKey.of(h.house) === key ? { ...result, house: h.house } : h))
        : [...list, result].sort((a, b) => compareHouses(a.house, b.house));
      housesByStreet.set(street?.id ?? query.streetId, next);
      return result;
    }
  }
  return null;
}
