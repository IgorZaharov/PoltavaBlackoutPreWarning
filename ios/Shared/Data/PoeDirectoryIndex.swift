import Foundation

/// The POE address directory snapshot (`poe_directory.json`: branches, settlements, streets; houses are
/// loaded live). Built by `scripts/crawl_poe_directory.py`, bundled in the app target and refreshed as
/// described in docs/POLTAVA_PORT_PLAN.md section 4.4 (mirror of android PoeDirectoryIndex.kt).
/// Settlement and street ids are global (spec/POE_API.md section 2, trap 4), so the index is keyed by
/// settlement id and a settlement lists every branch it belongs to.
public final class PoeDirectoryIndex: @unchecked Sendable {
    public struct Branch: Hashable, Sendable {
        public var cabinetId: Int
        public var registryId: Int
        public var name: String
    }

    public struct Street: Hashable, Sendable {
        public var id: Int64
        public var name: String
    }

    public struct Settlement: Hashable, Sendable {
        public var id: Int64
        public var name: String
        public var branchCabinetIds: [Int]
        public var streets: [Street]
    }

    public let crawledAt: String
    public let branches: [Branch]
    public let settlements: [Settlement]
    private let byId: [Int64: Int]

    init(crawledAt: String, branches: [Branch], settlements: [Settlement]) {
        self.crawledAt = crawledAt
        self.branches = branches
        self.settlements = settlements
        var map: [Int64: Int] = [:]
        for (i, s) in settlements.enumerated() where map[s.id] == nil { map[s.id] = i }
        byId = map
    }

    public func settlement(_ id: Int64) -> Settlement? { byId[id].map { settlements[$0] } }

    /// Settlements of one branch (a settlement may belong to several), in snapshot order.
    public func settlementsOf(_ cabinetId: Int) -> [Settlement] { settlements.filter { $0.branchCabinetIds.contains(cabinetId) } }

    public func streetsOf(_ settlementId: Int64) -> [Street] { settlement(settlementId)?.streets ?? [] }

    public func branch(_ cabinetId: Int) -> Branch? { branches.first { $0.cabinetId == cabinetId } }

    /// The settlement list of one branch as POE gives it now (E3 `city`): new settlements are added
    /// (without streets), known ones gain the branch. Nothing is removed, so a saved address stays findable.
    public func withBranchSettlements(_ cabinetId: Int, _ fetched: [(id: Int64, name: String)]) -> PoeDirectoryIndex {
        let ids = Set(fetched.map(\.id))
        let updated = settlements.map { s -> Settlement in
            guard ids.contains(s.id), !s.branchCabinetIds.contains(cabinetId) else { return s }
            var copy = s
            copy.branchCabinetIds.append(cabinetId)
            return copy
        }
        let known = Set(settlements.map(\.id))
        var seen = Set<Int64>()
        let added = fetched.filter { !known.contains($0.id) && seen.insert($0.id).inserted }
            .map { Settlement(id: $0.id, name: $0.name, branchCabinetIds: [cabinetId], streets: []) }
        return PoeDirectoryIndex(crawledAt: crawledAt, branches: branches, settlements: updated + added)
    }

    /// The street list of one settlement as POE gives it now (E3 `street`), merged with the known one (nothing removed).
    public func withStreets(_ settlementId: Int64, _ fetched: [(id: Int64, name: String)]) -> PoeDirectoryIndex {
        guard let s = settlement(settlementId) else { return self }
        var known = Set(s.streets.map(\.id))
        var streets = s.streets
        for f in fetched where known.insert(f.id).inserted { streets.append(Street(id: f.id, name: f.name)) }
        return PoeDirectoryIndex(crawledAt: crawledAt, branches: branches, settlements: settlements.map { item in
            guard item.id == settlementId else { return item }
            var copy = item
            copy.streets = streets
            return copy
        })
    }

    /// This index plus everything `older` knew that this one does not (settlements, their branches,
    /// streets), so a newer crawl never makes a saved address unfindable.
    public func keeping(_ older: PoeDirectoryIndex) -> PoeDirectoryIndex {
        let merged = settlements.map { s -> Settlement in
            guard let old = older.settlement(s.id) else { return s }
            var copy = s
            copy.branchCabinetIds += old.branchCabinetIds.filter { !s.branchCabinetIds.contains($0) }
            let known = Set(s.streets.map(\.id))
            copy.streets += old.streets.filter { !known.contains($0.id) }
            return copy
        }
        let missing = older.settlements.filter { byId[$0.id] == nil }
        return PoeDirectoryIndex(crawledAt: crawledAt, branches: branches, settlements: merged + missing)
    }

    /// The same JSON layout as `poe_directory.json`, so a stored copy reads back through `fromJson`.
    public func toJsonObject() -> [String: Any] {
        [
            "crawledAt": crawledAt,
            "branches": branches.map { ["cabinetId": $0.cabinetId, "registryId": $0.registryId, "name": $0.name] as [String: Any] },
            "settlements": settlements.map { s -> [String: Any] in
                [
                    "id": s.id,
                    "name": s.name,
                    "branches": s.branchCabinetIds,
                    "streets": s.streets.map { [$0.id, $0.name] as [Any] }
                ]
            }
        ]
    }

    public func toJson() -> Data? { try? JSONSerialization.data(withJSONObject: toJsonObject()) }

    /// Parses the snapshot; nil when the data is not a usable snapshot (the bundled copy is then kept).
    public static func fromJson(_ data: Data) -> PoeDirectoryIndex? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let br = root["branches"] as? [Any], let st = root["settlements"] as? [Any] else { return nil }
        var branches: [Branch] = []
        for item in br {
            guard let o = item as? [String: Any], let cabinet = o["cabinetId"] as? NSNumber,
                  let registry = o["registryId"] as? NSNumber, let name = o["name"] as? String else { return nil }
            branches.append(Branch(cabinetId: cabinet.intValue, registryId: registry.intValue, name: name))
        }
        var settlements: [Settlement] = []
        settlements.reserveCapacity(st.count)
        for item in st {
            guard let o = item as? [String: Any], let id = o["id"] as? NSNumber, let name = o["name"] as? String,
                  let ids = o["branches"] as? [Any], let streets = o["streets"] as? [Any] else { return nil }
            var list: [Street] = []
            list.reserveCapacity(streets.count)
            for pair in streets {
                guard let p = pair as? [Any], p.count >= 2, let sid = p[0] as? NSNumber, let sname = p[1] as? String else { return nil }
                list.append(Street(id: sid.int64Value, name: sname))
            }
            settlements.append(Settlement(
                id: id.int64Value, name: name,
                branchCabinetIds: ids.compactMap { ($0 as? NSNumber)?.intValue },
                streets: list
            ))
        }
        if branches.isEmpty || settlements.isEmpty { return nil }
        return PoeDirectoryIndex(crawledAt: root["crawledAt"] as? String ?? "", branches: branches, settlements: settlements)
    }

    public static func fromJson(_ text: String) -> PoeDirectoryIndex? { fromJson(Data(text.utf8)) }
}
