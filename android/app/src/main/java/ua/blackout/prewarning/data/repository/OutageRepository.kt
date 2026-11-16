package ua.blackout.prewarning.data.repository

import ua.blackout.prewarning.widget.WidgetBindings
import android.content.Context
import ua.blackout.prewarning.core.DayView
import ua.blackout.prewarning.core.EmergencyEvent
import ua.blackout.prewarning.core.EmergencyFetch
import ua.blackout.prewarning.core.EmergencyLedger
import ua.blackout.prewarning.core.HouseKey
import ua.blackout.prewarning.core.IntervalStatus
import ua.blackout.prewarning.core.Outage
import ua.blackout.prewarning.core.OutageEngine
import ua.blackout.prewarning.core.OutageKind
import ua.blackout.prewarning.core.SiteState
import ua.blackout.prewarning.core.StatusInfo
import ua.blackout.prewarning.core.StreetKey
import ua.blackout.prewarning.core.Subscription
import ua.blackout.prewarning.core.SubscriptionStore
import ua.blackout.prewarning.core.Subscriptions
import ua.blackout.prewarning.core.SwitchWindow
import ua.blackout.prewarning.data.KYIV_ZONE
import ua.blackout.prewarning.data.model.BlackoutSlot
import ua.blackout.prewarning.data.model.SelectedAddressQuery
import ua.blackout.prewarning.data.model.SlotStatus
import ua.blackout.prewarning.data.model.UserSettings
import ua.blackout.prewarning.data.poe.AddressStatusFetch
import ua.blackout.prewarning.data.poe.FetchStatus
import ua.blackout.prewarning.data.poe.PoeAddressLookup
import ua.blackout.prewarning.data.poe.PoeClient
import ua.blackout.prewarning.data.poe.PoeScheduleSync
import ua.blackout.prewarning.notification.NotificationHelper
import java.time.LocalDate
import java.time.LocalDateTime

private fun hhmm(minuteOfDay: Int): String =
    "${(minuteOfDay / 60).toString().padStart(2, '0')}:${(minuteOfDay % 60).toString().padStart(2, '0')}"

/** Everything the screens, widgets and alarms need, derived from local state only (no network). */
data class OutageSnapshot(
    val now: LocalDateTime,
    val queue: String,
    val outages: List<Outage>,
    /** Today's ztoe table is cached and still valid for today (or the address has no queue at all). */
    val plannedKnown: Boolean,
    val tomorrowPublished: Boolean,
    val site: SiteSnapshot?,
    val poweron: PowerOnSnapshot?,
    val hasAddress: Boolean,
    /** POE switching half-hours of the queue (spec/OUTAGE_ENGINE.md 3.5). */
    val switching: List<SwitchWindow> = emptyList()
) {
    val today: LocalDate get() = now.toLocalDate()

    fun dayView(date: LocalDate): DayView = OutageEngine.dayView(outages, date, now, switching = switching)

    fun status(): StatusInfo = OutageEngine.status(outages, now, switching = switching)

    /** The planned schedule is unknown and nothing else is known either: screens go grey. */
    val isUnclear: Boolean
        get() = queue.isNotBlank() && !plannedKnown && outages.none { !it.stale && it.kind != OutageKind.PLANNED }

    /** True when the shown schedule comes from the cache because the site could not be refreshed. */
    val isStale: Boolean
        get() = plannedKnown && queue.isNotBlank() && site != null && site.state != SiteState.AVAILABLE_WITH_TABLE

    /** Legacy shape used by the existing main screen and widgets. */
    fun scheduleStatus(): ScheduleStatusInfo {
        if (isUnclear) {
            return ScheduleStatusInfo(
                isBlackoutNow = false,
                countdownText = "--:--:--",
                nextSlotTime = "--:-- - --:--",
                totalBlackoutHours = 0.0,
                isUnclear = true
            )
        }
        val st = status()
        return ScheduleStatusInfo(
            isBlackoutNow = st.isOffNow,
            countdownText = st.countdownText,
            nextSlotTime = st.nextSlotTime,
            totalBlackoutHours = dayView(today).totalOffMinutes / 60.0,
            isUnclear = false
        )
    }

    /** The 48 cells of [date] in the shape the drum chart and widgets draw. Empty when unclear. */
    fun slotsFor(date: LocalDate): List<BlackoutSlot> {
        if (isUnclear) return emptyList()
        val view = dayView(date)
        val dateStr = date.toString()
        return view.slots.mapIndexed { i, s ->
            val startMin = i * 30
            val endMin = startMin + 30
            val startStr = hhmm(startMin)
            val endStr = if (endMin >= 1440) "24:00" else hhmm(endMin)
            BlackoutSlot(
                id = "${dateStr}_${startStr}_Q$queue",
                startHour = startMin / 60,
                endHour = endMin / 60,
                startMinute = startMin % 60,
                endMinute = endMin % 60,
                startTimeStr = startStr,
                endTimeStr = endStr,
                status = if (s.off) SlotStatus.POWER_OFF else SlotStatus.POWER_ON,
                isEmergency = s.emergency,
                isPlanned = s.planned,
                isSwitching = s.switching
            )
        }
    }

    /** The emergency outage to feature in the banner: active or overdue first, then the next upcoming one. */
    fun featuredEmergency(): Outage? {
        val live = outages.filter { it.kind == OutageKind.EMERGENCY && !it.stale }
        return live.firstOrNull { val st = it.statusAt(now); st == IntervalStatus.ACTIVE || st == IntervalStatus.OVERDUE }
            ?: live.filter { it.statusAt(now) == IntervalStatus.UPCOMING }.minByOrNull { it.start }
    }
}

data class RefreshOutcome(
    val siteState: SiteState?,
    val fetchStatus: FetchStatus?,
    val poweronOk: Boolean?,
    val events: List<EmergencyEvent>,
    val snapshot: OutageSnapshot
)

/**
 * One place that refreshes both sources and turns the stored state into a snapshot. The main
 * screen, the background worker, the widgets and the alarm scheduler all go through it, so they
 * can no longer disagree about what is off and when (spec/OUTAGE_ENGINE.md).
 */
class OutageRepository(context: Context) {
    private val appContext: Context = context.applicationContext
    private val schedule = ScheduleRepository(appContext)
    private val store = OutageStateStore(appContext)
    private val client: PoeClient get() = PoeAddressLookup.client

    init {
        PoeAddressLookup.init(appContext)
    }

    /** Stable key of the selected address; survives duplicate-street merges because it uses the canonical street key. */
    fun addressKey(query: SelectedAddressQuery?): String? {
        query ?: return null
        if (query.house.isBlank()) return null
        val streetName = try {
            PoeAddressLookup.findStreetById(query.streetId)?.nameUk
        } catch (_: Exception) {
            null
        } ?: query.streetId
        return "${query.settlementId}|${StreetKey.of(streetName)}|${HouseKey.of(query.house)}"
    }

    fun snapshot(
        settings: UserSettings,
        now: LocalDateTime = LocalDateTime.now(KYIV_ZONE),
        key: String? = addressKey(settings.selectedAddressQuery)
    ): OutageSnapshot = snapshotOf(settings.queue, key, now, store.poweron())

    /**
     * The snapshot of one non-primary subscription for the main screen (spec/SUBSCRIPTIONS.md 9).
     * The primary goes through [snapshot]; another item has its own PowerOn status under its address key.
     */
    fun snapshotFor(item: Subscription, now: LocalDateTime = LocalDateTime.now(KYIV_ZONE)): OutageSnapshot {
        val key = item.address?.key
        return snapshotOf(item.queue.orEmpty(), key, now, key?.let { store.poweron(it) })
    }

    private fun snapshotOf(q: String, key: String?, now: LocalDateTime, poweron: PowerOnSnapshot?): OutageSnapshot =
        OutageSnapshot(
            now = now,
            queue = q,
            outages = outagesFor(q, key, now),
            plannedKnown = q.isBlank() || schedule.hasValidTodayCache(q),
            tomorrowPublished = q.isNotBlank() && schedule.hasTomorrowSchedule(q),
            site = store.site(),
            poweron = poweron,
            hasAddress = key != null,
            switching = if (q.isBlank()) emptyList() else OutageEngine.switchWindows(
                now.toLocalDate(), schedule.todayCells(q), schedule.tomorrowCells(q), schedule.yesterdayCells(q)
            )
        )

    /**
     * The outages of one queue and address key (either may be absent), local state only. One POE
     * fetch caches all 12 queues, so this works for every subscription (spec/SUBSCRIPTIONS.md 8.1).
     */
    fun outagesFor(queue: String?, key: String?, now: LocalDateTime = LocalDateTime.now(KYIV_ZONE)): List<Outage> {
        val today = now.toLocalDate()
        val q = queue.orEmpty()
        val planned = if (q.isNotBlank()) {
            OutageEngine.buildPlannedCells(today, schedule.todayCells(q), schedule.tomorrowCells(q), schedule.yesterdayCells(q))
        } else {
            emptyList()
        }
        val emergencies = if (key != null) EmergencyLedger.outages(store.ledger(key), now) else emptyList()
        val repairs = if (key != null) store.repairs(key) else emptyList()
        return OutageEngine.inWindow(planned + repairs + emergencies, today)
    }

    /**
     * Refreshes the POE queue tables and the per-house status (emergency «пошкодження», repair works,
     * the house's queue) for the selected address and the other subscriptions.
     * Runs on a worker thread. A source that fails keeps its previous data and is reported as such;
     * it never counts as "no outage". [shownId] is the item the main screen shows: it is polled whatever
     * its switches (spec/SUBSCRIPTIONS.md 8.4).
     */
    fun refresh(settings: UserSettings, forceNetwork: Boolean = false, notify: Boolean = true, shownId: String? = null): RefreshOutcome {
        val nowMs = System.currentTimeMillis()
        var siteState: SiteState? = null
        var fetchStatus: FetchStatus? = null
        val subs: Pair<SubscriptionStore, Boolean>? = try {
            val sync = SubscriptionSync(appContext)
            sync.store() to sync.master()
        } catch (_: Exception) {
            null
        }

        // One POE request per day caches all 12 queues. A primary without a queue still fetches for the
        // other addresses, and an address whose queue is not known yet gets it from the per-house status.
        val anyQueue = settings.queue.isNotBlank() || settings.selectedAddressQuery != null ||
            subs?.first?.items?.any { it.queue != null || it.address != null } == true
        if (anyQueue && (forceNetwork || !schedule.isCacheFresh(1L))) {
            try {
                val res = PoeScheduleSync.refresh(appContext)
                store.saveSite(res.siteState, nowMs, res.notice)
                if (settings.queue.isNotBlank()) {
                    fetchStatus = res.status
                    siteState = res.siteState
                }
            } catch (_: Exception) {
            }
        }

        var poweronOk: Boolean? = null
        var events: List<EmergencyEvent> = emptyList()
        val query = settings.selectedAddressQuery
        val key = addressKey(query)
        var queueChanged = false
        if (query != null && key != null) {
            val polled = pollPoe(query, key)
            poweronOk = polled?.ok ?: false
            events = polled?.events.orEmpty()
            store.savePowerOn(poweronOk, nowMs)
            polled?.status?.let { st ->
                val queue = st.status.queue.orEmpty()
                val statusText = if (queue.isEmpty()) PoeAddressLookup.NO_QUEUE_TEXT else null
                if (queue != settings.queue || statusText != settings.customQueueStatusText) {
                    // into the primary subscription, which is mirrored back into the settings keys
                    runCatching { SubscriptionSync(appContext).assignPrimaryQueue(queue, statusText, null) }
                    queueChanged = true
                }
            }
            if (notify && events.isNotEmpty() && settings.emergencyNotificationsEnabled) {
                val primary = subs?.first?.primary
                NotificationHelper.postEmergencyEvents(
                    appContext, settings, key, events, subscriptionId = subs?.first?.primaryId,
                    plannedSpans = OutageEngine.plannedSpans(outagesFor(settings.queue, key)),
                    plannedAlertsOn = if (subs != null && primary != null) Subscriptions.plannedActive(subs.second, primary) else settings.notificationsEnabled
                )
            }
        }
        if (subs != null) refreshOtherAddresses(settings, subs.first, subs.second, key, nowMs, notify, shownId)
        val current = if (queueChanged) runCatching { SettingsRepository(appContext).getSettings() }.getOrDefault(settings) else settings
        return RefreshOutcome(siteState, fetchStatus, poweronOk, events, snapshot(current))
    }

    /**
     * The per-house status for every other subscription that wants emergency alerts, plus the one the main screen
     * shows (spec/SUBSCRIPTIONS.md 8.4): own request, own failure, own ledger, own status line.
     */
    private fun refreshOtherAddresses(
        settings: UserSettings,
        subs: SubscriptionStore,
        master: Boolean,
        primaryKey: String?,
        nowMs: Long,
        notify: Boolean,
        shownId: String?
    ) {
        // Addresses on a widget are polled too, so the widget's emergency state is fresh (spec/SUBSCRIPTIONS.md 10)
        val onWidgets = try {
            WidgetBindings.shownItemIds(appContext, subs)
        } catch (_: Exception) {
            emptyList()
        }
        for (item in subs.items) {
            val a = item.address ?: continue
            if (item.id == subs.primaryId) continue
            val alerts = master && item.emergencyAlerts
            if (!alerts && item.id != shownId && item.id !in onWidgets) continue
            val key = a.key
            if (key == primaryKey) continue
            val polled = pollPoe(SelectedAddressQuery(a.remSlug, a.settlementId, a.streetId, a.house), key)
            store.savePowerOn(key, polled?.ok ?: false, nowMs)
            if (polled == null) continue
            polled.status?.let { st ->
                val queue = st.status.queue
                val statusText = if (queue == null) PoeAddressLookup.NO_QUEUE_TEXT else null
                if (queue != item.queue || statusText != item.queueStatusText) {
                    runCatching { SubscriptionSync(appContext).assignItemQueue(item.id, queue, statusText) }
                }
            }
            if (notify && alerts && polled.events.isNotEmpty()) {
                NotificationHelper.postEmergencyEvents(
                    appContext, settings, key, polled.events, addressLine(item), enabled = true, subscriptionId = item.id,
                    plannedSpans = OutageEngine.plannedSpans(outagesFor(item.queue, key)),
                    plannedAlertsOn = Subscriptions.plannedActive(master, item)
                )
            }
        }
    }

    /** Second line of an emergency notification for [item] (spec/SUBSCRIPTIONS.md 8.4). */
    private fun addressLine(item: Subscription): String =
        item.address?.text?.takeIf { it.isNotBlank() } ?: Subscriptions.displayLabel(item)

    /** One per-house status: confirmed or not, the ledger events, and the confirmed answer (for the queue). */
    private data class Poll(val ok: Boolean, val events: List<EmergencyEvent>, val status: AddressStatusFetch.Confirmed?)

    /**
     * Asks POE about one house (E4) and saves the ledger and repair works under [key]. The street's
     * merged ids are tried in turn until POE answers for one. An unavailable answer leaves the ledger
     * and the repairs as they were (spec/POE_API.md section 9). Null only when it could not be built.
     */
    private fun pollPoe(query: SelectedAddressQuery, key: String): Poll? = try {
        val cityId = query.settlementId.toLongOrNull()
        if (cityId == null || query.house.isBlank()) {
            null
        } else {
            val now = LocalDateTime.now(KYIV_ZONE)
            val today = now.toLocalDate()
            val street = PoeAddressLookup.findStreetById(query.streetId)
            val ids = (street?.allIds ?: listOf(query.streetId)).mapNotNull { it.toLongOrNull() }
            var fetch: AddressStatusFetch = AddressStatusFetch.Unavailable("unresolved")
            for (sid in ids) {
                fetch = client.addressStatus(cityId, sid, query.house, today)
                if (fetch is AddressStatusFetch.Confirmed) break
            }
            val ledger = EmergencyLedger.reconcile(store.ledger(key), PoeClient.emergencyFetch(fetch, today), now)
            store.saveLedger(key, ledger.entries)
            val confirmed = fetch as? AddressStatusFetch.Confirmed
            if (confirmed != null) store.saveRepairs(key, confirmed.status.repairs)
            Poll(confirmed != null, ledger.events, confirmed)
        }
    } catch (_: Exception) {
        null
    }
}
