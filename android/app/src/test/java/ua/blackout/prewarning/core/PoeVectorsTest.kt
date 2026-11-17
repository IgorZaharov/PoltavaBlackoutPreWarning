package ua.blackout.prewarning.core

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.LocalDate
import java.time.LocalDateTime

/**
 * Runs the POE golden vectors (`spec/vectors/poe_api.json`, `spec/vectors/outage_engine_poe.json`).
 * `tests/spec-vectors.test.ts` makes the same comparisons against the TypeScript core.
 */
class PoeVectorsTest {

    private fun specDir(): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile
        while (dir != null) {
            val candidate = File(dir, "spec/vectors")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
        }
        error("spec/vectors not found above ${System.getProperty("user.dir")}")
    }

    private fun load(name: String) = JSONObject(File(specDir(), name).readText(Charsets.UTF_8))

    private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
    private fun JSONArray.strings(): List<String> = (0 until length()).map { getString(it) }
    private fun JSONObject.optStr(key: String): String? = if (!has(key) || isNull(key)) null else getString(key)
    private fun dt(s: String?): LocalDateTime? = s?.let { LocalDateTime.parse(it) }
    private fun txt(t: LocalDateTime?): String? = t?.toString()

    // ---------------------------------------------------------------------------------------------
    // poe_api.json
    // ---------------------------------------------------------------------------------------------

    private fun placesJson(places: List<PoeMapper.Place>): String = JSONArray(places.map { p ->
        JSONObject()
            .put("settlement", p.settlement)
            .put("streets", JSONArray(p.streets.map { s -> JSONObject().put("street", s.street).put("houses", JSONArray(s.houses)) }))
            .put("freeText", JSONArray(p.freeText))
    }).toString()

    /** Canonical text of a JSON value (keys sorted) so whole structures can be compared. */
    private fun canon(v: Any?): String = when (v) {
        null, JSONObject.NULL -> "null"
        is JSONObject -> v.keySet().sorted().joinToString(",", "{", "}") { "\"$it\":${canon(v.get(it))}" }
        is JSONArray -> (0 until v.length()).joinToString(",", "[", "]") { canon(v.get(it)) }
        is String -> JSONObject.quote(v)
        else -> v.toString()
    }

    @Test
    fun queueCatalogueVectors() {
        val v = load("queue_catalogue.json")
        val entries = v.getJSONArray("entries").objects().map { e ->
            val ranges = e.getJSONArray("ranges")
            QueueCatalogue.Entry(
                queue = e.getString("q"),
                branch = e.optStr("branch"),
                row = e.getInt("row"),
                settlement = e.optStr("settlement"),
                street = e.optStr("street"),
                houses = e.getJSONArray("houses").strings(),
                ranges = (0 until ranges.length()).map { i -> ranges.getJSONArray(i).let { it.getInt(0)..it.getInt(1) } },
                whole = e.optStr("whole")
            )
        }
        val cases = v.getJSONArray("cases").objects()
        assertEquals(14, cases.size)
        for (c in cases) {
            val got = JSONArray(
                QueueCatalogue.lookup(entries, c.getString("settlement"), c.getJSONArray("branches").strings(), c.getString("street"), c.getString("house")).map {
                    JSONObject().put("queue", it.queue).put("kind", it.kind.name).put("branch", it.branch ?: JSONObject.NULL).put("row", it.row).put("exact", it.exact)
                }
            )
            assertEquals("queue_catalogue: ${c.getString("name")}", canon(c.getJSONArray("expect")), canon(got))
        }
        val confident = v.getJSONArray("confident").objects()
        assertEquals(6, confident.size)
        for (c in confident) {
            val hints = c.getJSONArray("hints").objects().map {
                QueueCatalogue.Hint(it.getString("queue"), QueueCatalogue.Kind.valueOf(it.getString("kind")), it.optStr("branch"), it.getInt("row"), it.getBoolean("exact"))
            }
            assertEquals("queue_catalogue confident: ${c.getString("name")}", c.optStr("expect"), QueueCatalogue.confident(hints))
        }
    }

    @Test
    fun poeApiVectors() {
        val v = load("poe_api.json")
        mapOf(
            "times" to 10, "eta" to 7, "plannedList" to 5, "queue" to 8,
            "addressStatus" to 12, "registryReason" to 6, "registryRows" to 6, "registryMatch" to 9, "nearby" to 6, "registryRepairs" to 6
        ).forEach { (key, min) -> assertTrue("poe_api.json: $key must hold at least $min cases", v.getJSONArray(key).length() >= min) }

        for (t in v.getJSONArray("times").objects()) {
            assertEquals("time '${t.getString("in")}'", t.optStr("out"), txt(PoeMapper.parseTime(t.getString("in"))))
        }
        for (t in v.getJSONArray("eta").objects()) {
            assertEquals("eta: ${t.getString("name")}", t.optStr("out"), txt(PoeMapper.parseEta(t.getString("in"))))
        }
        for (t in v.getJSONArray("plannedList").objects()) {
            val got = JSONArray(PoeMapper.parsePlannedList(t.optStr("in")).map { JSONObject().put("start", it.start.toString()).put("end", it.end.toString()) })
            assertEquals("plannedList: ${t.getString("name")}", canon(t.getJSONArray("out")), canon(got))
        }
        for (t in v.getJSONArray("queue").objects()) {
            val input = t.getJSONArray("in")
            val q1 = if (input.isNull(0)) null else input.getString(0)
            val q2 = if (input.isNull(1)) null else input.getString(1)
            assertEquals("queue $input", t.optStr("out"), PoeMapper.parseQueue(q1, q2))
        }
        for (c in v.getJSONArray("addressStatus").objects()) {
            val name = c.getString("name")
            val st = PoeMapper.addressStatus(c.getJSONObject("in").toMap(), LocalDate.parse(c.getString("today")))
            val e = c.getJSONObject("expect")
            assertEquals("$name: messageType", e.getInt("messageType"), st.messageType)
            assertEquals("$name: queue", e.optStr("queue"), st.queue)
            assertEquals("$name: unparsed", e.getBoolean("unparsed"), st.unparsed)
            assertEquals("$name: scheduleMirror", e.getBoolean("scheduleMirror"), st.scheduleMirror)
            assertEquals("$name: severalConnections", e.getBoolean("severalConnections"), st.severalConnections)
            if (e.isNull("emergency")) {
                assertNull("$name: emergency", st.emergency)
            } else {
                val em = e.getJSONObject("emergency")
                val got = st.emergency
                assertNotNull("$name: emergency expected", got)
                assertEquals("$name: emergency.id", em.getString("id"), got!!.id)
                assertEquals("$name: emergency.start", em.getString("start"), got.start.toString())
                assertEquals("$name: emergency.estimatedEnd", em.optStr("estimatedEnd"), txt(got.estimatedEnd))
                assertEquals("$name: emergency.label", em.optStr("label"), got.label)
            }
            val repairs = JSONArray(st.repairs.map {
                assertEquals("$name: repair kind", OutageKind.REPAIR, it.kind)
                JSONObject().put("id", it.id).put("start", it.start.toString()).put("end", it.end.toString()).put("label", it.label)
            })
            assertEquals("$name: repairs", canon(e.getJSONArray("repairs")), canon(repairs))
        }
        for (t in v.getJSONArray("registryReason").objects()) {
            assertEquals("registryReason '${t.getString("in")}'", t.getString("out"), PoeMapper.classifyRegistryReason(t.getString("in")).name)
        }
        for (c in v.getJSONArray("registryRows").objects()) {
            val name = c.getString("name")
            val row = PoeMapper.parseRegistryRow(c.getString("in"))
            if (c.isNull("expect")) {
                assertNull("$name: null", row)
                continue
            }
            assertNotNull("$name: row expected", row)
            val got = JSONObject()
                .put("id", row!!.id)
                .put("start", row.start.toString())
                .put("end", row.end?.toString() ?: JSONObject.NULL)
                .put("reason", row.reason)
                .put("kind", row.kind.name)
                .put("places", JSONArray(placesJson(row.places)))
            assertEquals(name, canon(c.getJSONObject("expect")), canon(got))
        }
        for (c in v.getJSONArray("registryMatch").objects()) {
            val row = PoeMapper.parseRegistryRow(c.getString("row"))
            assertNotNull("${c.getString("name")}: row", row)
            assertEquals(
                "registryMatch: ${c.getString("name")}",
                c.getString("out"),
                PoeMapper.registryMatch(row!!.places, c.getString("settlement"), c.getString("street"), c.getString("house")).name
            )
        }
        for (c in v.getJSONArray("nearby").objects()) {
            val name = c.getString("name")
            val rowsJson = c.getJSONArray("rows")
            val rows = (0 until rowsJson.length()).map { assertNotNull("$name: row", PoeMapper.parseRegistryRow(rowsJson.getString(it))); PoeMapper.parseRegistryRow(rowsJson.getString(it))!! }
            val got = JSONArray(PoeMapper.nearbyOutages(rows, c.getString("settlement"), c.getString("street"), c.getString("house"), LocalDateTime.parse(c.getString("now"))).map { n ->
                JSONObject()
                    .put("id", n.id)
                    .put("kind", n.kind.name)
                    .put("start", n.start.toString())
                    .put("end", n.end?.toString() ?: JSONObject.NULL)
                    .put("reason", n.reason)
                    .put("status", n.status.name)
                    .put("streets", JSONArray(n.streets.map { s -> JSONObject().put("name", s.name).put("houses", JSONArray(s.houses)).put("mine", s.mine) }))
                    .put("match", n.match.name)
            })
            assertEquals("nearby: $name", canon(c.getJSONArray("expect")), canon(got))
        }
        for (c in v.getJSONArray("registryRepairs").objects()) {
            val name = c.getString("name")
            val rowsJson = c.getJSONArray("rows")
            val rows = (0 until rowsJson.length()).map { PoeMapper.parseRegistryRow(rowsJson.getString(it))!! }
            val got = PoeMapper.registryRepairs(rows, c.getString("settlement"), c.getString("street"), c.getString("house"))
            assertTrue("registryRepairs: $name: kind", got.all { it.kind == OutageKind.REPAIR })
            val json = JSONArray(got.map { JSONObject().put("id", it.id).put("start", it.start.toString()).put("end", it.end.toString()) })
            assertEquals("registryRepairs: $name", canon(c.getJSONArray("expect")), canon(json))
        }
    }

    // ---------------------------------------------------------------------------------------------
    // outage_engine_poe.json
    // ---------------------------------------------------------------------------------------------

    private fun toMin(hhmm: String): Int {
        val (h, m) = hhmm.split(":").map { it.toInt() }
        return h * 60 + m
    }

    private fun scheduleCells(day: JSONObject?): List<ScheduleCell>? {
        if (day == null) return null
        val arr = Array(48) { ScheduleCell.ON }
        fun mark(ranges: JSONArray?, state: ScheduleCell) {
            for (r in ranges?.strings().orEmpty()) {
                val (a, b) = r.split("-")
                for (k in toMin(a) / 30 until toMin(b) / 30) arr[k] = state
            }
        }
        mark(day.optJSONArray("off"), ScheduleCell.OFF)
        mark(day.optJSONArray("switching"), ScheduleCell.SWITCHING)
        return arr.toList()
    }

    private fun rangesOf(flags: List<Boolean>): List<String> {
        fun fmt(slot: Int): String = if (slot == 48) "24:00" else "%02d:%02d".format(slot / 2, (slot % 2) * 30)
        val out = ArrayList<String>()
        var start = -1
        for (i in 0..flags.size) {
            val on = i < flags.size && flags[i]
            if (on && start < 0) start = i
            if (!on && start >= 0) {
                out.add("${fmt(start)}-${fmt(i)}")
                start = -1
            }
        }
        return out
    }

    @Test
    fun outageEnginePoeVectors() {
        val cases = load("outage_engine_poe.json").getJSONArray("cases").objects()
        assertTrue("outage_engine_poe.json must hold at least 7 cases", cases.size >= 7)
        for (c in cases) {
            val name = c.getString("name")
            val today = LocalDate.parse(c.getString("today"))
            val now = LocalDateTime.parse(c.getString("now"))
            val advance = c.optInt("advanceMinutes", 15)
            val cl = c.optJSONObject("cells") ?: JSONObject()
            val t = scheduleCells(cl.optJSONObject("today"))
            val tm = scheduleCells(cl.optJSONObject("tomorrow"))
            val y = scheduleCells(cl.optJSONObject("yesterday"))

            val outages = ArrayList(OutageEngine.buildPlannedCells(today, t, tm, y))
            c.optJSONArray("repair")?.objects()?.forEach {
                outages.add(Outage(it.getString("id"), OutageKind.REPAIR, LocalDateTime.parse(it.getString("start")), LocalDateTime.parse(it.getString("end"))))
            }
            c.optJSONArray("emergencies")?.objects()?.forEach {
                val rec = EmergencyRecord(it.getString("id"), LocalDateTime.parse(it.getString("start")), dt(it.optStr("estimatedEnd")), dt(it.optStr("closedAt")), it.optStr("label"))
                outages.add(OutageEngine.resolveEmergency(rec, now))
            }
            val window = OutageEngine.inWindow(outages, today)
            val windows = OutageEngine.switchWindows(today, t, tm, y)
            val expect = c.getJSONObject("expect")

            expect.optJSONObject("status")?.let { s ->
                val st = OutageEngine.status(window, now, switching = windows)
                assertEquals("$name: isOffNow", s.getBoolean("isOffNow"), st.isOffNow)
                assertEquals("$name: countdownText", s.getString("countdownText"), st.countdownText)
                assertEquals("$name: nextSlotTime", s.getString("nextSlotTime"), st.nextSlotTime)
                assertEquals("$name: restoreUntil", s.optStr("restoreUntil"), txt(st.restoreUntil))
            }
            expect.optJSONArray("spans")?.let { exp ->
                val got = JSONArray(OutageEngine.spans(window.filter { !it.stale }).map {
                    JSONObject().put("start", it.start.toString()).put("end", it.end.toString()).put("mayContinue", it.mayContinue)
                })
                assertEquals("$name: spans", canon(exp), canon(got))
            }
            expect.optJSONArray("alerts")?.let { exp ->
                val got = JSONArray(OutageEngine.planAlerts(window, now, advance).map {
                    JSONObject().put("key", it.key).put("fireAt", it.fireAt.toString()).put("spanEnd", it.spanEnd.toString())
                        .put("mayContinue", it.mayContinue).put("durationMinutes", it.durationMinutes)
                })
                assertEquals("$name: alerts", canon(exp), canon(got))
            }
            expect.optJSONObject("days")?.let { days ->
                for (dateKey in days.keySet()) {
                    val d = days.getJSONObject(dateKey)
                    val view = OutageEngine.dayView(window, LocalDate.parse(dateKey), now, switching = windows)
                    assertEquals("$name/$dateKey: total", d.getLong("totalOffMinutes"), view.totalOffMinutes)
                    assertEquals("$name/$dateKey: plannedCells", d.getJSONArray("plannedCells").strings(), rangesOf(view.slots.map { it.planned }))
                    assertEquals("$name/$dateKey: switchingCells", d.getJSONArray("switchingCells").strings(), rangesOf(view.slots.map { it.switching }))
                    assertEquals("$name/$dateKey: emergencyCells", d.getJSONArray("emergencyCells").strings(), rangesOf(view.slots.map { it.emergency }))
                    assertTrue("$name/$dateKey: switching never with planned", view.slots.none { it.planned && it.switching })
                }
            }
        }
    }

    // ---------------------------------------------------------------------------------------------
    // poe_schedule.json
    // ---------------------------------------------------------------------------------------------

    @Test
    fun poeScheduleVectors() {
        val cases = load("poe_schedule.json").getJSONArray("cases").objects()
        assertTrue("poe_schedule.json must hold at least 13 cases", cases.size >= 13)
        val fixtures = File(specDir().parentFile, "fixtures/poe")
        for (c in cases) {
            val name = c.getString("name")
            val html = if (c.has("fixture")) File(fixtures, c.getString("fixture")).readText(Charsets.UTF_8) else c.optStr("html")
            val got = PoeSchedule.parseDay(html, LocalDate.parse(c.getString("date")))
            val e = c.getJSONObject("expect")
            assertEquals("$name: kind", e.getString("kind"), got.kind.name)
            assertEquals("$name: stamp", e.optStr("stamp"), got.stamp)
            assertEquals("$name: reason", e.optStr("reason"), got.reason)
            if (got.kind == PoeSchedule.Kind.PUBLISHED) {
                val queues = JSONObject()
                for ((q, cells) in got.queues) {
                    queues.put(q, JSONObject()
                        .put("off", JSONArray(rangesOf(cells.map { it == ScheduleCell.OFF })))
                        .put("switching", JSONArray(rangesOf(cells.map { it == ScheduleCell.SWITCHING }))))
                }
                assertEquals("$name: queues", canon(e.getJSONObject("queues")), canon(queues))
            } else {
                assertTrue("$name: no queues", got.queues.isEmpty())
            }
        }
    }
}
