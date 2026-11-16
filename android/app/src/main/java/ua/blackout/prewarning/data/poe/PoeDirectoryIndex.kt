package ua.blackout.prewarning.data.poe

import org.json.JSONObject

/**
 * The POE address directory snapshot (`poe_directory.json`: branches, settlements, streets; houses are
 * loaded live). Built by `scripts/crawl_poe_directory.py`, bundled in the app and refreshed as described
 * in docs/POLTAVA_PORT_PLAN.md section 4.4. Settlement and street ids are global (spec/POE_API.md
 * section 2, trap 4), so the index is keyed by settlement id and a settlement lists every branch it
 * belongs to.
 */
class PoeDirectoryIndex private constructor(
    val crawledAt: String,
    val branches: List<Branch>,
    val settlements: List<Settlement>
) {
    data class Branch(val cabinetId: Int, val registryId: Int, val name: String)
    data class Street(val id: Long, val name: String)
    data class Settlement(val id: Long, val name: String, val branchCabinetIds: List<Int>, val streets: List<Street>)

    private val byId: Map<Long, Settlement> = settlements.associateBy { it.id }

    fun settlement(id: Long): Settlement? = byId[id]

    /** Settlements of one branch (a settlement may belong to several), in snapshot order. */
    fun settlementsOf(cabinetId: Int): List<Settlement> = settlements.filter { cabinetId in it.branchCabinetIds }

    fun streetsOf(settlementId: Long): List<Street> = byId[settlementId]?.streets.orEmpty()

    fun branch(cabinetId: Int): Branch? = branches.firstOrNull { it.cabinetId == cabinetId }

    companion object {
        /** Parses the snapshot; null when the text is not a usable snapshot (the bundled copy is then kept). */
        fun fromJson(text: String): PoeDirectoryIndex? = try {
            val root = JSONObject(text)
            val br = root.getJSONArray("branches")
            val branches = (0 until br.length()).map {
                val o = br.getJSONObject(it)
                Branch(o.getInt("cabinetId"), o.getInt("registryId"), o.getString("name"))
            }
            val st = root.getJSONArray("settlements")
            val settlements = (0 until st.length()).map { i ->
                val o = st.getJSONObject(i)
                val ids = o.getJSONArray("branches")
                val streets = o.getJSONArray("streets")
                Settlement(
                    id = o.getLong("id"),
                    name = o.getString("name"),
                    branchCabinetIds = (0 until ids.length()).map { ids.getInt(it) },
                    streets = (0 until streets.length()).map { k ->
                        val pair = streets.getJSONArray(k)
                        Street(pair.getLong(0), pair.getString(1))
                    }
                )
            }
            if (branches.isEmpty() || settlements.isEmpty()) null
            else PoeDirectoryIndex(root.optString("crawledAt"), branches, settlements)
        } catch (e: org.json.JSONException) {
            null
        }
    }
}
