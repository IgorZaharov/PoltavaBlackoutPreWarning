import Foundation

/// Address -> queue from the POE hourly-schedule catalogue (`poe_queues.json`, built from POE's PDF by
/// `scripts/build_poe_queue_catalogue.py`). Mirror of android core/QueueCatalogue.kt and
/// src/core/queueCatalogue.ts. Rules: spec/POE_API.md 8.11, golden cases: spec/vectors/queue_catalogue.json.
/// Pure: the entries are parsed by the data layer. A hint never overrides the per-house status (E4); it fills
/// in the queue when E4 says "several connections" and gives none.
public enum QueueCatalogue {

    public enum Kind: String, Hashable, Sendable {
        case HOUSE, RANGE, STREET, SETTLEMENT

        var ordinal: Int {
            switch self {
            case .HOUSE: return 0
            case .RANGE: return 1
            case .STREET: return 2
            case .SETTLEMENT: return 3
            }
        }
    }

    /// Kotlin `IntRange` (`first..last`); empty when `first > last`.
    public struct HouseRange: Hashable, Sendable {
        public var first: Int
        public var last: Int

        public init(_ first: Int, _ last: Int) {
            self.first = first
            self.last = last
        }

        public func contains(_ n: Int) -> Bool { first <= n && n <= last }
    }

    public struct Entry: Hashable, Sendable {
        public var queue: String
        public var branch: String?
        public var row: Int
        public var settlement: String?
        /// nil = the whole settlement.
        public var street: String?
        public var houses: [String]
        public var ranges: [HouseRange]
        /// "street" when the row lists the street without houses; "settlement" for a whole settlement.
        public var whole: String?

        public init(queue: String, branch: String?, row: Int, settlement: String?, street: String?,
                    houses: [String], ranges: [HouseRange], whole: String?) {
            self.queue = queue
            self.branch = branch
            self.row = row
            self.settlement = settlement
            self.street = street
            self.houses = houses
            self.ranges = ranges
            self.whole = whole
        }
    }

    public struct Hint: Hashable, Sendable {
        public var queue: String
        public var kind: Kind
        public var branch: String?
        public var row: Int
        public var exact: Bool

        public init(queue: String, kind: Kind, branch: String?, row: Int, exact: Bool) {
            self.queue = queue
            self.kind = kind
            self.branch = branch
            self.row = row
            self.exact = exact
        }
    }

    /// The queue a refresh may fill in without asking (spec/POE_API.md 8.11 step 5): the best hint, when no
    /// other queue has a hint of the same kind and exactness. nil when there is none or it is a tie.
    public static func confident(_ hints: [Hint]) -> String? {
        guard let best = hints.first else { return nil }
        let tie = hints.dropFirst().contains { $0.kind == best.kind && $0.exact == best.exact }
        return tie ? nil : best.queue
    }

    private static let TYPE_PREFIX = Rx("^\(Rx.ws)*([\\p{L}-]+)\\.?\(Rx.ws)*(.*)$")
    private static let DIGITS = Rx("^[0-9]+$")

    /// The street name without a leading type word ("вул. Європейська", "вул.Європейська" -> "Європейська").
    public static func withoutType(_ name: String) -> String {
        guard let m = TYPE_PREFIX.firstMatch(in: name) else { return name.ktTrim() }
        let ns = name as NSString
        let rest = Rx.group(m, 2, in: ns) ?? ""
        let type = Rx.group(m, 1, in: ns) ?? ""
        return !rest.ktIsBlank && StreetKey.isTypeWord(type) ? rest.ktTrim() : name.ktTrim()
    }

    /// `full` key and its last word (after the last space or dot), see 8.11 step 2.
    public static func streetKeys(_ name: String) -> (full: String, last: String) {
        let full = PoeMapper.streetKey(withoutType(name))
        let ns = full as NSString
        let space = ns.range(of: " ", options: [.literal, .backwards]).location
        let dot = ns.range(of: ".", options: [.literal, .backwards]).location
        let cut = max(space == NSNotFound ? -1 : space, dot == NSNotFound ? -1 : dot)
        return (full, ns.substring(from: cut + 1))
    }

    public static func lookup(_ entries: [Entry], settlement: String, branches: [String], street: String, house: String) -> [Hint] {
        let sk = PoeMapper.settlementKey(settlement)
        let keys: (full: String, last: String) = street.ktIsBlank ? ("", "") : streetKeys(street)
        let hk = house.ktIsBlank ? "" : HouseKey.of(house)
        let number: Int? = DIGITS.matches(hk) ? Int(hk) : nil
        var hits: [Hint] = []
        for e in entries {
            guard let es = e.settlement else { continue }
            if PoeMapper.settlementKey(es) != sk { continue }
            if !branches.isEmpty && !(e.branch.map { branches.contains($0) } ?? false) { continue }
            guard let eStreet = e.street else {
                hits.append(Hint(queue: e.queue, kind: .SETTLEMENT, branch: e.branch, row: e.row, exact: true))
                continue
            }
            if keys.full.isEmpty { continue }
            let eKeys = streetKeys(eStreet)
            let exact = eKeys.full == keys.full
            if !exact && eKeys.last != keys.last { continue }
            let kind: Kind?
            if hk.isEmpty {
                // a street without a house number (POE lists no houses) matches the whole street only
                kind = e.whole == "street" ? .STREET : nil
            } else if e.houses.contains(where: { HouseKey.of($0) == hk }) {
                kind = .HOUSE
            } else if let n = number, e.ranges.contains(where: { $0.contains(n) }) {
                kind = .RANGE
            } else if e.whole == "street" {
                kind = .STREET
            } else {
                kind = nil
            }
            guard let k = kind else { continue }
            hits.append(Hint(queue: e.queue, kind: k, branch: e.branch, row: e.row, exact: exact))
        }
        let sorted = hits.stableSorted { a, b in
            if a.kind.ordinal != b.kind.ordinal { return a.kind.ordinal < b.kind.ordinal }
            if a.exact != b.exact { return a.exact }
            if a.queue != b.queue { return a.queue.utf16.lexicographicallyPrecedes(b.queue.utf16) }
            return a.row < b.row
        }
        var seen = Set<String>()
        return sorted.filter { seen.insert($0.queue).inserted }
    }
}
