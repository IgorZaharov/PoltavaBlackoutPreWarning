import Foundation

/// Kotlin `ScheduleStatusInfo`: the status shape the main screen and the widgets print.
public struct ScheduleStatusInfo: Hashable, Sendable {
    public var isBlackoutNow: Bool
    public var countdownText: String
    public var nextSlotTime: String
    public var totalBlackoutHours: Double
    public var isUnclear: Bool
}

/// The card «Ремонти й пошкодження поруч» (spec/POE_API.md 8.10): today's registry rows of the address's
/// settlement. `fetchedMs` is the oldest branch answer used; `complete` is false when a branch could not be
/// asked on the last attempt (the card then shows the time of its data).
public struct NearbySnapshot: Hashable, Sendable {
    public var items: [PoeMapper.NearbyOutage]
    public var fetchedMs: Int64
    public var complete: Bool
}

/// Everything the screens, widgets and alerts need, derived from local state only (no network).
/// Mirror of android `OutageSnapshot`.
public struct OutageSnapshot: Sendable {
    public var now: LocalDateTime
    public var queue: String
    public var outages: [Outage]
    /// Today's POE table is cached and still valid for today (or the address has no queue at all).
    public var plannedKnown: Bool
    public var tomorrowPublished: Bool
    public var site: SiteSnapshot?
    public var poweron: PowerOnSnapshot?
    public var hasAddress: Bool
    /// POE switching half-hours of the queue (spec/OUTAGE_ENGINE.md 3.5).
    public var switching: [SwitchWindow] = []
    /// Today's active POE measures (ГАВ, ГОП ...), one per line, or nil.
    public var measures: String? = nil
    /// POE's info line of the house (`gav_message`), or nil.
    public var gavMessage: String? = nil
    /// Registry rows of the address's settlement for today; nil for a queue only, before the first answer,
    /// and in the widget extension (the card is on the main screen only).
    public var nearby: NearbySnapshot? = nil

    public var today: LocalDate { now.date }

    public func dayView(_ date: LocalDate) -> DayView { OutageEngine.dayView(outages, date: date, now: now, switching: switching) }

    public func status() -> StatusInfo { OutageEngine.status(outages, now: now, switching: switching) }

    /// Start and end of the switching half-hour after the shown span (spec/OUTAGE_ENGINE.md 3.5): power
    /// comes back somewhere inside it. nil when unknown or when the day is unclear.
    public func restoreWindow() -> (start: LocalDateTime, end: LocalDateTime)? {
        if isUnclear { return nil }
        let st = status()
        guard let until = st.restoreUntil, let span = st.currentSpan ?? st.nextSpan else { return nil }
        return (span.end, until)
    }

    /// The planned schedule is unknown and nothing else is known either: screens go grey.
    public var isUnclear: Bool {
        !queue.ktIsBlank && !plannedKnown && !outages.contains { !$0.stale && $0.kind != .PLANNED }
    }

    /// True when the shown schedule comes from the cache because the site could not be refreshed.
    public var isStale: Bool {
        guard plannedKnown, !queue.ktIsBlank, let site else { return false }
        return site.state != .AVAILABLE_WITH_TABLE
    }

    public func scheduleStatus() -> ScheduleStatusInfo {
        if isUnclear {
            return ScheduleStatusInfo(isBlackoutNow: false, countdownText: "--:--:--", nextSlotTime: "--:-- - --:--",
                                      totalBlackoutHours: 0, isUnclear: true)
        }
        let st = status()
        return ScheduleStatusInfo(isBlackoutNow: st.isOffNow, countdownText: st.countdownText, nextSlotTime: st.nextSlotTime,
                                  totalBlackoutHours: Double(dayView(today).totalOffMinutes) / 60.0, isUnclear: false)
    }

    private static func hhmm(_ minuteOfDay: Int) -> String { String(format: "%02d:%02d", minuteOfDay / 60, minuteOfDay % 60) }

    /// The 48 cells of `date` in the shape the drum chart and widgets draw. Empty when unclear.
    public func slotsFor(_ date: LocalDate) -> [BlackoutSlot] {
        if isUnclear { return [] }
        return dayView(date).slots.enumerated().map { i, s in
            let startMin = i * 30
            let endMin = startMin + 30
            let startStr = Self.hhmm(startMin)
            let endStr = endMin >= 1440 ? "24:00" : Self.hhmm(endMin)
            return BlackoutSlot(
                id: "\(date)_\(startStr)_Q\(queue)", startHour: startMin / 60, endHour: endMin / 60,
                startMinute: startMin % 60, endMinute: endMin % 60, startTimeStr: startStr, endTimeStr: endStr,
                status: s.off ? .POWER_OFF : .POWER_ON, isEmergency: s.emergency, isPlanned: s.planned, isSwitching: s.switching
            )
        }
    }

    /// The emergency outage to feature in the banner: active or overdue first, then the next upcoming one.
    public func featuredEmergency() -> Outage? {
        let live = outages.filter { $0.kind == .EMERGENCY && !$0.stale }
        if let current = live.first(where: { let st = $0.statusAt(now); return st == .ACTIVE || st == .OVERDUE }) {
            return current
        }
        var best: Outage?
        for o in live where o.statusAt(now) == .UPCOMING && (best == nil || o.start < best!.start) { best = o }
        return best
    }
}

/// Emergency events of one address from one refresh, with what the announcer needs to decide how to
/// post them (spec/NOTIFICATIONS.md 2.4a). Android posts these inside the repository; on iOS the
/// notification layer posts them, so the decision inputs travel with the events.
public struct EmergencyBatch: Sendable {
    public var addressKey: String
    /// nil for the primary address (1.4.0 single-address keys).
    public var subscriptionId: String?
    /// Second line of the notification for a non-primary address (nil for the primary).
    public var addressLine: String?
    public var events: [EmergencyEvent]
    public var plannedSpans: [Span]
    public var plannedAlertsOn: Bool
    /// The address wants emergency alerts (primary: `emergencyNotificationsEnabled`; others: master and switch).
    public var alertsOn: Bool
}

public struct RefreshOutcome: Sendable {
    public var siteState: SiteState?
    public var fetchStatus: FetchStatus?
    public var poweronOk: Bool?
    /// Events of the primary address (Kotlin `RefreshOutcome.events`).
    public var events: [EmergencyEvent]
    /// Every address with new events, primary first, for the notification layer.
    public var batches: [EmergencyBatch]
    public var snapshot: OutageSnapshot
}

/// One place that refreshes the POE sources and turns the stored state into a snapshot (mirror of
/// android OutageRepository.kt). The main screen, background refresh, widgets and alerts all go through
/// it, so they cannot disagree about what is off and when (spec/OUTAGE_ENGINE.md).
public final class OutageRepository {
    public static let shared = OutageRepository()

    /// The registry of a branch is asked at most this often (it is about 50 KB gzipped).
    public static let NEARBY_TTL_MS: Int64 = 10 * 60 * 1000

    /// The widget extension draws from the stored state; the nearby card is the app's only.
    static let isExtension = Bundle.main.bundlePath.hasSuffix(".appex")

    private final class Caches: @unchecked Sendable {
        let lock = NSLock()
        /// Registry rows are parsed once per stored answer, not on every snapshot.
        var parsed: [Int: (fetchedMs: Int64, rows: [PoeMapper.RegistryRow])] = [:]
        /// The last nearby card, keyed by address, the stored answers it used and the minute (the screen asks every second).
        var nearby: (key: String, value: NearbySnapshot?)?
    }

    private static let caches = Caches()

    private let schedule: ScheduleRepository
    private let store: OutageStateStore
    private let settingsRepo: SettingsRepository
    private let subscriptions: SubscriptionSync
    private let clientOverride: PoeClient?

    /// `client` nil = the shared `PoeAddressLookup.client` (one 60 s per-house cache for the picker and the refresh).
    public init(
        schedule: ScheduleRepository = .shared,
        store: OutageStateStore = .shared,
        settingsRepo: SettingsRepository = .shared,
        subscriptions: SubscriptionSync = .shared,
        client: PoeClient? = nil
    ) {
        self.schedule = schedule
        self.store = store
        self.settingsRepo = settingsRepo
        self.subscriptions = subscriptions
        self.clientOverride = client
    }

    private var client: PoeClient { clientOverride ?? PoeAddressLookup.client }

    private static func kyivNow() -> LocalDateTime { KyivTime.localDateTime(of: Date()) }
    private static func epochMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    /// Stable key of the selected address; survives duplicate-street merges because it uses the canonical street key.
    public func addressKey(_ query: SelectedAddressQuery?) -> String? {
        guard let query, !query.house.ktIsBlank else { return nil }
        let streetName = PoeAddressLookup.findStreetById(query.streetId)?.nameUk ?? query.streetId
        return "\(query.settlementId)|\(StreetKey.of(streetName))|\(HouseKey.of(query.house))"
    }

    public func snapshot(_ settings: UserSettings, now: LocalDateTime? = nil) -> OutageSnapshot {
        let key = addressKey(settings.selectedAddressQuery)
        return snapshotOf(settings.queue, key, now ?? Self.kyivNow(), store.poweron(), settings.selectedAddressQuery)
    }

    /// The snapshot of one non-primary subscription for the main screen (spec/SUBSCRIPTIONS.md 9).
    public func snapshotFor(_ item: Subscription, now: LocalDateTime? = nil) -> OutageSnapshot {
        let key = item.address?.key
        let query = item.address.map { SelectedAddressQuery(remId: $0.remSlug, settlementId: $0.settlementId, streetId: $0.streetId, house: $0.house) }
        return snapshotOf(item.queue ?? "", key, now ?? Self.kyivNow(), key.flatMap { store.poweron($0) }, query)
    }

    private func snapshotOf(_ q: String, _ key: String?, _ now: LocalDateTime, _ poweron: PowerOnSnapshot?,
                            _ address: SelectedAddressQuery?) -> OutageSnapshot {
        OutageSnapshot(
            now: now,
            queue: q,
            outages: outagesFor(queue: q, key: key, now: now),
            plannedKnown: q.ktIsBlank || schedule.hasValidTodayCache(q),
            tomorrowPublished: !q.ktIsBlank && schedule.hasTomorrowSchedule(q),
            site: store.site(),
            poweron: poweron,
            hasAddress: key != nil,
            switching: q.ktIsBlank ? [] : OutageEngine.switchWindows(
                today: now.date, todayCells: schedule.todayCells(q), tomorrowCells: schedule.tomorrowCells(q),
                yesterdayCells: schedule.yesterdayCells(q)
            ),
            measures: store.measures(now.date),
            gavMessage: key.flatMap { store.gavMessage($0) },
            nearby: key != nil && !Self.isExtension ? nearbyOf(address, now) : nil
        )
    }

    // MARK: - Registry (E5): the nearby card and the rows naming the house

    /// Registry ids of every branch `address`'s settlement belongs to (its registry may list the outage).
    private func branchesOf(_ address: SelectedAddressQuery?) -> [Int] {
        guard let address else { return [] }
        let slugs = PoeAddressLookup.findSettlementById(address.settlementId)?.branchIds
        var out: [Int] = []
        for slug in (slugs?.isEmpty == false ? slugs! : [address.remId]) {
            if let id = PoeBranches.bySlug(slug)?.registryId, !out.contains(id) { out.append(id) }
        }
        return out
    }

    private func parsedRows(_ registryId: Int, _ cache: RegistryCache) -> [PoeMapper.RegistryRow] {
        let c = Self.caches
        c.lock.lock()
        if let hit = c.parsed[registryId], hit.fetchedMs == cache.fetchedMs {
            c.lock.unlock()
            return hit.rows
        }
        c.lock.unlock()
        let rows = cache.rows.compactMap { PoeMapper.parseRegistryRow($0) }
        c.lock.lock()
        c.parsed[registryId] = (fetchedMs: cache.fetchedMs, rows: rows)
        c.lock.unlock()
        return rows
    }

    /// Today's stored registries of `branches` (branch id and answer).
    private func todayRegistries(_ branches: [Int], _ today: LocalDate) -> [(id: Int, cache: RegistryCache)] {
        var out: [(id: Int, cache: RegistryCache)] = []
        for id in branches {
            if let cache = store.registry(id), cache.date == today { out.append((id: id, cache: cache)) }
        }
        return out
    }

    private func nearbyOf(_ address: SelectedAddressQuery?, _ now: LocalDateTime) -> NearbySnapshot? {
        guard let address else { return nil }
        let branches = branchesOf(address)
        let minute = LocalDateTime(date: now.date, hour: now.hour, minute: now.minute)
        let cacheKey = "\(address.settlementId)|\(address.streetId)|\(address.house)|\(minute)|"
            + branches.map { "\($0)=\(store.registryMeta($0) ?? "")" }.joined(separator: ",")
        let c = Self.caches
        c.lock.lock()
        if let hit = c.nearby, hit.key == cacheKey {
            c.lock.unlock()
            return hit.value
        }
        c.lock.unlock()
        let result = buildNearby(address, branches, now)
        c.lock.lock()
        c.nearby = (key: cacheKey, value: result)
        c.lock.unlock()
        return result
    }

    private func buildNearby(_ address: SelectedAddressQuery, _ branches: [Int], _ now: LocalDateTime) -> NearbySnapshot? {
        guard let settlement = PoeAddressLookup.findSettlementById(address.settlementId) else { return nil }
        let caches = todayRegistries(branches, now.date)
        if caches.isEmpty { return nil }
        let rows = caches.flatMap { parsedRows($0.id, $0.cache) }
        let street = PoeAddressLookup.findStreetById(address.streetId)?.nameUk ?? ""
        let items = PoeMapper.nearbyOutages(rows, settlement: settlement.nameUk, street: street, house: address.house, now: now)
        return NearbySnapshot(
            items: items,
            fetchedMs: caches.map { $0.cache.fetchedMs }.min() ?? 0,
            complete: caches.count == branches.count && caches.allSatisfy { $0.cache.lastOk }
        )
    }

    /// The registry rows of today that name each address's house, stored as its repair outages
    /// (`PoeMapper.registryRepairs`). An address whose registries have no answer of today keeps what it had.
    private func saveRegistryRepairs(_ addresses: [SelectedAddressQuery], _ now: LocalDateTime) {
        for address in addresses {
            guard let key = addressKey(address), let settlement = PoeAddressLookup.findSettlementById(address.settlementId) else { continue }
            let caches = todayRegistries(branchesOf(address), now.date)
            if caches.isEmpty { continue }
            let rows = caches.flatMap { parsedRows($0.id, $0.cache) }
            let street = PoeAddressLookup.findStreetById(address.streetId)?.nameUk ?? ""
            store.saveRegistryRepairs(key, PoeMapper.registryRepairs(rows, settlement: settlement.nameUk, street: street, house: address.house))
        }
    }

    /// Fetches the registry (E5) of every branch of the addresses' settlements, at most once per
    /// `NEARBY_TTL_MS` unless `force`. A failure keeps the stored rows (spec/POE_API.md section 9).
    private func refreshNearby(_ addresses: [SelectedAddressQuery], nowMs: Int64, force: Bool) async {
        let today = Self.kyivNow().date
        var ids: [Int] = []
        for a in addresses { for id in branchesOf(a) where !ids.contains(id) { ids.append(id) } }
        for id in ids {
            if !force, let cached = store.registry(id), cached.date == today, cached.lastOk,
               (0..<Self.NEARBY_TTL_MS).contains(nowMs - cached.fetchedMs) { continue }
            if case .confirmed(_, let raw) = await client.registry(id, date: today) {
                store.saveRegistry(id, date: today, rows: raw, nowMs: nowMs)
            } else {
                store.saveRegistry(id, date: today, rows: nil, nowMs: nowMs)
            }
        }
    }

    // MARK: - Outages

    /// The outages of one queue and address key (either may be absent), local state only. One POE fetch
    /// caches all 12 queues, so this works for every subscription (spec/SUBSCRIPTIONS.md 8.1).
    public func outagesFor(queue: String?, key: String?, now: LocalDateTime? = nil) -> [Outage] {
        let at = now ?? Self.kyivNow()
        let today = at.date
        let q = queue ?? ""
        let planned = q.ktIsBlank ? [] : OutageEngine.buildPlannedCells(
            today: today, todayCells: schedule.todayCells(q), tomorrowCells: schedule.tomorrowCells(q),
            yesterdayCells: schedule.yesterdayCells(q)
        )
        let emergencies = key.map { EmergencyLedger.outages(store.ledger($0), now: at) } ?? []
        let repairs = key.map { store.repairs($0) } ?? []
        // registry rows naming the house, unless the per-house status already lists the same works
        let listed = key.map { k in
            store.registryRepairs(k).filter { r in !repairs.contains { $0.start == r.start && $0.end == r.end } }
        } ?? []
        return OutageEngine.inWindow(planned + repairs + listed + emergencies, today: today)
    }

    // MARK: - Refresh

    /// Refreshes the POE queue tables and the per-house status (emergency «пошкодження», repair works, the
    /// house's queue) of every address that needs it, then the registries of their branches. A source that
    /// fails keeps its previous data and is reported as such; it never counts as "no outage". `shownId` is
    /// the item the main screen shows and `widgetItemIds` the items placed widgets show: both are polled
    /// whatever their switches (spec/SUBSCRIPTIONS.md 8.4 and 10).
    public func refresh(
        _ settings: UserSettings,
        forceNetwork: Bool = false,
        shownId: String? = nil,
        widgetItemIds: [String] = []
    ) async -> RefreshOutcome {
        let nowMs = Self.epochMs()
        var siteState: SiteState?
        var fetchStatus: FetchStatus?
        let subs = subscriptions.store()
        let master = subscriptions.master()

        // One POE request per day caches all 12 queues. A primary without a queue still fetches for the
        // other addresses, and an address whose queue is not known yet gets it from the per-house status.
        let anyQueue = !settings.queue.ktIsBlank || settings.selectedAddressQuery != nil
            || subs.items.contains { $0.queue != nil || $0.address != nil }
        if anyQueue && (forceNetwork || !schedule.isCacheFresh(refreshIntervalMinutes: 1)) {
            let res = await PoeScheduleSync.refresh(repo: schedule)
            store.saveSite(res.siteState, nowMs: nowMs)
            if res.measuresKnown { store.saveMeasures(Self.kyivNow().date, res.notice) }
            if !settings.queue.ktIsBlank {
                fetchStatus = res.status
                siteState = res.siteState
            }
        }

        var poweronOk: Bool?
        var events: [EmergencyEvent] = []
        var batches: [EmergencyBatch] = []
        let query = settings.selectedAddressQuery
        let key = addressKey(query)
        var queueChanged = false
        if let query, let key {
            let polled = await pollPoe(query, key: key)
            poweronOk = polled?.ok ?? false
            events = polled?.events ?? []
            store.savePowerOn(ok: poweronOk ?? false, nowMs: nowMs)
            if let st = polled?.status,
               let target = queueFromStatus(st, query, current: settings.queue.ktIsBlank ? nil : settings.queue) {
                if (target.queue ?? "") != settings.queue || target.statusText != settings.customQueueStatusText {
                    // into the primary subscription, which is mirrored back into the settings keys
                    subscriptions.assignPrimaryQueue(queue: target.queue ?? "", statusText: target.statusText, addressText: nil)
                    queueChanged = true
                }
            }
            if !events.isEmpty {
                let primary = subs.primary
                batches.append(EmergencyBatch(
                    addressKey: key,
                    subscriptionId: subs.primaryId,
                    addressLine: nil,
                    events: events,
                    plannedSpans: OutageEngine.plannedSpans(outagesFor(queue: settings.queue, key: key)),
                    plannedAlertsOn: primary.map { Subscriptions.plannedActive(master: master, item: $0) } ?? settings.notificationsEnabled,
                    alertsOn: settings.emergencyNotificationsEnabled
                ))
            }
        }
        batches += await refreshOtherAddresses(subs, master: master, primaryKey: key, nowMs: nowMs,
                                               shownId: shownId, widgetItemIds: widgetItemIds)

        // the nearby outages card of the address the main screen shows (the primary unless another is shown)
        let shown = subs.items.first { $0.id == shownId && $0.id != subs.primaryId }?.address
        let nearbyAddress = shown.map { SelectedAddressQuery(remId: $0.remSlug, settlementId: $0.settlementId, streetId: $0.streetId, house: $0.house) } ?? query
        // the registries of every address's branches: their rows naming a house become its repair outages
        var addresses: [SelectedAddressQuery] = []
        let others = subs.items.compactMap { item in
            item.address.map { SelectedAddressQuery(remId: $0.remSlug, settlementId: $0.settlementId, streetId: $0.streetId, house: $0.house) }
        }
        for a in [nearbyAddress, query].compactMap({ $0 }) + others where !addresses.contains(a) { addresses.append(a) }
        if !addresses.isEmpty {
            // the widget extension resolves these addresses without the directory (PoeResolvedAddresses)
            PoeAddressLookup.rememberResolved(addresses)
            await refreshNearby(addresses, nowMs: nowMs, force: forceNetwork)
            saveRegistryRepairs(addresses, Self.kyivNow())
        }
        let current = queueChanged ? settingsRepo.getSettings() : settings
        // the hourly-schedule catalogue from this repository's CI, at most once a week (spec/POE_API.md 8.11), last
        if !Self.isExtension { _ = await PoeQueues.refreshIfDue() }
        return RefreshOutcome(siteState: siteState, fetchStatus: fetchStatus, poweronOk: poweronOk, events: events,
                              batches: batches, snapshot: snapshot(current))
    }

    /// The per-house status for every other subscription that wants emergency alerts, plus the one the main
    /// screen shows and the ones on widgets (spec/SUBSCRIPTIONS.md 8.4): own request, failure, ledger, status line.
    private func refreshOtherAddresses(
        _ subs: SubscriptionStore, master: Bool, primaryKey: String?, nowMs: Int64,
        shownId: String?, widgetItemIds: [String]
    ) async -> [EmergencyBatch] {
        var out: [EmergencyBatch] = []
        for item in subs.items {
            guard let a = item.address, item.id != subs.primaryId else { continue }
            let alerts = master && item.emergencyAlerts
            if !alerts && item.id != shownId && !widgetItemIds.contains(item.id) { continue }
            let key = a.key
            if key == primaryKey { continue }
            let query = SelectedAddressQuery(remId: a.remSlug, settlementId: a.settlementId, streetId: a.streetId, house: a.house)
            let polled = await pollPoe(query, key: key)
            store.savePowerOn(key, ok: polled?.ok ?? false, nowMs: nowMs)
            guard let polled else { continue }
            if let st = polled.status, let target = queueFromStatus(st, query, current: item.queue),
               target.queue != item.queue || target.statusText != item.queueStatusText {
                subscriptions.assignItemQueue(id: item.id, queue: target.queue, statusText: target.statusText)
            }
            guard !polled.events.isEmpty else { continue }
            out.append(EmergencyBatch(
                addressKey: key,
                subscriptionId: item.id,
                addressLine: a.text.ktIsBlank ? Subscriptions.displayLabel(item) : a.text,
                events: polled.events,
                plannedSpans: OutageEngine.plannedSpans(outagesFor(queue: item.queue, key: key)),
                plannedAlertsOn: Subscriptions.plannedActive(master: master, item: item),
                alertsOn: alerts
            ))
        }
        return out
    }

    /// The queue (and no-queue text) an address gets from a confirmed per-house status, or nil to leave it
    /// as it is. "Several connections" (spec/POE_API.md 8.11) never clears a queue: an address that has one
    /// keeps it; one that has none takes the queue of POE's hourly-schedule catalogue when it names one
    /// without doubt (`QueueCatalogue.confident`); otherwise the user picks it in the address dialog.
    private func queueFromStatus(_ st: ConfirmedAddressStatus, _ query: SelectedAddressQuery,
                                 current: String?) -> (queue: String?, statusText: String?)? {
        if let queue = st.status.queue { return (queue, nil) }
        if !st.status.severalConnections { return (nil, PoeAddressLookup.NO_QUEUE_TEXT) }
        if current != nil { return nil }
        return (QueueCatalogue.confident(PoeQueues.queuesFor(query)), nil)
    }

    /// One per-house status: confirmed or not, the ledger events, and the confirmed answer (for the queue).
    private struct Poll {
        var ok: Bool
        var events: [EmergencyEvent]
        var status: ConfirmedAddressStatus?
    }

    /// Asks POE about one house (E4) and saves the ledger, the repair works and the info line under `key`.
    /// The street's merged ids are tried in turn until POE answers for one. An unavailable answer leaves
    /// the ledger and the repairs as they were (spec/POE_API.md section 9). nil only when it could not be built.
    private func pollPoe(_ query: SelectedAddressQuery, key: String) async -> Poll? {
        guard let cityId = Int64(query.settlementId), !query.house.ktIsBlank else { return nil }
        let now = Self.kyivNow()
        let today = now.date
        let street = PoeAddressLookup.findStreetById(query.streetId)
        let ids = (street?.allIds ?? [query.streetId]).compactMap { Int64($0) }
        var fetch: AddressStatusFetch = .unavailable("unresolved")
        for sid in ids {
            fetch = await client.addressStatus(cityId: cityId, streetId: sid, house: query.house, today: today)
            if fetch.confirmedStatus != nil { break }
        }
        let ledger = EmergencyLedger.reconcile(store.ledger(key), fetch: PoeClient.emergencyFetch(fetch, today: today), now: now)
        store.saveLedger(key, ledger.entries)
        let confirmed = fetch.confirmedStatus
        if let confirmed {
            store.saveRepairs(key, confirmed.status.repairs)
            store.saveGavMessage(key, confirmed.gavMessage)
        }
        return Poll(ok: confirmed != nil, events: ledger.events, status: confirmed)
    }
}
