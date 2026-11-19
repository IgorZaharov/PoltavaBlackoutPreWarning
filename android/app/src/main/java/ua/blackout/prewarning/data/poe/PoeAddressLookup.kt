package ua.blackout.prewarning.data.poe

import android.content.Context
import ua.blackout.prewarning.core.HouseKey
import ua.blackout.prewarning.core.StreetKey
import ua.blackout.prewarning.data.KYIV_ZONE
import ua.blackout.prewarning.data.model.SelectedAddressQuery
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.GZIPInputStream

/** A branch in the address picker (`id` = branch slug, stored as `remSlug`). */
data class PoeBranchOption(val id: String, val cabinetId: Int, val registryId: Int, val nameUk: String, val nameEn: String)

/** A settlement (`id` = POE city_id as text; ids are global, a settlement may belong to several branches). */
data class PoeSettlementOption(val id: String, val nameUk: String, val branchIds: List<String>)

/** One street; spelling variants of the same street (StreetKey) are one option holding every id. */
data class PoeStreetOption(val id: String, val settlementId: String, val nameUk: String, val allIds: List<String> = listOf(id))

/** A house, and once POE was asked about it (E4) its queue; `queue` is empty when unknown or none. */
data class PoeHouseLookupResult(
    val house: String,
    val queue: String = "",
    val statusText: String? = null,
    val addressLabel: String = "",
    /** POE gives no queue because the address has several connections (spec/POE_API.md 8.11): ask the user. */
    val severalConnections: Boolean = false,
    /** The queues of POE's hourly-schedule catalogue for this address, best first. */
    val hints: List<ua.blackout.prewarning.core.QueueCatalogue.Hint> = emptyList()
)

typealias AddressLookupResult = PoeHouseLookupResult

/** One entry of the settlement picker: [label] names the branch when the settlement is outside the chosen one or its name repeats. */
data class SettlementChoice(val option: PoeSettlementOption, val label: String, val inBranch: Boolean)

/** Outcome of «Оновити довідник повністю». */
enum class DirectoryUpdate { UPDATED, UP_TO_DATE, FAILED }

/**
 * The address picker and the address re-check on Полтаваобленерго data: branches from
 * [PoeBranches], settlements and streets from the bundled snapshot ([PoeDirectoryIndex],
 * `assets/poe_directory.json`), houses live from the address search (E3), the queue from the
 * per-house status (E4). Replaces the inherited ztoe lookup.
 */
object PoeAddressLookup {
    const val NO_QUEUE_TEXT = "Будинок не входить до жодної черги погодинних відключень (ГПВ). Аварійні та планові роботи за адресою відстежуються."
    private const val ASSET = "poe_directory.json"
    /** The directory the weekly CI job commits (.github/workflows/poe-data.yml); never a crawl from the phone. */
    const val DIRECTORY_URL = "https://raw.githubusercontent.com/IgorZaharov/PoltavaBlackoutPreWarning/main/poe_directory.json"
    /** A newer downloaded directory, or the bundled one with the scoped refreshes merged in. */
    private const val LOCAL_FILE = "poe_directory_local.json"
    private const val PREFS = "poe_directory_prefs"

    @Volatile
    private var appContext: Context? = null

    @Volatile
    private var index: PoeDirectoryIndex? = null
    private val housesByStreet = ConcurrentHashMap<String, List<PoeHouseLookupResult>>()
    private val streetsBySettlement = ConcurrentHashMap<String, List<PoeStreetOption>>()
    private val streetById = ConcurrentHashMap<String, PoeStreetOption>()

    @Volatile
    var client: PoeClient = PoeClient()

    /**
     * Loads the directory once: the bundled snapshot, or the local copy when it is at least as new
     * (a downloaded directory, or the bundled one with refreshed lists). Safe from any thread.
     */
    fun init(context: Context) {
        if (index != null) return
        synchronized(this) {
            if (index != null) return
            appContext = context.applicationContext
            val bundled = runCatching {
                context.applicationContext.assets.open(ASSET).use { it.readBytes().toString(Charsets.UTF_8) }
            }.getOrNull()?.let { PoeDirectoryIndex.fromJson(it) }
            val local = runCatching { localFile(context).takeIf { it.isFile }?.readText(Charsets.UTF_8) }.getOrNull()
                ?.let { PoeDirectoryIndex.fromJson(it) }
            index = if (local != null && (bundled == null || local.crawledAt >= bundled.crawledAt)) local else bundled
        }
    }

    private fun localFile(context: Context) = File(context.applicationContext.filesDir, LOCAL_FILE)

    /** Replaces the index and keeps it on disk so the next start uses it too. True when the file was written. */
    private fun store(value: PoeDirectoryIndex): Boolean {
        useIndex(value)
        val ctx = appContext ?: return false
        return runCatching {
            val tmp = File(ctx.filesDir, LOCAL_FILE + ".tmp")
            tmp.writeText(value.toJson(), Charsets.UTF_8)
            tmp.renameTo(localFile(ctx))
        }.getOrDefault(false)
    }

    /** For unit tests and a later downloaded snapshot. */
    fun useIndex(value: PoeDirectoryIndex?) {
        synchronized(this) {
            index = value
            housesByStreet.clear()
            streetsBySettlement.clear()
            streetById.clear()
        }
    }

    fun indexOrNull(): PoeDirectoryIndex? = index

    // ---------------------------------------------------------------------------------------------
    // Branches, settlements, streets (local)
    // ---------------------------------------------------------------------------------------------

    fun getRems(): List<PoeBranchOption> = PoeBranches.ALL.map { PoeBranchOption(it.slug, it.cabinetId, it.registryId, it.nameUk, it.nameEn) }

    fun findRem(id: String?): PoeBranchOption? = getRems().firstOrNull { it.id == id }

    fun getSettlementsForRem(remId: String): List<PoeSettlementOption> {
        val branch = PoeBranches.bySlug(remId) ?: return emptyList()
        return index?.settlementsOf(branch.cabinetId).orEmpty().map { option(it) }
    }

    private fun option(s: PoeDirectoryIndex.Settlement) = PoeSettlementOption(
        id = s.id.toString(),
        nameUk = s.name.trim(),
        branchIds = s.branchCabinetIds.mapNotNull { PoeBranches.byCabinetId(it)?.slug }
    )

    /** Every settlement of the oblast, once each (ids are global), for the oblast-wide search (plan D4). */
    fun getAllSettlements(): List<PoeSettlementOption> = index?.settlements.orEmpty().map { option(it) }

    /**
     * The settlement picker list (plan section 4.4, D4): the chosen branch's settlements first, then the
     * rest of the oblast, each settlement once. Picking one outside the branch switches to its branch.
     */
    fun settlementChoices(remId: String, lang: String): List<SettlementChoice> {
        val all = getAllSettlements()
        val repeated = all.groupingBy { it.nameUk.trim().lowercase() }.eachCount().filterValues { it > 1 }.keys
        fun branchName(slug: String?) = PoeBranches.bySlug(slug)?.let { if (lang == "uk") it.nameUk else it.nameEn }
        val own = getSettlementsForRem(remId)
        val ownIds = own.map { it.id }.toSet()
        val first = own.map { s ->
            val label = if (s.nameUk.trim().lowercase() in repeated) "${s.nameUk} · ${branchName(remId)}" else s.nameUk
            SettlementChoice(s, label, inBranch = true)
        }
        val rest = all.filter { it.id !in ownIds }
            .sortedBy { it.nameUk.lowercase() }
            .map { s -> SettlementChoice(s, listOfNotNull(s.nameUk, branchName(s.branchIds.firstOrNull())).joinToString(" · "), inBranch = false) }
        return first + rest
    }

    fun findSettlementById(settlementId: String): PoeSettlementOption? =
        settlementId.toLongOrNull()?.let { index?.settlement(it) }?.let { option(it) }

    /** Streets of a settlement with spelling variants merged (spec/ADDRESS_KEY.md), sorted by name. */
    fun getStreetsForSettlement(settlementId: String): List<PoeStreetOption> {
        streetsBySettlement[settlementId]?.let { return it }
        val id = settlementId.toLongOrNull() ?: return emptyList()
        val idx = index ?: return emptyList()
        val built = buildStreets(idx, id, settlementId)
        // The index may have been replaced meanwhile (a refresh on another thread): never cache an old list
        synchronized(this) {
            if (index !== idx) return built
            streetsBySettlement[settlementId] = built
            for (o in built) for (sid in o.allIds) streetById[sid] = o
        }
        return built
    }

    private fun buildStreets(idx: PoeDirectoryIndex, id: Long, settlementId: String): List<PoeStreetOption> {
        val merged = idx.streetsOf(id)
            .groupBy { StreetKey.of(it.name) }
            .values
            .map { group ->
                val first = group.first()
                PoeStreetOption(first.id.toString(), settlementId, first.name.trim(), group.map { it.id.toString() })
            }
            .sortedBy { it.nameUk.lowercase() }
        return merged
    }

    /** The option that holds [streetId] among its merged ids, searched in every settlement of the snapshot. */
    fun findStreetById(streetId: String): PoeStreetOption? {
        streetById[streetId]?.let { return it }
        val id = streetId.toLongOrNull() ?: return null
        val settlement = index?.settlements?.firstOrNull { s -> s.streets.any { it.id == id } } ?: return null
        return getStreetsForSettlement(settlement.id.toString()).firstOrNull { streetId in it.allIds }
    }

    // ---------------------------------------------------------------------------------------------
    // "My address is missing" (plan section 4.4): one request to POE, or the latest directory file
    // ---------------------------------------------------------------------------------------------

    /** Asks POE for the settlements of one branch (E3) and adds the new ones. False when POE could not be asked. */
    fun refreshSettlements(remId: String): Boolean {
        val branch = PoeBranches.bySlug(remId) ?: return false
        val idx = index ?: return false
        val r = client.cities(branch.cabinetId) as? DirectoryFetch.Ok ?: return false
        store(idx.withBranchSettlements(branch.cabinetId, r.options.map { it.id to it.name.trim() }))
        return true
    }

    /** Asks POE for the streets of one settlement (E3) and adds the new ones. False when POE could not be asked. */
    fun refreshStreets(remId: String, settlementId: String): Boolean {
        val cityId = settlementId.toLongOrNull() ?: return false
        val branch = PoeBranches.bySlug(remId)
            ?: findSettlementById(settlementId)?.branchIds?.firstNotNullOfOrNull { PoeBranches.bySlug(it) }
            ?: return false
        val idx = index ?: return false
        val r = client.streets(branch.cabinetId, cityId) as? DirectoryFetch.Ok ?: return false
        store(idx.withStreets(cityId, r.options.map { it.id to it.name }))
        return true
    }

    /**
     * Downloads the directory the weekly CI job publishes (conditional request: nothing is downloaded
     * when it did not change). Only a newer crawl replaces the one in use.
     */
    fun updateDirectory(): DirectoryUpdate {
        val directory = updateDirectoryFile()
        // the queue catalogue is published by the same CI: ask for its newer copy too, whatever the directory did
        val catalogue = appContext?.let { runCatching { PoeQueues.refreshIfDue(it, force = true) }.getOrNull() }
        return if (directory == DirectoryUpdate.UPDATED || catalogue == DirectoryUpdate.UPDATED) DirectoryUpdate.UPDATED else directory
    }

    private fun updateDirectoryFile(): DirectoryUpdate {
        val ctx = appContext ?: return DirectoryUpdate.FAILED
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(DIRECTORY_URL).openConnection() as HttpURLConnection).apply {
                connectTimeout = 8000
                readTimeout = 20000
                setRequestProperty("Accept-Encoding", "gzip")
                // Only when the downloaded directory is on this phone: a restored or orphaned ETag must not hide a newer file
                if (localFile(ctx).isFile) prefs.getString("etag", null)?.let { setRequestProperty("If-None-Match", it) }
            }
            val code = conn.responseCode
            if (code == HttpURLConnection.HTTP_NOT_MODIFIED) return DirectoryUpdate.UP_TO_DATE
            if (code !in 200..299) return DirectoryUpdate.FAILED
            val stream = if (conn.contentEncoding?.lowercase()?.contains("gzip") == true) GZIPInputStream(conn.inputStream) else conn.inputStream
            val fetched = PoeDirectoryIndex.fromJson(stream.use { it.readBytes().toString(Charsets.UTF_8) }) ?: return DirectoryUpdate.FAILED
            val current = index
            if (current != null && fetched.crawledAt <= current.crawledAt) return DirectoryUpdate.UP_TO_DATE
            // A newer crawl keeps what this phone already knew, so a saved address stays findable
            val written = store(if (current != null) fetched.keeping(current) else fetched)
            val etag = conn.getHeaderField("ETag")
            if (written && etag != null) prefs.edit().putString("etag", etag).apply() else prefs.edit().remove("etag").apply()
            DirectoryUpdate.UPDATED
        } catch (_: Exception) {
            DirectoryUpdate.FAILED
        } finally {
            conn?.disconnect()
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Houses (live, E3) and the queue of one house (E4)
    // ---------------------------------------------------------------------------------------------

    fun getHousesForStreet(streetId: String): List<PoeHouseLookupResult> = housesByStreet[streetId].orEmpty()

    /** Houses of every merged id of the street, from POE; null when POE could not be asked. */
    fun fetchHousesForStreet(remId: String, settlementId: String, streetId: String): List<PoeHouseLookupResult>? {
        val street = findStreetById(streetId) ?: PoeStreetOption(streetId, settlementId, "")
        val branch = PoeBranches.bySlug(remId)
            ?: findSettlementById(settlementId)?.branchIds?.firstNotNullOfOrNull { PoeBranches.bySlug(it) }
            ?: return null
        val cityId = settlementId.toLongOrNull() ?: return null
        val names = LinkedHashMap<String, String>()
        var anyOk = false
        for (sid in street.allIds) {
            val r = client.buildings(branch.cabinetId, cityId, sid.toLongOrNull() ?: continue)
            if (r is DirectoryFetch.Ok) {
                anyOk = true
                for (o in r.options) names.putIfAbsent(HouseKey.of(o.name), o.name.trim())
            }
        }
        if (!anyOk) return null
        val known = housesByStreet[street.id].orEmpty().associateBy { HouseKey.of(it.house) }
        val houses = names.values.sortedWith(HouseOrder).map { known[HouseKey.of(it)] ?: PoeHouseLookupResult(it) }
        for (sid in street.allIds) housesByStreet[sid] = houses
        housesByStreet[street.id] = houses
        return houses
    }

    /**
     * Asks POE for the queue of one house (E4). The street's merged ids are tried in turn until POE
     * answers for one. Null when POE could not be asked or did not know the house.
     */
    fun checkAddress(query: SelectedAddressQuery, today: LocalDate = LocalDate.now(KYIV_ZONE)): PoeHouseLookupResult? {
        val cityId = query.settlementId.toLongOrNull() ?: return null
        if (HouseKey.of(query.house).isEmpty()) return null
        val street = findStreetById(query.streetId)
        val ids = (street?.allIds ?: listOf(query.streetId)).mapNotNull { it.toLongOrNull() }
        for (sid in ids) {
            val r = client.addressStatus(cityId, sid, query.house, today)
            if (r is AddressStatusFetch.Confirmed) {
                val queue = r.status.queue.orEmpty()
                val several = r.status.severalConnections
                val result = PoeHouseLookupResult(
                    house = query.house,
                    queue = queue,
                    // several connections: the queue is unknown, never "no queue" (spec/POE_API.md 8.11)
                    statusText = if (queue.isEmpty() && !several) NO_QUEUE_TEXT else null,
                    addressLabel = addressLabel(query),
                    severalConnections = several,
                    hints = if (several) runCatching { PoeQueues.queuesFor(query) }.getOrDefault(emptyList()) else emptyList()
                )
                remember(street?.id ?: query.streetId, result)
                return result
            }
        }
        return null
    }

    private fun remember(streetId: String, result: PoeHouseLookupResult) {
        val list = housesByStreet[streetId].orEmpty()
        val key = HouseKey.of(result.house)
        housesByStreet[streetId] = if (list.any { HouseKey.of(it.house) == key }) {
            list.map { if (HouseKey.of(it.house) == key) result.copy(house = it.house) else it }
        } else {
            (list + result).sortedWith(compareBy(HouseOrder) { it.house })
        }
    }

    /** `місто Полтава, вул. Соборності, буд. 1` for the notification and the address line. */
    fun addressLabel(query: SelectedAddressQuery): String {
        val settlement = findSettlementById(query.settlementId)?.nameUk.orEmpty()
        val street = findStreetById(query.streetId)?.nameUk.orEmpty()
        return listOf(settlement, street, "буд. ${query.house.trim()}").filter { it.isNotBlank() }.joinToString(", ")
    }

    /** `2` before `10`, `10` before `10а`, then the rest by text. */
    object HouseOrder : Comparator<String> {
        private val LEADING = Regex("^(\\d+)(.*)$")
        override fun compare(a: String, b: String): Int {
            val ma = LEADING.find(a.trim())
            val mb = LEADING.find(b.trim())
            if (ma != null && mb != null) {
                val na = ma.groupValues[1].toBigInteger()
                val nb = mb.groupValues[1].toBigInteger()
                if (na != nb) return na.compareTo(nb)
                return ma.groupValues[2].lowercase().compareTo(mb.groupValues[2].lowercase())
            }
            if (ma != null) return -1
            if (mb != null) return 1
            return a.lowercase().compareTo(b.lowercase())
        }
    }
}
