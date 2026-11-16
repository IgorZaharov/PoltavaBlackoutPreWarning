package ua.blackout.prewarning.data.poe

import android.content.Context
import org.json.JSONArray
import ua.blackout.prewarning.core.FetchFailure
import ua.blackout.prewarning.core.PoeSchedule
import ua.blackout.prewarning.core.SiteState
import ua.blackout.prewarning.core.SiteStateResolver
import ua.blackout.prewarning.data.KYIV_ZONE
import ua.blackout.prewarning.data.net.NetworkProbe
import ua.blackout.prewarning.data.repository.ScheduleRepository
import java.time.LocalDate

/** Outcome of a schedule check, in the shape the settings screen shows. */
enum class FetchStatus {
    SUCCESS,
    NO_INTERNET,
    NO_QUEUES_FOUND
}

data class ScheduleSyncResult(
    val status: FetchStatus,
    val siteState: SiteState,
    /** Active measures (ГАВ, СГАВ, ГОП ...) as one notice text, or null. */
    val notice: String?
)

/**
 * Refreshes the POE queue tables (spec/POE_API.md sections 3, 7): today and tomorrow for all 12 queues
 * in one request each, stored by [ScheduleRepository] as three-state cells. A failure never clears the
 * cached schedule (spec/SITE_STATE.md); tomorrow keeps its cached table when only tomorrow failed.
 */
object PoeScheduleSync {
    /** The POE page users know; shown in Settings and checked against `valid-urls.json`. */
    const val DEFAULT_SITE_URL = "https://www.poe.pl.ua/disconnection/power-outages/"

    @Volatile
    var client: PoeClient = PoeClient()

    private fun loadValidUrls(context: Context): List<String> = try {
        val text = context.assets.open("valid-urls.json").use { it.readBytes().toString(Charsets.UTF_8) }
        val arr = JSONArray(text)
        (0 until arr.length()).map { arr.getString(it).trim().trimEnd('/') }
    } catch (_: Exception) {
        listOf(DEFAULT_SITE_URL.trimEnd('/'))
    }

    fun isValidUrl(url: String, context: Context): Boolean = url.trim().trimEnd('/') in loadValidUrls(context)

    fun refresh(context: Context, today: LocalDate = LocalDate.now(KYIV_ZONE)): ScheduleSyncResult {
        val schedule = ScheduleRepository(context)
        val todayFetch = client.schedule(today)
        val tomorrowFetch = client.schedule(today.plusDays(1))
        val notice = (client.measures(today) as? MeasuresFetch.Ok)?.let { noticeOf(it.measures) }

        return when (todayFetch) {
            is ScheduleFetch.Ok -> {
                val table = todayFetch.table
                if (table.kind == PoeSchedule.Kind.PUBLISHED) {
                    val tomorrow: Map<String, List<ua.blackout.prewarning.core.ScheduleCell>>? = when (tomorrowFetch) {
                        is ScheduleFetch.Ok -> tomorrowFetch.table.takeIf { it.kind == PoeSchedule.Kind.PUBLISHED }?.queues
                        // only tomorrow failed: keep what is cached for it
                        is ScheduleFetch.Unavailable -> PoeSchedule.QUEUES.associateWith { schedule.tomorrowCells(it) }
                            .takeIf { m -> m.values.all { it != null } }
                            ?.mapValues { it.value!! }
                    }
                    schedule.saveAllCellsBatch(table.queues, tomorrow)
                    ScheduleSyncResult(FetchStatus.SUCCESS, SiteState.AVAILABLE_WITH_TABLE, notice)
                } else {
                    ScheduleSyncResult(FetchStatus.NO_QUEUES_FOUND, SiteState.AVAILABLE_NO_TABLE, notice)
                }
            }
            is ScheduleFetch.Unavailable -> {
                val networkFailure = todayFetch.reason == "network" || todayFetch.reason.startsWith("http_")
                if (networkFailure) {
                    val state = SiteStateResolver.resolve(FetchFailure.OTHER, hasTodayTable = false, networkValidated = NetworkProbe.isValidated(context))
                    ScheduleSyncResult(if (state == SiteState.NO_INTERNET) FetchStatus.NO_INTERNET else FetchStatus.NO_QUEUES_FOUND, state, notice)
                } else {
                    // POE answered, but not with a table we can read (error body, other date, changed layout)
                    ScheduleSyncResult(FetchStatus.NO_QUEUES_FOUND, SiteState.AVAILABLE_NO_TABLE, notice)
                }
            }
        }
    }

    /** `ГАВ 08:54–23:59 (за розпорядженням НЕК «Укренерго»)`, one line per measure. */
    fun noticeOf(measures: List<PoeMeasure>): String? {
        if (measures.isEmpty()) return null
        fun p2(n: Int) = n.toString().padStart(2, '0')
        return measures.joinToString("\n") { m ->
            val reason = m.reason?.let { " ($it)" }.orEmpty()
            "${m.type} ${p2(m.beginHour)}:${p2(m.beginMinute)}–${p2(m.endHour)}:${p2(m.endMinute)}$reason"
        }
    }
}
