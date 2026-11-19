import XCTest
@testable import ZTPreBlackout

/// Widgets (plan milestone M6, spec/SUBSCRIPTIONS.md 10): the widget drum shows the same 48 states as the
/// main screen's drum, the countdown has no seconds, and the model follows Android `buildWidgetModel`.
final class WidgetTests: XCTestCase {
    private let today = LocalDate(year: 2026, month: 11, day: 13)!

    private func at(_ day: Int, _ h: Int, _ m: Int = 0) -> LocalDateTime {
        LocalDateTime(year: 2026, month: 11, day: day, hour: h, minute: m)!
    }

    private func off(_ ranges: [(Int, Int)]) -> [Bool] {
        var cells = [Bool](repeating: false, count: 48)
        for (a, b) in ranges { for i in a..<b { cells[i] = true } }
        return cells
    }

    /// Planned 08:00-10:00 and 13:00-16:00 today, 01:00-03:00 tomorrow, an emergency 15:00-17:00.
    private func snapshot(now: LocalDateTime, queue: String = "5.2", tomorrow: Bool = true) -> OutageSnapshot {
        var outages = OutageEngine.buildPlanned(today: today, todayOff: off([(16, 20), (26, 32)]),
                                                tomorrowOff: tomorrow ? off([(2, 6)]) : nil)
        outages.append(OutageEngine.resolveEmergency(EmergencyRecord(id: "e1", start: at(13, 15), estimatedEnd: at(13, 17)), now: now))
        return OutageSnapshot(now: now, queue: queue, outages: OutageEngine.inWindow(outages, today: today), plannedKnown: true,
                              tomorrowPublished: tomorrow, site: nil, poweron: nil, hasAddress: true)
    }

    /// CLAUDE.md invariant: the main timeline and the big widget produce identical 48 half-hour states.
    func testWidgetDrumShowsTheSame48StatesAsTheMainDrum() {
        let snap = snapshot(now: at(13, 12, 40))
        let m = WidgetModelBuilder.build(queue: "5.2", statusText: nil, snapshot: snap, lang: "uk")
        let mainSlots = snap.slotsFor(snap.today)
        XCTAssertEqual(m.slots, mainSlots)
        let widgetCells = DrumGeometry.cells(m.slots)
        let mainCells = DrumGeometry.cells(mainSlots)
        XCTAssertEqual(widgetCells?.count, 48)
        XCTAssertEqual(widgetCells, mainCells)
        // 15:00-16:00 is planned with an emergency on top, 16:00-17:00 emergency only
        XCTAssertEqual(widgetCells?[30], DrumCell(planned: true, emergency: true))
        XCTAssertEqual(widgetCells?[32], DrumCell(planned: false, emergency: true))
        // the tinted look tells off from on by opacity
        XCTAssertEqual(WidgetDrum.tintedAlpha(DrumCell(planned: true, emergency: false)), 1)
        XCTAssertLessThan(WidgetDrum.tintedAlpha(DrumCell(planned: false, emergency: false)), 0.5)
    }

    /// I4: POE's switching half-hour on the widget drums. Planned 08:00-10:00 then switching 10:00-10:30,
    /// planned 13:00-15:00 then switching 15:00-15:30 with an emergency 15:00-16:00 on top. The widget shows
    /// the main drum's 48 states (signature codes 4 and 5), and the tinted look keeps switching apart from
    /// both off and on (spec/UI_DRUM.md, tinted widgets).
    func testWidgetDrumShowsTheSwitchingHalfHourLikeTheMainDrum() {
        var cells = [ScheduleCell](repeating: .ON, count: 48)
        for i in 16..<20 { cells[i] = .OFF }
        cells[20] = .SWITCHING
        for i in 26..<30 { cells[i] = .OFF }
        cells[30] = .SWITCHING
        let now = at(13, 10, 10)
        var outages = OutageEngine.buildPlannedCells(today: today, todayCells: cells, tomorrowCells: nil)
        outages.append(OutageEngine.resolveEmergency(EmergencyRecord(id: "e1", start: at(13, 15), estimatedEnd: at(13, 16)), now: now))
        var snap = OutageSnapshot(now: now, queue: "3.1", outages: OutageEngine.inWindow(outages, today: today), plannedKnown: true,
                                  tomorrowPublished: false, site: nil, poweron: nil, hasAddress: true)
        snap.switching = OutageEngine.switchWindows(today: today, todayCells: cells, tomorrowCells: nil)

        let m = WidgetModelBuilder.build(queue: "3.1", statusText: nil, snapshot: snap, lang: "uk")
        XCTAssertEqual(m.slots, snap.slotsFor(snap.today))
        XCTAssertEqual(DrumGeometry.cells(m.slots), DrumGeometry.cells(snap.slotsFor(snap.today)))
        let expected = String(repeating: "0", count: 16) + "1111" + "4" + "00000" + "1111" + "52" + String(repeating: "0", count: 16)
        XCTAssertEqual(DrumGeometry.signature(m.slots), expected)
        XCTAssertEqual(DrumGeometry.cells(m.slots)?[20], DrumCell(planned: false, emergency: false, switching: true))

        // inside the switching half-hour the widget does not say "off" (spec/OUTAGE_ENGINE.md 3.5)
        XCTAssertFalse(m.isUnclear)
        XCTAssertFalse(m.isOffNow, "«СВІТЛО Є» while switching")
        XCTAssertEqual(m.nextOutage, "13:00 – 16:00")

        // tinted: off > switching > on, so the three read apart without colour
        let off = WidgetDrum.tintedAlpha(DrumCell(planned: true, emergency: false))
        let switching = WidgetDrum.tintedAlpha(DrumCell(planned: false, emergency: false, switching: true))
        let on = WidgetDrum.tintedAlpha(DrumCell(planned: false, emergency: false))
        XCTAssertEqual(off, 1)
        XCTAssertEqual(switching, 0.6)
        XCTAssertEqual(on, 0.28)
        XCTAssertEqual(WidgetDrum.tintedAlpha(DrumCell(planned: false, emergency: true, switching: true)), switching,
                       "an emergency on a switching half-hour keeps the switching opacity behind its stripes")
    }

    func testCountdownHasNoSeconds() {
        XCTAssertEqual(WidgetModelBuilder.formatCountdown("01:02:03", lang: "uk"), "01г. 02хв.")
        XCTAssertEqual(WidgetModelBuilder.formatCountdown("01:02:03", lang: "en"), "01hr. 02m.")
        XCTAssertEqual(WidgetModelBuilder.formatCountdown("--:--:--", lang: "uk"), "--г. --хв.")
        XCTAssertEqual(WidgetModelBuilder.formatCountdown("1:05:00", lang: "uk"), "01г. 05хв.")
    }

    func testModelFollowsBuildWidgetModel() {
        // at 12:40 the power is on, the next outage is 13:00, today
        let on = WidgetModelBuilder.build(queue: "5.2", statusText: nil, snapshot: snapshot(now: at(13, 12, 40)), lang: "uk", label: "Київська 1")
        XCTAssertEqual(on.queueHeader, "Черга 5.2")
        XCTAssertEqual(on.queueShort, "5.2")
        XCTAssertFalse(on.isOffNow)
        XCTAssertEqual(on.countdown, "00г. 20хв.")
        XCTAssertEqual(on.nextOutage, "13:00 – 17:00")
        XCTAssertEqual(on.addressLabel, "Київська 1")
        XCTAssertFalse(on.rows.isEmpty)

        // at 20:00 nothing more today (the emergency went stale an hour after its 17:00 estimate): the next is tomorrow
        let evening = WidgetModelBuilder.build(queue: "5.2", statusText: nil, snapshot: snapshot(now: at(13, 20)), lang: "uk")
        XCTAssertEqual(evening.nextOutage, "Завтра 01:00 – 03:00")

        // no tomorrow table and the day is over: "Відключень немає" in the period
        let quiet = WidgetModelBuilder.build(queue: "5.2", statusText: nil, snapshot: snapshot(now: at(13, 20), tomorrow: false), lang: "uk")
        XCTAssertEqual(quiet.period, AppStrings.widgetNoOutages("uk"))
        XCTAssertEqual(quiet.nextOutage, AppStrings.widgetNoMoreOutages("uk"))

        // a house without a queue and an empty first launch
        let noQueue = WidgetModelBuilder.build(queue: "", statusText: "Будинок не відключається", snapshot: snapshot(now: at(13, 12), queue: ""), lang: "uk")
        XCTAssertEqual(noQueue.queueHeader, "Черга відсутня")
        XCTAssertEqual(noQueue.queueShort, "—")
        let noQueueWithQueue = WidgetModelBuilder.build(queue: "5.2", statusText: "Будинок не відключається", snapshot: snapshot(now: at(13, 12)), lang: "uk")
        XCTAssertEqual(noQueueWithQueue.queueShort, "—")
        var empty = snapshot(now: at(13, 12), queue: "")
        empty.hasAddress = false
        let unset = WidgetModelBuilder.build(queue: "", statusText: nil, snapshot: empty, lang: "en")
        XCTAssertTrue(unset.isUnclear)
        XCTAssertEqual(unset.queueHeader, "Queue —")
        XCTAssertEqual(unset.queueShort, "—")
        XCTAssertEqual(unset.countdown, "--hr. --m.")
        XCTAssertTrue(unset.slots.isEmpty)
    }

    func testTimelineHasEveryMinuteAndEveryTransition() {
        let now = KyivTime.date(of: at(13, 12, 40)).addingTimeInterval(25)
        let transitions = [Transition(at: at(13, 13), isOff: true), Transition(at: at(13, 17), isOff: false), Transition(at: at(13, 12), isOff: false)]
        let dates = WidgetModelBuilder.entryDates(now: now, transitions: transitions, minutes: 90)
        XCTAssertEqual(dates.first, now)
        XCTAssertEqual(dates, dates.sorted())
        XCTAssertEqual(Set(dates).count, dates.count)
        XCTAssertTrue(dates.contains(KyivTime.date(of: at(13, 12, 41))), "the next whole minute")
        XCTAssertTrue(dates.contains(KyivTime.date(of: at(13, 17))), "a transition beyond the 90 minutes")
        XCTAssertFalse(dates.contains(KyivTime.date(of: at(13, 12))), "a past transition")
        // 1 + 90 minutes + the 17:00 transition (13:00 falls on a minute already listed)
        XCTAssertEqual(dates.count, 92)
    }
}
