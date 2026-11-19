import Foundation

/// Pure mapping of Полтаваобленерго (POE) answers to outages: the per-house status (queue, emergency
/// «пошкодження», repair works) and the per-branch outage registry. Mirror of android core/PoeMapper.kt
/// and src/core/poeMapper.ts. Rules: spec/POE_API.md section 8, golden cases: spec/vectors/poe_api.json.
/// No I/O: the per-house answer comes in as a plain JSON object (`JSONSerialization` output).
public enum PoeMapper {

    public static let LABEL_EMERGENCY = "Аварійна перерва"
    public static let LABEL_OTHER = "Перерва в електропостачанні"
    public static let LABEL_REPAIR = "Планові роботи"

    public enum RegistryKind: String, Hashable, Sendable { case EMERGENCY, REPAIR, MIRROR }
    public enum Match: String, Hashable, Sendable { case CONFIRMED, STREET, NONE }

    public struct TimeRange: Hashable, Sendable {
        public var start: LocalDateTime
        public var end: LocalDateTime
    }

    public struct AddressStatus: Hashable, Sendable {
        public var messageType: Int
        public var queue: String?
        public var emergency: EmergencyRecord?
        public var repairs: [Outage]
        /// The house is off because of the hourly schedule (type 4, spec/POE_API.md 8.5): a mirror of E1, not an emergency.
        public var scheduleMirror: Bool
        /// The answer names an outage that could not be read: the fetch counts as unavailable.
        public var unparsed: Bool
        /// No queue because the address has several connections (section 8.5 step 6): unknown, not "no queue".
        public var severalConnections: Bool
    }

    public struct StreetEntry: Hashable, Sendable {
        public var street: String
        public var houses: [String]
    }

    public struct Place: Hashable, Sendable {
        public var settlement: String
        public var streets: [StreetEntry]
        public var freeText: [String]
    }

    public struct RegistryRow: Hashable, Sendable {
        public var id: String
        public var start: LocalDateTime
        public var end: LocalDateTime?
        public var reason: String
        public var kind: RegistryKind
        public var places: [Place]
    }

    // Java's \s and \d are ASCII only, ICU's are Unicode: the classes are spelled out (Rx.ws, [0-9]).
    private static let ws = Rx.ws
    private static let TIME = Rx("^\(ws)*([0-9]{1,2})\\.([0-9]{1,2})\\.([0-9]{4})\(ws)+([0-9]{1,2}):([0-9]{2})(?::[0-9]{2})?")
    private static let ETA = Rx(
        "([0-9]{1,2})\\.([0-9]{1,2})\\.([0-9]{4})\(ws)*р\\.?\(ws)*о\(ws)*([0-9]{1,2})\(ws)*годин[^\(Rx.wsChars)]*\(ws)*([0-9]{1,2})\(ws)*хвилин"
    )
    private static let PLANNED = Rx(
        "([0-9]{1,2})\\.([0-9]{1,2})\\.([0-9]{4})\(ws)*р\\.?\(ws)*з\(ws)*([0-9]{1,2})(?:[:.]([0-9]{2}))?(?:-?ї)?\(ws)*до\(ws)*([0-9]{1,2})(?:[:.]([0-9]{2}))?(?:-?ї)?\(ws)*годин"
    )
    private static let BR = Rx("<br\(ws)*/?>", ignoreCase: true)
    private static let GROUP_BREAK = Rx("<br\(ws)*/?>[\(Rx.wsChars),]*<br\(ws)*/?>", ignoreCase: true)
    private static let TAG = Rx("<[^>]*>")
    private static let TD = Rx("<td[^>]*>(.*?)</td>", ignoreCase: true, dotAll: true)
    private static let STREET_LINE = Rx("^<b>(.+?)</b>\(ws)*(?:\\(б\\.\(ws)*(.*?)\\))?$", dotAll: true)
    private static let SPACES = Rx("[\(Rx.wsChars)\\x{00A0}\\x{200B}]+")
    private static let SETTLEMENT_TYPE = Rx("^(?:місто|село|селище|смт\\.?|сщ\\.|м\\.|с\\.)\(ws)*")
    private static let BRACKET_TAIL = Rx("\(ws)*\\([^)]*\\)\(ws)*$")
    private static let GLUED_ABBREVIATION = Rx("^(\\p{L}{1,6}\\.)(?=\\p{L})")
    private static let DIGIT = Rx("[0-9]")
    private static let QUEUE_MAJOR = Rx("[1-6]")
    private static let QUEUE_MINOR = Rx("[12]")

    /// Group `i` of a match, "" when it did not take part (Kotlin `groupValues`).
    private static func g(_ m: NSTextCheckingResult, _ i: Int, _ ns: NSString) -> String {
        Rx.group(m, i, in: ns) ?? ""
    }

    // MARK: - Times (sections 8.1 - 8.3)

    private static func dateTime(_ day: Int, _ month: Int, _ year: Int, _ hour: Int, _ minute: Int, allow24: Bool) -> LocalDateTime? {
        if allow24 && hour == 24 && minute == 0 {
            return LocalDate(year: year, month: month, day: day)?.plusDays(1).atStartOfDay()
        }
        return LocalDateTime(year: year, month: month, day: day, hour: hour, minute: minute)
    }

    /// `DD.MM.YYYY HH:mm[:ss]` -> wall-clock time; anything impossible or else -> nil.
    public static func parseTime(_ raw: String?) -> LocalDateTime? {
        guard let raw, let m = TIME.firstMatch(in: raw) else { return nil }
        let ns = raw as NSString
        return dateTime(Int(g(m, 1, ns))!, Int(g(m, 2, ns))!, Int(g(m, 3, ns))!, Int(g(m, 4, ns))!, Int(g(m, 5, ns))!, allow24: false)
    }

    /// Estimated end inside `fn_accident_message` (`... DD.MM.YYYY р. о HH годин(и) MM хвилин(и)`).
    public static func parseEta(_ message: String?) -> LocalDateTime? {
        guard let message, !message.isEmpty else { return nil }
        let full = message as NSString
        let at = full.range(of: "закінчення", options: .literal).location
        let part = at != NSNotFound ? full.substring(from: at) : message
        guard let m = ETA.firstMatch(in: part) else { return nil }
        let ns = part as NSString
        return dateTime(Int(g(m, 1, ns))!, Int(g(m, 2, ns))!, Int(g(m, 3, ns))!, Int(g(m, 4, ns))!, Int(g(m, 5, ns))!, allow24: true)
    }

    /// Future repair works of `planned_message`, in text order, exact duplicates removed.
    public static func parsePlannedList(_ text: String?) -> [TimeRange] {
        guard let text, !text.isEmpty else { return [] }
        var out: [TimeRange] = []
        for part in BR.split(text) {
            guard let m = PLANNED.firstMatch(in: part) else { continue }
            let ns = part as NSString
            let day = Int(g(m, 1, ns))!
            let month = Int(g(m, 2, ns))!
            let year = Int(g(m, 3, ns))!
            let m1 = g(m, 5, ns)
            let m2 = g(m, 7, ns)
            guard let start = dateTime(day, month, year, Int(g(m, 4, ns))!, Int(m1.isEmpty ? "0" : m1)!, allow24: true),
                  let end = dateTime(day, month, year, Int(g(m, 6, ns))!, Int(m2.isEmpty ? "0" : m2)!, allow24: true)
            else { continue }
            if !end.isAfter(start) { continue }
            let range = TimeRange(start: start, end: end)
            if !out.contains(range) { out.append(range) }
        }
        return out
    }

    /// `gp_qnum_1` + `gp_qnum_2` -> `"4.2"`; anything outside 1..6 / 1..2 (both empty included) -> nil.
    public static func parseQueue(_ q1: String?, _ q2: String?) -> String? {
        let a = q1?.ktTrim() ?? ""
        let b = q2?.ktTrim() ?? ""
        if !QUEUE_MAJOR.matches(a) || !QUEUE_MINOR.matches(b) { return nil }
        return "\(a).\(b)"
    }

    // MARK: - Per-house status (section 8.5)

    /// JSON number or numeric string -> Int; JSON null, a fraction or anything else -> nil.
    private static func intOf(_ v: Any?) -> Int? {
        if let s = v as? String { return Int(s.ktTrim()) }
        if let n = v as? NSNumber {
            let d = n.doubleValue
            return d.isFinite && d == d.rounded(.down) ? n.intValue : nil
        }
        return nil
    }

    /// JSON string, or a number as text; JSON null -> nil.
    private static func strOf(_ v: Any?) -> String? {
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return intOf(n).map { String($0) } ?? n.stringValue }
        return nil
    }

    /// Maps the first element of the per-house answer (E4) to outages.
    public static func addressStatus(_ result: [String: Any], today: LocalDate) -> AddressStatus {
        let messageType = intOf(result["message_type"]) ?? -1
        let queue = parseQueue(strOf(result["gp_qnum_1"]), strOf(result["gp_qnum_2"]))
        let start = parseTime(strOf(result["accident_str"]))
        var eta = parseEta(strOf(result["fn_accident_message"]))
        if let e = eta, !(start != nil && e.isAfter(start!)) { eta = nil }

        var emergency: EmergencyRecord?
        var unparsed = false
        var scheduleMirror = false
        let message = (strOf(result["fn_accident_message"]) ?? "").lowercased()
        var repairIds: [String] = []
        var repairs: [String: Outage] = [:]

        func addRepair(_ s: LocalDateTime, _ e: LocalDateTime) {
            let id = "repair_\(s)"
            if let prev = repairs[id] {
                if e.isAfter(prev.end) { repairs[id] = Outage(id: id, kind: .REPAIR, start: s, end: e, label: LABEL_REPAIR) }
            } else {
                repairIds.append(id)
                repairs[id] = Outage(id: id, kind: .REPAIR, start: s, end: e, label: LABEL_REPAIR)
            }
        }

        switch messageType {
        case 0:
            break
        case 2:
            if let s = start, let e = eta { addRepair(s, e) } else { unparsed = true }
        default:
            if messageType != 3 && (message.ktContains("гпв") || message.ktContains("погодинн")) {
                scheduleMirror = true
            } else if let s = start {
                let accidentId = intOf(result["accident_id"]).flatMap { $0 > 0 ? $0 : nil }
                emergency = EmergencyRecord(
                    id: accidentId != nil ? "poe_\(accidentId!)" : "poe_\(s)",
                    start: s,
                    estimatedEnd: eta,
                    label: messageType == 3 ? LABEL_EMERGENCY : LABEL_OTHER
                )
            } else {
                unparsed = true
            }
        }

        let horizon = today.plusDays(2).atStartOfDay()
        for r in parsePlannedList(strOf(result["planned_message"])) where r.start.isBefore(horizon) {
            addRepair(r.start, r.end)
        }
        let several = queue == nil && message.ktContains("декілька підключень")
        let sorted = repairIds.compactMap { repairs[$0] }.stableSorted { $0.start < $1.start }
        return AddressStatus(
            messageType: messageType, queue: queue, emergency: emergency, repairs: sorted,
            scheduleMirror: scheduleMirror, unparsed: unparsed, severalConnections: several
        )
    }

    // MARK: - Branch registry (sections 8.6 - 8.9)

    public static func classifyRegistryReason(_ reason: String?) -> RegistryKind {
        let r = (reason?.ktTrim() ?? "").lowercased()
        if r.ktContains("авар") { return .EMERGENCY }
        if r.ktContains("гпв") || r.ktContains("графік") { return .MIRROR }
        return .REPAIR
    }

    private static func stripTags(_ s: String) -> String { TAG.replace(s, template: "") }

    /// Kotlin `s.trim().removeSuffix(",").trim()`.
    private static func trimComma(_ s: String) -> String {
        var t = s.ktTrim()
        if t.hasSuffix(",") { t.removeLast() }
        return t.ktTrim()
    }

    private static func trimmedPieces(_ s: String, by separator: String) -> [String] {
        s.components(separatedBy: separator).map { $0.ktTrim() }
    }

    public static func parseRegistryRow(_ outText: String?) -> RegistryRow? {
        guard let outText else { return nil }
        let ns = outText as NSString
        let cells = TD.allMatches(in: outText).map { g($0, 1, ns) }
        if cells.count < 4 { return nil }
        guard let start = parseTime(TextNorm.decodeEntities(stripTags(cells[0]))) else { return nil }
        let end = parseTime(TextNorm.decodeEntities(stripTags(cells[1])))
        let reason = TextNorm.decodeEntities(stripTags(cells[3])).ktTrim()
        return RegistryRow(
            id: "poe_reg_\(start)",
            start: start,
            end: end,
            reason: reason,
            kind: classifyRegistryReason(reason),
            places: parsePlaces(cells[2])
        )
    }

    public static func parsePlaces(_ html: String) -> [Place] {
        var out: [Place] = []
        for group in GROUP_BREAK.split(TextNorm.decodeEntities(html)) {
            let lines = BR.split(group).map { $0.ktTrim() }.filter { !$0.isEmpty }
            if lines.isEmpty { continue }
            let settlement = trimComma(stripTags(lines[0]))
            if settlement.isEmpty { continue }
            var streets: [StreetEntry] = []
            var freeText: [String] = []
            for raw in lines.dropFirst() {
                let line = trimComma(raw)
                if let m = STREET_LINE.firstMatch(in: line) {
                    let lns = line as NSString
                    let houses = trimmedPieces(g(m, 2, lns), by: ",").filter { !$0.isEmpty }
                    streets.append(StreetEntry(street: g(m, 1, lns).ktTrim(), houses: houses))
                    continue
                }
                let text = trimComma(stripTags(line))
                if text.isEmpty { continue }
                freeText.append(text)
                let parts = trimmedPieces(text, by: ",")
                if parts.count >= 3 && DIGIT.containsMatch(in: parts[parts.count - 1]) {
                    streets.append(StreetEntry(street: parts[parts.count - 2], houses: [parts[parts.count - 1]]))
                } else if parts.count == 2 && !parts[1].isEmpty {
                    streets.append(StreetEntry(street: parts[1], houses: []))
                }
            }
            out.append(Place(settlement: settlement, streets: streets, freeText: freeText))
        }
        return out
    }

    /// `м.Полтава`, `місто Полтава`, `Полтава` -> one key; a bracketed tail such as `(... ТГ)` is ignored.
    public static func settlementKey(_ name: String) -> String {
        var s = SPACES.replace(TextNorm.decodeEntities(name).lowercased(), template: " ").ktTrim()
        s = SETTLEMENT_TYPE.replace(s, template: "")
        s = BRACKET_TAIL.replace(s, template: "").ktTrim()
        return StreetKey.of(s)
    }

    /// `вул.Дружби`, `вул. Дружби ` and `вул. Дружби (Леніна)` -> one key.
    public static func streetKey(_ name: String) -> String {
        var s = SPACES.replace(TextNorm.decodeEntities(name), template: " ").ktTrim()
        s = BRACKET_TAIL.replace(s, template: "").ktTrim()
        s = GLUED_ABBREVIATION.replace(s, template: "$1 ")
        return StreetKey.of(s)
    }

    // MARK: - Nearby outages card (section 8.10)

    public enum NearbyStatus: String, Hashable, Sendable {
        case ACTIVE, UPCOMING, FINISHED

        var ordinal: Int {
            switch self {
            case .ACTIVE: return 0
            case .UPCOMING: return 1
            case .FINISHED: return 2
            }
        }
    }

    public struct NearbyStreet: Hashable, Sendable {
        public var name: String
        public var houses: [String]
        public var mine: Bool
    }

    public struct NearbyOutage: Hashable, Sendable {
        public var id: String
        public var kind: RegistryKind
        public var start: LocalDateTime
        public var end: LocalDateTime?
        public var reason: String
        public var status: NearbyStatus
        public var streets: [NearbyStreet]
        public var match: Match
    }

    /// Street of a registry row while merging: display name, houses by HouseKey in first-seen order, whole street.
    private struct MergedStreet {
        var name: String
        var houseKeys: [String] = []
        var houses: [String: String] = [:]
        var whole = false
    }

    /// The registry rows of the address's settlement for the card «Ремонти й пошкодження поруч»
    /// (display only: alerts and the timer come from the per-house status).
    public static func nearbyOutages(
        _ rows: [RegistryRow], settlement: String, street: String, house: String, now: LocalDateTime
    ) -> [NearbyOutage] {
        let sk = settlementKey(settlement)
        let userStreet: String? = street.ktIsBlank ? nil : streetKey(street)
        var out: [NearbyOutage] = []
        for row in rows {
            if row.kind == .MIRROR { continue }
            let groups = row.places.filter { settlementKey($0.settlement) == sk }
            if groups.isEmpty { continue }
            var order: [String] = []
            var merged: [String: MergedStreet] = [:]
            for grp in groups {
                for s in grp.streets {
                    let key = streetKey(s.street)
                    var m = merged[key] ?? MergedStreet(name: SPACES.replace(s.street, template: " ").ktTrim())
                    if merged[key] == nil { order.append(key) }
                    for h in s.houses {
                        let t = h.ktTrim()
                        if t.isEmpty { continue }
                        let hk = HouseKey.of(t)
                        if m.houses[hk] == nil {
                            m.houses[hk] = t
                            m.houseKeys.append(hk)
                        }
                    }
                    m.whole = m.whole || s.houses.isEmpty
                    merged[key] = m
                }
            }
            let streets = order.map { key -> NearbyStreet in
                let v = merged[key]!
                return NearbyStreet(
                    name: v.name,
                    houses: v.whole ? [] : v.houseKeys.compactMap { v.houses[$0] },
                    mine: userStreet != nil && key == userStreet!
                )
            }
            // only outages on the user's own street (owner, 2026-11-16)
            if !streets.contains(where: { $0.mine }) { continue }
            let status: NearbyStatus
            if now.isBefore(row.start) {
                status = .UPCOMING
            } else if let end = row.end, !now.isBefore(end) {
                status = .FINISHED
            } else {
                status = .ACTIVE
            }
            let match: Match = (!street.ktIsBlank && !house.ktIsBlank)
                ? registryMatch(row.places, settlement: settlement, street: street, house: house)
                : .NONE
            let item = NearbyOutage(
                id: row.id, kind: row.kind, start: row.start, end: row.end, reason: row.reason,
                status: status, streets: streets, match: match
            )
            let duplicate = out.contains { $0.id == item.id && $0.kind == item.kind && $0.end == item.end && $0.streets == item.streets }
            if !duplicate { out.append(item) }
        }
        return out.stableSorted { a, b in
            if a.status.ordinal != b.status.ordinal { return a.status.ordinal < b.status.ordinal }
            if a.start != b.start { return a.start < b.start }
            return a.id.utf16.lexicographicallyPrecedes(b.id.utf16)
        }
    }

    /// Registry rows (8.7) that name the house itself (`registryMatch` CONFIRMED), as REPAIR outages of the
    /// address (owner, 2026-11-17: a repair or fault listed for the house must reach the drum, the list and
    /// the timer even when the per-house status says nothing). Rows without an end and ГПВ mirror rows are
    /// left out; a row naming only the street never becomes an outage (registry lists are incomplete).
    public static func registryRepairs(_ rows: [RegistryRow], settlement: String, street: String, house: String) -> [Outage] {
        if street.ktIsBlank || house.ktIsBlank { return [] }
        var ids: [String] = []
        var byId: [String: Outage] = [:]
        for row in rows {
            if row.kind == .MIRROR { continue }
            guard let end = row.end else { continue }
            if !end.isAfter(row.start) { continue }
            if registryMatch(row.places, settlement: settlement, street: street, house: house) != .CONFIRMED { continue }
            let id = "registry_\(row.start)_\(end)"
            if byId[id] == nil {
                ids.append(id)
                byId[id] = Outage(id: id, kind: .REPAIR, start: row.start, end: end, label: LABEL_REPAIR)
            }
        }
        return ids.compactMap { byId[$0] }.stableSorted { $0.start < $1.start }
    }

    /// Does a registry row name the address? Registry house lists are incomplete, see section 6.
    public static func registryMatch(_ places: [Place], settlement: String, street: String, house: String) -> Match {
        let sk = settlementKey(settlement)
        let stk = streetKey(street)
        var streetSeen = false
        for p in places where settlementKey(p.settlement) == sk {
            for s in p.streets where streetKey(s.street) == stk {
                if !s.houses.isEmpty && HouseKey.listContains(s.houses.joined(separator: ", "), house: house) { return .CONFIRMED }
                streetSeen = true
            }
        }
        return streetSeen ? .STREET : .NONE
    }
}
