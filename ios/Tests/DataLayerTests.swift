import XCTest
@testable import ZTPreBlackout

/// Fake HTTP for the data-layer tests (directory and catalogue downloads): answers by URL substring, records every request.
final class FakeHttp: HttpClient, @unchecked Sendable {
    private let lock = NSLock()
    private var _urls: [String] = []
    private let routes: [(String, HttpResponse)]
    private let failOn: String?
    private let error: Error

    init(_ routes: [(String, HttpResponse)], failOn: String? = nil, error: Error = URLError(.timedOut)) {
        self.routes = routes
        self.failOn = failOn
        self.error = error
    }

    convenience init(json routes: [(String, String)], failOn: String? = nil) {
        self.init(routes.map { ($0.0, HttpResponse(status: 200, body: Data($0.1.utf8))) }, failOn: failOn)
    }

    var urls: [String] { lock.lock(); defer { lock.unlock() }; return _urls }

    func send(_ request: URLRequest) async throws -> HttpResponse {
        let url = request.url?.absoluteString ?? ""
        lock.lock(); _urls.append(url); lock.unlock()
        if let failOn, url.contains(failOn) { throw error }
        return routes.first { url.contains($0.0) }?.1 ?? HttpResponse(status: 200, body: Data("[]".utf8))
    }
}

private func isolatedDefaults() -> UserDefaults {
    let name = "zt.tests.\(UUID().uuidString)"
    return UserDefaults(suiteName: name)!
}

final class SettingsRepositoryTests: XCTestCase {
    func testDefaultsAndOldIosKeysAreMigrated() {
        let defaults = isolatedDefaults()
        let fresh = SettingsRepository(prefs: Prefs("zt_user_settings_v1", bareKeys: true, defaults: defaults)).getSettings()
        XCTAssertEqual(fresh.advanceNoticeMinutes, 15)
        XCTAssertEqual(fresh.refreshIntervalMinutes, 30)
        XCTAssertEqual(fresh.language, "SYSTEM")

        let old = isolatedDefaults()
        old.set(20, forKey: "advance_notice_minutes")
        old.set(45, forKey: "refresh_interval_minutes")
        old.set("system", forKey: "theme")
        old.set("en", forKey: "language")
        old.set("07.04 19:21", forKey: "active_emergency_outage_start")
        let s = SettingsRepository(prefs: Prefs("zt_user_settings_v1", bareKeys: true, defaults: old)).getSettings()
        XCTAssertEqual(s.advanceNoticeMinutes, 20)
        XCTAssertEqual(s.refreshIntervalMinutes, 45)
        XCTAssertEqual(s.themeMode, "SYSTEM")
        XCTAssertEqual(s.language, "EN")
        XCTAssertNil(old.object(forKey: "advance_notice_minutes"))
        XCTAssertEqual(old.integer(forKey: "advance_minutes"), 20)
        XCTAssertNil(old.object(forKey: "active_emergency_outage_start"))
    }

    func testBothSwitchesOffMuteSoundAndRestoreIt() {
        let repo = SettingsRepository(prefs: Prefs("zt_user_settings_v1", bareKeys: true, defaults: isolatedDefaults()))
        var s = repo.getSettings()
        s.soundEnabled = false
        s.vibrationEnabled = true
        repo.saveSettings(s)
        _ = repo.updateNotificationsEnabled(false)
        let off = repo.updateEmergencyNotificationsEnabled(false)
        XCTAssertFalse(off.soundEnabled)
        XCTAssertFalse(off.vibrationEnabled)
        let on = repo.updateNotificationsEnabled(true)
        XCTAssertFalse(on.soundEnabled, "restored to the remembered value")
        XCTAssertTrue(on.vibrationEnabled)
    }
}

final class StoresTests: XCTestCase {
    func testOutageStateRoundTripAndSiteNoticeRule() {
        let file = "test_outage_\(UUID().uuidString).json"
        let store = OutageStateStore(prefs: Prefs("zt_outage_state_test", defaults: isolatedDefaults()), fileName: file)
        defer { AppGroup.removeFile(file) }
        let t = LocalDateTime(iso: "2026-11-14T10:00")!
        let entry = LedgerEntry(id: "pw_2026-11-14T09:00", start: t.minusHours(1), estimatedEnd: t.plusHours(2), label: "МО",
                                firstSeen: t, lastSeen: t, closedAt: nil, startEmitted: true, endEmitted: false, lastEmittedEta: t.plusHours(2))
        store.saveLedger("16657|вул київська|37", [entry])
        XCTAssertEqual(store.ledger("16657|вул київська|37"), [entry])
        store.saveRepairs("k", [Outage(id: "repair_x", kind: .REPAIR, start: t, end: t.plusHours(3), label: nil)])
        XCTAssertEqual(store.repairs("k").map(\.id), ["repair_x"])

        store.saveSite(.AVAILABLE_NO_TABLE, nowMs: 1, notice: "УВАГА")
        XCTAssertEqual(store.site()?.notice, "УВАГА")
        store.saveSite(.SITE_UNREACHABLE, nowMs: 2)
        XCTAssertNil(store.site()?.notice, "the notice is shown only while the page has no table")
        store.saveSite(.AVAILABLE_WITH_TABLE, nowMs: 3)
        XCTAssertEqual(store.site()?.lastSuccessMs, 3)

        store.saveLedger("16657|вул київська|37", [])
        XCTAssertEqual(store.ledger("16657|вул київська|37"), [])
    }

    func testSubscriptionMigrationRunsOnceAndRoundTrips() {
        let prefs = Prefs("zt_user_settings_v1", bareKeys: true, defaults: isolatedDefaults())
        var counter = 0
        let repo = SubscriptionRepository(prefs: prefs, clock: { 1000 }, random: { counter += 1; return "item000\(counter)" })
        var legacyCalls = 0
        let legacy = LegacySettings(queue: "2.1", customQueueStatusText: nil, selectedAddress: nil, remSlug: "", settlementId: "",
                                    streetId: "", streetName: nil, house: "", notificationsEnabled: true, emergencyNotificationsEnabled: false)
        let first = repo.ensureMigrated { legacyCalls += 1; return legacy }
        XCTAssertEqual(first.items.map(\.queue), ["2.1"])
        XCTAssertTrue(repo.alertsMaster())
        _ = repo.ensureMigrated { legacyCalls += 1; return legacy }
        XCTAssertEqual(legacyCalls, 1, "the migration runs once")
        XCTAssertEqual(SubscriptionRepository.decode(SubscriptionRepository.encode(first)), first)
        XCTAssertNil(SubscriptionRepository.decode("{\"schemaVersion\":2}"))
    }

    func testAlertRegistryMarksOnceAndBoundsEntries() {
        var now: Int64 = 1_000_000_000_000
        let registry = AlertRegistry(prefs: Prefs("zt_notified_test", defaults: isolatedDefaults()), nowMs: { now })
        XCTAssertFalse(registry.hasFired("planned_2026-11-14T18:00"))
        registry.markFired("planned_2026-11-14T18:00")
        XCTAssertTrue(registry.hasFired("planned_2026-11-14T18:00"))
        for i in 0..<(AlertRegistry.MAX_STORED_ENTRIES + 5) {
            now += 1
            registry.markFired("k\(i)")
        }
        XCTAssertFalse(registry.hasFired("planned_2026-11-14T18:00"), "the oldest entry is evicted")
        XCTAssertTrue(registry.hasFired("k\(AlertRegistry.MAX_STORED_ENTRIES + 4)"))
    }
}
