import Foundation

/// E1: a valid table (or "not published", tomorrow only) or why it could not be read.
public enum ScheduleFetch: Hashable, Sendable {
    case ok(PoeSchedule.DayTable)
    case unavailable(String)
}

/// One E3 row: a settlement, street or house of the address search.
public struct DirectoryOption: Hashable, Sendable {
    public var id: Int64
    public var name: String

    public init(id: Int64, name: String) {
        self.id = id
        self.name = name
    }
}

public enum DirectoryFetch: Hashable, Sendable {
    case ok([DirectoryOption])
    case unavailable(String)
}

/// E4 mapped by `PoeMapper.addressStatus`, plus the raw info line (`gav_message`) for display.
public struct ConfirmedAddressStatus: Hashable, Sendable {
    public var status: PoeMapper.AddressStatus
    public var gavMessage: String?
}

public enum AddressStatusFetch: Hashable, Sendable {
    case confirmed(ConfirmedAddressStatus)
    case unavailable(String)

    public var confirmedStatus: ConfirmedAddressStatus? {
        if case .confirmed(let c) = self { return c }
        return nil
    }
}

public enum RegistryFetch: Hashable, Sendable {
    /// `raw` keeps each row's `out_text` so the rows can be stored and parsed again later.
    case confirmed(rows: [PoeMapper.RegistryRow], raw: [String])
    case unavailable(String)
}

/// One E2 item ("ГАВ з 08:54 до 23:59 за розпорядженням НЕК «Укренерго»").
public struct PoeMeasure: Hashable, Sendable {
    public var type: String
    public var beginHour: Int
    public var beginMinute: Int
    public var endHour: Int
    public var endMinute: Int
    public var reason: String?
    public var note: String?
    public var queueNumber: Int?

    public init(type: String, beginHour: Int, beginMinute: Int, endHour: Int, endMinute: Int,
                reason: String? = nil, note: String? = nil, queueNumber: Int? = nil) {
        self.type = type
        self.beginHour = beginHour
        self.beginMinute = beginMinute
        self.endHour = endHour
        self.endMinute = endMinute
        self.reason = reason
        self.note = note
        self.queueNumber = queueNumber
    }
}

public enum MeasuresFetch: Hashable, Sendable {
    case ok([PoeMeasure])
    case unavailable(String)
}

/// The Полтаваобленерго endpoints (spec/POE_API.md section 2; mirror of android data/poe/PoeClient.kt).
/// Every call returns exactly one of a confirmed answer or `unavailable`; a failure is never turned into
/// "no outage" (section 9). Network goes through `transport`; parsing is the pure core (`PoeSchedule`,
/// `PoeMapper`).
public final class PoeClient: @unchecked Sendable {
    private let transport: PoeTransport
    private let nowMs: @Sendable () -> Int64
    private let lock = NSLock()
    private var statusCache: [String: (at: Int64, value: ConfirmedAddressStatus)] = [:]

    public init(
        transport: PoeTransport = HttpPoeTransport(),
        nowMs: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) }
    ) {
        self.transport = transport
        self.nowMs = nowMs
    }

    /// `dd-MM-yyyy`, the date format of every POE request.
    public func formatDate(_ date: LocalDate) -> String { String(format: "%02d-%02d-%04d", date.day, date.month, date.year) }

    private func post(_ endpoint: String, _ field: String, _ json: [String: String],
                      readTimeoutMs: Int = PoeConfig.READ_TIMEOUT_MS) async -> PoeHttpResult {
        guard let data = try? JSONSerialization.data(withJSONObject: json, options: [.sortedKeys, .withoutEscapingSlashes]) else {
            return .failed("encode")
        }
        return await transport.post(endpoint, field: field, json: String(decoding: data, as: UTF8.self), readTimeoutMs: readTimeoutMs)
    }

    /// A JSON array answer, or nil when the body is not one (error object, HTML, truncated).
    static func arrayOf(_ body: String) -> [Any]? {
        let t = body.ktTrim()
        guard t.hasPrefix("[") else { return nil }
        return (try? JSONSerialization.jsonObject(with: Data(t.utf8))) as? [Any]
    }

    /// Top-level fields as plain values, JSON null dropped (Kotlin `plainMap`).
    static func plainMap(_ o: [String: Any]) -> [String: Any] { o.filter { !($0.value is NSNull) } }

    /// A JSON string or number as text; nil for null or absent.
    static func text(_ v: Any?) -> String? {
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    /// A JSON number or numeric string as Int (org.json `optInt`).
    static func int(_ v: Any?) -> Int? {
        if let n = v as? NSNumber { return n.intValue }
        if let s = v as? String { return Int(s.ktTrim()) }
        return nil
    }

    private static func nonBlank(_ v: Any?) -> String? {
        guard let s = text(v)?.ktTrim(), !s.isEmpty else { return nil }
        return s
    }

    // MARK: - E1 schedule, E2 measures

    public func schedule(_ date: LocalDate) async -> ScheduleFetch {
        switch await post(PoeConfig.SCHEDULE, "seldate", ["date_in": formatDate(date)]) {
        case .failed(let reason):
            return .unavailable(reason)
        case .ok(let body):
            let table = PoeSchedule.parseDay(body, date: date)
            return table.kind == .INVALID ? .unavailable(table.reason ?? "invalid") : .ok(table)
        }
    }

    public func measures(_ date: LocalDate) async -> MeasuresFetch {
        switch await post(PoeConfig.MEASURES, "seldate", ["date_in": formatDate(date)]) {
        case .failed(let reason):
            return .unavailable(reason)
        case .ok(let body):
            let parsed: [Any]? = body.ktIsBlank ? [Any]() : Self.arrayOf(body)
            guard let arr = parsed else { return .unavailable("not_an_array") }
            return .ok(arr.compactMap { item -> PoeMeasure? in
                guard let o = item as? [String: Any], let type = Self.nonBlank(o["unloadingtypename"]) else { return nil }
                return PoeMeasure(
                    type: type,
                    beginHour: Self.int(o["beginhour"]) ?? 0,
                    beginMinute: Self.int(o["beginminute"]) ?? 0,
                    endHour: Self.int(o["endhour"]) ?? 23,
                    endMinute: Self.int(o["endminute"]) ?? 59,
                    reason: Self.nonBlank(o["unloadingreasonname"]),
                    note: Self.nonBlank(o["note"]),
                    queueNumber: Self.int(o["unloading_queue_number"])
                )
            })
        }
    }

    // MARK: - E3 address directory

    private func directory(_ op: String, _ cabinetId: Int, _ cityId: Int64?, _ streetId: Int64?) async -> DirectoryFetch {
        let req = [
            "operation_type": op,
            "filial_id": String(cabinetId),
            "city_id": cityId.map { String($0) } ?? "",
            "street_id": streetId.map { String($0) } ?? ""
        ]
        switch await post(PoeConfig.DIRECTORY, "disconn", req) {
        case .failed(let reason):
            return .unavailable(reason)
        case .ok(let body):
            guard let arr = Self.arrayOf(body) else { return .unavailable("not_an_array") }
            return .ok(arr.compactMap { item -> DirectoryOption? in
                guard let o = item as? [String: Any], let n = o["instance_id"] as? NSNumber else { return nil }
                let name = Self.text(o["instance_name"]) ?? ""
                let id = n.int64Value
                return id < 0 || Self.isJunkName(name) ? nil : DirectoryOption(id: id, name: name)
            })
        }
    }

    /// `село _` and empty names are rows without a real name (spec/POE_API.md section 4).
    public static func isJunkName(_ name: String) -> Bool {
        let trimmed = name.ktTrim()
        if trimmed.isEmpty { return true }
        let parts = trimmed.split(maxSplits: 1, whereSeparator: { $0.isWhitespace })
        let rest = (parts.count == 2 ? String(parts[1]) : String(parts[0])).ktTrim()
        return rest.isEmpty || rest.allSatisfy { $0 == "_" || $0 == "-" }
    }

    public func cities(_ cabinetId: Int) async -> DirectoryFetch { await directory("city", cabinetId, nil, nil) }

    public func streets(_ cabinetId: Int, cityId: Int64) async -> DirectoryFetch { await directory("street", cabinetId, cityId, nil) }

    public func buildings(_ cabinetId: Int, cityId: Int64, streetId: Int64) async -> DirectoryFetch {
        await directory("building", cabinetId, cityId, streetId)
    }

    // MARK: - E4 per-house status, E5 branch registry

    /// Queue, emergency and repair works of one house; answers are reused for 60 s per house.
    public func addressStatus(cityId: Int64, streetId: Int64, house: String, today: LocalDate) async -> AddressStatusFetch {
        let key = "\(cityId)|\(streetId)|\(house)|\(today)"
        if let cached = cachedStatus(key) { return .confirmed(cached) }
        // `streerid` is POE's own spelling of the key (spec/POE_API.md section 2, trap 2)
        let req = ["cityid": String(cityId), "streerid": String(streetId), "house": house]
        let result: AddressStatusFetch
        switch await post(PoeConfig.ADDRESS_STATUS, "disconn", req) {
        case .failed(let reason):
            result = .unavailable(reason)
        case .ok(let body):
            if let first = Self.arrayOf(body)?.first as? [String: Any] {
                let status = PoeMapper.addressStatus(Self.plainMap(first), today: today)
                result = status.unparsed ? .unavailable("unparsed")
                    : .confirmed(ConfirmedAddressStatus(status: status, gavMessage: Self.nonBlank(first["gav_message"])))
            } else {
                result = .unavailable("empty")
            }
        }
        if case .confirmed(let value) = result { rememberStatus(key, value) }
        return result
    }

    private func cachedStatus(_ key: String) -> ConfirmedAddressStatus? {
        lock.lock(); defer { lock.unlock() }
        guard let cached = statusCache[key], (0..<PoeConfig.ADDRESS_STATUS_TTL_MS).contains(nowMs() - cached.at) else { return nil }
        return cached.value
    }

    private func rememberStatus(_ key: String, _ value: ConfirmedAddressStatus) {
        lock.lock(); defer { lock.unlock() }
        statusCache[key] = (at: nowMs(), value: value)
    }

    public func registry(_ registryId: Int, date: LocalDate) async -> RegistryFetch {
        let req = ["filialid": String(registryId), "date_in": formatDate(date)]
        switch await post(PoeConfig.REGISTRY, "disconngav", req, readTimeoutMs: PoeConfig.REGISTRY_READ_TIMEOUT_MS) {
        case .failed(let reason):
            return .unavailable(reason)
        case .ok(let body):
            guard let arr = Self.arrayOf(body) else { return .unavailable("not_an_array") }
            let raw = arr.compactMap { item -> String? in
                guard let o = item as? [String: Any], let t = Self.text(o["out_text"]), !t.ktIsBlank else { return nil }
                return t
            }
            return .confirmed(rows: raw.compactMap { PoeMapper.parseRegistryRow($0) }, raw: raw)
        }
    }

    /// The emergency input of `EmergencyLedger` from an E4 answer. Records starting on or after the day
    /// after tomorrow are dropped before the ledger sees them (the adapter rule of the inherited
    /// PowerOn adapter, which applies to POE the same way).
    public static func emergencyFetch(_ fetch: AddressStatusFetch, today: LocalDate) -> EmergencyFetch {
        switch fetch {
        case .unavailable(let reason):
            return .unavailable(reason)
        case .confirmed(let c):
            let horizon = today.plusDays(2).atStartOfDay()
            return .confirmed([c.status.emergency].compactMap { $0 }.filter { $0.start.isBefore(horizon) })
        }
    }
}
