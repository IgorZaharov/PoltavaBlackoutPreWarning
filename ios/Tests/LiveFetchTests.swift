import XCTest
@testable import ZTPreBlackout

/// Talks to the real www.poe.pl.ua. Runs only when the test runner has `ZT_LIVE=1` (CI passes
/// `TEST_RUNNER_ZT_LIVE=1`), so local and offline runs stay deterministic. Prints what it parsed, so the
/// CI log shows the live 12×48 queue table (milestone I2 in docs/ios/POLTAVA_IOS_PLAN.md).
///
/// POE drops connections from GitHub-hosted runners outside Ukraine (I0 geo-check, plan section 9). A
/// request that never reached the host is printed and skipped; an answer that arrived but cannot be read
/// still fails, and the recorded answers in spec/fixtures/poe carry the parser checks (PoeDataTests).
final class LiveFetchTests: XCTestCase {
    private let client = PoeClient()

    override func setUpWithError() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["ZT_LIVE"] == "1", "live network tests are off")
    }

    private func skipWhenUnreachable(_ reason: String, _ what: String) throws {
        if reason == "network" {
            print("[live] POE \(what): host not reachable from this runner (expected outside Ukraine)")
            throw XCTSkip("www.poe.pl.ua is not reachable from this runner")
        }
    }

    private static func bits(_ cells: [ScheduleCell]) -> String {
        String(cells.map { c -> Character in
            switch c {
            case .ON: return "."
            case .OFF: return "#"
            case .SWITCHING: return "~"
            }
        })
    }

    func testLiveScheduleTable() async throws {
        let today = KyivTime.localDateTime(of: Date()).date
        let fetch = await client.schedule(today)
        guard case .ok(let table) = fetch else {
            if case .unavailable(let reason) = fetch {
                try skipWhenUnreachable(reason, "E1 schedule")
                XCTFail("POE answered E1 but the table could not be read: \(reason)")
            }
            return
        }
        print("[live] POE E1 \(today): \(table.kind.rawValue), stamp: \(table.stamp ?? "-")")
        guard table.kind == .PUBLISHED else { return }
        print("[live]      00  02  04  06  08  10  12  14  16  18  20  22    (# off, ~ switching)")
        for q in PoeSchedule.QUEUES {
            let cells = try XCTUnwrap(table.queues[q], "queue \(q) missing from today's table")
            XCTAssertEqual(cells.count, 48, "queue \(q)")
            print("[live] \(q)  \(Self.bits(cells))")
        }
        let measures = await client.measures(today)
        if case .ok(let list) = measures { print("[live] POE E2 measures: \(PoeScheduleSync.noticeOf(list) ?? "none")") }
    }

    /// Соборності 1, Полтава: queue and emergency of one house (E4).
    func testLiveAddressStatus() async throws {
        let today = KyivTime.localDateTime(of: Date()).date
        let fetch = await client.addressStatus(cityId: 11389, streetId: 1227174, house: "1", today: today)
        switch fetch {
        case .unavailable(let reason):
            try skipWhenUnreachable(reason, "E4 house status")
            XCTFail("POE answered E4 but it could not be read: \(reason)")
        case .confirmed(let c):
            print("[live] POE E4 Соборності 1: queue \(c.status.queue ?? "-"), type \(c.status.messageType), "
                  + "emergency \(c.status.emergency.map { "\($0.start)" } ?? "none"), repairs \(c.status.repairs.count)")
        }
    }

    /// The registry of the Poltava united branch (E5).
    func testLiveRegistry() async throws {
        let today = KyivTime.localDateTime(of: Date()).date
        let fetch = await client.registry(23, date: today)
        switch fetch {
        case .unavailable(let reason):
            try skipWhenUnreachable(reason, "E5 registry")
            XCTFail("POE answered E5 but it could not be read: \(reason)")
        case .confirmed(let rows, let raw):
            print("[live] POE E5 branch 23: \(rows.count) rows parsed of \(raw.count)")
        }
    }
}
