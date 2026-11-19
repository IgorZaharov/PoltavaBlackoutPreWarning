package ua.blackout.prewarning.data.poe

import android.content.Context
import org.json.JSONObject
import ua.blackout.prewarning.core.QueueCatalogue
import ua.blackout.prewarning.data.model.SelectedAddressQuery
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.zip.GZIPInputStream

/** A company named in POE's hourly-schedule PDF (search by workplace): its queue, branch and the text of its row. */
data class PoeCompany(
    val name: String,
    val queue: String,
    val branch: String?,
    val row: Int,
    val settlement: String?,
    val rowText: String = "",
    /** Words people search for that the PDF does not use ("ЗОШ" for «Школа № 27»). */
    val aliases: String = ""
)

/**
 * The queue catalogue (`poe_queues.json`, spec/POE_API.md 8.11): bundled in the assets, refreshed from the
 * copy this repository's CI keeps current (`.github/workflows/poe-data.yml`, job `queues`) at most once a
 * week with a conditional request. Used when the per-house status says "several connections" and gives
 * no queue, and for the company search. Mirrored by `src/services/poeQueues.ts`.
 */
object PoeQueues {
    const val CATALOGUE_URL = "https://raw.githubusercontent.com/IgorZaharov/PoltavaBlackoutPreWarning/main/poe_queues.json"
    private const val ASSET = "poe_queues.json"
    private const val LOCAL_FILE = "poe_queues_local.json"
    private const val PREFS = "poe_queues_prefs"
    private const val CHECK_EVERY_MS = 7L * 24 * 60 * 60 * 1000
    private const val RETRY_AFTER_MS = 24L * 60 * 60 * 1000

    class Catalogue(val builtAt: String, val sha256: String?, val entries: List<QueueCatalogue.Entry>, val companies: List<PoeCompany>)

    @Volatile
    private var catalogue: Catalogue? = null

    @Volatile
    private var appContext: Context? = null

    fun parse(text: String): Catalogue? = try {
        val root = JSONObject(text)
        val e = root.getJSONArray("entries")
        val entries = (0 until e.length()).map { i ->
            val o = e.getJSONObject(i)
            val houses = o.getJSONArray("houses")
            val ranges = o.getJSONArray("ranges")
            QueueCatalogue.Entry(
                queue = o.getString("q"),
                branch = if (o.isNull("branch")) null else o.getString("branch"),
                row = o.getInt("row"),
                settlement = if (o.isNull("settlement")) null else o.getString("settlement"),
                street = if (o.isNull("street")) null else o.getString("street"),
                houses = (0 until houses.length()).map { houses.getString(it) },
                ranges = (0 until ranges.length()).map { k -> ranges.getJSONArray(k).let { it.getInt(0)..it.getInt(1) } },
                whole = if (o.isNull("whole")) null else o.getString("whole")
            )
        }
        // the raw text of each row, so the company search also finds the words around a name
        val r = root.optJSONArray("rows")
        val rowTexts = HashMap<String, String>()
        if (r != null) for (i in 0 until r.length()) {
            val o = r.getJSONObject(i)
            rowTexts["${o.optString("q")}|${o.optString("branch")}|${o.optInt("n")}"] = o.optString("text")
        }
        val c = root.optJSONArray("companies")
        val companies = if (c == null) emptyList() else (0 until c.length()).map { i ->
            val o = c.getJSONObject(i)
            val branch = if (o.isNull("branch")) null else o.getString("branch")
            PoeCompany(
                name = o.getString("name"),
                queue = o.getString("q"),
                branch = branch,
                row = o.getInt("row"),
                settlement = if (o.isNull("settlement")) null else o.getString("settlement"),
                rowText = rowTexts["${o.getString("q")}|${branch.orEmpty()}|${o.getInt("row")}"].orEmpty(),
                aliases = o.optString("aliases")
            )
        }
        val sha = root.optJSONObject("source")?.let { if (it.isNull("sha256")) null else it.optString("sha256") }
        if (entries.isEmpty()) null else Catalogue(root.optString("builtAt"), sha, entries, companies)
    } catch (_: Exception) {
        null
    }

    private fun localFile(ctx: Context) = File(ctx.filesDir, LOCAL_FILE)

    /** Loads the catalogue once (the bundled one, or the downloaded one when it is newer). Call off the main thread. */
    fun init(context: Context): Catalogue? {
        catalogue?.let { return it }
        synchronized(this) {
            catalogue?.let { return it }
            val ctx = context.applicationContext
            appContext = ctx
            val bundled = runCatching { ctx.assets.open(ASSET).use { it.readBytes().toString(Charsets.UTF_8) } }.getOrNull()?.let { parse(it) }
            val local = runCatching { localFile(ctx).takeIf { it.isFile }?.readText(Charsets.UTF_8) }.getOrNull()?.let { parse(it) }
            catalogue = if (local != null && (bundled == null || local.builtAt > bundled.builtAt)) local else bundled
            return catalogue
        }
    }

    /** Remembers the context so [queuesFor] can load the catalogue on first use (cheap; no parsing here). */
    fun attach(context: Context) {
        if (appContext == null) appContext = context.applicationContext
    }

    /** For tests. */
    fun use(value: Catalogue?) {
        catalogue = value
    }

    fun current(): Catalogue? = catalogue

    /** The catalogue's queues for one address, best first (QueueCatalogue.lookup). Empty when not loaded or not listed. */
    fun queuesFor(query: SelectedAddressQuery): List<QueueCatalogue.Hint> {
        val cat = catalogue ?: appContext?.let { init(it) } ?: return emptyList()
        val settlement = PoeAddressLookup.findSettlementById(query.settlementId) ?: return emptyList()
        val street = PoeAddressLookup.findStreetById(query.streetId)?.nameUk.orEmpty()
        val branches = settlement.branchIds.ifEmpty { listOf(query.remId) }
        return QueueCatalogue.lookup(cat.entries, settlement.nameUk, branches, street, query.house)
    }

    fun companies(): List<PoeCompany> = catalogue?.companies.orEmpty()

    /**
     * Downloads the CI copy when [force] or a week has passed since the last check (a day after a failed one).
     * Conditional request with the ETag of the CI copy last seen; a newer `builtAt` replaces the one in use.
     */
    fun refreshIfDue(context: Context, force: Boolean = false, nowMs: Long = System.currentTimeMillis()): DirectoryUpdate {
        val ctx = context.applicationContext
        init(ctx)
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!force && nowMs - prefs.getLong("checked_ms", 0L) in 0 until CHECK_EVERY_MS) return DirectoryUpdate.UP_TO_DATE
        // a failed check is tried again after a day, a successful one after a week
        prefs.edit().putLong("checked_ms", nowMs - CHECK_EVERY_MS + RETRY_AFTER_MS).apply()
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(CATALOGUE_URL).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 30000
                setRequestProperty("Accept-Encoding", "gzip")
                // the ETag names the CI copy last seen, taken or not: the catalogue in use is at least as new
                prefs.getString("etag", null)?.let { setRequestProperty("If-None-Match", it) }
            }
            val code = conn.responseCode
            if (code == HttpURLConnection.HTTP_NOT_MODIFIED) {
                prefs.edit().putLong("checked_ms", nowMs).apply()
                return DirectoryUpdate.UP_TO_DATE
            }
            if (code !in 200..299) return DirectoryUpdate.FAILED
            val stream = if (conn.contentEncoding?.lowercase()?.contains("gzip") == true) GZIPInputStream(conn.inputStream) else conn.inputStream
            val text = stream.use { it.readBytes().toString(Charsets.UTF_8) }
            val fetched = parse(text) ?: return DirectoryUpdate.FAILED
            val current = catalogue
            prefs.edit().putLong("checked_ms", nowMs).apply()
            if (current != null && (fetched.builtAt <= current.builtAt || fetched.sha256 != null && fetched.sha256 == current.sha256)) {
                // not newer than the one in use: remember its ETag, so next week's check is a 304 instead of 2 MB
                conn.getHeaderField("ETag")?.let { prefs.edit().putString("etag", it).apply() }
                return DirectoryUpdate.UP_TO_DATE
            }
            val written = runCatching {
                val tmp = File(ctx.filesDir, "$LOCAL_FILE.tmp")
                tmp.writeText(text, Charsets.UTF_8)
                tmp.renameTo(localFile(ctx))
            }.getOrDefault(false)
            catalogue = fetched
            val etag = conn.getHeaderField("ETag")
            if (written && etag != null) prefs.edit().putString("etag", etag).apply() else prefs.edit().remove("etag").apply()
            DirectoryUpdate.UPDATED
        } catch (_: Exception) {
            DirectoryUpdate.FAILED
        } finally {
            conn?.disconnect()
        }
    }
}
