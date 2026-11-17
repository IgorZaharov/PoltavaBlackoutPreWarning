package ua.blackout.prewarning.core

/**
 * Address -> queue from the POE hourly-schedule catalogue (`poe_queues.json`, built from POE's PDF by
 * `scripts/build_poe_queue_catalogue.py`). Rules: `spec/POE_API.md` 8.11, golden cases:
 * `spec/vectors/queue_catalogue.json`. Mirrored by `src/core/queueCatalogue.ts`. Pure: the entries are
 * parsed by the data layer. The catalogue is free text turned into data, so a hint never overrides the
 * per-house status (E4); it fills in the queue when E4 says "several connections" and gives none.
 */
object QueueCatalogue {

    enum class Kind { HOUSE, RANGE, STREET, SETTLEMENT }

    data class Entry(
        val queue: String,
        val branch: String?,
        val row: Int,
        val settlement: String?,
        /** Null = the whole settlement. */
        val street: String?,
        val houses: List<String>,
        val ranges: List<IntRange>,
        /** "street" when the row lists the street without houses; "settlement" for a whole settlement. */
        val whole: String?
    )

    data class Hint(val queue: String, val kind: Kind, val branch: String?, val row: Int, val exact: Boolean)

    /**
     * The queue a refresh may fill in without asking (spec/POE_API.md 8.11 step 5): the best hint, when no other
     * queue has a hint of the same kind and exactness. Null when there is none or it is a tie.
     */
    fun confident(hints: List<Hint>): String? {
        val best = hints.firstOrNull() ?: return null
        val tie = hints.drop(1).any { it.kind == best.kind && it.exact == best.exact }
        return if (tie) null else best.queue
    }

    private val TYPE_PREFIX = Regex("^\\s*([\\p{L}-]+)\\.?\\s*(.*)$")
    private val DIGITS = Regex("^\\d+$")

    /** The street name without a leading type word ("вул. Європейська", "вул.Європейська" -> "Європейська"). */
    fun withoutType(name: String): String {
        val m = TYPE_PREFIX.find(name) ?: return name.trim()
        val rest = m.groupValues[2]
        return if (rest.isNotBlank() && StreetKey.isTypeWord(m.groupValues[1])) rest.trim() else name.trim()
    }

    /** `full` key and its last word (after the last space or dot), see 8.11 step 2. */
    fun streetKeys(name: String): Pair<String, String> {
        val full = PoeMapper.streetKey(withoutType(name))
        val last = full.substring(maxOf(full.lastIndexOf(' '), full.lastIndexOf('.')) + 1)
        return full to last
    }

    fun lookup(entries: List<Entry>, settlement: String, branches: List<String>, street: String, house: String): List<Hint> {
        val sk = PoeMapper.settlementKey(settlement)
        val (full, last) = if (street.isBlank()) "" to "" else streetKeys(street)
        val hk = if (house.isBlank()) "" else HouseKey.of(house)
        val number = if (DIGITS.matches(hk)) hk.toIntOrNull() else null
        val hits = ArrayList<Hint>()
        for (e in entries) {
            val es = e.settlement ?: continue
            if (PoeMapper.settlementKey(es) != sk) continue
            if (branches.isNotEmpty() && e.branch !in branches) continue
            if (e.street == null) {
                hits.add(Hint(e.queue, Kind.SETTLEMENT, e.branch, e.row, exact = true))
                continue
            }
            if (full.isEmpty()) continue
            val (eFull, eLast) = streetKeys(e.street)
            val exact = eFull == full
            if (!exact && eLast != last) continue
            val kind = when {
                // a street without a house number (POE lists no houses) matches the whole street only
                hk.isEmpty() -> if (e.whole == "street") Kind.STREET else null
                e.houses.any { HouseKey.of(it) == hk } -> Kind.HOUSE
                number != null && e.ranges.any { number in it } -> Kind.RANGE
                e.whole == "street" -> Kind.STREET
                else -> null
            } ?: continue
            hits.add(Hint(e.queue, kind, e.branch, e.row, exact))
        }
        val sorted = hits.sortedWith(compareBy<Hint>({ it.kind.ordinal }, { if (it.exact) 0 else 1 }, { it.queue }, { it.row }))
        val seen = HashSet<String>()
        return sorted.filter { seen.add(it.queue) }
    }
}
