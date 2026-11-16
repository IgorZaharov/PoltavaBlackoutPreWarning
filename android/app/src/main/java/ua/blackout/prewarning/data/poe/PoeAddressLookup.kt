package ua.blackout.prewarning.data.poe

import android.content.Context
import ua.blackout.prewarning.core.HouseKey
import ua.blackout.prewarning.core.StreetKey
import ua.blackout.prewarning.data.KYIV_ZONE
import ua.blackout.prewarning.data.model.SelectedAddressQuery
import java.time.LocalDate
import java.util.concurrent.ConcurrentHashMap

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
    val addressLabel: String = ""
)

typealias AddressLookupResult = PoeHouseLookupResult

/**
 * The address picker and the address re-check on Полтаваобленерго data: branches from
 * [PoeBranches], settlements and streets from the bundled snapshot ([PoeDirectoryIndex],
 * `assets/poe_directory.json`), houses live from the address search (E3), the queue from the
 * per-house status (E4). Replaces the inherited ztoe lookup.
 */
object PoeAddressLookup {
    const val NO_QUEUE_TEXT = "Будинок не входить до жодної черги погодинних відключень (ГПВ). Аварійні та планові роботи за адресою відстежуються."
    private const val ASSET = "poe_directory.json"

    @Volatile
    private var index: PoeDirectoryIndex? = null
    private val housesByStreet = ConcurrentHashMap<String, List<PoeHouseLookupResult>>()
    private val streetsBySettlement = ConcurrentHashMap<String, List<PoeStreetOption>>()
    private val streetById = ConcurrentHashMap<String, PoeStreetOption>()

    @Volatile
    var client: PoeClient = PoeClient()

    /** Loads the bundled snapshot once. Safe to call from any thread; cheap after the first call. */
    fun init(context: Context) {
        if (index != null) return
        synchronized(this) {
            if (index != null) return
            index = runCatching {
                context.applicationContext.assets.open(ASSET).use { it.readBytes().toString(Charsets.UTF_8) }
            }.getOrNull()?.let { PoeDirectoryIndex.fromJson(it) }
        }
    }

    /** For unit tests and a later downloaded snapshot. */
    fun useIndex(value: PoeDirectoryIndex?) {
        index = value
        housesByStreet.clear()
        streetsBySettlement.clear()
        streetById.clear()
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

    fun findSettlementById(settlementId: String): PoeSettlementOption? =
        settlementId.toLongOrNull()?.let { index?.settlement(it) }?.let { option(it) }

    /** Streets of a settlement with spelling variants merged (spec/ADDRESS_KEY.md), sorted by name. */
    fun getStreetsForSettlement(settlementId: String): List<PoeStreetOption> {
        streetsBySettlement[settlementId]?.let { return it }
        val id = settlementId.toLongOrNull() ?: return emptyList()
        val idx = index ?: return emptyList()
        val merged = idx.streetsOf(id)
            .groupBy { StreetKey.of(it.name) }
            .values
            .map { group ->
                val first = group.first()
                PoeStreetOption(first.id.toString(), settlementId, first.name.trim(), group.map { it.id.toString() })
            }
            .sortedBy { it.nameUk.lowercase() }
        streetsBySettlement[settlementId] = merged
        for (o in merged) for (sid in o.allIds) streetById[sid] = o
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
                val result = PoeHouseLookupResult(
                    house = query.house,
                    queue = queue,
                    statusText = if (queue.isEmpty()) NO_QUEUE_TEXT else null,
                    addressLabel = addressLabel(query)
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
