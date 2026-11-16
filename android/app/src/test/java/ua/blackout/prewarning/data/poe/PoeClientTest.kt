package ua.blackout.prewarning.data.poe

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import ua.blackout.prewarning.core.EmergencyFetch
import ua.blackout.prewarning.core.PoeMapper
import ua.blackout.prewarning.core.PoeSchedule
import ua.blackout.prewarning.core.ScheduleCell
import java.io.File
import java.time.LocalDate

/**
 * [PoeClient] against the live answers of 2026-11-16 (spec/fixtures/poe/), replayed by a fake
 * transport: request shape, tri-state results, and that a failure is never "no outage".
 */
class PoeClientTest {

    private val today = LocalDate.of(2026, 11, 16)

    private fun repoDir(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            if (File(dir, "spec/fixtures/poe").isDirectory) return dir
            dir = dir.parentFile
        }
        error("spec/fixtures/poe not found above ${System.getProperty("user.dir")}")
    }

    private fun fixture(name: String) = File(repoDir(), "spec/fixtures/poe/$name").readText(Charsets.UTF_8)

    private data class Call(val endpoint: String, val field: String, val json: JSONObject, val timeout: Int)

    private class FakeTransport(private val answer: (Call) -> PoeHttpResult) : PoeTransport {
        val calls = ArrayList<Call>()
        override fun post(endpoint: String, field: String, json: String, readTimeoutMs: Int): PoeHttpResult {
            val call = Call(endpoint, field, JSONObject(json), readTimeoutMs)
            calls.add(call)
            return answer(call)
        }
    }

    private fun ok(body: String) = PoeHttpResult.Ok(body)

    // ---------------------------------------------------------------------------------------------
    // E1 schedule
    // ---------------------------------------------------------------------------------------------

    @Test
    fun scheduleOfTodayIsParsedAndRequestedWithHyphenDate() {
        val t = FakeTransport { ok(fixture("poe_newgpv_2026-11-16.html")) }
        val r = PoeClient(t).schedule(today)
        assertEquals(PoeConfig.SCHEDULE, t.calls.single().endpoint)
        assertEquals("seldate", t.calls.single().field)
        assertEquals("16-11-2026", t.calls.single().json.getString("date_in"))
        assertTrue(r is ScheduleFetch.Ok)
        val table = (r as ScheduleFetch.Ok).table
        assertEquals(PoeSchedule.Kind.PUBLISHED, table.kind)
        assertEquals(12, table.queues.size)
        val q11 = table.queues.getValue("1.1")
        assertEquals(ScheduleCell.SWITCHING, q11[0])
        assertEquals(ScheduleCell.OFF, q11[8]) // 04:00
        assertEquals(ScheduleCell.SWITCHING, q11[14]) // 07:00
    }

    @Test
    fun emptyBodyIsNotPublishedButErrorBodyAndNetworkFailureAreUnavailable() {
        assertEquals(PoeSchedule.Kind.NOT_PUBLISHED, ((PoeClient(FakeTransport { ok("") }).schedule(today.plusDays(1))) as ScheduleFetch.Ok).table.kind)
        val error = PoeClient(FakeTransport { ok("{\"title\":\"Bad Request\",\"status\":400}") }).schedule(today)
        assertEquals(ScheduleFetch.Unavailable("error_body"), error)
        assertEquals(ScheduleFetch.Unavailable("network"), PoeClient(FakeTransport { PoeHttpResult.Failed("network") }).schedule(today))
        // the live page asked for tomorrow is a date mismatch, never tomorrow's table
        val wrongDay = PoeClient(FakeTransport { ok(fixture("poe_newgpv_2026-11-16.html")) }).schedule(today.plusDays(1))
        assertEquals(ScheduleFetch.Unavailable("date_mismatch"), wrongDay)
    }

    // ---------------------------------------------------------------------------------------------
    // E2 measures, E3 directory
    // ---------------------------------------------------------------------------------------------

    @Test
    fun measuresListGavAndGop() {
        val r = PoeClient(FakeTransport { ok(fixture("poe_unloading_2026-11-16.json")) }).measures(today) as MeasuresFetch.Ok
        assertEquals(listOf("ГАВ", "ГОП"), r.measures.map { it.type })
        val gav = r.measures[0]
        assertEquals(8, gav.beginHour)
        assertEquals(54, gav.beginMinute)
        assertEquals("за розпорядженням НЕК «Укренерго»", gav.reason)
        assertEquals(MeasuresFetch.Ok(emptyList()), PoeClient(FakeTransport { ok("[]") }).measures(today))
        assertTrue(PoeClient(FakeTransport { ok("<html>") }).measures(today) is MeasuresFetch.Unavailable)
    }

    @Test
    fun directoryDropsJunkRowsAndSendsTheCabinetBranchId() {
        val t = FakeTransport { ok(fixture("poe_cabinet_cities_filial123.json")) }
        val r = PoeClient(t).cities(123) as DirectoryFetch.Ok
        val req = t.calls.single().json
        assertEquals("city", req.getString("operation_type"))
        assertEquals("123", req.getString("filial_id"))
        assertEquals("", req.getString("city_id"))
        assertTrue(r.options.any { it.id == 11389L && it.name == "місто Полтава" })
        assertTrue(r.options.none { it.name.trim() == "село _" })

        val houses = PoeClient(FakeTransport { ok(fixture("poe_cabinet_buildings_poltava_sobornosti.json")) })
            .buildings(123, 11389L, 1227174L) as DirectoryFetch.Ok
        assertTrue(houses.options.map { it.name }.containsAll(listOf("1", "11/13")))
    }

    // ---------------------------------------------------------------------------------------------
    // E4 per-house status
    // ---------------------------------------------------------------------------------------------

    @Test
    fun addressStatusUsesPoeKeySpellingAndMapsTheEmergency() {
        val t = FakeTransport { ok(fixture("poe_result_type3_emergency_noqueue.json")) }
        val r = PoeClient(t).addressStatus(11143L, 1012802L, "9", today)
        val req = t.calls.single().json
        assertEquals("11143", req.getString("cityid"))
        assertEquals("1012802", req.getString("streerid"))
        assertEquals("9", req.getString("house"))
        assertTrue(r is AddressStatusFetch.Confirmed)
        val c = r as AddressStatusFetch.Confirmed
        assertNull(c.status.queue)
        assertEquals("poe_3462256", c.status.emergency?.id)
        assertTrue(c.gavMessage!!.contains("СГАВ"))
        val fetch = PoeClient.emergencyFetch(r, today) as EmergencyFetch.Confirmed
        assertEquals(listOf("poe_3462256"), fetch.records.map { it.id })
    }

    @Test
    fun addressStatusWithNothingRegisteredIsAConfirmedEmptyEmergencyList() {
        val r = PoeClient(FakeTransport { ok(fixture("poe_result_type0_none.json")) }).addressStatus(11389L, 1227174L, "1", today)
        val c = r as AddressStatusFetch.Confirmed
        assertEquals("1.1", c.status.queue)
        assertEquals(EmergencyFetch.Confirmed(emptyList()), PoeClient.emergencyFetch(r, today))
    }

    @Test
    fun addressStatusFailuresAreUnavailableNeverNoOutage() {
        for (body in listOf("[]", "{\"status\":400}", "<html></html>", "[{\"message_type\":3,\"accident_str\":\"?\"}]")) {
            val r = PoeClient(FakeTransport { ok(body) }).addressStatus(1L, 2L, "3", today)
            assertTrue("$body -> $r", r is AddressStatusFetch.Unavailable)
            assertTrue(PoeClient.emergencyFetch(r, today) is EmergencyFetch.Unavailable)
        }
    }

    @Test
    fun addressStatusIsReusedFor60Seconds() {
        var now = 1_000_000L
        val t = FakeTransport { ok(fixture("poe_result_type0_none.json")) }
        val client = PoeClient(t) { now }
        client.addressStatus(1L, 2L, "3", today)
        now += 59_000
        client.addressStatus(1L, 2L, "3", today)
        assertEquals(1, t.calls.size)
        now += 2_000
        client.addressStatus(1L, 2L, "3", today)
        assertEquals(2, t.calls.size)
    }

    // ---------------------------------------------------------------------------------------------
    // E5 registry
    // ---------------------------------------------------------------------------------------------

    @Test
    fun registryParsesTheBranchRowsWithTheLongerTimeout() {
        val t = FakeTransport { ok(fixture("poe_gavapi_filial19_2026-11-16.json")) }
        val r = PoeClient(t).registry(19, today) as RegistryFetch.Confirmed
        val call = t.calls.single()
        assertEquals("disconngav", call.field)
        assertEquals("19", call.json.getString("filialid"))
        assertEquals(PoeConfig.REGISTRY_READ_TIMEOUT_MS, call.timeout)
        assertEquals(56, r.rows.size)
        val zuivtsi = r.rows.firstOrNull { row -> row.places.any { it.settlement == "с.Зуївці" } }
        assertNotNull(zuivtsi)
        assertEquals(PoeMapper.RegistryKind.EMERGENCY, zuivtsi!!.kind)
        assertEquals(PoeMapper.Match.STREET, PoeMapper.registryMatch(zuivtsi.places, "село Зуївці", "вул. Дружби", "3"))
        assertTrue(PoeClient(FakeTransport { ok("oops") }).registry(19, today) is RegistryFetch.Unavailable)
    }

    // ---------------------------------------------------------------------------------------------
    // Directory snapshot
    // ---------------------------------------------------------------------------------------------

    @Test
    fun bundledDirectorySnapshotIsUsable() {
        val text = File(repoDir(), "poe_directory.json").readText(Charsets.UTF_8)
        val index = PoeDirectoryIndex.fromJson(text)
        assertNotNull(index)
        index!!
        assertEquals(28, index.branches.size)
        val poltava = index.settlement(11389L)!!
        assertEquals("місто Полтава", poltava.name)
        assertEquals(9, poltava.branchCabinetIds.size)
        assertEquals(1044, index.streetsOf(11389L).size)
        assertTrue(index.settlementsOf(123).any { it.id == 11389L })
        assertTrue(index.settlements.none { it.name.trim() == "село _" })
        assertEquals(23, index.branch(123)?.registryId)
        assertNull(PoeDirectoryIndex.fromJson("{}"))
        assertNull(PoeDirectoryIndex.fromJson("not json"))
    }
}
