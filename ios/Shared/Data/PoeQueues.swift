import Foundation

/// A company named in POE's hourly-schedule PDF (search by workplace): its queue, branch and the text of its row.
public struct PoeCompany: Hashable, Sendable {
    public var name: String
    public var queue: String
    public var branch: String?
    public var row: Int
    public var settlement: String?
    public var rowText: String = ""
    /// Words people search for that the PDF does not use ("ЗОШ" for «Школа № 27»).
    public var aliases: String = ""
}

/// The queue catalogue (`poe_queues.json`, spec/POE_API.md 8.11; mirror of android PoeQueues.kt): bundled
/// in the app target, refreshed from the copy this repository's CI keeps current at most once a week with
/// a conditional request. Used when the per-house status says "several connections" and gives no queue,
/// and for the company search. Loaded on first use (about 2 MB of JSON), never in the widget extension.
public enum PoeQueues {
    public static let CATALOGUE_URL = "https://raw.githubusercontent.com/IgorZaharov/PoltavaBlackoutPreWarning/main/poe_queues.json"
    static let ASSET = "poe_queues"
    static let LOCAL_FILE = "poe_queues_local.json"
    static let CHECK_EVERY_MS: Int64 = 7 * 24 * 60 * 60 * 1000
    static let RETRY_AFTER_MS: Int64 = 24 * 60 * 60 * 1000

    public final class Catalogue: @unchecked Sendable {
        public let builtAt: String
        public let sha256: String?
        public let entries: [QueueCatalogue.Entry]
        public let companies: [PoeCompany]

        init(builtAt: String, sha256: String?, entries: [QueueCatalogue.Entry], companies: [PoeCompany]) {
            self.builtAt = builtAt
            self.sha256 = sha256
            self.entries = entries
            self.companies = companies
        }
    }

    private final class State: @unchecked Sendable {
        let lock = NSLock()
        var catalogue: Catalogue?
        var loadTried = false
    }

    private static let state = State()
    private static let prefs = Prefs("poe_queues_prefs")
    nonisolated(unsafe) static var http: HttpClient = URLSessionHttp(timeoutSeconds: 30)

    private static func optString(_ v: Any?) -> String? { v as? String }

    public static func parse(_ data: Data) -> Catalogue? {
        guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let e = root["entries"] as? [Any] else { return nil }
        var entries: [QueueCatalogue.Entry] = []
        entries.reserveCapacity(e.count)
        for item in e {
            guard let o = item as? [String: Any], let q = o["q"] as? String, let row = (o["row"] as? NSNumber)?.intValue,
                  let houses = o["houses"] as? [Any], let ranges = o["ranges"] as? [Any] else { return nil }
            entries.append(QueueCatalogue.Entry(
                queue: q,
                branch: optString(o["branch"]),
                row: row,
                settlement: optString(o["settlement"]),
                street: optString(o["street"]),
                houses: houses.compactMap { $0 as? String },
                ranges: ranges.compactMap { r -> QueueCatalogue.HouseRange? in
                    guard let pair = r as? [Any], pair.count >= 2, let a = pair[0] as? NSNumber, let b = pair[1] as? NSNumber else { return nil }
                    return QueueCatalogue.HouseRange(a.intValue, b.intValue)
                },
                whole: optString(o["whole"])
            ))
        }
        // the raw text of each row, so the company search also finds the words around a name
        var rowTexts: [String: String] = [:]
        for item in root["rows"] as? [Any] ?? [] {
            guard let o = item as? [String: Any] else { continue }
            let n = (o["n"] as? NSNumber)?.intValue ?? 0
            rowTexts["\(optString(o["q"]) ?? "")|\(optString(o["branch"]) ?? "")|\(n)"] = optString(o["text"]) ?? ""
        }
        let companies = (root["companies"] as? [Any] ?? []).compactMap { item -> PoeCompany? in
            guard let o = item as? [String: Any], let name = o["name"] as? String, let q = o["q"] as? String,
                  let row = (o["row"] as? NSNumber)?.intValue else { return nil }
            let branch = optString(o["branch"])
            return PoeCompany(
                name: name, queue: q, branch: branch, row: row, settlement: optString(o["settlement"]),
                rowText: rowTexts["\(q)|\(branch ?? "")|\(row)"] ?? "",
                aliases: optString(o["aliases"]) ?? ""
            )
        }
        let sha = (root["source"] as? [String: Any]).flatMap { optString($0["sha256"]) }
        if entries.isEmpty { return nil }
        return Catalogue(builtAt: optString(root["builtAt"]) ?? "", sha256: sha, entries: entries, companies: companies)
    }

    static func localFileURL() -> URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(LOCAL_FILE)
    }

    /// The catalogue (the bundled one, or the downloaded one when it is newer), loaded once. Call off the main thread.
    @discardableResult
    public static func initialize() -> Catalogue? {
        state.lock.lock(); defer { state.lock.unlock() }
        if !state.loadTried {
            state.loadTried = true
            let bundled = Bundle.main.url(forResource: ASSET, withExtension: "json").flatMap { try? Data(contentsOf: $0) }.flatMap(parse)
            let local = (try? Data(contentsOf: localFileURL())).flatMap(parse)
            if let local, bundled == nil || local.builtAt > bundled!.builtAt {
                state.catalogue = local
            } else {
                state.catalogue = bundled
            }
        }
        return state.catalogue
    }

    /// For tests.
    public static func use(_ value: Catalogue?) {
        state.lock.lock(); defer { state.lock.unlock() }
        state.loadTried = true
        state.catalogue = value
    }

    public static func current() -> Catalogue? {
        state.lock.lock(); defer { state.lock.unlock() }
        return state.catalogue
    }

    /// The catalogue's queues for one address, best first (QueueCatalogue.lookup). Empty when not loaded or not listed.
    public static func queuesFor(_ query: SelectedAddressQuery) -> [QueueCatalogue.Hint] {
        guard let cat = initialize(), let settlement = PoeAddressLookup.findSettlementById(query.settlementId) else { return [] }
        let street = PoeAddressLookup.findStreetById(query.streetId)?.nameUk ?? ""
        let branches = settlement.branchIds.isEmpty ? [query.remId] : settlement.branchIds
        return QueueCatalogue.lookup(cat.entries, settlement: settlement.nameUk, branches: branches, street: street, house: query.house)
    }

    public static func companies() -> [PoeCompany] { current()?.companies ?? [] }

    /// Downloads the CI copy when `force` or a week has passed since the last check (a day after a failed one).
    /// Conditional request with the ETag of the CI copy last seen; a newer `builtAt` replaces the one in use.
    public static func refreshIfDue(force: Bool = false, nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000)) async -> DirectoryUpdate {
        // no catalogue at all (the widget extension bundles none): nothing to keep current
        guard initialize() != nil else { return .UP_TO_DATE }
        if !force && (0..<CHECK_EVERY_MS).contains(nowMs - prefs.int64("checked_ms", 0)) { return .UP_TO_DATE }
        // a failed check is tried again after a day, a successful one after a week
        prefs.set("checked_ms", nowMs - CHECK_EVERY_MS + RETRY_AFTER_MS)
        guard let url = URL(string: CATALOGUE_URL) else { return .FAILED }
        var request = URLRequest(url: url)
        // the ETag names the CI copy last seen, taken or not: the catalogue in use is at least as new
        if let etag = prefs.string("etag") { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }
        guard let response = try? await http.send(request) else { return .FAILED }
        if response.status == 304 {
            prefs.set("checked_ms", nowMs)
            return .UP_TO_DATE
        }
        guard (200...299).contains(response.status), let fetched = parse(response.body) else { return .FAILED }
        prefs.set("checked_ms", nowMs)
        if let cur = current(), fetched.builtAt <= cur.builtAt || (fetched.sha256 != nil && fetched.sha256 == cur.sha256) {
            // not newer than the one in use: remember its ETag, so next week's check is a 304 instead of 2 MB
            if let etag = response.header("ETag") { prefs.set("etag", etag) }
            return .UP_TO_DATE
        }
        let written = (try? response.body.write(to: localFileURL(), options: .atomic)) != nil
        use(fetched)
        if written, let etag = response.header("ETag") { prefs.set("etag", etag) } else { prefs.remove("etag") }
        return .UPDATED
    }
}
