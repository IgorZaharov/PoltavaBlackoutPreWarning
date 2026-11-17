package ua.blackout.prewarning.data.poe

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import ua.blackout.prewarning.core.EmergencyFetch
import ua.blackout.prewarning.core.PoeMapper
import ua.blackout.prewarning.core.PoeSchedule
import java.time.LocalDate
import java.time.format.DateTimeFormatter

/** E1: a valid table (or "not published", tomorrow only) or why it could not be read. */
sealed interface ScheduleFetch {
    data class Ok(val table: PoeSchedule.DayTable) : ScheduleFetch
    data class Unavailable(val reason: String) : ScheduleFetch
}

/** One E3 row: a settlement, street or house of the address search. */
data class DirectoryOption(val id: Long, val name: String)

sealed interface DirectoryFetch {
    data class Ok(val options: List<DirectoryOption>) : DirectoryFetch
    data class Unavailable(val reason: String) : DirectoryFetch
}

/** E4 mapped by [PoeMapper.addressStatus], plus the raw info line (`gav_message`) for display. */
sealed interface AddressStatusFetch {
    data class Confirmed(val status: PoeMapper.AddressStatus, val gavMessage: String?) : AddressStatusFetch
    data class Unavailable(val reason: String) : AddressStatusFetch
}

sealed interface RegistryFetch {
    /** [raw] keeps each row's `out_text` so the rows can be stored and parsed again later. */
    data class Confirmed(val rows: List<PoeMapper.RegistryRow>, val raw: List<String> = emptyList()) : RegistryFetch
    data class Unavailable(val reason: String) : RegistryFetch
}

/** One E2 item ("ГАВ з 08:54 до 23:59 за розпорядженням НЕК «Укренерго»"). */
data class PoeMeasure(
    val type: String,
    val beginHour: Int,
    val beginMinute: Int,
    val endHour: Int,
    val endMinute: Int,
    val reason: String?,
    val note: String?,
    val queueNumber: Int?
)

sealed interface MeasuresFetch {
    data class Ok(val measures: List<PoeMeasure>) : MeasuresFetch
    data class Unavailable(val reason: String) : MeasuresFetch
}

/**
 * The Полтаваобленерго endpoints (spec/POE_API.md section 2). Every call returns exactly one of a
 * confirmed answer or `Unavailable`; a failure is never turned into "no outage" (section 9).
 * Network goes through [transport]; parsing is the pure core ([PoeSchedule], [PoeMapper]).
 */
class PoeClient(
    private val transport: PoeTransport = HttpPoeTransport(),
    private val nowMs: () -> Long = System::currentTimeMillis
) {
    private val dateFormat = DateTimeFormatter.ofPattern("dd-MM-yyyy")
    private val statusCache = HashMap<String, Pair<Long, AddressStatusFetch.Confirmed>>()

    fun formatDate(date: LocalDate): String = date.format(dateFormat)

    private fun post(endpoint: String, field: String, json: JSONObject, readTimeoutMs: Int = PoeConfig.READ_TIMEOUT_MS): PoeHttpResult =
        transport.post(endpoint, field, json.toString(), readTimeoutMs)

    /** Top-level fields as plain values (JSON null -> null). Android's org.json has no `toMap()`. */
    private fun plainMap(o: JSONObject): Map<String, Any?> {
        val out = HashMap<String, Any?>()
        val keys = o.keys()
        while (keys.hasNext()) {
            val k = keys.next()
            out[k] = if (o.isNull(k)) null else o.get(k)
        }
        return out
    }

    /** A JSON array answer, or null when the body is not one (error object, HTML, truncated). */
    private fun arrayOf(body: String): JSONArray? = try {
        val t = body.trim()
        if (t.startsWith("[")) JSONArray(t) else null
    } catch (e: JSONException) {
        null
    }

    // ---------------------------------------------------------------------------------------------
    // E1 schedule, E2 measures
    // ---------------------------------------------------------------------------------------------

    fun schedule(date: LocalDate): ScheduleFetch =
        when (val r = post(PoeConfig.SCHEDULE, "seldate", JSONObject().put("date_in", formatDate(date)))) {
            is PoeHttpResult.Failed -> ScheduleFetch.Unavailable(r.reason)
            is PoeHttpResult.Ok -> {
                val table = PoeSchedule.parseDay(r.body, date)
                if (table.kind == PoeSchedule.Kind.INVALID) ScheduleFetch.Unavailable(table.reason ?: "invalid") else ScheduleFetch.Ok(table)
            }
        }

    fun measures(date: LocalDate): MeasuresFetch =
        when (val r = post(PoeConfig.MEASURES, "seldate", JSONObject().put("date_in", formatDate(date)))) {
            is PoeHttpResult.Failed -> MeasuresFetch.Unavailable(r.reason)
            is PoeHttpResult.Ok -> {
                val arr = if (r.body.isBlank()) JSONArray() else arrayOf(r.body)
                if (arr == null) {
                    MeasuresFetch.Unavailable("not_an_array")
                } else {
                    MeasuresFetch.Ok((0 until arr.length()).mapNotNull { i ->
                        val o = arr.optJSONObject(i) ?: return@mapNotNull null
                        val type = o.optString("unloadingtypename").trim()
                        if (type.isEmpty()) return@mapNotNull null
                        PoeMeasure(
                            type = type,
                            beginHour = o.optInt("beginhour", 0),
                            beginMinute = o.optInt("beginminute", 0),
                            endHour = o.optInt("endhour", 23),
                            endMinute = o.optInt("endminute", 59),
                            reason = o.optString("unloadingreasonname").trim().ifEmpty { null },
                            note = if (o.isNull("note")) null else o.optString("note").trim().ifEmpty { null },
                            queueNumber = if (o.isNull("unloading_queue_number")) null else o.optInt("unloading_queue_number")
                        )
                    })
                }
            }
        }

    // ---------------------------------------------------------------------------------------------
    // E3 address directory
    // ---------------------------------------------------------------------------------------------

    private fun directory(op: String, cabinetId: Int, cityId: Long?, streetId: Long?): DirectoryFetch {
        val req = JSONObject()
            .put("operation_type", op)
            .put("filial_id", cabinetId.toString())
            .put("city_id", cityId?.toString() ?: "")
            .put("street_id", streetId?.toString() ?: "")
        return when (val r = post(PoeConfig.DIRECTORY, "disconn", req)) {
            is PoeHttpResult.Failed -> DirectoryFetch.Unavailable(r.reason)
            is PoeHttpResult.Ok -> {
                val arr = arrayOf(r.body) ?: return DirectoryFetch.Unavailable("not_an_array")
                DirectoryFetch.Ok((0 until arr.length()).mapNotNull { i ->
                    val o = arr.optJSONObject(i) ?: return@mapNotNull null
                    val id = o.optLong("instance_id", -1L)
                    val name = o.optString("instance_name")
                    if (id < 0 || isJunkName(name)) null else DirectoryOption(id, name)
                })
            }
        }
    }

    /** `село _` and empty names are rows without a real name (spec/POE_API.md section 4). */
    fun isJunkName(name: String): Boolean {
        val rest = name.trim().split(Regex("\\s+"), limit = 2).let { if (it.size == 2) it[1] else it[0] }.trim()
        return name.isBlank() || rest.isEmpty() || rest.all { it == '_' || it == '-' }
    }

    fun cities(cabinetId: Int): DirectoryFetch = directory("city", cabinetId, null, null)
    fun streets(cabinetId: Int, cityId: Long): DirectoryFetch = directory("street", cabinetId, cityId, null)
    fun buildings(cabinetId: Int, cityId: Long, streetId: Long): DirectoryFetch = directory("building", cabinetId, cityId, streetId)

    // ---------------------------------------------------------------------------------------------
    // E4 per-house status, E5 branch registry
    // ---------------------------------------------------------------------------------------------

    /** Queue, emergency and repair works of one house; answers are reused for 60 s per house. */
    fun addressStatus(cityId: Long, streetId: Long, house: String, today: LocalDate): AddressStatusFetch {
        val key = "$cityId|$streetId|$house|$today"
        statusCache[key]?.let { (at, value) -> if (nowMs() - at in 0 until PoeConfig.ADDRESS_STATUS_TTL_MS) return value }
        // `streerid` is POE's own spelling of the key (spec/POE_API.md section 2, trap 2)
        val req = JSONObject().put("cityid", cityId.toString()).put("streerid", streetId.toString()).put("house", house)
        val result = when (val r = post(PoeConfig.ADDRESS_STATUS, "disconn", req)) {
            is PoeHttpResult.Failed -> AddressStatusFetch.Unavailable(r.reason)
            is PoeHttpResult.Ok -> {
                val first = arrayOf(r.body)?.optJSONObject(0)
                if (first == null) {
                    AddressStatusFetch.Unavailable("empty")
                } else {
                    val status = PoeMapper.addressStatus(plainMap(first), today)
                    if (status.unparsed) {
                        AddressStatusFetch.Unavailable("unparsed")
                    } else {
                        val gav = if (first.isNull("gav_message")) null else first.optString("gav_message").trim().ifEmpty { null }
                        AddressStatusFetch.Confirmed(status, gav)
                    }
                }
            }
        }
        if (result is AddressStatusFetch.Confirmed) statusCache[key] = nowMs() to result
        return result
    }

    fun registry(registryId: Int, date: LocalDate): RegistryFetch {
        val req = JSONObject().put("filialid", registryId.toString()).put("date_in", formatDate(date))
        return when (val r = post(PoeConfig.REGISTRY, "disconngav", req, PoeConfig.REGISTRY_READ_TIMEOUT_MS)) {
            is PoeHttpResult.Failed -> RegistryFetch.Unavailable(r.reason)
            is PoeHttpResult.Ok -> {
                val arr = arrayOf(r.body) ?: return RegistryFetch.Unavailable("not_an_array")
                val raw = (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.optString("out_text")?.takeIf { it.isNotBlank() } }
                RegistryFetch.Confirmed(raw.mapNotNull { PoeMapper.parseRegistryRow(it) }, raw)
            }
        }
    }

    companion object {
        /**
         * The emergency input of [ua.blackout.prewarning.core.EmergencyLedger] from an E4 answer. Records
         * starting on or after the day after tomorrow are dropped before the ledger sees them (the
         * adapter rule of spec/POWERON_API.md 5.3, which applies to POE the same way).
         */
        fun emergencyFetch(fetch: AddressStatusFetch, today: LocalDate): EmergencyFetch = when (fetch) {
            is AddressStatusFetch.Unavailable -> EmergencyFetch.Unavailable(fetch.reason)
            is AddressStatusFetch.Confirmed -> {
                val horizon = today.plusDays(2).atStartOfDay()
                EmergencyFetch.Confirmed(listOfNotNull(fetch.status.emergency).filter { it.start.isBefore(horizon) })
            }
        }
    }
}
