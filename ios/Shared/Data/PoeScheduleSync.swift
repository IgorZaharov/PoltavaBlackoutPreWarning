import Foundation

/// Outcome of a schedule check, in the shape the settings screen shows.
public enum FetchStatus: String, Sendable {
    case SUCCESS
    case NO_INTERNET
    case NO_QUEUES_FOUND
}

public struct ScheduleSyncResult: Sendable {
    public var status: FetchStatus
    public var siteState: SiteState
    /// Active measures (ГАВ, СГАВ, ГОП ...) as one notice text, or nil.
    public var notice: String?
    /// E2 answered (so a nil `notice` means "no measures today", not "unknown").
    public var measuresKnown: Bool = false
}

/// Refreshes the POE queue tables (spec/POE_API.md sections 3, 7; mirror of android PoeScheduleSync.kt):
/// today and tomorrow for all 12 queues in one request each, stored by `ScheduleRepository` as three-state
/// cells. A failure never clears the cached schedule (spec/SITE_STATE.md); tomorrow keeps its cached table
/// when only tomorrow failed.
public enum PoeScheduleSync {
    /// The POE page users know; shown in Settings and checked against `valid-urls.json`.
    public static let DEFAULT_SITE_URL = "https://www.poe.pl.ua/disconnection/power-outages/"

    /// Network seam; tests replace it with a client over a fake transport.
    nonisolated(unsafe) public static var client = PoeClient()

    private static func strip(_ url: String) -> String {
        var t = url.ktTrim()
        while t.hasSuffix("/") { t.removeLast() }
        return t
    }

    /// URLs of the bundled valid-urls.json (app and widget both bundle it), else the POE page.
    public static let validUrls: [String] = {
        guard let url = Bundle.main.url(forResource: "valid-urls", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let list = (try? JSONSerialization.jsonObject(with: data)) as? [Any] else { return [strip(DEFAULT_SITE_URL)] }
        let found = list.compactMap { ($0 as? String).map(strip) }.filter { !$0.isEmpty }
        return found.isEmpty ? [strip(DEFAULT_SITE_URL)] : found
    }()

    public static func isValidUrl(_ url: String) -> Bool {
        let trimmed = strip(url)
        return !trimmed.isEmpty && validUrls.contains(trimmed)
    }

    public static func refresh(
        repo: ScheduleRepository = .shared,
        today: LocalDate = KyivTime.localDateTime(of: Date()).date,
        networkValidated: () -> Bool = { NetworkProbe.isValidated() }
    ) async -> ScheduleSyncResult {
        async let todayFetch = client.schedule(today)
        async let tomorrowFetch = client.schedule(today.plusDays(1))
        async let measuresFetch = client.measures(today)
        let todayResult = await todayFetch
        let tomorrowResult = await tomorrowFetch
        var notice: String?
        var known = false
        if case .ok(let measures) = await measuresFetch {
            notice = noticeOf(measures)
            known = true
        }

        switch todayResult {
        case .ok(let table):
            guard table.kind == .PUBLISHED else {
                return ScheduleSyncResult(status: .NO_QUEUES_FOUND, siteState: .AVAILABLE_NO_TABLE, notice: notice, measuresKnown: known)
            }
            var tomorrow: [String: [ScheduleCell]]?
            switch tomorrowResult {
            case .ok(let next):
                tomorrow = next.kind == .PUBLISHED ? next.queues : nil
            case .unavailable:
                // only tomorrow failed: keep what is cached for it
                var cached: [String: [ScheduleCell]] = [:]
                for q in PoeSchedule.QUEUES {
                    guard let cells = repo.tomorrowCells(q) else { cached = [:]; break }
                    cached[q] = cells
                }
                tomorrow = cached.count == PoeSchedule.QUEUES.count ? cached : nil
            }
            repo.saveAllCellsBatch(today: table.queues, tomorrow: tomorrow)
            return ScheduleSyncResult(status: .SUCCESS, siteState: .AVAILABLE_WITH_TABLE, notice: notice, measuresKnown: known)
        case .unavailable(let reason):
            if reason == "network" || reason.hasPrefix("http_") {
                let state = SiteStateResolver.resolve(failure: .OTHER, hasTodayTable: false, networkValidated: networkValidated())
                return ScheduleSyncResult(status: state == .NO_INTERNET ? .NO_INTERNET : .NO_QUEUES_FOUND, siteState: state,
                                          notice: notice, measuresKnown: known)
            }
            // POE answered, but not with a table we can read (error body, other date, changed layout)
            return ScheduleSyncResult(status: .NO_QUEUES_FOUND, siteState: .AVAILABLE_NO_TABLE, notice: notice, measuresKnown: known)
        }
    }

    /// `ГАВ 08:54–23:59 (за розпорядженням НЕК «Укренерго»)`, one line per measure.
    public static func noticeOf(_ measures: [PoeMeasure]) -> String? {
        if measures.isEmpty { return nil }
        return measures.map { m in
            let reason = m.reason.map { " (\($0))" } ?? ""
            return String(format: "%@ %02d:%02d–%02d:%02d", m.type, m.beginHour, m.beginMinute, m.endHour, m.endMinute) + reason
        }.joined(separator: "\n")
    }
}
