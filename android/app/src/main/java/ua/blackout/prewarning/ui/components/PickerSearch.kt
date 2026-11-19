package ua.blackout.prewarning.ui.components

import java.text.Normalizer
import ua.blackout.prewarning.core.HouseKey
import ua.blackout.prewarning.core.StreetKey
import ua.blackout.prewarning.core.TextNorm

/**
 * Pure matching used by [SearchablePickerField] (no Compose, unit-tested in `PickerSearchTest`).
 *
 * Matching is case-, apostrophe-, diacritic- and prefix-insensitive:
 *  - apostrophes of every kind (`'`, `’`, `ʼ` ...) are dropped on both sides (via [StreetKey]);
 *  - quotes of every kind ("", «», „“) and "№" count as spaces, so `ТОВ "Літіз` finds «ТОВ «Літіз»» and
 *    `Школа 27` finds «Школа № 27»;
 *  - Latin and Cyrillic look-alike letters share one skeleton letter (via [TextNorm.skeleton]), so a
 *    Latin "16a" finds the Cyrillic house "16А";
 *  - combining marks are stripped, so "ї" matches "і" and "й" matches "и" (typing without the special
 *    letters still finds the street);
 *  - a leading type word ("вул.", "пров.", "м.", "с.", "смт") is optional on both sides: "ш" finds
 *    "вул. Шевченка" and "вул ш" finds "Шевченка".
 *
 * An item may carry a context text (a company's PDF row): it is searched only after every label match, and
 * such a hit names the piece of the context that matched ([contextSnippet]), so a row never shows without
 * the typed words. A context hit whose piece is just the name of an item already found by its label is left
 * out (the other companies of the row of «кафе "Аква"» add nothing to a search for «кафе»).
 *
 * Results are ranked: prefix match first, then a match at the start of any word, then a plain
 * substring. Inside one rank the original order of the list is kept (streets arrive sorted); houses
 * additionally put shorter keys first so "16" lists 16 before 16А and 160.
 */
object PickerSearch {
    const val NO_MATCH = -1
    const val PREFIX = 0
    const val WORD_PREFIX = 1
    const val CONTAINS = 2

    enum class Kind { TEXT, HOUSE }

    /** Normalized form of one label or query: [full] with the type word, [core] without it. */
    class Key internal constructor(val full: String, val core: String, internal val kind: Kind) {
        val isEmpty: Boolean get() = full.isEmpty()
    }

    private val MARKS = Regex("\\p{Mn}+")
    private val SEPARATORS = Regex("[-/,()\"]")
    private val QUOTES = Regex("[\"«»„“”‟‹›№]")
    private val SPACES = Regex("\\s+")

    /** Type words that may open a street or settlement name, folded exactly like the labels are. */
    private val PREFIX_WORDS = listOf(
        "вул", "вулиця", "пров", "провулок", "просп", "проспект", "пр-т", "пр-к", "б-р", "бульвар", "бульв", "бул",
        "пл", "площа", "пр-д", "проїзд", "узв", "узвіз", "туп", "тупик", "наб", "набережна", "шосе", "майдан", "м-н",
        "м", "с", "смт", "сел", "селище", "місто", "село", "район", "р-н"
    )

    private val LEADING_TYPE: Regex by lazy {
        val alternatives = PREFIX_WORDS
            .map { foldWord(it) }
            .distinct()
            .sortedByDescending { it.length }
            .joinToString("|") { Regex.escape(it) }
        Regex("^(?:$alternatives)(?:\\.\\s*|\\s+)")
    }

    private fun fold(raw: String): String = MARKS.replace(Normalizer.normalize(raw, Normalizer.Form.NFD), "")

    private fun foldWord(word: String): String = TextNorm.skeleton(fold(word).lowercase())

    fun keyOf(raw: String, kind: Kind = Kind.TEXT): Key {
        return when (kind) {
            Kind.HOUSE -> {
                val k = HouseKey.of(fold(raw))
                Key(k, k, kind)
            }
            Kind.TEXT -> {
                val full = StreetKey.of(SPACES.replace(QUOTES.replace(fold(raw), " "), " ").trim())
                var core = full
                // two passes so "м. вул. X" style double prefixes lose both words; never strip down to nothing
                repeat(2) {
                    val stripped = LEADING_TYPE.replaceFirst(core, "")
                    if (stripped.isNotEmpty() && stripped != core) core = stripped
                }
                Key(full, core, kind)
            }
        }
    }

    private fun wordForm(core: String): String = " " + SEPARATORS.replace(core, " ")

    /** Rank of [candidate] for [query]: [PREFIX], [WORD_PREFIX], [CONTAINS] or [NO_MATCH]. An empty query matches everything as [PREFIX]. */
    fun rank(query: Key, candidate: Key): Int {
        if (query.isEmpty) return PREFIX
        if (candidate.isEmpty) return NO_MATCH
        if (candidate.full.startsWith(query.full)) return PREFIX
        if (candidate.core.startsWith(query.core)) {
            // "вул ш" ranks "вул. Шевченка" above "пров. Шевченка"; plain "ш" treats the type word as absent
            return if (query.core == query.full || query.kind == Kind.HOUSE) PREFIX else WORD_PREFIX
        }
        if (query.kind == Kind.TEXT && wordForm(candidate.core).contains(wordForm(query.core))) return WORD_PREFIX
        if (candidate.core.contains(query.core) || candidate.full.contains(query.full)) return CONTAINS
        return NO_MATCH
    }

    fun rank(query: String, label: String, kind: Kind = Kind.TEXT): Int =
        rank(keyOf(query, kind), keyOf(label, kind))

    private val CONTEXT_PIECES = Regex("[;\\n]")
    private const val SNIPPET_MAX = 70

    private fun tidy(s: String): String = s.replace(Regex("\\s+"), " ").trim()
    private fun clip(s: String): String = if (s.length > SNIPPET_MAX) s.take(SNIPPET_MAX - 1).trimEnd() + "…" else s

    /**
     * Cuts at the commas outside quotes, so «Кафе "Ні пуху, ні пера"» stays one item. The PDF leaves quotes
     * unbalanced («ТОВ «Татнєфть-АЗС Україна, ПП «Лякун»», ТОВ "Агрофірма "Маяк"-), so there is no nesting: an
     * opening quote (or a straight one after a space) opens, a closing one (or a straight one after a letter) closes.
     */
    private fun splitItems(piece: String): List<String> {
        val out = ArrayList<String>()
        var quoted = false
        var start = 0
        for ((i, ch) in piece.withIndex()) {
            when {
                ch == '«' || ch == '„' || ch == '“' -> quoted = true
                ch == '»' || ch == '”' -> quoted = false
                ch == '"' -> quoted = i == 0 || piece[i - 1].isWhitespace() || piece[i - 1] == '('
                ch == ',' && !quoted -> {
                    out.add(piece.substring(start, i))
                    start = i + 1
                }
            }
        }
        out.add(piece.substring(start))
        return out
    }

    /**
     * The first piece of [context] (cut at ";", a long piece again at ",") that matches [query], to show why an
     * item was found by its context; the clipped start of the context when the match spans pieces.
     */
    fun contextSnippet(context: String, query: String): String {
        val q = keyOf(query)
        for (piece in context.split(CONTEXT_PIECES).map(::tidy).filter { it.isNotEmpty() }) {
            if (rank(q, keyOf(piece)) == NO_MATCH) continue
            if (piece.length <= SNIPPET_MAX) return piece
            val item = splitItems(piece).map(::tidy).firstOrNull { it.isNotEmpty() && rank(q, keyOf(it)) != NO_MATCH }
            return clip(item ?: piece)
        }
        return clip(tidy(context))
    }

    /** One search result: the item and, when only its context matched, the piece of the context that did. */
    data class Hit<T>(val item: T, val snippet: String?)

    /** Keys are computed once per list (966 streets), then every keystroke only compares strings. */
    class Index<T>(
        items: List<T>,
        private val kind: Kind = Kind.TEXT,
        context: ((T) -> String?)? = null,
        label: (T) -> String
    ) {
        private val items: List<T> = items
        private val keys: List<Key> = items.map { keyOf(label(it), kind) }
        private val contexts: List<String?> = items.map { item -> context?.invoke(item)?.takeIf { it.isNotEmpty() } }
        private val contextKeys: List<Key?> = contexts.map { c -> c?.let { keyOf(it, kind) } }

        fun search(query: String): List<T> = searchHits(query).map { it.item }

        /** Label matches by rank, then the items found only by their context, each with its snippet. */
        fun searchHits(query: String): List<Hit<T>> {
            val q = keyOf(query, kind)
            if (q.isEmpty) return items.map { Hit(it, null) }
            val hits = ArrayList<Ranked>()
            for (i in items.indices) {
                val r = rank(q, keys[i])
                if (r != NO_MATCH) {
                    hits.add(Ranked(i, r, keys[i].core.length, false))
                    continue
                }
                val c = contextKeys[i]?.let { rank(q, it) } ?: NO_MATCH
                if (c != NO_MATCH) hits.add(Ranked(i, CONTAINS + 1 + c, keys[i].core.length, true))
            }
            val comparator = if (kind == Kind.HOUSE) {
                compareBy<Ranked>({ it.rank }, { it.length }, { it.index })
            } else {
                compareBy<Ranked>({ it.rank }, { it.index })
            }
            hits.sortWith(comparator)
            val found = hits.filter { !it.inContext }.map { keys[it.index].full }
            val out = ArrayList<Hit<T>>(hits.size)
            for (h in hits) {
                if (!h.inContext) {
                    out.add(Hit(items[h.index], null))
                    continue
                }
                val snippet = contextSnippet(contexts[h.index].orEmpty(), query)
                val k = keyOf(snippet, kind).full
                if (found.any { it == k || it.startsWith("$k ") }) continue
                out.add(Hit(items[h.index], snippet))
            }
            return out
        }

        private class Ranked(val index: Int, val rank: Int, val length: Int, val inContext: Boolean)
    }

    fun <T> filter(items: List<T>, query: String, kind: Kind = Kind.TEXT, label: (T) -> String): List<T> =
        Index(items, kind, label = label).search(query)
}
