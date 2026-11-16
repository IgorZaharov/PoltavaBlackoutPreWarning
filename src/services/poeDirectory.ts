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
