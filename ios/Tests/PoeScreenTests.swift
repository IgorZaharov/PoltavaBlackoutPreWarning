import XCTest
@testable import ZTPreBlackout

/// The POE pieces of the main screen (milestone I3): switching cells on the drum, the drum summary for
/// VoiceOver, the texts of the nearby outages card and the restore window.
final class PoeScreenTests: XCTestCase {

    private func slot(_ i: Int, off: Bool = false, emergency: Bool = false, planned: Bool? = nil, switching: Bool = false) -> BlackoutSlot {
        let endMin = (i + 1) * 30
        return BlackoutSlot(
            id: "slot_\(i)", startHour: i / 2, endHour: endMin / 60, startMinute: (i % 2) * 30, endMinute: endMin % 60,
            startTimeStr: String(format: "%02d:%02d", i / 2, (i % 2) * 30),
            endTimeStr: endMin >= 1440 ? "24:00" : String(format: "%02d:%02d", endMin / 60, endMin % 60),
            status: off ? .POWER_OFF : .POWER_ON, isEmergency: emergency, isPlanned: planned, isSwitching: switching
        )
    }

    func testSwitchingCellsAreDrawnButNeverOnAPlannedCell() {
        var slots = (0..<48).map { slot($0) }
        slots[4] = slot(4, off: true, planned: true)
        slots[5] = slot(5, switching: true)
        slots[6] = slot(6, off: true, emergency: true, planned: false, switching: true)
        slots[7] = slot(7, off: true, planned: true, switching: true)
        let cells = DrumGeometry.cells(slots)!
        XCTAssertEqual(cells[5], DrumCell(planned: false, emergency: false, switching: true))
        XCTAssertEqual(cells[6], DrumCell(planned: false, emergency: true, switching: true))
        XCTAssertEqual(cells[7], DrumCell(planned: true, emergency: false, switching: false), "a planned cell is never switching")
        XCTAssertEqual(String(DrumGeometry.signature(slots).prefix(9)), "000014510")
        XCTAssertEqual(DrumGeometry.signature([]), "UNCLEAR")
    }

    func testDrumSummaryNamesTheSwitchingHalfHours() {
        var slots = (0..<48).map { slot($0) }
        for i in 8..<14 { slots[i] = slot(i, off: true, planned: true) }
        slots[14] = slot(14, switching: true)
        XCTAssertEqual(OutageRowFormat.drumSummary("uk", slots, unclearBase: false),
                       "Шкала доби: без світла: 04:00 – 07:00; перемикання: 07:00 – 07:30")
    }

    /// The live table of 2026-11-16: the snapshot's slots carry POE's switching half-hours, so the main drum
    /// and the widget (both through `slotsFor` and `DrumGeometry.cells`) draw them in the same cells.
    func testSnapshotSlotsCarryTheSwitchingCellsOfTheTable() throws {
        let day = LocalDate(year: 2026, month: 11, day: 16)!
        let table = PoeSchedule.parseDay(try poeFixture("poe_newgpv_2026-11-16.html"), date: day)
        let cells = try XCTUnwrap(table.queues["1.1"])
        let now = LocalDateTime(date: day, hour: 3, minute: 10)
        let snapshot = OutageSnapshot(
            now: now, queue: "1.1",
            outages: OutageEngine.inWindow(OutageEngine.buildPlannedCells(today: day, todayCells: cells, tomorrowCells: nil), today: day),
            plannedKnown: true, tomorrowPublished: false, site: nil, poweron: nil, hasAddress: false,
            switching: OutageEngine.switchWindows(today: day, todayCells: cells, tomorrowCells: nil)
        )
        let signature = DrumGeometry.signature(snapshot.slotsFor(day))
        for (i, c) in cells.enumerated() {
            let code = signature[signature.index(signature.startIndex, offsetBy: i)]
            switch c {
            case .OFF: XCTAssertEqual(code, "1", "cell \(i)")
            case .SWITCHING: XCTAssertEqual(code, "4", "cell \(i)")
            case .ON: XCTAssertEqual(code, "0", "cell \(i)")
            }
        }
        // the restore window starts where the shown span ends, on a switching half-hour of the table
        if let window = snapshot.restoreWindow() {
            XCTAssertTrue(window.start < window.end)
            if window.start.date == day {
                XCTAssertEqual(cells[window.start.hour * 2 + window.start.minute / 30], .SWITCHING)
            }
        }
    }

    func testNearbyRowTexts() {
        let start = LocalDateTime(iso: "2026-11-16T08:59")!
        let end = LocalDateTime(iso: "2026-11-16T15:59")!
        let row = PoeMapper.NearbyOutage(
            id: "r1", kind: .EMERGENCY, start: start, end: end, reason: "Аварійна перерва", status: .ACTIVE,
            streets: [PoeMapper.NearbyStreet(name: "вул.Дружби", houses: ["1", "9"], mine: true),
                      PoeMapper.NearbyStreet(name: "вул.Зелена", houses: [], mine: false)],
            match: .STREET
        )
        XCTAssertEqual(NearbyFormat.timeRange(row), "08:59 – 15:59")
        XCTAssertEqual(NearbyFormat.status("uk", row), "зараз")
        XCTAssertEqual(NearbyFormat.kind("uk", row), "пошкодження")
        XCTAssertEqual(NearbyFormat.duration("uk", row), AppStrings.durationText("uk", 420))
        XCTAssertEqual(NearbyFormat.yours("uk", row), "Ваша вулиця у списку")
        XCTAssertEqual(NearbyFormat.houses("uk", row.streets[0]), "буд. 1, 9")
        XCTAssertEqual(NearbyFormat.houses("uk", row.streets[1]), "уся вулиця")

        var repair = row
        repair.kind = .REPAIR
        repair.status = .UPCOMING
        repair.end = nil
        repair.match = .CONFIRMED
        XCTAssertEqual(NearbyFormat.kind("uk", repair), "планова")
        XCTAssertEqual(NearbyFormat.status("uk", repair), "о 08:59")
        XCTAssertEqual(NearbyFormat.timeRange(repair), "08:59 – --:--")
        XCTAssertNil(NearbyFormat.duration("uk", repair))
        XCTAssertEqual(NearbyFormat.yours("uk", repair), "Ваш будинок у списку")

        XCTAssertNil(NearbyFormat.staleChip("uk", NearbySnapshot(items: [row], fetchedMs: 0, complete: true)))
        let at = KyivTime.date(of: LocalDateTime(iso: "2026-11-16T14:05")!)
        let stale = NearbySnapshot(items: [row], fetchedMs: Int64(at.timeIntervalSince1970 * 1000), complete: false)
        XCTAssertEqual(NearbyFormat.staleChip("uk", stale), "дані за 14:05")
    }
}
