import Foundation

/// Parses the POE schedule page fragment (`newgpv-info.php`, spec/POE_API.md section 3) into 12 queues
/// of 48 `ScheduleCell`s. Pure text scanning (no HTML library), rule for rule the same as android
/// core/PoeSchedule.kt and src/core/poeSchedule.ts. Golden cases: spec/vectors/poe_schedule.json.
public enum PoeSchedule {

    public static let QUEUES = ["1.1", "1.2", "2.1", "2.2", "3.1", "3.2", "4.1", "4.2", "5.1", "5.2", "6.1", "6.2"]

    public enum Kind: String, Hashable, Sendable { case PUBLISHED, NOT_PUBLISHED, INVALID }

    public struct DayTable: Hashable, Sendable {
        public var kind: Kind
        /// Queue -> 48 cells; empty unless `kind` is PUBLISHED.
        public var queues: [String: [ScheduleCell]] = [:]
        /// `Оновлено: 15 листопада 2026 22:46` -> `15 листопада 2026 22:46`.
        public var stamp: String? = nil
        /// Why the answer is INVALID: error_body, no_date, date_mismatch, no_table, bad_row, missing_queue.
        public var reason: String? = nil
    }

    private static let MONTHS = [
        "січня", "лютого", "березня", "квітня", "травня", "червня",
        "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"
    ]
    private static let ws = Rx.ws
    private static let HEADER_DATE = Rx("([0-9]{1,2})\(ws)+(\(MONTHS.joined(separator: "|")))\(ws)+([0-9]{4})")
    private static let ROW = Rx("<td\(ws)+class=\"gpv-q\"[^>]*>\(ws)*([0-9.]+)\(ws)*</td>(.*?)</tr>", dotAll: true)
    private static let CELL = Rx("<td\(ws)+class=\"([^\"]*)\"")
    private static let STAMP = Rx("Оновлено:\(ws)*([^<]+)")
    private static let TABLE_MARK = "class=\"gpv-table\""
    private static let NO_OUTAGES_MARK = "не застосов"

    private static func invalid(_ reason: String) -> DayTable { DayTable(kind: .INVALID, reason: reason) }

    private static func cellOf(_ classes: String) -> ScheduleCell? {
        let tokens = Set(classes.split(separator: " ").map(String.init))
        if !tokens.contains("gpv-c") { return nil }
        if tokens.contains("gpv-s2") { return .OFF }
        if tokens.contains("gpv-s3") { return .SWITCHING }
        if tokens.contains("gpv-s1") { return .ON }
        return nil
    }

    /// Parses the answer for `date`. An empty body is "not published yet"; it is never "no outages".
    public static func parseDay(_ html: String?, date: LocalDate) -> DayTable {
        let body = html?.ktTrim() ?? ""
        if body.isEmpty { return DayTable(kind: .NOT_PUBLISHED) }
        if body.ktStartsWith("{") || body.ktStartsWith("[") { return invalid("error_body") }

        let ns = body as NSString
        let tableRange = ns.range(of: TABLE_MARK, options: .literal)
        let tableAt = tableRange.location
        let head = tableAt != NSNotFound ? ns.substring(to: tableAt) : body
        guard let dm = HEADER_DATE.firstMatch(in: head) else { return invalid("no_date") }
        let hns = head as NSString
        let monthIndex = MONTHS.firstIndex(of: Rx.group(dm, 2, in: hns) ?? "") ?? -1
        guard let day = Int(Rx.group(dm, 1, in: hns) ?? ""),
              let year = Int(Rx.group(dm, 3, in: hns) ?? ""),
              let headerDate = LocalDate(year: year, month: monthIndex + 1, day: day)
        else { return invalid("no_date") }
        if headerDate != date { return invalid("date_mismatch") }
        var stamp: String?
        if let sm = STAMP.firstMatch(in: body), let s = Rx.group(sm, 1, in: ns)?.ktTrim(), !s.isEmpty { stamp = s }

        if tableAt == NSNotFound {
            if !head.ktContains(NO_OUTAGES_MARK) { return invalid("no_table") }
            let allOn = [ScheduleCell](repeating: .ON, count: OutageConfig.SLOTS_PER_DAY)
            return DayTable(kind: .PUBLISHED, queues: Dictionary(uniqueKeysWithValues: QUEUES.map { ($0, allOn) }), stamp: stamp)
        }

        let endRange = ns.range(of: "</table>", options: .literal, range: NSRange(location: tableAt, length: ns.length - tableAt))
        let tableEnd = endRange.location == NSNotFound ? ns.length : endRange.location
        let table = ns.substring(with: NSRange(location: tableAt, length: tableEnd - tableAt))
        let tns = table as NSString
        var queues: [String: [ScheduleCell]] = [:]
        for row in ROW.allMatches(in: table) {
            let queue = Rx.group(row, 1, in: tns) ?? ""
            if !QUEUES.contains(queue) || queues[queue] != nil { return invalid("bad_row") }
            let rowCells = Rx.group(row, 2, in: tns) ?? ""
            let rns = rowCells as NSString
            var cells: [ScheduleCell] = []
            for c in CELL.allMatches(in: rowCells) {
                guard let cell = cellOf(Rx.group(c, 1, in: rns) ?? "") else { return invalid("bad_row") }
                cells.append(cell)
            }
            if cells.count != OutageConfig.SLOTS_PER_DAY { return invalid("bad_row") }
            queues[queue] = cells
        }
        if queues.count != QUEUES.count { return invalid("missing_queue") }
        return DayTable(kind: .PUBLISHED, queues: queues, stamp: stamp)
    }
}
