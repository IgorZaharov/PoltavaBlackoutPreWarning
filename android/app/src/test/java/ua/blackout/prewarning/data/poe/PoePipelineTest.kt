package ua.blackout.prewarning.data.poe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import ua.blackout.prewarning.core.EmergencyEventKind
import ua.blackout.prewarning.core.EmergencyLedger
import ua.blackout.prewarning.core.IntervalStatus
import ua.blackout.prewarning.core.OutageEngine
import ua.blackout.prewarning.core.OutageKind
import java.io.File
import java.time.LocalDate
import java.time.LocalDateTime

/**
 * The path OutageRepository.pollPoe takes, on the recorded POE answers of 2026-11-16: per-house status
 * -> emergency fetch -> ledger events, and repair works -> outages (docs/POLTAVA_PORT_PLAN.md, P3).
 */
class PoePipelineTest {

    private val today = LocalDate.of(2026, 11, 16)

    private fun fixture(name: String): String {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val f = File(dir, "spec/fixtures/poe/$name")
            if (f.isFile) return f.readText(Charsets.UTF_8)
            dir = dir.parentFile
        }
        error("fixture $name not found")
    }

    private fun clientAnswering(body: () -> String) = PoeClient({ _, _, _, _ -> PoeHttpResult.Ok(body()) })

    private fun status(body: String, now: LocalDateTime): AddressStatusFetch =
        clientAnswering { body }.addressStatus(11143L, 1012802L, "9", now.toLocalDate())

    @Test
    fun poshkodzhennyaStartsThenEndsWhenPoeConfirmsItIsOver() {
        val at1030 = LocalDateTime.of(2026, 11, 16, 10, 30)
        val first = EmergencyLedger.reconcile(emptyList(), PoeClient.emergencyFetch(status(fixture("poe_result_type3_emergency_noqueue.json"), at1030), today), at1030)
        assertEquals(listOf(EmergencyEventKind.START), first.events.map { it.kind })
        assertEquals("poe_3462256", first.events.single().entryId)
        val live = EmergencyLedger.outages(first.entries, at1030)
        assertEquals(OutageKind.EMERGENCY, live.single().kind)
        assertEquals(IntervalStatus.ACTIVE, live.single().statusAt(at1030))
        assertEquals(LocalDateTime.of(2026, 11, 16, 15, 59), live.single().end)

        // POE could not be asked: nothing is announced and the record stays
        val at1100 = LocalDateTime.of(2026, 11, 16, 11, 0)
        val down = EmergencyLedger.reconcile(first.entries, PoeClient.emergencyFetch(AddressStatusFetch.Unavailable("network"), today), at1100)
        assertTrue(down.events.isEmpty())
        assertEquals(first.entries.map { it.id }, down.entries.map { it.id })

        // POE answers "nothing registered": the emergency is over, announced once
        val at1530 = LocalDateTime.of(2026, 11, 16, 15, 30)
        val over = EmergencyLedger.reconcile(down.entries, PoeClient.emergencyFetch(status(fixture("poe_result_type0_none.json"), at1530), today), at1530)
        assertEquals(listOf(EmergencyEventKind.END), over.events.map { it.kind })
        assertTrue(over.events.single().earlyEnd)
    }

    @Test
    fun scheduleMirrorIsNeverAnEmergency() {
        val at1800 = LocalDateTime.of(2026, 11, 16, 18, 6)
        val fetch = status(fixture("poe_result_type4_schedule_mirror.json"), at1800)
        assertTrue((fetch as AddressStatusFetch.Confirmed).status.scheduleMirror)
        val result = EmergencyLedger.reconcile(emptyList(), PoeClient.emergencyFetch(fetch, today), at1800)
        assertTrue(result.events.isEmpty())
        assertTrue(result.entries.isEmpty())
    }

    @Test
    fun repairWorksBecomeRepairOutagesOfTodayAndTomorrow() {
        val at1200 = LocalDateTime.of(2026, 11, 16, 12, 0)
        val fetch = status(fixture("poe_result_type2_planned.json"), at1200) as AddressStatusFetch.Confirmed
        assertEquals("4.2", fetch.status.queue)
        val repairs = OutageEngine.inWindow(fetch.status.repairs, today)
        assertEquals(listOf("repair_2026-11-16T09:34", "repair_2026-11-17T08:00"), repairs.map { it.id })
        assertTrue(repairs.all { it.kind == OutageKind.REPAIR })
        // one warning for tomorrow's works (today's started already)
        val alerts = OutageEngine.planAlerts(repairs, at1200, 15)
        assertEquals(listOf("planned_2026-11-17T08:00"), alerts.map { it.key })
    }
}
