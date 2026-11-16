package ua.blackout.prewarning.core

import java.time.LocalDate
import java.time.LocalDateTime

/**
 * Pure mapping of Полтаваобленерго (POE) answers to outages: the per-house status (queue, emergency
 * «пошкодження», repair works) and the per-branch outage registry. Rules: `spec/POE_API.md` section 8,
 * golden cases: `spec/vectors/poe_api.json`. Mirrored by `src/core/poeMapper.ts`. No I/O, no JSON
 * library: the per-house answer comes in as a plain map.
 */
object PoeMapper {

    const val LABEL_EMERGENCY = "Аварійна перерва"
    const val LABEL_OTHER = "Перерва в електропостачанні"
    const val LABEL_REPAIR = "Планові роботи"

    enum class RegistryKind { EMERGENCY, REPAIR, MIRROR }
    enum class Match { CONFIRMED, STREET, NONE }

    data class TimeRange(val start: LocalDateTime, val end: LocalDateTime)

    data class AddressStatus(
        val messageType: Int,
        val queue: String?,
        val emergency: EmergencyRecord?,
        val repairs: List<Outage>,
        /** The answer names an outage that could not be read: the fetch counts as unavailable. */
        val unparsed: Boolean
    )

    data class StreetEntry(val street: String, val houses: List<String>)
    data class Place(val settlement: String, val streets: List<StreetEntry>, val freeText: List<String>)

    data class RegistryRow(
        val id: String,
        val start: LocalDateTime,
        val end: LocalDateTime?,
        val reason: String,
        val kind: RegistryKind,
        val places: List<Place>
    )

    private val TIME = Regex("""^\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::\d{2})?""")
    private val ETA = Regex("""(\d{1,2})\.(\d{1,2})\.(\d{4})\s*р\.?\s*о\s*(\d{1,2})\s*годин\S*\s*(\d{1,2})\s*хвилин""")
    private val PLANNED = Regex(
        """(\d{1,2})\.(\d{1,2})\.(\d{4})\s*р\.?\s*з\s*(\d{1,2})(?:[:.](\d{2}))?(?:-?ї)?\s*до\s*(\d{1,2})(?:[:.](\d{2}))?(?:-?ї)?\s*годин"""
    )
    private val BR = Regex("""<br\s*/?>""", RegexOption.IGNORE_CASE)
    private val GROUP_BREAK = Regex("""<br\s*/?>[\s,]*<br\s*/?>""", RegexOption.IGNORE_CASE)
    private val TAG = Regex("""<[^>]*>""")
    private val TD = Regex("""<td[^>]*>(.*?)</td>""", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
    private val STREET_LINE = Regex("""^<b>(.+?)</b>\s*(?:\(б\.\s*(.*?)\))?$""", RegexOption.DOT_MATCHES_ALL)
    private val SPACES = Regex("""[\s ​]+""")
    private val SETTLEMENT_TYPE = Regex("""^(?:місто|село|селище|смт\.?|сщ\.|м\.|с\.)\s*""")
    private val BRACKET_TAIL = Regex("""\s*\([^)]*\)\s*$""")
    private val GLUED_ABBREVIATION = Regex("""^(\p{L}{1,6}\.)(?=\p{L})""")
    private val DIGIT = Regex("""\d""")

    // ---------------------------------------------------------------------------------------------
    // Times (section 8.1 - 8.3)
    // ---------------------------------------------------------------------------------------------

    private fun dateTime(day: Int, month: Int, year: Int, hour: Int, minute: Int, allow24: Boolean): LocalDateTime? =
        try {
            if (allow24 && hour == 24 && minute == 0) {
                LocalDate.of(year, month, day).plusDays(1).atStartOfDay()
            } else {
                LocalDateTime.of(year, month, day, hour, minute)
            }
        } catch (e: java.time.DateTimeException) {
            null
        }

    /** `DD.MM.YYYY HH:mm[:ss]` -> wall-clock time; anything impossible or else -> null. */
    fun parseTime(raw: String?): LocalDateTime? {
        val m = TIME.find(raw ?: return null) ?: return null
        val g = m.groupValues
        return dateTime(g[1].toInt(), g[2].toInt(), g[3].toInt(), g[4].toInt(), g[5].toInt(), allow24 = false)
    }

    /** Estimated end inside `fn_accident_message` (`... DD.MM.YYYY р. о HH годин(и) MM хвилин(и)`). */
    fun parseEta(message: String?): LocalDateTime? {
        if (message.isNullOrEmpty()) return null
        val at = message.indexOf("закінчення")
        val part = if (at >= 0) message.substring(at) else message
        val m = ETA.find(part) ?: return null
        val g = m.groupValues
        return dateTime(g[1].toInt(), g[2].toInt(), g[3].toInt(), g[4].toInt(), g[5].toInt(), allow24 = true)
    }

    /** Future repair works of `planned_message`, in text order, exact duplicates removed. */
    fun parsePlannedList(text: String?): List<TimeRange> {
        if (text.isNullOrEmpty()) return emptyList()
        val out = ArrayList<TimeRange>()
        for (part in text.split(BR)) {
            val m = PLANNED.find(part) ?: continue
            val g = m.groupValues
            val day = g[1].toInt()
            val month = g[2].toInt()
            val year = g[3].toInt()
            val start = dateTime(day, month, year, g[4].toInt(), g[5].ifEmpty { "0" }.toInt(), allow24 = true) ?: continue
            val end = dateTime(day, month, year, g[6].toInt(), g[7].ifEmpty { "0" }.toInt(), allow24 = true) ?: continue
            if (!end.isAfter(start)) continue
            val range = TimeRange(start, end)
            if (range !in out) out.add(range)
        }
        return out
    }

    /** `gp_qnum_1` + `gp_qnum_2` -> `"4.2"`; anything outside 1..6 / 1..2 (both empty included) -> null. */
    fun parseQueue(q1: String?, q2: String?): String? {
        val a = q1?.trim().orEmpty()
        val b = q2?.trim().orEmpty()
        if (!a.matches(Regex("[1-6]")) || !b.matches(Regex("[12]"))) return null
        return "$a.$b"
    }

    // ---------------------------------------------------------------------------------------------
    // Per-house status (section 8.5)
    // ---------------------------------------------------------------------------------------------

    private fun intOf(v: Any?): Long? = when (v) {
        is Number -> if (v.toDouble() == Math.floor(v.toDouble())) v.toLong() else null
        is String -> v.trim().toLongOrNull()
        else -> null
    }

    private fun strOf(v: Any?): String? = when (v) {
        null -> null
        is String -> v
        is Number -> intOf(v)?.toString() ?: v.toString()
        else -> null
    }

    /** Maps the first element of the per-house answer (E4) to outages. */
    fun addressStatus(result: Map<String, Any?>, today: LocalDate): AddressStatus {
        val messageType = intOf(result["message_type"])?.toInt() ?: -1
        val queue = parseQueue(strOf(result["gp_qnum_1"]), strOf(result["gp_qnum_2"]))
        val start = parseTime(strOf(result["accident_str"]))
        val eta = parseEta(strOf(result["fn_accident_message"]))?.takeIf { start != null && it.isAfter(start) }

        var emergency: EmergencyRecord? = null
        var unparsed = false
        val repairs = LinkedHashMap<String, Outage>()

        fun addRepair(s: LocalDateTime, e: LocalDateTime) {
            val id = "repair_$s"
            val prev = repairs[id]
            if (prev == null || e.isAfter(prev.end)) {
                repairs[id] = Outage(id = id, kind = OutageKind.REPAIR, start = s, end = e, label = LABEL_REPAIR)
            }
        }

        when (messageType) {
            0 -> Unit
            2 -> if (start != null && eta != null) addRepair(start, eta) else unparsed = true
            else -> if (start != null) {
                val accidentId = intOf(result["accident_id"])?.takeIf { it > 0 }
                emergency = EmergencyRecord(
                    id = if (accidentId != null) "poe_$accidentId" else "poe_$start",
                    start = start,
                    estimatedEnd = eta,
                    label = if (messageType == 3) LABEL_EMERGENCY else LABEL_OTHER
                )
            } else {
                unparsed = true
            }
        }

        val horizon = today.plusDays(2).atStartOfDay()
        for (r in parsePlannedList(strOf(result["planned_message"]))) {
            if (r.start.isBefore(horizon)) addRepair(r.start, r.end)
        }
        return AddressStatus(messageType, queue, emergency, repairs.values.sortedBy { it.start }, unparsed)
    }

    // ---------------------------------------------------------------------------------------------
    // Branch registry (sections 8.6 - 8.9)
    // ---------------------------------------------------------------------------------------------

    fun classifyRegistryReason(reason: String?): RegistryKind {
        val r = reason?.trim()?.lowercase().orEmpty()
        return when {
            r.contains("авар") -> RegistryKind.EMERGENCY
            r.contains("гпв") || r.contains("графік") -> RegistryKind.MIRROR
            else -> RegistryKind.REPAIR
        }
    }

    private fun stripTags(s: String): String = TAG.replace(s, "")

    private fun trimComma(s: String): String = s.trim().removeSuffix(",").trim()

    fun parseRegistryRow(outText: String?): RegistryRow? {
        val cells = TD.findAll(outText ?: return null).map { it.groupValues[1] }.toList()
        if (cells.size < 4) return null
        val start = parseTime(TextNorm.decodeEntities(stripTags(cells[0]))) ?: return null
        val end = parseTime(TextNorm.decodeEntities(stripTags(cells[1])))
        val reason = TextNorm.decodeEntities(stripTags(cells[3])).trim()
        return RegistryRow(
            id = "poe_reg_$start",
            start = start,
            end = end,
            reason = reason,
            kind = classifyRegistryReason(reason),
            places = parsePlaces(cells[2])
        )
    }

    fun parsePlaces(html: String): List<Place> {
        val out = ArrayList<Place>()
        for (group in TextNorm.decodeEntities(html).split(GROUP_BREAK)) {
            val lines = group.split(BR).map { it.trim() }.filter { it.isNotEmpty() }
            if (lines.isEmpty()) continue
            val settlement = trimComma(stripTags(lines[0]))
            if (settlement.isEmpty()) continue
            val streets = ArrayList<StreetEntry>()
            val freeText = ArrayList<String>()
            for (raw in lines.drop(1)) {
                val line = trimComma(raw)
                val m = STREET_LINE.find(line)
                if (m != null) {
                    val houses = m.groupValues[2].split(',').map { it.trim() }.filter { it.isNotEmpty() }
                    streets.add(StreetEntry(m.groupValues[1].trim(), houses))
                    continue
                }
                val text = trimComma(stripTags(line))
                if (text.isEmpty()) continue
                freeText.add(text)
                val parts = text.split(',').map { it.trim() }
                if (parts.size >= 3 && DIGIT.containsMatchIn(parts.last())) {
                    streets.add(StreetEntry(parts[parts.size - 2], listOf(parts.last())))
                } else if (parts.size == 2 && parts[1].isNotEmpty()) {
                    streets.add(StreetEntry(parts[1], emptyList()))
                }
            }
            out.add(Place(settlement, streets, freeText))
        }
        return out
    }

    /** `м.Полтава`, `місто Полтава`, `Полтава` -> one key; a bracketed tail such as `(... ТГ)` is ignored. */
    fun settlementKey(name: String): String {
        var s = SPACES.replace(TextNorm.decodeEntities(name).lowercase(), " ").trim()
        s = SETTLEMENT_TYPE.replace(s, "")
        s = BRACKET_TAIL.replace(s, "").trim()
        return StreetKey.of(s)
    }

    /** `вул.Дружби`, `вул. Дружби ` and `вул. Дружби (Леніна)` -> one key. */
    fun streetKey(name: String): String {
        var s = SPACES.replace(TextNorm.decodeEntities(name), " ").trim()
        s = BRACKET_TAIL.replace(s, "").trim()
        s = GLUED_ABBREVIATION.replace(s, "$1 ")
        return StreetKey.of(s)
    }

    /** Does a registry row name the address? Registry house lists are incomplete, see section 6. */
    fun registryMatch(places: List<Place>, settlement: String, street: String, house: String): Match {
        val sk = settlementKey(settlement)
        val stk = streetKey(street)
        var streetSeen = false
        for (p in places) {
            if (settlementKey(p.settlement) != sk) continue
            for (s in p.streets) {
                if (streetKey(s.street) != stk) continue
                if (s.houses.isNotEmpty() && HouseKey.listContains(s.houses.joinToString(", "), house)) return Match.CONFIRMED
                streetSeen = true
            }
        }
        return if (streetSeen) Match.STREET else Match.NONE
    }
}
