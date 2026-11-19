import XCTest
@testable import ZTPreBlackout

/// Fake POE transport: answers every POST with `answer`, records the calls (port of the Kotlin
/// `FakeTransport` of PoeClientTest.kt).
final class FakePoeTransport: PoeTransport, @unchecked Sendable {
    struct Call {
        var endpoint: String
        var field: String
        var json: [String: Any]
        var timeout: Int
    }

    private let lock = NSLock()
    private var _calls: [Call] = []
    private let answer: @Sendable (Call) -> PoeHttpResult

    init(_ answer: @escaping @Sendable (Call) -> PoeHttpResult) {
        self.answer = answer
    }

    convenience init(body: String) {
        self.init { _ in .ok(body) }
    }

    var calls: [Call] {
        lock.lock(); defer { lock.unlock() }
        return _calls
    }

    func post(_ endpoint: String, field: String, json: String, readTimeoutMs: Int) async -> PoeHttpResult {
        let obj = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
        let call = Call(endpoint: endpoint, field: field, json: obj, timeout: readTimeoutMs)
        record(call)
        return answer(call)
    }

    private func record(_ call: Call) {
        lock.lock(); defer { lock.unlock() }
        _calls.append(call)
    }
}

/// The recorded POE answers of 2026-11-16 (spec/fixtures/poe, a folder resource of the test target).
func poeFixture(_ name: String, file: StaticString = #filePath, line: UInt = #line) throws -> String {
    let bundle = Bundle(for: FakePoeTransport.self)
    let dir = try XCTUnwrap(bundle.url(forResource: "poe", withExtension: nil), "spec/fixtures/poe is not in the test bundle",
                            file: file, line: line)
    return try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
}

private func testDefaults() -> UserDefaults { UserDefaults(suiteName: "zt.poe.\(UUID().uuidString)")! }

/// The bundled directory of the app target (the tests run inside the app, so `Bundle.main` holds it).
private func bundledDirectory(file: StaticString = #filePath, line: UInt = #line) throws -> PoeDirectoryIndex {
    let url = try XCTUnwrap(Bundle.main.url(forResource: "poe_directory", withExtension: "json"), "poe_directory.json is not in the app",
                            file: file, line: line)
    return try XCTUnwrap(PoeDirectoryIndex.fromJson(try Data(contentsOf: url)), file: file, line: line)
}

/// Port of android PoeClientTest.kt: request shape, tri-state results, and that a failure is never "no outage".
final class PoeClientTests: XCTestCase {
    private let today = LocalDate(year: 2026, month: 11, day: 16)!

    // MARK: E1 schedule

    func testScheduleOfTodayIsParsedAndRequestedWithHyphenDate() async throws {
        let html = try poeFixture("poe_newgpv_2026-11-16.html")
        let t = FakePoeTransport(body: html)
        let r = await PoeClient(transport: t).schedule(today)
        XCTAssertEqual(t.calls.count, 1)
        XCTAssertEqual(t.calls.first?.endpoint, PoeConfig.SCHEDULE)
        XCTAssertEqual(t.calls.first?.field, "seldate")
        XCTAssertEqual(t.calls.first?.json["date_in"] as? String, "16-11-2026")
        guard case .ok(let table) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(table.kind, .PUBLISHED)
        XCTAssertEqual(table.queues.count, 12)
        let q11 = try XCTUnwrap(table.queues["1.1"])
        XCTAssertEqual(q11[0], .SWITCHING)
        XCTAssertEqual(q11[8], .OFF)        // 04:00
        XCTAssertEqual(q11[14], .SWITCHING) // 07:00
    }

    func testEmptyBodyIsNotPublishedButErrorBodyAndNetworkFailureAreUnavailable() async throws {
        let empty = await PoeClient(transport: FakePoeTransport(body: "")).schedule(today.plusDays(1))
        guard case .ok(let table) = empty else { return XCTFail("\(empty)") }
        XCTAssertEqual(table.kind, .NOT_PUBLISHED)
        let error = await PoeClient(transport: FakePoeTransport(body: "{\"title\":\"Bad Request\",\"status\":400}")).schedule(today)
        XCTAssertEqual(error, .unavailable("error_body"))
        let network = await PoeClient(transport: FakePoeTransport { _ in .failed("network") }).schedule(today)
        XCTAssertEqual(network, .unavailable("network"))
        // the live page asked for tomorrow is a date mismatch, never tomorrow's table
        let page = try poeFixture("poe_newgpv_2026-11-16.html")
        let wrongDay = await PoeClient(transport: FakePoeTransport(body: page)).schedule(today.plusDays(1))
        XCTAssertEqual(wrongDay, .unavailable("date_mismatch"))
    }

    // MARK: E2 measures, E3 directory

    func testMeasuresListGavAndGop() async throws {
        let unloading = try poeFixture("poe_unloading_2026-11-16.json")
        let r = await PoeClient(transport: FakePoeTransport(body: unloading)).measures(today)
        guard case .ok(let measures) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(measures.map(\.type), ["ГАВ", "ГОП"])
        XCTAssertEqual(measures[0].beginHour, 8)
        XCTAssertEqual(measures[0].beginMinute, 54)
        XCTAssertEqual(measures[0].reason, "за розпорядженням НЕК «Укренерго»")
        XCTAssertNil(measures[0].note, "JSON null is no note")
        let none = await PoeClient(transport: FakePoeTransport(body: "[]")).measures(today)
        XCTAssertEqual(none, .ok([]))
        if case .ok = await PoeClient(transport: FakePoeTransport(body: "<html>")).measures(today) { XCTFail("HTML is not an answer") }
        let firstLine = PoeScheduleSync.noticeOf(measures)?.components(separatedBy: "\n").first
        XCTAssertEqual(firstLine, "ГАВ 08:54–23:59 (за розпорядженням НЕК «Укренерго»)")
        XCTAssertNil(PoeScheduleSync.noticeOf([]))
    }

    func testDirectoryDropsJunkRowsAndSendsTheCabinetBranchId() async throws {
        let t = FakePoeTransport(body: try poeFixture("poe_cabinet_cities_filial123.json"))
        let r = await PoeClient(transport: t).cities(123)
        let req = try XCTUnwrap(t.calls.first?.json)
        XCTAssertEqual(req["operation_type"] as? String, "city")
        XCTAssertEqual(req["filial_id"] as? String, "123")
        XCTAssertEqual(req["city_id"] as? String, "")
        guard case .ok(let options) = r else { return XCTFail("\(r)") }
        XCTAssertTrue(options.contains { $0.id == 11389 && $0.name == "місто Полтава" })
        XCTAssertFalse(options.contains { $0.name.ktTrim() == "село _" })

        let buildings = try poeFixture("poe_cabinet_buildings_poltava_sobornosti.json")
        let houses = await PoeClient(transport: FakePoeTransport(body: buildings)).buildings(123, cityId: 11389, streetId: 1227174)
        guard case .ok(let list) = houses else { return XCTFail("\(houses)") }
        XCTAssertTrue(Set(list.map(\.name)).isSuperset(of: ["1", "11/13"]))
        XCTAssertTrue(PoeClient.isJunkName("село _"))
        XCTAssertTrue(PoeClient.isJunkName("  "))
        XCTAssertFalse(PoeClient.isJunkName("село Зуївці"))
    }

    // MARK: E4 per-house status

    func testAddressStatusUsesPoeKeySpellingAndMapsTheEmergency() async throws {
        let t = FakePoeTransport(body: try poeFixture("poe_result_type3_emergency_noqueue.json"))
        let r = await PoeClient(transport: t).addressStatus(cityId: 11143, streetId: 1012802, house: "9", today: today)
        let req = try XCTUnwrap(t.calls.first?.json)
        XCTAssertEqual(req["cityid"] as? String, "11143")
        XCTAssertEqual(req["streerid"] as? String, "1012802")
        XCTAssertEqual(req["house"] as? String, "9")
        let c = try XCTUnwrap(r.confirmedStatus, "\(r)")
        XCTAssertNil(c.status.queue)
        XCTAssertEqual(c.status.emergency?.id, "poe_3462256")
        XCTAssertTrue(c.gavMessage?.contains("СГАВ") == true)
        guard case .confirmed(let records) = PoeClient.emergencyFetch(r, today: today) else { return XCTFail("not confirmed") }
        XCTAssertEqual(records.map(\.id), ["poe_3462256"])
    }

    func testAddressStatusWithNothingRegisteredIsAConfirmedEmptyEmergencyList() async throws {
        let none = try poeFixture("poe_result_type0_none.json")
        let r = await PoeClient(transport: FakePoeTransport(body: none)).addressStatus(cityId: 11389, streetId: 1227174, house: "1", today: today)
        XCTAssertEqual(r.confirmedStatus?.status.queue, "1.1")
        XCTAssertEqual(PoeClient.emergencyFetch(r, today: today), .confirmed([]))
    }

    func testSeveralConnectionsGiveNoQueueAndAreNotNoQueue() async throws {
        let several = try poeFixture("poe_result_type0_several.json")
        let r = await PoeClient(transport: FakePoeTransport(body: several)).addressStatus(cityId: 1, streetId: 2, house: "3", today: today)
        let c = try XCTUnwrap(r.confirmedStatus, "\(r)")
        XCTAssertNil(c.status.queue)
        XCTAssertTrue(c.status.severalConnections)
    }

    func testAddressStatusFailuresAreUnavailableNeverNoOutage() async {
        for body in ["[]", "{\"status\":400}", "<html></html>", "[{\"message_type\":3,\"accident_str\":\"?\"}]"] {
            let r = await PoeClient(transport: FakePoeTransport(body: body)).addressStatus(cityId: 1, streetId: 2, house: "3", today: today)
            XCTAssertNil(r.confirmedStatus, "\(body) -> \(r)")
            if case .confirmed = PoeClient.emergencyFetch(r, today: today) { XCTFail("\(body) became confirmed") }
        }
    }

    func testAddressStatusIsReusedFor60Seconds() async throws {
        final class Clock: @unchecked Sendable { var now: Int64 = 1_000_000 }
        let clock = Clock()
        let t = FakePoeTransport(body: try poeFixture("poe_result_type0_none.json"))
        let client = PoeClient(transport: t, nowMs: { clock.now })
        _ = await client.addressStatus(cityId: 1, streetId: 2, house: "3", today: today)
        clock.now += 59_000
        _ = await client.addressStatus(cityId: 1, streetId: 2, house: "3", today: today)
        XCTAssertEqual(t.calls.count, 1)
        clock.now += 2_000
        _ = await client.addressStatus(cityId: 1, streetId: 2, house: "3", today: today)
        XCTAssertEqual(t.calls.count, 2)
    }

    // MARK: E5 registry

    func testRegistryParsesTheBranchRowsWithTheLongerTimeout() async throws {
        let t = FakePoeTransport(body: try poeFixture("poe_gavapi_filial19_2026-11-16.json"))
        let r = await PoeClient(transport: t).registry(19, date: today)
        let call = try XCTUnwrap(t.calls.first)
        XCTAssertEqual(call.field, "disconngav")
        XCTAssertEqual(call.json["filialid"] as? String, "19")
        XCTAssertEqual(call.timeout, PoeConfig.REGISTRY_READ_TIMEOUT_MS)
        guard case .confirmed(let rows, let raw) = r else { return XCTFail("\(r)") }
        XCTAssertEqual(rows.count, 56)
        let zuivtsi = try XCTUnwrap(rows.first { row in row.places.contains { $0.settlement == "с.Зуївці" } })
        XCTAssertEqual(zuivtsi.kind, .EMERGENCY)
        XCTAssertEqual(PoeMapper.registryMatch(zuivtsi.places, settlement: "село Зуївці", street: "вул. Дружби", house: "3"), .STREET)
        if case .confirmed = await PoeClient(transport: FakePoeTransport(body: "oops")).registry(19, date: today) { XCTFail("oops is not an answer") }
        // the raw rows are kept so the nearby outages card can store and parse them again
        XCTAssertEqual(raw.count, rows.count)
        XCTAssertEqual(raw.compactMap { PoeMapper.parseRegistryRow($0) }, rows)
    }

    func testFormBodyIsUrlEncodedJsonInUtf8() {
        XCTAssertEqual(PoeForm.body(field: "disconn", json: "{\"house\":\"11/13 а\"}"),
                       "disconn=%7B%22house%22%3A%2211%2F13+%D0%B0%22%7D")
    }
}

/// Port of android PoePipelineTest.kt: per-house status -> emergency fetch -> ledger events, and repair
/// works -> outages, on the recorded answers of 2026-11-16.
final class PoePipelineTests: XCTestCase {
    private let today = LocalDate(year: 2026, month: 11, day: 16)!

    private func status(_ fixture: String, _ now: LocalDateTime) async throws -> AddressStatusFetch {
        let body = try poeFixture(fixture)
        return await PoeClient(transport: FakePoeTransport(body: body)).addressStatus(cityId: 11143, streetId: 1012802, house: "9", today: now.date)
    }

    func testPoshkodzhennyaStartsThenEndsWhenPoeConfirmsItIsOver() async throws {
        let at1030 = LocalDateTime(iso: "2026-11-16T10:30")!
        let started = try await status("poe_result_type3_emergency_noqueue.json", at1030)
        let first = EmergencyLedger.reconcile([], fetch: PoeClient.emergencyFetch(started, today: today), now: at1030)
        XCTAssertEqual(first.events.map(\.kind), [.START])
        XCTAssertEqual(first.events.first?.entryId, "poe_3462256")
        let live = EmergencyLedger.outages(first.entries, now: at1030)
        XCTAssertEqual(live.map(\.kind), [.EMERGENCY])
        XCTAssertEqual(live.first?.statusAt(at1030), .ACTIVE)
        XCTAssertEqual(live.first?.end, LocalDateTime(iso: "2026-11-16T15:59"))

        // POE could not be asked: nothing is announced and the record stays
        let at1100 = LocalDateTime(iso: "2026-11-16T11:00")!
        let down = EmergencyLedger.reconcile(first.entries, fetch: PoeClient.emergencyFetch(.unavailable("network"), today: today), now: at1100)
        XCTAssertTrue(down.events.isEmpty)
        XCTAssertEqual(down.entries.map(\.id), first.entries.map(\.id))

        // POE answers "nothing registered": the emergency is over, announced once
        let at1530 = LocalDateTime(iso: "2026-11-16T15:30")!
        let ended = try await status("poe_result_type0_none.json", at1530)
        let over = EmergencyLedger.reconcile(down.entries, fetch: PoeClient.emergencyFetch(ended, today: today), now: at1530)
        XCTAssertEqual(over.events.map(\.kind), [.END])
        XCTAssertEqual(over.events.first?.earlyEnd, true)
    }

    /// I4: the same recorded E4 answers, on through the notification layer. «Пошкодження» from E4 is posted
    /// once as START with POE's estimated end, the "nothing registered" answer as the early END, and an
    /// unreachable POE posts nothing (spec/NOTIFICATIONS.md 2, Android `NotificationHelper.postEmergencyEvents`).
    func testPoshkodzhennyaFromE4ReachesTheNotificationsOnce() async throws {
        var fired = Set<String>()
        func post(_ events: [EmergencyEvent], _ now: LocalDateTime) -> [LocalAlert] {
            let batch = EmergencyBatch(addressKey: "11143|key|9", subscriptionId: "aaaa1111", addressLine: "вул. Тестова, 9",
                                       events: events, plannedSpans: [], plannedAlertsOn: true, alertsOn: true)
            var marked = fired
            let out = NotificationPlanner.emergencyAlerts(batch, settings: UserSettings(), lang: "uk", now: now, sound: true,
                                                          fired: { marked.contains($0) }, markFired: { marked.insert($0) })
            fired = marked
            return out
        }

        let at1030 = LocalDateTime(iso: "2026-11-16T10:30")!
        let started = try await status("poe_result_type3_emergency_noqueue.json", at1030)
        let first = EmergencyLedger.reconcile([], fetch: PoeClient.emergencyFetch(started, today: today), now: at1030)
        let start = post(first.events, at1030)
        XCTAssertEqual(start.map(\.identifier), ["emerg_start_11143|key|9_2026-11-16T08:59"])
        XCTAssertEqual(start.first?.title, "Аварійне відключення")
        XCTAssertEqual(start.first?.body, "Початок: 08:59. Орієнтовне відновлення: 15:59.\nвул. Тестова, 9")
        XCTAssertNil(start.first?.fireAt, "an emergency is delivered at once")
        XCTAssertEqual(start.first?.category, .emergency)
        XCTAssertEqual(start.first?.subscriptionId, "aaaa1111")

        // the next refresh sees the same emergency: no new event, nothing posted again
        let at1100 = LocalDateTime(iso: "2026-11-16T11:00")!
        let again = EmergencyLedger.reconcile(first.entries, fetch: PoeClient.emergencyFetch(started, today: today), now: at1100)
        XCTAssertTrue(post(again.events, at1100).isEmpty)
        XCTAssertTrue(post(first.events, at1100).isEmpty, "the fired registry stops a replayed START")

        // POE unreachable: nothing
        let down = EmergencyLedger.reconcile(again.entries, fetch: PoeClient.emergencyFetch(.unavailable("network"), today: today), now: at1100)
        XCTAssertTrue(post(down.events, at1100).isEmpty)

        // POE answers "nothing registered" before the estimated end: the early END, once
        let at1530 = LocalDateTime(iso: "2026-11-16T15:30")!
        let ended = try await status("poe_result_type0_none.json", at1530)
        let over = EmergencyLedger.reconcile(down.entries, fetch: PoeClient.emergencyFetch(ended, today: today), now: at1530)
        let end = post(over.events, at1530)
        XCTAssertEqual(end.map(\.identifier), ["emerg_end_11143|key|9_2026-11-16T08:59"])
        XCTAssertEqual(end.first?.title, "Аварійне відключення скасовано")
        XCTAssertEqual(end.first?.body, "Відключення зникло зі списку до 15:59: світло, імовірно, вже є.\nвул. Тестова, 9")
        XCTAssertTrue(post(over.events, at1530).isEmpty)
    }

    func testScheduleMirrorIsNeverAnEmergency() async throws {
        let at1800 = LocalDateTime(iso: "2026-11-16T18:06")!
        let fetch = try await status("poe_result_type4_schedule_mirror.json", at1800)
        XCTAssertEqual(fetch.confirmedStatus?.status.scheduleMirror, true)
        let result = EmergencyLedger.reconcile([], fetch: PoeClient.emergencyFetch(fetch, today: today), now: at1800)
        XCTAssertTrue(result.events.isEmpty)
        XCTAssertTrue(result.entries.isEmpty)
    }

    func testRepairWorksBecomeRepairOutagesOfTodayAndTomorrow() async throws {
        let at1200 = LocalDateTime(iso: "2026-11-16T12:00")!
        let answer = try await status("poe_result_type2_planned.json", at1200)
        let fetch = try XCTUnwrap(answer.confirmedStatus)
        XCTAssertEqual(fetch.status.queue, "4.2")
        let repairs = OutageEngine.inWindow(fetch.status.repairs, today: today)
        XCTAssertEqual(repairs.map(\.id), ["repair_2026-11-16T09:34", "repair_2026-11-17T08:00"])
        XCTAssertTrue(repairs.allSatisfy { $0.kind == .REPAIR })
        // one warning for tomorrow's works (today's started already)
        let alerts = OutageEngine.planAlerts(repairs, now: at1200, advanceMinutes: 15)
        XCTAssertEqual(alerts.map(\.key), ["planned_2026-11-17T08:00"])
    }
}

/// `PoeScheduleSync` and the three-state cache of `ScheduleRepository`.
final class PoeScheduleSyncTests: XCTestCase {
    private var day = LocalDate(year: 2026, month: 11, day: 16)!
    private var previousClient: PoeClient!

    override func setUp() {
        super.setUp()
        previousClient = PoeScheduleSync.client
    }

    override func tearDown() {
        PoeScheduleSync.client = previousClient
        super.tearDown()
    }

    private func repo(_ defaults: UserDefaults) -> ScheduleRepository {
        ScheduleRepository(prefs: Prefs("zt_schedule_cache_v2", defaults: defaults), today: { [unowned self] in self.day }, nowMs: { 1_000 })
    }

    /// Today's page for today's date, an empty body (not published) for tomorrow, the measures for E2.
    private func transport(tomorrow: PoeHttpResult = .ok(""), measures: PoeHttpResult? = nil) throws -> FakePoeTransport {
        let html = try poeFixture("poe_newgpv_2026-11-16.html")
        let unloading = try poeFixture("poe_unloading_2026-11-16.json")
        return FakePoeTransport { call in
            if call.endpoint == PoeConfig.MEASURES { return measures ?? .ok(unloading) }
            return (call.json["date_in"] as? String) == "16-11-2026" ? .ok(html) : tomorrow
        }
    }

    func testRefreshStoresAllQueuesWithSwitchingCellsAndTheMeasures() async throws {
        PoeScheduleSync.client = PoeClient(transport: try transport())
        let r = repo(testDefaults())
        let res = await PoeScheduleSync.refresh(repo: r, today: day, networkValidated: { true })
        XCTAssertEqual(res.status, .SUCCESS)
        XCTAssertEqual(res.siteState, .AVAILABLE_WITH_TABLE)
        XCTAssertTrue(res.measuresKnown)
        XCTAssertTrue(res.notice?.hasPrefix("ГАВ 08:54–23:59") == true)
        for q in PoeSchedule.QUEUES {
            XCTAssertEqual(r.todayCells(q)?.count, 48, "queue \(q)")
            XCTAssertNil(r.tomorrowCells(q), "tomorrow is not published")
        }
        let cells = try XCTUnwrap(r.todayCells("1.1"))
        XCTAssertEqual(cells[0], .SWITCHING)
        XCTAssertEqual(cells[8], .OFF)
        // the boolean readers see the switching half-hour as on
        XCTAssertEqual(r.todayOffCells("1.1")?[0], false)
        XCTAssertEqual(r.todayOffCells("1.1")?[8], true)
        // the engine: switching cells close the planned block and feed the restore window
        let windows = OutageEngine.switchWindows(today: day, todayCells: cells, tomorrowCells: nil)
        XCTAssertFalse(windows.isEmpty)
        let planned = OutageEngine.buildPlannedCells(today: day, todayCells: cells, tomorrowCells: nil)
        XCTAssertFalse(planned.contains { o in windows.contains { $0.start < o.end && o.start < $0.end } },
                       "a switching half-hour is never part of a planned outage")
    }

    func testOnlyTomorrowFailingKeepsTheCachedTomorrow() async throws {
        let r = repo(testDefaults())
        let html = try poeFixture("poe_newgpv_2026-11-16.html")
        let table = PoeSchedule.parseDay(html, date: day)
        r.saveAllCellsBatch(today: table.queues, tomorrow: table.queues)
        PoeScheduleSync.client = PoeClient(transport: try transport(tomorrow: .failed("network")))
        let res = await PoeScheduleSync.refresh(repo: r, today: day, networkValidated: { true })
        XCTAssertEqual(res.status, .SUCCESS)
        XCTAssertEqual(r.tomorrowCells("2.1"), table.queues["2.1"], "a failed tomorrow keeps the cached one")
    }

    func testFailureNeverClearsTheCacheAndTellsNoInternetFromSiteDown() async throws {
        let r = repo(testDefaults())
        let html = try poeFixture("poe_newgpv_2026-11-16.html")
        r.saveAllCellsBatch(today: PoeSchedule.parseDay(html, date: day).queues, tomorrow: nil)
        PoeScheduleSync.client = PoeClient(transport: FakePoeTransport { _ in .failed("network") })
        let down = await PoeScheduleSync.refresh(repo: r, today: day, networkValidated: { true })
        XCTAssertEqual(down.siteState, .SITE_UNREACHABLE)
        XCTAssertEqual(down.status, .NO_QUEUES_FOUND)
        XCTAssertFalse(down.measuresKnown)
        let offline = await PoeScheduleSync.refresh(repo: r, today: day, networkValidated: { false })
        XCTAssertEqual(offline.siteState, .NO_INTERNET)
        XCTAssertEqual(offline.status, .NO_INTERNET)
        XCTAssertNotNil(r.todayCells("1.1"), "a failure never clears the cached schedule")

        PoeScheduleSync.client = PoeClient(transport: FakePoeTransport(body: "{\"status\":400}"))
        let odd = await PoeScheduleSync.refresh(repo: r, today: day, networkValidated: { true })
        XCTAssertEqual(odd.siteState, .AVAILABLE_NO_TABLE, "POE answered, but not with a table")
    }

    func testMidnightPromotesTomorrowAndArchivesYesterday() {
        let r = repo(testDefaults())
        let todayCells: [ScheduleCell] = (0..<48).map { $0 < 4 ? .OFF : $0 == 4 ? .SWITCHING : .ON }
        let tomorrowCells: [ScheduleCell] = (0..<48).map { $0 >= 44 ? .OFF : .ON }
        r.saveAllCellsBatch(today: ["1.1": todayCells], tomorrow: ["1.1": tomorrowCells])
        XCTAssertEqual(r.todayCells("1.1"), todayCells)
        XCTAssertEqual(r.tomorrowCells("1.1"), tomorrowCells)

        day = day.plusDays(1)
        XCTAssertEqual(r.todayCells("1.1"), tomorrowCells, "tomorrow becomes today after midnight")
        XCTAssertEqual(r.yesterdayCells("1.1"), todayCells, "the old today stays as yesterday's tail")
        XCTAssertNil(r.tomorrowCells("1.1"))

        day = day.plusDays(1)
        XCTAssertNil(r.todayCells("1.1"), "a two-day-old table is not today's")
    }

    func testValidUrlsComeFromTheBundledList() {
        XCTAssertTrue(PoeScheduleSync.isValidUrl("https://www.poe.pl.ua/disconnection/power-outages/"))
        XCTAssertTrue(PoeScheduleSync.isValidUrl(" https://www.poe.pl.ua/disconnection/power-outages "))
        XCTAssertFalse(PoeScheduleSync.isValidUrl("https://www.ztoe.com.ua/"), "the Zhytomyr site is no longer accepted")
        XCTAssertFalse(PoeScheduleSync.isValidUrl(""))
        XCTAssertEqual(SettingsRepository.DEFAULT_URL, PoeScheduleSync.DEFAULT_SITE_URL)
        XCTAssertEqual(UserSettings().cityUrl, PoeScheduleSync.DEFAULT_SITE_URL)
    }
}

/// The address directory, the picker lists and the queue catalogue.
final class PoeAddressLookupTests: XCTestCase {
    private var previousClient: PoeClient!

    override func setUp() {
        super.setUp()
        previousClient = PoeAddressLookup.client
    }

    override func tearDown() {
        PoeAddressLookup.client = previousClient
        PoeAddressLookup.useIndex(nil)
        super.tearDown()
    }

    func testBranchesMatchSpecBranchesJson() throws {
        let url = try XCTUnwrap(Bundle(for: FakePoeTransport.self).url(forResource: "branches", withExtension: "json"), "spec/branches.json is not in the test bundle")
        let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let spec = try XCTUnwrap(root["branches"] as? [[String: Any]])
        XCTAssertEqual(spec.count, 28)
        XCTAssertEqual(spec.count, PoeBranches.ALL.count)
        for (s, b) in zip(spec, PoeBranches.ALL) {
            XCTAssertEqual(s["slug"] as? String, b.slug)
            XCTAssertEqual((s["cabinetId"] as? NSNumber)?.intValue, b.cabinetId, b.slug)
            XCTAssertEqual((s["registryId"] as? NSNumber)?.intValue, b.registryId, b.slug)
            XCTAssertEqual(s["nameUk"] as? String, b.nameUk, b.slug)
            XCTAssertEqual(s["nameEn"] as? String, b.nameEn, b.slug)
        }
    }

    func testBundledDirectorySnapshotIsUsable() throws {
        let index = try bundledDirectory()
        XCTAssertEqual(index.branches.count, 28)
        let poltava = try XCTUnwrap(index.settlement(11389))
        XCTAssertEqual(poltava.name, "місто Полтава")
        XCTAssertEqual(poltava.branchCabinetIds.count, 9)
        XCTAssertEqual(index.streetsOf(11389).count, 1044)
        XCTAssertTrue(index.settlementsOf(123).contains { $0.id == 11389 })
        XCTAssertFalse(index.settlements.contains { $0.name.ktTrim() == "село _" })
        XCTAssertEqual(index.branch(123)?.registryId, 23)
        XCTAssertNil(PoeDirectoryIndex.fromJson("{}"))
        XCTAssertNil(PoeDirectoryIndex.fromJson("not json"))
    }

    func testScopedRefreshAddsAndNeverRemovesAndSurvivesTheJsonRoundTrip() throws {
        let index = try bundledDirectory()
        let before = index.streetsOf(11389).count
        let firstStreet = try XCTUnwrap(index.streetsOf(11389).first)
        let merged = index
            .withStreets(11389, [(id: 999_000_001, name: "вул. Нова"), (id: firstStreet.id, name: firstStreet.name)])
            .withBranchSettlements(102, [(id: 999_000_002, name: "село Нове"), (id: 11389, name: "місто Полтава")])
        XCTAssertEqual(merged.streetsOf(11389).count, before + 1)
        XCTAssertTrue(merged.streetsOf(11389).contains { $0.name == "вул. Нова" })
        XCTAssertEqual(merged.settlement(999_000_002)?.branchCabinetIds, [102])
        XCTAssertTrue(merged.settlement(11389)?.branchCabinetIds.contains(102) == true)
        XCTAssertEqual(merged.settlements.count, index.settlements.count + 1)
        XCTAssertEqual(index.withStreets(1, [(id: 5, name: "x")]).settlements.count, index.settlements.count)
        // a newer crawl that lost the new street and settlement keeps them from the older index
        let kept = index.keeping(merged)
        XCTAssertEqual(kept.streetsOf(11389).count, merged.streetsOf(11389).count)
        XCTAssertEqual(kept.settlement(999_000_002)?.branchCabinetIds, [102])
        XCTAssertTrue(kept.settlement(11389)?.branchCabinetIds.contains(102) == true)
        XCTAssertEqual(kept.crawledAt, index.crawledAt)
        let back = try XCTUnwrap(PoeDirectoryIndex.fromJson(try XCTUnwrap(merged.toJson())))
        XCTAssertEqual(back.crawledAt, merged.crawledAt)
        XCTAssertEqual(back.settlements, merged.settlements)
        XCTAssertEqual(back.branches, merged.branches)
    }

    func testSettlementChoicesListTheBranchFirstThenTheWholeOblastOnce() throws {
        let index = try bundledDirectory()
        PoeAddressLookup.useIndex(index)
        let choices = PoeAddressLookup.settlementChoices("poltavska", lang: "uk")
        let own = PoeAddressLookup.getSettlementsForRem("poltavska")
        XCTAssertEqual(Array(choices.prefix(own.count)).map(\.option.id), own.map(\.id))
        XCTAssertTrue(choices.prefix(own.count).allSatisfy(\.inBranch))
        XCTAssertEqual(choices.count, index.settlements.count)
        XCTAssertEqual(Set(choices.map(\.option.id)).count, choices.count)
        // Зуївці (Миргородська об'єднана філія) is outside the Poltava branch: named with its branch
        let zuivtsi = try XCTUnwrap(choices.first { $0.option.nameUk == "село Зуївці" })
        XCTAssertFalse(zuivtsi.inBranch)
        XCTAssertTrue(zuivtsi.label.hasPrefix("село Зуївці · "), zuivtsi.label)
        XCTAssertFalse(zuivtsi.option.branchIds.isEmpty)
    }

    func testStreetsMergeSpellingVariantsAndEveryIdFindsTheOption() throws {
        PoeAddressLookup.useIndex(try bundledDirectory())
        let streets = PoeAddressLookup.getStreetsForSettlement("11389")
        XCTAssertFalse(streets.isEmpty)
        XCTAssertEqual(streets.map(\.nameUk), streets.map(\.nameUk).sorted { $0.lowercased() < $1.lowercased() })
        XCTAssertEqual(Set(streets.map { StreetKey.of($0.nameUk) }).count, streets.count, "one option per street key")
        for option in streets.prefix(50) {
            for id in option.allIds { XCTAssertEqual(PoeAddressLookup.findStreetById(id)?.id, option.id) }
        }
        let label = PoeAddressLookup.addressLabel(SelectedAddressQuery(remId: "poltavska", settlementId: "11389", streetId: streets[0].id, house: " 5 "))
        XCTAssertEqual(label, "місто Полтава, \(streets[0].nameUk), буд. 5")
    }

    func testRefreshStreetsAsksPoeOnceAndAFailureChangesNothing() async throws {
        PoeAddressLookup.useIndex(try bundledDirectory())
        let t = FakePoeTransport(body: "[{\"instance_id\":999000003,\"instance_name\":\"вул. Свіжа\"}]")
        PoeAddressLookup.client = PoeClient(transport: t)
        let ok = await PoeAddressLookup.refreshStreets("poltavska", "11389")
        XCTAssertTrue(ok)
        XCTAssertEqual(t.calls.count, 1)
        XCTAssertEqual(t.calls.first?.json["operation_type"] as? String, "street")
        XCTAssertEqual(t.calls.first?.json["filial_id"] as? String, "123")
        XCTAssertTrue(PoeAddressLookup.getStreetsForSettlement("11389").contains { $0.nameUk == "вул. Свіжа" })
        PoeAddressLookup.client = PoeClient(transport: FakePoeTransport { _ in .failed("network") })
        let size = PoeAddressLookup.getStreetsForSettlement("11389").count
        let failed = await PoeAddressLookup.refreshStreets("poltavska", "11389")
        XCTAssertFalse(failed)
        XCTAssertEqual(PoeAddressLookup.getStreetsForSettlement("11389").count, size)
        try? FileManager.default.removeItem(at: PoeAddressLookup.localFileURL())
    }

    func testHousesAreFetchedLiveSortedAndTheQueueComesFromTheHouseStatus() async throws {
        PoeAddressLookup.useIndex(try bundledDirectory())
        let buildings = try poeFixture("poe_cabinet_buildings_poltava_sobornosti.json")
        let none = try poeFixture("poe_result_type0_none.json")
        PoeAddressLookup.client = PoeClient(transport: FakePoeTransport { call in
            call.endpoint == PoeConfig.DIRECTORY ? .ok(buildings) : .ok(none)
        })
        let street = try XCTUnwrap(PoeAddressLookup.findStreetById("1227174"))
        let fetched = await PoeAddressLookup.fetchHousesForStreet("poltavska", "11389", street.id)
        let houses = try XCTUnwrap(fetched)
        XCTAssertTrue(houses.contains { $0.house == "11/13" })
        let names = houses.map(\.house)
        XCTAssertEqual(names, names.sorted { PoeAddressLookup.HouseOrder.compare($0, $1) < 0 })
        let checked = await PoeAddressLookup.checkAddress(
            SelectedAddressQuery(remId: "poltavska", settlementId: "11389", streetId: street.id, house: "1"),
            today: LocalDate(year: 2026, month: 11, day: 16)!)
        let found = try XCTUnwrap(checked)
        XCTAssertEqual(found.queue, "1.1")
        XCTAssertNil(found.statusText)
        XCTAssertTrue(found.addressLabel.hasPrefix("місто Полтава, "))
        XCTAssertEqual(PoeAddressLookup.getHousesForStreet(street.id).first { $0.house == "1" }?.queue, "1.1", "the answer is remembered")

        PoeAddressLookup.client = PoeClient(transport: FakePoeTransport { _ in .failed("network") })
        let down = await PoeAddressLookup.checkAddress(SelectedAddressQuery(remId: "poltavska", settlementId: "11389", streetId: street.id, house: "2"))
        XCTAssertNil(down, "POE could not be asked: no answer, never \"no queue\"")
    }

    func testHouseOrder() {
        let sorted = ["10а", "2", "10", "буд", "1/2", "01"].sorted { PoeAddressLookup.HouseOrder.compare($0, $1) < 0 }
        XCTAssertEqual(sorted, ["01", "1/2", "2", "10", "10а", "буд"])
    }

    func testResolvedAddressesLetTheWidgetFindTheStreetWithoutTheDirectory() throws {
        PoeAddressLookup.useIndex(try bundledDirectory())
        let street = try XCTUnwrap(PoeAddressLookup.getStreetsForSettlement("11389").first)
        let query = SelectedAddressQuery(remId: "poltavska", settlementId: "11389", streetId: street.id, house: "1")
        let key = OutageRepository().addressKey(query)
        PoeAddressLookup.rememberResolved([query])
        PoeAddressLookup.useIndex(nil)
        XCTAssertEqual(PoeAddressLookup.findStreetById(street.id)?.nameUk, street.nameUk)
        XCTAssertEqual(PoeAddressLookup.findSettlementById("11389")?.nameUk, "місто Полтава")
        XCTAssertEqual(OutageRepository().addressKey(query), key, "the widget computes the app's address key")
        AppGroup.removeFile(PoeResolvedAddresses.FILE)
    }

    func testQueueCatalogueIsBundledAndAnswersForAnAddress() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "poe_queues", withExtension: "json"), "poe_queues.json is not in the app")
        let cat = try XCTUnwrap(PoeQueues.parse(try Data(contentsOf: url)))
        XCTAssertFalse(cat.entries.isEmpty)
        XCTAssertFalse(cat.companies.isEmpty)
        XCTAssertFalse(cat.builtAt.isEmpty)
        XCTAssertNotNil(cat.sha256)
        XCTAssertTrue(cat.companies.contains { !$0.rowText.isEmpty }, "companies carry the text of their row")
        XCTAssertNil(PoeQueues.parse(Data("{\"entries\":[]}".utf8)))
        XCTAssertNil(PoeQueues.parse(Data("oops".utf8)))
    }
}

/// The stores of the outage pipeline (port of the store parts of the inherited DataLayerTests).
final class PoeStoreTests: XCTestCase {
    func testRegistryMeasuresInfoLineAndRegistryRepairsRoundTrip() {
        let file = "test_outage_\(UUID().uuidString).json"
        let store = OutageStateStore(prefs: Prefs("zt_outage_state_test", defaults: testDefaults()), fileName: file)
        defer {
            AppGroup.removeFile(file)
            AppGroup.removeFile("poe_registry_998.json")
        }
        let day = LocalDate(year: 2026, month: 11, day: 16)!
        store.saveMeasures(day, "ГАВ 08:54–23:59")
        XCTAssertEqual(store.measures(day), "ГАВ 08:54–23:59")
        XCTAssertNil(store.measures(day.plusDays(1)), "measures are of one day")
        store.saveMeasures(day, nil)
        XCTAssertNil(store.measures(day))

        store.saveGavMessage("k", "Заживлено від ПЛ-0,4 КВ")
        XCTAssertEqual(store.gavMessage("k"), "Заживлено від ПЛ-0,4 КВ")
        store.saveGavMessage("k", " ")
        XCTAssertNil(store.gavMessage("k"))

        XCTAssertNil(store.registry(998))
        store.saveRegistry(998, date: day, rows: nil, nowMs: 5)
        XCTAssertNil(store.registry(998), "a failure without stored rows stores nothing")
        store.saveRegistry(998, date: day, rows: ["<tr>a</tr>", "<tr>b</tr>"], nowMs: 10)
        XCTAssertEqual(store.registry(998), RegistryCache(date: day, rows: ["<tr>a</tr>", "<tr>b</tr>"], fetchedMs: 10, lastOk: true))
        XCTAssertEqual(store.registryMeta(998), "2026-11-16|10|true")
        store.saveRegistry(998, date: day, rows: nil, nowMs: 20)
        XCTAssertEqual(store.registry(998)?.rows.count, 2, "a failure keeps the rows")
        XCTAssertEqual(store.registry(998)?.lastOk, false)
        XCTAssertEqual(store.registry(998)?.fetchedMs, 10)

        let t = LocalDateTime(iso: "2026-11-16T10:00")!
        store.saveRegistryRepairs("k", [Outage(id: "registry_x", kind: .REPAIR, start: t, end: t.plusHours(2), label: "Планові роботи")])
        XCTAssertEqual(store.registryRepairs("k").map(\.id), ["registry_x"])
        XCTAssertTrue(store.repairs("k").isEmpty, "registry repairs are kept apart from the per-house ones")
        store.saveRegistryRepairs("k", [])
        XCTAssertTrue(store.registryRepairs("k").isEmpty)
    }

    func testRegistryRowsNamingTheHouseAreRepairsUnlessThePerHouseStatusListsThem() {
        let schedulePrefs = Prefs("zt_schedule_cache_test", defaults: testDefaults())
        let file = "test_outage_\(UUID().uuidString).json"
        let store = OutageStateStore(prefs: Prefs("zt_outage_state_test", defaults: testDefaults()), fileName: file)
        defer { AppGroup.removeFile(file) }
        let repo = OutageRepository(schedule: ScheduleRepository(prefs: schedulePrefs), store: store)
        let now = LocalDateTime(iso: "2026-11-16T08:00")!
        let works = Outage(id: "repair_2026-11-16T09:00", kind: .REPAIR, start: LocalDateTime(iso: "2026-11-16T09:00")!,
                           end: LocalDateTime(iso: "2026-11-16T17:00")!, label: "Планові роботи")
        let other = Outage(id: "registry_2", kind: .REPAIR, start: LocalDateTime(iso: "2026-11-16T18:00")!,
                           end: LocalDateTime(iso: "2026-11-16T19:00")!, label: "Планові роботи")
        store.saveRepairs("k", [works])
        store.saveRegistryRepairs("k", [Outage(id: "registry_1", kind: .REPAIR, start: works.start, end: works.end, label: nil), other])
        let outages = repo.outagesFor(queue: nil, key: "k", now: now)
        XCTAssertEqual(outages.map(\.id).sorted(), [works.id, other.id].sorted(), "the same works are listed once")
    }
}
