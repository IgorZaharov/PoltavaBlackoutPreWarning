import Foundation

/// A branch in the address picker (`id` = branch slug, stored as `remSlug`).
public struct PoeBranchOption: Hashable, Sendable {
    public var id: String
    public var cabinetId: Int
    public var registryId: Int
    public var nameUk: String
    public var nameEn: String
}

/// A settlement (`id` = POE city_id as text; ids are global, a settlement may belong to several branches).
public struct PoeSettlementOption: Hashable, Sendable {
    public var id: String
    public var nameUk: String
    public var branchIds: [String]
}

/// One street; spelling variants of the same street (StreetKey) are one option holding every id.
public struct PoeStreetOption: Hashable, Sendable {
    public var id: String
    public var settlementId: String
    public var nameUk: String
    public var allIds: [String]

    public init(id: String, settlementId: String, nameUk: String, allIds: [String]? = nil) {
        self.id = id
        self.settlementId = settlementId
        self.nameUk = nameUk
        self.allIds = allIds ?? [id]
    }
}

/// A house, and once POE was asked about it (E4) its queue; `queue` is empty when unknown or none.
public struct PoeHouseLookupResult: Hashable, Sendable {
    public var house: String
    public var queue: String
    public var statusText: String?
    public var addressLabel: String
    /// POE gives no queue because the address has several connections (spec/POE_API.md 8.11): ask the user.
    public var severalConnections: Bool
    /// The queues of POE's hourly-schedule catalogue for this address, best first.
    public var hints: [QueueCatalogue.Hint]

    public init(house: String, queue: String = "", statusText: String? = nil, addressLabel: String = "",
                severalConnections: Bool = false, hints: [QueueCatalogue.Hint] = []) {
        self.house = house
        self.queue = queue
        self.statusText = statusText
        self.addressLabel = addressLabel
        self.severalConnections = severalConnections
        self.hints = hints
    }
}

public typealias AddressLookupResult = PoeHouseLookupResult

/// One entry of the settlement picker: `label` names the branch when the settlement is outside the
/// chosen one or its name repeats.
public struct SettlementChoice: Hashable, Sendable {
    public var option: PoeSettlementOption
    public var label: String
    public var inBranch: Bool
}

/// Outcome of «Оновити довідник повністю».
public enum DirectoryUpdate: String, Sendable { case UPDATED, UP_TO_DATE, FAILED }

/// The address picker and the address re-check on Полтаваобленерго data (mirror of android
/// data/poe/PoeAddressLookup.kt): branches from `PoeBranches`, settlements and streets from the bundled
/// snapshot (`PoeDirectoryIndex`, `poe_directory.json` in the app target), houses live from the address
/// search (E3), the queue from the per-house status (E4).
///
/// The widget extension does not bundle the directory (its memory is kept for drawing, plan section 5).
/// So that it computes the same address keys and settlement names as the app, every address the app
/// resolves is written to a small App Group file (`PoeResolvedAddresses`), which `findSettlementById`
/// and `findStreetById` read when the index is not loaded.
public enum PoeAddressLookup {
    public static let NO_QUEUE_TEXT =
        "Будинок не входить до жодної черги погодинних відключень (ГПВ). Аварійні та планові роботи за адресою відстежуються."
    /// The directory the weekly CI job commits (.github/workflows/poe-data.yml); never a crawl from the phone.
    public static let DIRECTORY_URL = "https://raw.githubusercontent.com/IgorZaharov/PoltavaBlackoutPreWarning/main/poe_directory.json"
    static let ASSET = "poe_directory"
    /// A newer downloaded directory, or the bundled one with the scoped refreshes merged in (app only).
    static let LOCAL_FILE = "poe_directory_local.json"

    /// Network seam; tests replace it with a client over a fake transport.
    nonisolated(unsafe) public static var client = PoeClient()
    nonisolated(unsafe) static var http: HttpClient = URLSessionHttp(timeoutSeconds: 20)

    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var index: PoeDirectoryIndex?
        var loadTried = false
        var housesByStreet: [String: [PoeHouseLookupResult]] = [:]
        var streetsBySettlement: [String: [PoeStreetOption]] = [:]
        var streetById: [String: PoeStreetOption] = [:]
    }

    private static let state = State()
    private static let prefs = Prefs("poe_directory_prefs")

    // MARK: - Loading

    /// Loads the directory once: the bundled snapshot, or the local copy when it is at least as new.
    /// Safe from any thread; the app calls it off the main thread at start (about 1 MB of JSON).
    public static func initialize() {
        state.lock.lock(); defer { state.lock.unlock() }
        loadLocked()
    }

    private static func loadLocked() {
        if state.loadTried { return }
        state.loadTried = true
        let bundled = Bundle.main.url(forResource: ASSET, withExtension: "json")
            .flatMap { try? Data(contentsOf: $0) }
            .flatMap { PoeDirectoryIndex.fromJson($0) }
        let local = (try? Data(contentsOf: localFileURL())).flatMap { PoeDirectoryIndex.fromJson($0) }
        if let local, bundled == nil || local.crawledAt >= bundled!.crawledAt {
            state.index = local
        } else {
            state.index = bundled
        }
    }

    /// The index in use (loaded on first use); nil in the widget extension.
    public static func indexOrNull() -> PoeDirectoryIndex? {
        state.lock.lock(); defer { state.lock.unlock() }
        loadLocked()
        return state.index
    }

    /// For unit tests and a downloaded snapshot: replaces the index and forgets the derived lists.
    public static func useIndex(_ value: PoeDirectoryIndex?) {
        state.lock.lock(); defer { state.lock.unlock() }
        state.loadTried = true
        state.index = value
        state.housesByStreet = [:]
        state.streetsBySettlement = [:]
        state.streetById = [:]
    }

    static func localFileURL() -> URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(LOCAL_FILE)
    }

    /// Replaces the index and keeps it on disk so the next start uses it too. True when the file was written.
    @discardableResult
    private static func store(_ value: PoeDirectoryIndex) -> Bool {
        useIndex(value)
        guard let data = value.toJson() else { return false }
        return (try? data.write(to: localFileURL(), options: .atomic)) != nil
    }

    // MARK: - Branches, settlements, streets (local)

    public static func getRems() -> [PoeBranchOption] {
        PoeBranches.ALL.map { PoeBranchOption(id: $0.slug, cabinetId: $0.cabinetId, registryId: $0.registryId, nameUk: $0.nameUk, nameEn: $0.nameEn) }
    }

    public static func findRem(_ id: String?) -> PoeBranchOption? { getRems().first { $0.id == id } }

    private static func option(_ s: PoeDirectoryIndex.Settlement) -> PoeSettlementOption {
        PoeSettlementOption(
            id: String(s.id),
            nameUk: s.name.ktTrim(),
            branchIds: s.branchCabinetIds.compactMap { PoeBranches.byCabinetId($0)?.slug }
        )
    }

    public static func getSettlementsForRem(_ remId: String) -> [PoeSettlementOption] {
        guard let branch = PoeBranches.bySlug(remId), let idx = indexOrNull() else { return [] }
        return idx.settlementsOf(branch.cabinetId).map(option)
    }

    /// Every settlement of the oblast, once each (ids are global), for the oblast-wide search (plan D4).
    public static func getAllSettlements() -> [PoeSettlementOption] { (indexOrNull()?.settlements ?? []).map(option) }

    /// The settlement picker list (plan section 4.4, D4): the chosen branch's settlements first, then the
    /// rest of the oblast, each settlement once. Picking one outside the branch switches to its branch.
    public static func settlementChoices(_ remId: String, lang: String) -> [SettlementChoice] {
        let all = getAllSettlements()
        var counts: [String: Int] = [:]
        for s in all { counts[s.nameUk.ktTrim().lowercased(), default: 0] += 1 }
        func branchName(_ slug: String?) -> String? {
            PoeBranches.bySlug(slug).map { lang == "uk" ? $0.nameUk : $0.nameEn }
        }
        let own = getSettlementsForRem(remId)
        let ownIds = Set(own.map(\.id))
        let first = own.map { s -> SettlementChoice in
            let repeated = (counts[s.nameUk.ktTrim().lowercased()] ?? 0) > 1
            return SettlementChoice(option: s, label: repeated ? "\(s.nameUk) · \(branchName(remId) ?? "")" : s.nameUk, inBranch: true)
        }
        let rest = all.filter { !ownIds.contains($0.id) }
            .sorted { $0.nameUk.lowercased() < $1.nameUk.lowercased() }
            .map { s in
                SettlementChoice(option: s, label: [s.nameUk, branchName(s.branchIds.first)].compactMap { $0 }.joined(separator: " · "), inBranch: false)
            }
        return first + rest
    }

    public static func findSettlementById(_ settlementId: String) -> PoeSettlementOption? {
        if let id = Int64(settlementId), let s = indexOrNull()?.settlement(id) { return option(s) }
        return PoeResolvedAddresses.settlement(settlementId)
    }

    /// Streets of a settlement with spelling variants merged (spec/ADDRESS_KEY.md), sorted by name.
    public static func getStreetsForSettlement(_ settlementId: String) -> [PoeStreetOption] {
        state.lock.lock(); defer { state.lock.unlock() }
        if let cached = state.streetsBySettlement[settlementId] { return cached }
        loadLocked()
        guard let id = Int64(settlementId), let idx = state.index else { return [] }
        var order: [String] = []
        var groups: [String: [PoeDirectoryIndex.Street]] = [:]
        for s in idx.streetsOf(id) {
            let key = StreetKey.of(s.name)
            if groups[key] == nil { order.append(key) }
            groups[key, default: []].append(s)
        }
        let built = order.compactMap { key -> PoeStreetOption? in
            guard let group = groups[key], let first = group.first else { return nil }
            return PoeStreetOption(id: String(first.id), settlementId: settlementId, nameUk: first.name.ktTrim(), allIds: group.map { String($0.id) })
        }.sorted { $0.nameUk.lowercased() < $1.nameUk.lowercased() }
        state.streetsBySettlement[settlementId] = built
        for o in built { for sid in o.allIds { state.streetById[sid] = o } }
        return built
    }

    /// The option that holds `streetId` among its merged ids, searched in every settlement of the snapshot.
    public static func findStreetById(_ streetId: String) -> PoeStreetOption? {
        state.lock.lock()
        let cached = state.streetById[streetId]
        loadLocked()
        let idx = state.index
        state.lock.unlock()
        if let cached { return cached }
        if let id = Int64(streetId), let idx,
           let settlement = idx.settlements.first(where: { s in s.streets.contains { $0.id == id } }),
           let found = getStreetsForSettlement(String(settlement.id)).first(where: { $0.allIds.contains(streetId) }) {
            return found
        }
        return PoeResolvedAddresses.street(streetId)
    }

    /// Writes what the widget needs to resolve `query` without the directory (its settlement and street).
    public static func rememberResolved(_ queries: [SelectedAddressQuery]) {
        guard indexOrNull() != nil else { return }
        var settlements: [String: PoeSettlementOption] = [:]
        var streets: [String: PoeStreetOption] = [:]
        for q in queries {
            if let s = findSettlementById(q.settlementId) { settlements[q.settlementId] = s }
            if let st = findStreetById(q.streetId) { streets[q.streetId] = st }
        }
        PoeResolvedAddresses.save(settlements: settlements, streets: streets)
    }

    // MARK: - "My address is missing" (plan section 4.4): one request to POE, or the latest directory file

    /// Asks POE for the settlements of one branch (E3) and adds the new ones. False when POE could not be asked.
    public static func refreshSettlements(_ remId: String) async -> Bool {
        guard let branch = PoeBranches.bySlug(remId), let idx = indexOrNull(),
              case .ok(let options) = await client.cities(branch.cabinetId) else { return false }
        store(idx.withBranchSettlements(branch.cabinetId, options.map { (id: $0.id, name: $0.name.ktTrim()) }))
        return true
    }

    private static func branchFor(_ remId: String, _ settlementId: String) -> PoeBranch? {
        if let b = PoeBranches.bySlug(remId) { return b }
        return findSettlementById(settlementId)?.branchIds.lazy.compactMap { PoeBranches.bySlug($0) }.first
    }

    /// Asks POE for the streets of one settlement (E3) and adds the new ones. False when POE could not be asked.
    public static func refreshStreets(_ remId: String, _ settlementId: String) async -> Bool {
        guard let cityId = Int64(settlementId), let branch = branchFor(remId, settlementId), let idx = indexOrNull(),
              case .ok(let options) = await client.streets(branch.cabinetId, cityId: cityId) else { return false }
        store(idx.withStreets(cityId, options.map { (id: $0.id, name: $0.name) }))
        return true
    }

    /// Downloads the directory the weekly CI job publishes (conditional request: nothing is downloaded
    /// when it did not change). Only a newer crawl replaces the one in use. The queue catalogue is
    /// published by the same CI, so its newer copy is asked for too.
    public static func updateDirectory() async -> DirectoryUpdate {
        let directory = await updateDirectoryFile()
        let catalogue = await PoeQueues.refreshIfDue(force: true)
        return directory == .UPDATED || catalogue == .UPDATED ? .UPDATED : directory
    }

    private static func updateDirectoryFile() async -> DirectoryUpdate {
        guard let url = URL(string: DIRECTORY_URL) else { return .FAILED }
        var request = URLRequest(url: url)
        // only when the downloaded directory is on this phone: an orphaned ETag must not hide a newer file
        if FileManager.default.fileExists(atPath: localFileURL().path), let etag = prefs.string("etag") {
            request.setValue(etag, forHTTPHeaderField: "If-None-Match")
        }
        guard let response = try? await http.send(request) else { return .FAILED }
        if response.status == 304 { return .UP_TO_DATE }
        guard (200...299).contains(response.status), let fetched = PoeDirectoryIndex.fromJson(response.body) else { return .FAILED }
        let current = indexOrNull()
        if let current, fetched.crawledAt <= current.crawledAt { return .UP_TO_DATE }
        // a newer crawl keeps what this phone already knew, so a saved address stays findable
        let written = store(current.map { fetched.keeping($0) } ?? fetched)
        if written, let etag = response.header("ETag") { prefs.set("etag", etag) } else { prefs.remove("etag") }
        return .UPDATED
    }

    // MARK: - Houses (live, E3) and the queue of one house (E4)

    public static func getHousesForStreet(_ streetId: String) -> [PoeHouseLookupResult] {
        state.lock.lock(); defer { state.lock.unlock() }
        return state.housesByStreet[streetId] ?? []
    }

    private static func setHouses(_ houses: [PoeHouseLookupResult], for ids: [String]) {
        state.lock.lock(); defer { state.lock.unlock() }
        for id in ids { state.housesByStreet[id] = houses }
    }

    /// Houses of every merged id of the street, from POE; nil when POE could not be asked.
    public static func fetchHousesForStreet(_ remId: String, _ settlementId: String, _ streetId: String) async -> [PoeHouseLookupResult]? {
        let street = findStreetById(streetId) ?? PoeStreetOption(id: streetId, settlementId: settlementId, nameUk: "")
        guard let branch = branchFor(remId, settlementId), let cityId = Int64(settlementId) else { return nil }
        var order: [String] = []
        var names: [String: String] = [:]
        var anyOk = false
        for sid in street.allIds {
            guard let id = Int64(sid), case .ok(let options) = await client.buildings(branch.cabinetId, cityId: cityId, streetId: id) else { continue }
            anyOk = true
            for o in options {
                let key = HouseKey.of(o.name)
                if names[key] == nil {
                    order.append(key)
                    names[key] = o.name.ktTrim()
                }
            }
        }
        if !anyOk { return nil }
        var known: [String: PoeHouseLookupResult] = [:]
        for h in getHousesForStreet(street.id) where known[HouseKey.of(h.house)] == nil { known[HouseKey.of(h.house)] = h }
        let houses = order.compactMap { names[$0] }
            .sorted { HouseOrder.compare($0, $1) < 0 }
            .map { known[HouseKey.of($0)] ?? PoeHouseLookupResult(house: $0) }
        setHouses(houses, for: street.allIds + [street.id])
        return houses
    }

    /// Asks POE for the queue of one house (E4). The street's merged ids are tried in turn until POE
    /// answers for one. nil when POE could not be asked or did not know the house.
    public static func checkAddress(_ query: SelectedAddressQuery, today: LocalDate? = nil) async -> PoeHouseLookupResult? {
        guard let cityId = Int64(query.settlementId), !HouseKey.of(query.house).isEmpty else { return nil }
        let day = today ?? KyivTime.localDateTime(of: Date()).date
        let street = findStreetById(query.streetId)
        let ids = (street?.allIds ?? [query.streetId]).compactMap { Int64($0) }
        for sid in ids {
            guard case .confirmed(let c) = await client.addressStatus(cityId: cityId, streetId: sid, house: query.house, today: day) else { continue }
            let queue = c.status.queue ?? ""
            let several = c.status.severalConnections
            let result = PoeHouseLookupResult(
                house: query.house,
                queue: queue,
                // several connections: the queue is unknown, never "no queue" (spec/POE_API.md 8.11)
                statusText: queue.isEmpty && !several ? NO_QUEUE_TEXT : nil,
                addressLabel: addressLabel(query),
                severalConnections: several,
                hints: several ? PoeQueues.queuesFor(query) : []
            )
            remember(street?.id ?? query.streetId, result)
            return result
        }
        return nil
    }

    private static func remember(_ streetId: String, _ result: PoeHouseLookupResult) {
        state.lock.lock(); defer { state.lock.unlock() }
        let list = state.housesByStreet[streetId] ?? []
        let key = HouseKey.of(result.house)
        if list.contains(where: { HouseKey.of($0.house) == key }) {
            state.housesByStreet[streetId] = list.map { h in
                guard HouseKey.of(h.house) == key else { return h }
                var r = result
                r.house = h.house
                return r
            }
        } else {
            state.housesByStreet[streetId] = (list + [result]).sorted { HouseOrder.compare($0.house, $1.house) < 0 }
        }
    }

    /// `місто Полтава, вул. Соборності, буд. 1` for the notification and the address line.
    public static func addressLabel(_ query: SelectedAddressQuery) -> String {
        let settlement = findSettlementById(query.settlementId)?.nameUk ?? ""
        let street = findStreetById(query.streetId)?.nameUk ?? ""
        return [settlement, street, "буд. \(query.house.ktTrim())"].filter { !$0.ktIsBlank }.joined(separator: ", ")
    }

    /// `2` before `10`, `10` before `10а`, then the rest by text.
    public enum HouseOrder {
        private static func split(_ s: String) -> (digits: String, rest: String)? {
            let t = s.ktTrim()
            let digits = t.prefix { $0.isASCII && $0.isNumber }
            if digits.isEmpty { return nil }
            return (String(digits), String(t.dropFirst(digits.count)))
        }

        /// Negative, zero or positive like a Kotlin comparator.
        public static func compare(_ a: String, _ b: String) -> Int {
            let ma = split(a)
            let mb = split(b)
            if let ma, let mb {
                let na = ma.digits.drop { $0 == "0" }
                let nb = mb.digits.drop { $0 == "0" }
                if na.count != nb.count { return na.count < nb.count ? -1 : 1 }
                if na != nb { return na < nb ? -1 : 1 }
                let ra = ma.rest.lowercased()
                let rb = mb.rest.lowercased()
                return ra == rb ? 0 : (ra < rb ? -1 : 1)
            }
            if ma != nil { return -1 }
            if mb != nil { return 1 }
            let la = a.lowercased()
            let lb = b.lowercased()
            return la == lb ? 0 : (la < lb ? -1 : 1)
        }
    }
}

/// The settlements and streets of the saved addresses as the app resolved them, in the App Group
/// (`poe_resolved_v1.json`), for the widget extension, which has no directory. Small: one entry per address.
public enum PoeResolvedAddresses {
    public static let FILE = "poe_resolved_v1.json"
    private static let lock = NSLock()

    private static func read() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return AppGroup.readJSON(FILE) as? [String: Any] ?? [:]
    }

    public static func settlement(_ id: String) -> PoeSettlementOption? {
        guard let o = (read()["settlements"] as? [String: Any])?[id] as? [String: Any], let name = o["name"] as? String else { return nil }
        return PoeSettlementOption(id: id, nameUk: name, branchIds: o["branches"] as? [String] ?? [])
    }

    public static func street(_ id: String) -> PoeStreetOption? {
        guard let o = (read()["streets"] as? [String: Any])?[id] as? [String: Any], let name = o["name"] as? String,
              let settlementId = o["settlementId"] as? String else { return nil }
        return PoeStreetOption(id: o["id"] as? String ?? id, settlementId: settlementId, nameUk: name, allIds: o["allIds"] as? [String])
    }

    /// Replaces the file with exactly these entries (the saved addresses of now); unchanged content is not rewritten.
    static func save(settlements: [String: PoeSettlementOption], streets: [String: PoeStreetOption]) {
        let doc: [String: Any] = [
            "settlements": settlements.mapValues { ["name": $0.nameUk, "branches": $0.branchIds] as [String: Any] },
            "streets": streets.mapValues { ["id": $0.id, "name": $0.nameUk, "settlementId": $0.settlementId, "allIds": $0.allIds] as [String: Any] }
        ]
        lock.lock(); defer { lock.unlock() }
        if let old = AppGroup.readJSON(FILE), NSDictionary(dictionary: doc).isEqual(old) { return }
        AppGroup.writeJSON(FILE, doc)
    }
}
