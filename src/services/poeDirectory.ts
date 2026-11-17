/**
 * The POE address directory snapshot (poe_directory.json), mirrored from
 * android/.../data/poe/PoeDirectoryIndex.kt. Settlement and street ids are global (spec/POE_API.md
 * section 2, trap 4), so the index is keyed by settlement id and a settlement lists all its branches.
 */
export interface PoeBranch {
  readonly cabinetId: number;
  readonly registryId: number;
  readonly name: string;
}

export interface PoeStreet {
  readonly id: number;
  readonly name: string;
}

export interface PoeSettlement {
  readonly id: number;
  readonly name: string;
  readonly branchCabinetIds: readonly number[];
  readonly streets: readonly PoeStreet[];
}

export class PoeDirectoryIndex {
  private readonly byId: Map<number, PoeSettlement>;

  private constructor(
    readonly crawledAt: string,
    readonly branches: readonly PoeBranch[],
    readonly settlements: readonly PoeSettlement[]
  ) {
    this.byId = new Map(settlements.map((s) => [s.id, s]));
  }

  settlement(id: number): PoeSettlement | null {
    return this.byId.get(id) ?? null;
  }

  /** Settlements of one branch (a settlement may belong to several), in snapshot order. */
  settlementsOf(cabinetId: number): PoeSettlement[] {
    return this.settlements.filter((s) => s.branchCabinetIds.includes(cabinetId));
  }

  streetsOf(settlementId: number): readonly PoeStreet[] {
    return this.byId.get(settlementId)?.streets ?? [];
  }

  branch(cabinetId: number): PoeBranch | null {
    return this.branches.find((b) => b.cabinetId === cabinetId) ?? null;
  }

  /**
   * The settlement list of one branch as POE gives it now (E3 `city`): new settlements are added (without
   * streets), known ones gain the branch. Nothing is removed, so a saved address always stays findable.
   */
  withBranchSettlements(cabinetId: number, fetched: readonly (readonly [number, string])[]): PoeDirectoryIndex {
    const ids = new Set(fetched.map(([id]) => id));
    const updated = this.settlements.map((s) =>
      ids.has(s.id) && !s.branchCabinetIds.includes(cabinetId) ? { ...s, branchCabinetIds: [...s.branchCabinetIds, cabinetId] } : s
    );
    const added = fetched
      .filter(([id]) => !this.byId.has(id))
      .map(([id, name]) => ({ id, name, branchCabinetIds: [cabinetId], streets: [] as PoeStreet[] }));
    return new PoeDirectoryIndex(this.crawledAt, this.branches, [...updated, ...added]);
  }

  /** The street list of one settlement as POE gives it now (E3 `street`), merged with the known one (nothing removed). */
  withStreets(settlementId: number, fetched: readonly (readonly [number, string])[]): PoeDirectoryIndex {
    const s = this.byId.get(settlementId);
    if (!s) return this;
    const known = new Set(s.streets.map((st) => st.id));
    const streets = [...s.streets, ...fetched.filter(([id]) => !known.has(id)).map(([id, name]) => ({ id, name }))];
    return new PoeDirectoryIndex(
      this.crawledAt,
      this.branches,
      this.settlements.map((x) => (x.id === settlementId ? { ...x, streets } : x))
    );
  }

  /**
   * This index plus everything [older] knew that this one does not (settlements, their branches, streets),
   * so a newer crawl never makes a saved address unfindable. Mirrors PoeDirectoryIndex.keeping.
   */
  keeping(older: PoeDirectoryIndex): PoeDirectoryIndex {
    const merged = this.settlements.map((s) => {
      const old = older.settlement(s.id);
      if (!old) return s;
      const known = new Set(s.streets.map((st) => st.id));
      return {
        ...s,
        branchCabinetIds: [...s.branchCabinetIds, ...old.branchCabinetIds.filter((b) => !s.branchCabinetIds.includes(b))],
        streets: [...s.streets, ...old.streets.filter((st) => !known.has(st.id))],
      };
    });
    const missing = older.settlements.filter((s) => !this.byId.has(s.id));
    return new PoeDirectoryIndex(this.crawledAt, this.branches, [...merged, ...missing]);
  }

  /** The same JSON layout as `poe_directory.json`, so a stored copy reads back through [fromJson]. */
  toJson(): string {
    return JSON.stringify({
      crawledAt: this.crawledAt,
      branches: this.branches,
      settlements: this.settlements.map((s) => ({ id: s.id, name: s.name, branches: s.branchCabinetIds, streets: s.streets.map((st) => [st.id, st.name]) })),
    });
  }

  /** Parses the snapshot; null when the text is not a usable snapshot (the bundled copy is then kept). */
  static fromJson(text: string): PoeDirectoryIndex | null {
    try {
      const root = JSON.parse(text);
      if (!Array.isArray(root?.branches) || !Array.isArray(root?.settlements)) return null;
      const branches: PoeBranch[] = root.branches.map((b: { cabinetId: number; registryId: number; name: string }) => {
        if (typeof b.cabinetId !== 'number' || typeof b.registryId !== 'number' || typeof b.name !== 'string') throw new Error('branch');
        return { cabinetId: b.cabinetId, registryId: b.registryId, name: b.name };
      });
      const settlements: PoeSettlement[] = root.settlements.map(
        (s: { id: number; name: string; branches: number[]; streets: [number, string][] }) => {
          if (typeof s.id !== 'number' || typeof s.name !== 'string' || !Array.isArray(s.branches) || !Array.isArray(s.streets)) {
            throw new Error('settlement');
          }
          return {
            id: s.id,
            name: s.name,
            branchCabinetIds: s.branches.map(Number),
            streets: s.streets.map(([id, name]) => ({ id: Number(id), name: String(name) })),
          };
        }
      );
      if (branches.length === 0 || settlements.length === 0) return null;
      return new PoeDirectoryIndex(typeof root.crawledAt === 'string' ? root.crawledAt : '', branches, settlements);
    } catch {
      return null;
    }
  }
}
