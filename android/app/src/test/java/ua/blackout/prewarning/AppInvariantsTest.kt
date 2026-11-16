package ua.blackout.prewarning

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import ua.blackout.prewarning.core.PoeSchedule
import ua.blackout.prewarning.core.ScheduleCell
import ua.blackout.prewarning.data.model.BlackoutSlot
import ua.blackout.prewarning.data.model.SlotStatus
import ua.blackout.prewarning.data.model.UserSettings
import ua.blackout.prewarning.data.repository.DonationsRepository
import ua.blackout.prewarning.ui.AppStrings
import ua.blackout.prewarning.ui.theme.TimeOfDayPalette
import java.io.File
import java.time.LocalDate
import java.time.LocalTime

/**
 * App-wide invariants (texts, defaults, main window and widget parity, Today/Tomorrow periods) that
 * tests/unit.test.ts checks on the web side too. Until P3 of docs/POLTAVA_PORT_PLAN.md this file was
 * ZtoeParserTest and fed the checks from the ztoe parser; they now read the POE tables.
 */
class AppInvariantsTest {

    private fun repoDir(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            if (File(dir, "spec/fixtures/poe").isDirectory) return dir
            dir = dir.parentFile
        }
        error("spec/fixtures/poe not found above ${System.getProperty("user.dir")}")
    }

    /** The 48 slots of one day as the main screen and the widgets draw them ('1' off, the rest on). */
    private fun slotsOf(cells: List<ScheduleCell>, date: LocalDate, queue: String): List<BlackoutSlot> = cells.mapIndexed { i, c ->
        val start = i * 30
        val end = start + 30
        fun hhmm(m: Int) = if (m >= 1440) "24:00" else "%02d:%02d".format(m / 60, m % 60)
        BlackoutSlot(
            id = "${date}_${hhmm(start)}_Q$queue",
            startHour = start / 60,
            endHour = end / 60,
            startMinute = start % 60,
            endMinute = end % 60,
            startTimeStr = hhmm(start),
            endTimeStr = hhmm(end),
            status = if (c == ScheduleCell.OFF) SlotStatus.POWER_OFF else SlotStatus.POWER_ON,
            isSwitching = c == ScheduleCell.SWITCHING
        )
    }

    @Test
    fun testUnitA_PoeScheduleAndMainWidgetGraphParity() {
        val date = LocalDate.of(2026, 11, 16)
        val html = File(repoDir(), "spec/fixtures/poe/poe_newgpv_2026-11-16.html").readText(Charsets.UTF_8)
        val table = PoeSchedule.parseDay(html, date)
        assertEquals(PoeSchedule.Kind.PUBLISHED, table.kind)
        val queue = PoeSchedule.QUEUES.random()
        val slots = slotsOf(table.queues.getValue(queue), date, queue)
        assertTrue("Expected blackout slots for queue $queue", slots.any { it.status == SlotStatus.POWER_OFF })

        // Main window TimelineBar and big widget (BlackoutGlanceWidget): 48 half-hour blocks each
        val mainWindowBlocks = (0 until 24).flatMap { hour ->
            listOf(slots[hour * 2].status == SlotStatus.POWER_OFF, slots[hour * 2 + 1].status == SlotStatus.POWER_OFF)
        }
        val bigWidgetBlocks = (0 until 24).flatMap { hour ->
            listOf(slots.getOrNull(hour * 2)?.status == SlotStatus.POWER_OFF, slots.getOrNull(hour * 2 + 1)?.status == SlotStatus.POWER_OFF)
        }
        assertEquals(48, mainWindowBlocks.size)
        assertEquals(48, bigWidgetBlocks.size)
        assertEquals("Discrepancy between the main window graph and the big widget graph for queue $queue", mainWindowBlocks, bigWidgetBlocks)
        // the switching half-hour is never drawn as off
        assertFalse(slots.any { it.isSwitching && it.status == SlotStatus.POWER_OFF })
    }

    @Test
    fun testUnitB_CriticalUiTextDefaultsAndInvariants() {
        val defaults = UserSettings()
        assertEquals("Default advanceNoticeMinutes must be 15", 15, defaults.advanceNoticeMinutes)
        assertEquals("Default refreshIntervalMinutes must be 30", 30L, defaults.refreshIntervalMinutes)

        assertEquals("Світло в Полтаві", AppStrings.aboutTitle("uk"))
        val steps = AppStrings.queueHelpSteps("uk")
        assertEquals(4, steps.size)
        assertEquals("1. Відкрийте сторінку пошуку черги на сайті https://www.ztoe.com.ua/unhooking-search.php", steps[0])
        assertEquals("2. Оберіть свій РЕМ, населений пункт і вулицю.", steps[1])
        assertEquals(
            "3. У таблиці знайдіть свій будинок і подивіться стовпці «Черга» і «Підчерга». Наприклад, черга 5 і підчерга 2 - це 5.2.",
            steps[2]
        )
        assertEquals("4. Виберіть це значення у полі «Черга» у вікні налаштувань (кнопка ⚙).", steps[3])
        assertEquals("Зрозуміло", AppStrings.queueHelpGotIt("uk"))
        assertEquals("Немає доступу до Інтернету", AppStrings.errorNoInternet("uk"))
        assertEquals("На сайті не знайдено черг", AppStrings.errorNoQueuesFound("uk"))
        assertEquals("https://www.facebook.com/atpoltavaoblenergo", AppStrings.EMERGENCY_OUTAGES_URL)
        assertEquals("Charity / Благодійність і Пожертви", AppStrings.aboutDonationsTitle("uk"))
        assertEquals("Charity / Благодійність і Пожертви", AppStrings.aboutDonationsTitle("en"))
        assertEquals("BLACKOUT HOURS FOR TODAY:", AppStrings.blackoutHoursHeader("en"))
        assertEquals(2, DonationsRepository.DEFAULT_DONATIONS.size)
        assertEquals("Допомога тваринам", DonationsRepository.DEFAULT_DONATIONS[0].title)
        assertEquals("https://send.monobank.ua/jar/7vJA5xrLoV", DonationsRepository.DEFAULT_DONATIONS[0].url)
        assertEquals("Фонд Повернись Живим", DonationsRepository.DEFAULT_DONATIONS[1].title)
        assertEquals("https://savelife.in.ua/donate/", DonationsRepository.DEFAULT_DONATIONS[1].url)
        assertEquals(24L * 60L * 60L * 1000L, DonationsRepository.REFRESH_INTERVAL_MS)

        val morningColors = TimeOfDayPalette.getInterpolatedColors(LocalTime.of(8, 30))
        assertEquals(TimeOfDayPalette.MORNING.primary, morningColors.primary)
    }

    @Test
    fun testUnitC_TomorrowNextPeriodAndDayTabIntervals() {
        val today = LocalDate.of(2026, 11, 2)
        fun day(off: IntRange): List<ScheduleCell> = List(48) { i ->
            when (i) {
                in off -> ScheduleCell.OFF
                off.last + 1 -> ScheduleCell.SWITCHING
                else -> ScheduleCell.ON
            }
        }
        // Today: blackout 08:00–10:00 (slots 16..19); tomorrow: 14:00–17:00 (slots 28..33); a switching half-hour after each
        val todaySlots = slotsOf(day(16..19), today, "1.1")
        val tomorrowSlots = slotsOf(day(28..33), today.plusDays(1), "1.1")

        val todayIntervals = ua.blackout.prewarning.data.repository.ScheduleRepository.computeDetailedIntervals(todaySlots)
        val tomorrowIntervals = ua.blackout.prewarning.data.repository.ScheduleRepository.computeDetailedIntervals(tomorrowSlots)

        assertEquals(1, todayIntervals.size)
        assertEquals("08:00", todayIntervals[0].startStr)
        assertEquals("10:00", todayIntervals[0].endStr)

        assertEquals(1, tomorrowIntervals.size)
        assertEquals("14:00", tomorrowIntervals[0].startStr)
        assertEquals("17:00", tomorrowIntervals[0].endStr)

        // At 21:00 (after today's 08:00–10:00 blackout), Next period must show tomorrow's 1st blackout (14:00 – 17:00), NOT today's 1st blackout (08:00 – 10:00)
        val statusAt21 = ua.blackout.prewarning.data.repository.ScheduleRepository.calculateStatusAndCountdown(
            slots = todaySlots,
            tomorrowSlots = tomorrowSlots,
            now = LocalTime.of(21, 0, 0)
        )
        assertEquals(false, statusAt21.isBlackoutNow)
        assertEquals("14:00 – 17:00", statusAt21.nextSlotTime)
        assertEquals("17:00:00", statusAt21.countdownText)
        assertNotNull(statusAt21)
    }

    @Test
    fun testUnitD_AboutLinksAndUnclearState() {
        // ZTOE schedules link, About GitHub README link, Unclear schedule state & uk / en localization
        // (kept from the removed roulette test; the roulette is not part of «Світло в Полтаві», D5)
        assertEquals("Графіки відключень на сайті", AppStrings.siteSchedulesLabel("uk"))
        assertEquals("https://www.ztoe.com.ua/unhooking-search.php", AppStrings.SITE_SCHEDULES_URL)
        assertEquals("Світло в Полтаві на Github", AppStrings.desktopApp("uk"))
        assertEquals("Світло в Полтаві на Github", AppStrings.desktopApp("en"))
        assertEquals("https://github.com/IgorZaharov/PoltavaBlackoutPreWarning/blob/main/README.md", AppStrings.ABOUT_GITHUB_README_URL)
        assertEquals("Невідомо", AppStrings.powerUnclear("uk"))
        assertEquals("Unclear", AppStrings.powerUnclear("en"))
        assertEquals("Графіки не діють", AppStrings.outagesUnclear("uk"))
        assertEquals("Outages unclear", AppStrings.outagesUnclear("en"))

        val unclearStatus = ua.blackout.prewarning.data.repository.ScheduleRepository.calculateStatusAndCountdown(
            slots = emptyList(),
            tomorrowSlots = null,
            now = LocalTime.of(12, 0)
        )
        assertEquals(true, unclearStatus.isUnclear)
        assertEquals("--:-- - --:--", unclearStatus.nextSlotTime)
    }
}
