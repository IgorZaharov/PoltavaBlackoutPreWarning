import XCTest
@testable import ZTPreBlackout

/// Runs the POE golden vectors (mirror of android PoeVectorsTest.kt and tests/spec-vectors.test.ts):
/// poe_api.json, outage_engine_poe.json, poe_schedule.json and queue_catalogue.json. Every group asserts
/// how many cases it ran, so an empty or skipped group fails instead of passing silently.
final class PoeVectorsTests: XCTestCase {

    private func report(_ file: String, _ section: String, ran: Int, atLeast: Int) {
        print("[vectors] \(file) \(section): \(ran) cases")
        XCTAssertGreaterThanOrEqual(ran, atLeast, "\(file) \(section): too few cases ran")
    }

    private func txt(_ t: LocalDateTime?) -> Any { t.map { $0.description } ?? NSNull() }
    private func orNull(_ s: String?) -> Any { s ?? NSNull() }

    // MARK: - queue_catalogue.json

    func testQueueCatalogueVectors() throws {
        let v = try Vectors.load("queue_catalogue.json")
        let entries = v.objs("entries").map { e -> QueueCatalogue.Entry in
            let ranges = (e.array("ranges") ?? []).compactMap { $0 as? [Any] }.map { r in
                QueueCatalogue.HouseRange((r[0] as! NSNumber).intValue, (r[1] as! NSNumber).intValue)
            }
            return QueueCatalogue.Entry(
                queue: e.str("q")!, branch: e.str("branch"), row: e.int("row")!, settlement: e.str("settlement"),
                street: e.str("street"), houses: e.strings("houses") ?? [], ranges: ranges, whole: e.str("whole")
            )
        }
        var ran = 0
        for c in v.objs("cases") {
            let got: [Any] = QueueCatalogue.lookup(
                entries, settlement: c.str("settlement")!, branches: c.strings("branches") ?? [],
                street: c.str("street")!, house: c.str("house")!
            ).map { h -> [String: Any] in
                ["queue": h.queue, "kind": h.kind.rawValue, "branch": orNull(h.branch), "row": h.row, "exact": h.exact]
            }
            XCTAssertEqual(canonicalJSON(c.array("expect")!), canonicalJSON(got), "queue_catalogue: \(c.str("name") ?? "?")")
            ran += 1
        }
        report("queue_catalogue.json", "cases", ran: ran, atLeast: 14)

        var conf = 0
        for c in v.objs("confident") {
            let hints = c.objs("hints").map {
                QueueCatalogue.Hint(queue: $0.str("queue")!, kind: QueueCatalogue.Kind(rawValue: $0.str("kind")!)!,
                                    branch: $0.str("branch"), row: $0.int("row")!, exact: $0.bool("exact")!)
            }
            XCTAssertEqual(c.str("expect"), QueueCatalogue.confident(hints), "queue_catalogue confident: \(c.str("name") ?? "?")")
            conf += 1
        }
        report("queue_catalogue.json", "confident", ran: conf, atLeast: 6)
        XCTAssertEqual(v.objs("entries").count, entries.count)
        report("queue_catalogue.json", "entries", ran: entries.count, atLeast: 12)
    }

    // MARK: - poe_api.json

    private func placesJSON(_ places: [PoeMapper.Place]) -> [Any] {
        places.map { p -> [String: Any] in
            [
                "settlement": p.settlement,
                "streets": p.streets.map { ["street": $0.street, "houses": $0.houses] as [String: Any] },
                "freeText": p.freeText
            ]
        }
    }

    func testPoeApiTimesEtaPlannedQueue() throws {
        let v = try Vectors.load("poe_api.json")

        var n = 0
        for t in v.objs("times") {
            XCTAssertEqual(t.str("out"), PoeMapper.parseTime(t.str("in")!)?.description, "time '\(t.str("in")!)'")
            n += 1
        }
        report("poe_api.json", "times", ran: n, atLeast: 10)

        n = 0
        for t in v.objs("eta") {
            XCTAssertEqual(t.str("out"), PoeMapper.parseEta(t.str("in")!)?.description, "eta: \(t.str("name") ?? "?")")
            n += 1
        }
        report("poe_api.json", "eta", ran: n, atLeast: 7)

        n = 0
        for t in v.objs("plannedList") {
            let got: [Any] = PoeMapper.parsePlannedList(t.str("in")).map { ["start": $0.start.description, "end": $0.end.description] }
            XCTAssertEqual(canonicalJSON(t.array("out")!), canonicalJSON(got), "plannedList: \(t.str("name") ?? "?")")
            n += 1
        }
        report("poe_api.json", "plannedList", ran: n, atLeast: 5)

        n = 0
        for t in v.objs("queue") {
            let input = t.array("in")!
            XCTAssertEqual(t.str("out"), PoeMapper.parseQueue(input[0] as? String, input[1] as? String), "queue \(input)")
            n += 1
        }
        report("poe_api.json", "queue", ran: n, atLeast: 8)
    }

    func testPoeApiAddressStatus() throws {
        let v = try Vectors.load("poe_api.json")
        var n = 0
        for c in v.objs("addressStatus") {
            let name = c.str("name") ?? "?"
            let st = PoeMapper.addressStatus(c.obj("in")!, today: ld(c.str("today")!))
            let e = c.obj("expect")!
            XCTAssertEqual(e.int("messageType"), st.messageType, "\(name): messageType")
            XCTAssertEqual(e.str("queue"), st.queue, "\(name): queue")
            XCTAssertEqual(e.bool("unparsed"), st.unparsed, "\(name): unparsed")
            XCTAssertEqual(e.bool("scheduleMirror"), st.scheduleMirror, "\(name): scheduleMirror")
            XCTAssertEqual(e.bool("severalConnections"), st.severalConnections, "\(name): severalConnections")
            if let em = e.obj("emergency") {
                if let got = st.emergency {
                    XCTAssertEqual(em.str("id"), got.id, "\(name): emergency.id")
                    XCTAssertEqual(em.str("start"), got.start.description, "\(name): emergency.start")
                    XCTAssertEqual(em.str("estimatedEnd"), got.estimatedEnd?.description, "\(name): emergency.estimatedEnd")
                    XCTAssertEqual(em.str("label"), got.label, "\(name): emergency.label")
                } else {
                    XCTFail("\(name): emergency expected")
                }
            } else {
                XCTAssertNil(st.emergency, "\(name): emergency")
            }
            let repairs: [Any] = st.repairs.map { r -> [String: Any] in
                XCTAssertEqual(r.kind, .REPAIR, "\(name): repair kind")
                return ["id": r.id, "start": r.start.description, "end": r.end.description, "label": orNull(r.label)]
            }
            XCTAssertEqual(canonicalJSON(e.array("repairs")!), canonicalJSON(repairs), "\(name): repairs")
            n += 1
        }
        report("poe_api.json", "addressStatus", ran: n, atLeast: 12)
    }

    func testPoeApiRegistry() throws {
        let v = try Vectors.load("poe_api.json")

        var n = 0
        for t in v.objs("registryReason") {
            XCTAssertEqual(t.str("out"), PoeMapper.classifyRegistryReason(t.str("in")!).rawValue, "registryReason '\(t.str("in")!)'")
            n += 1
        }
        report("poe_api.json", "registryReason", ran: n, atLeast: 6)

        n = 0
        for c in v.objs("registryRows") {
            let name = c.str("name") ?? "?"
            let row = PoeMapper.parseRegistryRow(c.str("in"))
            n += 1
            guard let expect = c.obj("expect") else {
                XCTAssertNil(row, "\(name): nil")
                continue
            }
            guard let row else {
                XCTFail("\(name): row expected")
                continue
            }
            let got: [String: Any] = [
                "id": row.id, "start": row.start.description, "end": txt(row.end), "reason": row.reason,
                "kind": row.kind.rawValue, "places": placesJSON(row.places)
            ]
            XCTAssertEqual(canonicalJSON(expect), canonicalJSON(got), name)
        }
        report("poe_api.json", "registryRows", ran: n, atLeast: 6)

        n = 0
        for c in v.objs("registryMatch") {
            let name = c.str("name") ?? "?"
            guard let row = PoeMapper.parseRegistryRow(c.str("row")) else {
                XCTFail("\(name): row")
                continue
            }
            let got = PoeMapper.registryMatch(row.places, settlement: c.str("settlement")!, street: c.str("street")!, house: c.str("house")!)
            XCTAssertEqual(c.str("out"), got.rawValue, "registryMatch: \(name)")
            n += 1
        }
        report("poe_api.json", "registryMatch", ran: n, atLeast: 9)

        n = 0
        for c in v.objs("nearby") {
            let name = c.str("name") ?? "?"
            let rows = (c.strings("rows") ?? []).compactMap { raw -> PoeMapper.RegistryRow? in
                let r = PoeMapper.parseRegistryRow(raw)
                XCTAssertNotNil(r, "\(name): row")
                return r
            }
            let got: [Any] = PoeMapper.nearbyOutages(
                rows, settlement: c.str("settlement")!, street: c.str("street")!, house: c.str("house")!, now: ldt(c.str("now"))!
            ).map { o -> [String: Any] in
                [
                    "id": o.id, "kind": o.kind.rawValue, "start": o.start.description, "end": txt(o.end), "reason": o.reason,
                    "status": o.status.rawValue,
                    "streets": o.streets.map { ["name": $0.name, "houses": $0.houses, "mine": $0.mine] as [String: Any] },
                    "match": o.match.rawValue
                ]
            }
            XCTAssertEqual(canonicalJSON(c.array("expect")!), canonicalJSON(got), "nearby: \(name)")
            n += 1
        }
        report("poe_api.json", "nearby", ran: n, atLeast: 6)

        n = 0
        for c in v.objs("registryRepairs") {
            let name = c.str("name") ?? "?"
            let rows = (c.strings("rows") ?? []).compactMap { PoeMapper.parseRegistryRow($0) }
            XCTAssertEqual(rows.count, c.strings("rows")?.count, "\(name): rows")
            let got = PoeMapper.registryRepairs(rows, settlement: c.str("settlement")!, street: c.str("street")!, house: c.str("house")!)
            XCTAssertTrue(got.allSatisfy { $0.kind == .REPAIR }, "registryRepairs: \(name): kind")
            let json: [Any] = got.map { ["id": $0.id, "start": $0.start.description, "end": $0.end.description] }
            XCTAssertEqual(canonicalJSON(c.array("expect")!), canonicalJSON(json), "registryRepairs: \(name)")
            n += 1
        }
        report("poe_api.json", "registryRepairs", ran: n, atLeast: 6)
    }

    // MARK: - outage_engine_poe.json

    private func toMin(_ hhmm: String) -> Int {
        let p = hhmm.split(separator: ":").map { Int($0)! }
        return p[0] * 60 + p[1]
    }

    private func scheduleCells(_ day: J?) -> [ScheduleCell]? {
        guard let day else { return nil }
        var arr = [ScheduleCell](repeating: .ON, count: 48)
        func mark(_ ranges: [String]?, _ state: ScheduleCell) {
            for r in ranges ?? [] {
                let ab = r.split(separator: "-").map(String.init)
                for k in (toMin(ab[0]) / 30)..<(toMin(ab[1]) / 30) { arr[k] = state }
            }
        }
        mark(day.strings("off"), .OFF)
        mark(day.strings("switching"), .SWITCHING)
        return arr
    }

    private func rangesOf(_ flags: [Bool]) -> [String] {
        func fmt(_ slot: Int) -> String { slot == 48 ? "24:00" : String(format: "%02d:%02d", slot / 2, (slot % 2) * 30) }
        var out: [String] = []
        var start = -1
        for i in 0...flags.count {
            let on = i < flags.count && flags[i]
            if on && start < 0 { start = i }
            if !on && start >= 0 {
                out.append("\(fmt(start))-\(fmt(i))")
                start = -1
            }
        }
        return out
    }

    func testOutageEnginePoeVectors() throws {
        let cases = try Vectors.load("outage_engine_poe.json").objs("cases")
        var ran = 0
        for c in cases {
            let name = c.str("name") ?? "?"
            let today = ld(c.str("today")!)
            let now = ldt(c.str("now"))!
            let advance = c.int("advanceMinutes") ?? 15
            let cl = c.obj("cells") ?? [:]
            let t = scheduleCells(cl.obj("today"))
            let tm = scheduleCells(cl.obj("tomorrow"))
            let y = scheduleCells(cl.obj("yesterday"))

            var outages = OutageEngine.buildPlannedCells(today: today, todayCells: t, tomorrowCells: tm, yesterdayCells: y)
            for r in c.objs("repair") {
                outages.append(Outage(id: r.str("id")!, kind: .REPAIR, start: ldt(r.str("start"))!, end: ldt(r.str("end"))!))
            }
            for e in c.objs("emergencies") {
                let rec = EmergencyRecord(id: e.str("id")!, start: ldt(e.str("start"))!, estimatedEnd: ldt(e.str("estimatedEnd")),
                                          closedAt: ldt(e.str("closedAt")), label: e.str("label"))
                outages.append(OutageEngine.resolveEmergency(rec, now: now))
            }
            let window = OutageEngine.inWindow(outages, today: today)
            let windows = OutageEngine.switchWindows(today: today, todayCells: t, tomorrowCells: tm, yesterdayCells: y)
            let expect = c.obj("expect")!

            if let s = expect.obj("status") {
                let st = OutageEngine.status(window, now: now, switching: windows)
                XCTAssertEqual(s.bool("isOffNow"), st.isOffNow, "\(name): isOffNow")
                XCTAssertEqual(s.str("countdownText"), st.countdownText, "\(name): countdownText")
                XCTAssertEqual(s.str("nextSlotTime"), st.nextSlotTime, "\(name): nextSlotTime")
                XCTAssertEqual(s.str("restoreUntil"), st.restoreUntil?.description, "\(name): restoreUntil")
            }
            if let exp = expect.array("spans") {
                let got: [Any] = OutageEngine.spans(window.filter { !$0.stale }).map {
                    ["start": $0.start.description, "end": $0.end.description, "mayContinue": $0.mayContinue]
                }
                XCTAssertEqual(canonicalJSON(exp), canonicalJSON(got), "\(name): spans")
            }
            if let exp = expect.array("alerts") {
                let got: [Any] = OutageEngine.planAlerts(window, now: now, advanceMinutes: advance).map {
                    ["key": $0.key, "fireAt": $0.fireAt.description, "spanEnd": $0.spanEnd.description,
                     "mayContinue": $0.mayContinue, "durationMinutes": $0.durationMinutes]
                }
                XCTAssertEqual(canonicalJSON(exp), canonicalJSON(got), "\(name): alerts")
            }
            if let days = expect.obj("days") {
                for (dateKey, value) in days {
                    guard let d = value as? J else { continue }
                    let view = OutageEngine.dayView(window, date: ld(dateKey), now: now, switching: windows)
                    let tag = "\(name)/\(dateKey)"
                    XCTAssertEqual(d.int("totalOffMinutes"), view.totalOffMinutes, "\(tag): total")
                    XCTAssertEqual(d.strings("plannedCells"), rangesOf(view.slots.map { $0.planned }), "\(tag): plannedCells")
                    XCTAssertEqual(d.strings("switchingCells"), rangesOf(view.slots.map { $0.switching }), "\(tag): switchingCells")
                    XCTAssertEqual(d.strings("emergencyCells"), rangesOf(view.slots.map { $0.emergency }), "\(tag): emergencyCells")
                    XCTAssertFalse(view.slots.contains { $0.planned && $0.switching }, "\(tag): switching never with planned")
                }
            }
            ran += 1
        }
        report("outage_engine_poe.json", "cases", ran: ran, atLeast: 7)
    }

    // MARK: - poe_schedule.json

    /// spec/fixtures/poe is a folder resource of the test target (ios/project.yml), like spec/vectors.
    private func fixture(_ name: String) throws -> String {
        let bundle = Bundle(for: PoeVectorsTests.self)
        let dir = try XCTUnwrap(bundle.url(forResource: "poe", withExtension: nil), "spec/fixtures/poe is not in the test bundle")
        return try String(contentsOf: dir.appendingPathComponent(name), encoding: .utf8)
    }

    func testPoeScheduleVectors() throws {
        let cases = try Vectors.load("poe_schedule.json").objs("cases")
        var ran = 0
        for c in cases {
            let name = c.str("name") ?? "?"
            let html: String? = try c.str("fixture").map { try fixture($0) } ?? c.str("html")
            let got = PoeSchedule.parseDay(html, date: ld(c.str("date")!))
            let e = c.obj("expect")!
            XCTAssertEqual(e.str("kind"), got.kind.rawValue, "\(name): kind")
            XCTAssertEqual(e.str("stamp"), got.stamp, "\(name): stamp")
            XCTAssertEqual(e.str("reason"), got.reason, "\(name): reason")
            if got.kind == .PUBLISHED {
                var queues: [String: Any] = [:]
                for (q, cells) in got.queues {
                    queues[q] = [
                        "off": rangesOf(cells.map { $0 == .OFF }),
                        "switching": rangesOf(cells.map { $0 == .SWITCHING })
                    ]
                }
                XCTAssertEqual(canonicalJSON(e.obj("queues")!), canonicalJSON(queues), "\(name): queues")
            } else {
                XCTAssertTrue(got.queues.isEmpty, "\(name): no queues")
            }
            ran += 1
        }
        report("poe_schedule.json", "cases", ran: ran, atLeast: 13)
    }
}
