package ua.blackout.prewarning.core

import java.time.LocalDate

/**
 * Parses the POE schedule page fragment (`newgpv-info.php`, spec/POE_API.md section 3) into 12 queues
 * of 48 [ScheduleCell]s. Pure text scanning (no HTML library), so the TypeScript (`src/core/poeSchedule.ts`)
 * and Swift ports match it rule for rule. Golden cases: `spec/vectors/poe_schedule.json`.
 */
object PoeSchedule {

    val QUEUES = listOf("1.1", "1.2", "2.1", "2.2", "3.1", "3.2", "4.1", "4.2", "5.1", "5.2", "6.1", "6.2")

    enum class Kind { PUBLISHED, NOT_PUBLISHED, INVALID }

    data class DayTable(
        val kind: Kind,
        /** Queue -> 48 cells; empty unless [kind] is PUBLISHED. */
        val queues: Map<String, List<ScheduleCell>> = emptyMap(),
        /** `Оновлено: 15 листопада 2026 22:46` -> `15 листопада 2026 22:46`. */
        val stamp: String? = null,
        /** Why the answer is INVALID: error_body, no_date, date_mismatch, no_table, bad_row, missing_queue. */
        val reason: String? = null
    )

    private val MONTHS = listOf(
        "січня", "лютого", "березня", "квітня", "травня", "червня",
        "липня", "серпня", "вересня", "жовтня", "листопада", "грудня"
    )
    private val HEADER_DATE = Regex("""(\d{1,2})\s+(${MONTHS.joinToString("|")})\s+(\d{4})""")
    private val ROW = Regex("""<td\s+class="gpv-q"[^>]*>\s*([0-9.]+)\s*</td>(.*?)</tr>""", RegexOption.DOT_MATCHES_ALL)
    private val CELL = Regex("""<td\s+class="([^"]*)"""")
    private val STAMP = Regex("""Оновлено:\s*([^<]+)""")
    private const val TABLE_MARK = "class=\"gpv-table\""
    private const val NO_OUTAGES_MARK = "не застосов"

    private fun invalid(reason: String) = DayTable(Kind.INVALID, reason = reason)

    private fun cellOf(classes: String): ScheduleCell? {
        val tokens = classes.split(' ').filter { it.isNotEmpty() }
        if ("gpv-c" !in tokens) return null
        return when {
            "gpv-s2" in tokens -> ScheduleCell.OFF
            "gpv-s3" in tokens -> ScheduleCell.SWITCHING
            "gpv-s1" in tokens -> ScheduleCell.ON
            else -> null
        }
    }

    /** Parses the answer for [date]. An empty body is "not published yet"; it is never "no outages". */
    fun parseDay(html: String?, date: LocalDate): DayTable {
        val body = html?.trim().orEmpty()
        if (body.isEmpty()) return DayTable(Kind.NOT_PUBLISHED)
        if (body.startsWith("{") || body.startsWith("[")) return invalid("error_body")

        val tableAt = body.indexOf(TABLE_MARK)
        val head = if (tableAt >= 0) body.substring(0, tableAt) else body
        val dm = HEADER_DATE.find(head) ?: return invalid("no_date")
        val headerDate = try {
            LocalDate.of(dm.groupValues[3].toInt(), MONTHS.indexOf(dm.groupValues[2]) + 1, dm.groupValues[1].toInt())
        } catch (e: java.time.DateTimeException) {
            return invalid("no_date")
        }
        if (headerDate != date) return invalid("date_mismatch")
        val stamp = STAMP.find(body)?.groupValues?.get(1)?.trim()?.takeIf { it.isNotEmpty() }

        if (tableAt < 0) {
            if (!head.contains(NO_OUTAGES_MARK)) return invalid("no_table")
            return DayTable(Kind.PUBLISHED, QUEUES.associateWith { List(OutageConfig.SLOTS_PER_DAY) { ScheduleCell.ON } }, stamp)
        }

        val tableEnd = body.indexOf("</table>", tableAt).let { if (it < 0) body.length else it }
        val table = body.substring(tableAt, tableEnd)
        val queues = LinkedHashMap<String, List<ScheduleCell>>()
        for (row in ROW.findAll(table)) {
            val queue = row.groupValues[1]
            if (queue !in QUEUES || queue in queues) return invalid("bad_row")
            val cells = ArrayList<ScheduleCell>()
            for (c in CELL.findAll(row.groupValues[2])) {
                cells.add(cellOf(c.groupValues[1]) ?: return invalid("bad_row"))
            }
            if (cells.size != OutageConfig.SLOTS_PER_DAY) return invalid("bad_row")
            queues[queue] = cells
        }
        if (queues.size != QUEUES.size) return invalid("missing_queue")
        return DayTable(Kind.PUBLISHED, QUEUES.associateWith { queues.getValue(it) }, stamp)
    }
}
