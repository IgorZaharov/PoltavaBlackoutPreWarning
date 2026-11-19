import SwiftUI

/// Loading flags of one level of the branch, settlement, street, house cascade; `retry` asks POE for
/// that list again.
private struct LevelState: Equatable {
    var loading = false
    var failed = false
    var retry = 0
}

/// One company of the search by workplace: its queues and the text the search matches.
private struct CompanyChoice: Hashable {
    let id: String
    let name: String
    let label: String
    let town: String?
    let queues: [String]
    let search: String
    let context: String
}

/// Full-screen queue help and address lookup (the "?" button; port of Android SettingsScreen.kt
/// `AddressLookupDialog`) on Полтаваобленерго data (`PoeAddressLookup`). The cascade starts from the
/// saved address, or from Полтава (Полтавська об'єднана філія) on a first launch; choosing another branch
/// clears settlement, street and house. Settlements and streets come from the bundled directory, houses
/// and the queue live from POE. Nothing is applied until the user presses the result button.
struct AddressLookupSheet: View {
    let siteUrl: String
    let lang: String
    let saved: SelectedAddressQuery?
    let onDismiss: () -> Void
    let onApply: (_ queue: String, _ statusText: String?, _ addressLabel: String, _ query: SelectedAddressQuery) -> Void
    let onBanner: (String) -> Void
    /// A workplace of the company search, or a place without streets or houses: its queue as a queue-only
    /// entry named after it (spec/POE_API.md 8.11).
    let onAddCompany: (_ queue: String, _ label: String) -> Void

    @State private var remId: String
    @State private var settlementId: String
    @State private var streetId: String
    @State private var house: String

    @State private var rems: [PoeBranchOption]
    @State private var settlements: [PoeSettlementOption]
    @State private var streets: [PoeStreetOption]
    @State private var houses: [PoeHouseLookupResult]
    @State private var remsState = LevelState()
    @State private var settlementsState = LevelState()
    @State private var streetsState = LevelState()
    @State private var housesState = LevelState()

    @State private var checking = false
    @State private var checkFailed = false
    @State private var lookup: PoeHouseLookupResult?
    /// The queue the user picks when POE names none ("several connections", spec/POE_API.md 8.11).
    @State private var chosenQueue: String?
    /// Company search (hourly-schedule catalogue): one entry per company name and town with all its queues.
    @State private var companies: [CompanyChoice] = []
    @State private var selectedCompany: String?
    @State private var companyQueue: String?
    @State private var catalogueReady = false
    /// POE answered with no houses for the chosen street (not a failure): the street is taken as a whole.
    @State private var housesAnswered = false
    /// Bumped after a scoped refresh so every list reloads.
    @State private var directoryVersion = 0
    /// "settlementId|directoryVersion" of the street list on screen: "no streets" only for the chosen one.
    @State private var streetsFor = ""
    /// Which "my address is missing" refresh runs.
    @State private var refreshing: String?
    @State private var placeHints: [QueueCatalogue.Hint] = []
    @State private var placeQueue: String?

    /// The POE page named in step 1 of the queue help (AppStrings.queueHelpSteps), made a link there.
    private static let POE_SEARCH_URL = "https://www.poe.pl.ua/disconnection/poshuk-vidkliuchennia-za-osobovym-rakhunkom/"
    private static let DEFAULT_BRANCH = "poltavska"
    /// місто Полтава (POE city_id).
    private static let DEFAULT_SETTLEMENT = "11389"

    init(
        siteUrl: String, lang: String, saved: SelectedAddressQuery?,
        onDismiss: @escaping () -> Void,
        onApply: @escaping (String, String?, String, SelectedAddressQuery) -> Void,
        onBanner: @escaping (String) -> Void,
        onAddCompany: @escaping (String, String) -> Void = { _, _ in }
    ) {
        self.siteUrl = siteUrl
        self.lang = lang
        self.saved = saved
        self.onDismiss = onDismiss
        self.onApply = onApply
        self.onBanner = onBanner
        self.onAddCompany = onAddCompany
        let rem = saved.map { $0.remId.ktIsBlank ? Self.DEFAULT_BRANCH : $0.remId } ?? Self.DEFAULT_BRANCH
        let settlement = saved.map { $0.settlementId.ktIsBlank ? Self.DEFAULT_SETTLEMENT : $0.settlementId } ?? Self.DEFAULT_SETTLEMENT
        let street = saved?.streetId ?? ""
        _remId = State(initialValue: rem)
        _settlementId = State(initialValue: settlement)
        _streetId = State(initialValue: street)
        _house = State(initialValue: saved?.house ?? "")
        _rems = State(initialValue: PoeAddressLookup.getRems())
        _settlements = State(initialValue: PoeAddressLookup.getSettlementsForRem(rem))
        _streets = State(initialValue: settlement.ktIsBlank ? [] : PoeAddressLookup.getStreetsForSettlement(settlement))
        _houses = State(initialValue: street.ktIsBlank ? [] : PoeAddressLookup.getHousesForStreet(street))
    }

    // MARK: - Derived

    private func name(uk: String, en: String) -> String { lang == "uk" ? uk : en }
    // Settlements and streets keep their Ukrainian names in both languages (SettingsScreen.kt): the POE
    // lists have no English names.
    private var currentRem: PoeBranchOption? { rems.first { $0.id == remId } }
    private var currentSettlement: PoeSettlementOption? {
        settlementId.ktIsBlank ? nil : (settlements.first { $0.id == settlementId } ?? PoeAddressLookup.findSettlementById(settlementId))
    }
    private var currentStreet: PoeStreetOption? {
        streetId.ktIsBlank ? nil : (streets.first { $0.id == streetId } ?? PoeAddressLookup.findStreetById(streetId))
    }
    private var currentHouseRecord: PoeHouseLookupResult? {
        houses.first { $0.house.caseInsensitiveCompare(house) == .orderedSame }
    }

    private var selectedAddressStr: String {
        guard let street = currentStreet, !house.ktIsBlank else { return "" }
        let remName = currentRem.map { name(uk: $0.nameUk, en: $0.nameEn) } ?? ""
        let settlementName = currentSettlement.map(\.nameUk) ?? ""
        return "\(remName), \(settlementName),\n\(street.nameUk), \(AppStrings.addrHousePrefix(lang)) \(house)"
    }

    /// The live answer when it is for this house, merged with the indexed row; else the indexed row.
    private var matchedRecord: PoeHouseLookupResult? {
        let valid = lookup.flatMap { $0.house.caseInsensitiveCompare(house) == .orderedSame ? $0 : nil }
        if var v = valid, let rec = currentHouseRecord {
            if v.queue.isEmpty { v.queue = rec.queue }
            if v.statusText == nil { v.statusText = rec.statusText }
            return v
        }
        if let valid { return valid }
        if let rec = currentHouseRecord { return rec }
        if !house.ktIsBlank { return PoeHouseLookupResult(house: house, queue: "", addressLabel: selectedAddressStr) }
        return nil
    }

    /// Oblast-wide search (plan D4): the branch's settlements first, then every other one with its branch named.
    private var settlementChoices: [SettlementChoice] { PoeAddressLookup.settlementChoices(remId, lang: lang) }

    /// A settlement whose directory has no streets, or a street POE lists no houses for: the lower picker is
    /// disabled and the place is added as a queue-only entry (spec/POE_API.md 8.11).
    private var noStreets: Bool {
        !settlementId.ktIsBlank && !streetsState.loading && streetsFor == "\(settlementId)|\(directoryVersion)" && streets.isEmpty
    }
    private var noHouses: Bool { !streetId.ktIsBlank && !housesState.loading && housesAnswered && houses.isEmpty }
    private var placeMode: String? { noStreets ? "settlement" : noHouses ? "street" : nil }
    private var placeLabel: String {
        [currentSettlement?.nameUk, placeMode == "street" ? currentStreet?.nameUk : nil]
            .compactMap { $0 }.filter { !$0.ktIsBlank }.joined(separator: ", ")
    }

    private func clearBelowRem() {
        settlementId = ""
        streetId = ""
        house = ""
        streets = []
        houses = []
        lookup = nil
    }

    private func clearBelowSettlement() {
        streetId = ""
        house = ""
        houses = []
        lookup = nil
    }

    // MARK: - Body

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                header
                searchCard
                if !companies.isEmpty { companyCard }
                missingCard
                Text(verbatim: AppStrings.queueHelpManualSearchTitle(lang).uppercased())
                    .ztText(ZtType.label.weight(.heavy).tracking(0.05))
                    .foregroundStyle(Color.white)
                    .padding(.top, 4)
                    .padding(.leading, 4)
                steps
                Button(action: onDismiss) {
                    Text(verbatim: AppStrings.queueHelpGotIt(lang))
                        .ztText(ZtType.subhead.weight(.heavy))
                        .foregroundStyle(Color.black)
                        .frame(maxWidth: .infinity, minHeight: ZtMinTouch)
                        .padding(.vertical, 4)
                        .background { RoundedRectangle(cornerRadius: 16).fill(Color.white) }
                }
                .buttonStyle(ZtPressStyle())
                .padding(.top, 4)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 16)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(ZtColors.cardSolid.ignoresSafeArea())
        .preferredColorScheme(.dark)
        // the hourly-schedule catalogue (about 2 MB) for the company search, read off the main thread
        .task { await loadCompanies() }
        // settlements of the branch (bundled directory): never picks one by itself
        .task(id: "\(remId)|\(settlementsState.retry)|\(directoryVersion)") { await loadSettlements() }
        // streets of the settlement (bundled directory, spelling variants merged)
        .task(id: "\(remId)|\(settlementId)|\(streetsState.retry)|\(directoryVersion)") { await loadStreets() }
        // the catalogue's queues of a place without streets or houses
        .task(id: "\(placeMode ?? "-")|\(remId)|\(settlementId)|\(streetId)|\(catalogueReady)|\(directoryVersion)") { loadPlaceHints() }
        // houses of the street, live from POE
        .task(id: "\(remId)|\(settlementId)|\(streetId)|\(housesState.retry)") { await loadHouses() }
        // asks POE for the queue when street and house are chosen
        .task(id: "\(remId)|\(settlementId)|\(streetId)|\(house)") { await checkAddress() }
    }

    private var header: some View {
        VStack(spacing: 14) {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 12).fill(ZtColors.accent).frame(width: 40, height: 40)
                    .overlay { Text(verbatim: "?").font(.system(size: 22, weight: .black)).foregroundStyle(Color.white) }
                    .accessibilityHidden(true)
                Text(verbatim: AppStrings.queueHelpTitle(lang)).ztText(ZtType.heading).foregroundStyle(Color.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
                Button(action: onDismiss) {
                    Circle().fill(Color(argb: 0x1AFFFFFF)).frame(width: 40, height: 40)
                        .overlay(Circle().strokeBorder(ZtColors.cardBorder, lineWidth: 1))
                        .overlay { Image(systemName: "xmark").font(.system(size: 16, weight: .semibold)).foregroundStyle(Color.white) }
                        .frame(width: ZtMinTouch, height: ZtMinTouch)
                }
                .buttonStyle(ZtPressStyle())
                .accessibilityLabel(Text(verbatim: AppStrings.pickerClose(lang)))
            }
            .padding(.horizontal, 4)
            DividerLine(color: ZtColors.inputBorder)
        }
    }

    private var searchCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: AppStrings.addrFindTitle(lang).uppercased())
                    .ztText(ZtType.label.weight(.heavy).tracking(0.05))
                    .foregroundStyle(Color.white)
                Text(verbatim: AppStrings.queueHelpAddressSubtitle(lang)).ztText(ZtType.caption).foregroundStyle(UiColors.textTertiaryHi)
            }

            SearchablePickerField(
                label: AppStrings.addrRemLabel(lang),
                value: currentRem.map { name(uk: $0.nameUk, en: $0.nameEn) },
                placeholder: AppStrings.addrRemPlaceholder(lang),
                items: rems.map { PickerItem(id: $0.id, label: name(uk: $0.nameUk, en: $0.nameEn)) },
                selectedId: remId,
                lang: lang,
                loading: remsState.loading,
                loadFailed: remsState.failed,
                onRetry: { remsState.retry += 1 }
            ) { item in
                if item.id != remId {
                    remId = item.id
                    clearBelowRem()
                }
            }

            SearchablePickerField(
                label: AppStrings.addrCityLabel(lang),
                value: currentSettlement.map(\.nameUk),
                placeholder: AppStrings.addrCityPlaceholder(lang),
                items: settlementChoices.map { PickerItem(id: $0.option.id, label: $0.label) },
                selectedId: settlementId.ktIsBlank ? nil : settlementId,
                lang: lang,
                loading: settlementsState.loading,
                loadFailed: settlementsState.failed,
                onRetry: { settlementsState.retry += 1 }
            ) { item in
                if item.id != settlementId {
                    // a settlement of another branch fills the branch in (most users do not know their дільниця)
                    if let choice = settlementChoices.first(where: { $0.option.id == item.id }), !choice.inBranch,
                       let branch = choice.option.branchIds.first {
                        remId = branch
                    }
                    settlementId = item.id
                    clearBelowSettlement()
                }
            }
            Text(verbatim: AppStrings.addrCityAnyBranchHint(lang))
                .ztText(ZtType.caption)
                .foregroundStyle(ZtColors.textTertiary)
                .padding(.leading, 4)

            SearchablePickerField(
                label: AppStrings.addrStreetLabel(lang),
                value: currentStreet.map(\.nameUk),
                placeholder: AppStrings.addrStreetPlaceholder(lang),
                items: streets.map { PickerItem(id: $0.id, label: $0.nameUk) },
                selectedId: streetId.ktIsBlank ? nil : streetId,
                lang: lang,
                enabled: !settlementId.ktIsBlank && !noStreets,
                loading: streetsState.loading,
                loadFailed: streetsState.failed && !settlementId.ktIsBlank && !noStreets,
                onRetry: { streetsState.retry += 1 },
                disabledHint: noStreets ? AppStrings.noStreetsHint(lang) : AppStrings.pickerChooseFirst(lang),
                // CI screenshots only: `-ZTPicker street` opens the street list (ios/scripts/gallery_screenshots.sh)
                autoOpen: UserDefaults.standard.string(forKey: "ZTPicker") == "street"
            ) { item in
                if item.id != streetId {
                    streetId = item.id
                    house = ""
                    houses = PoeAddressLookup.getHousesForStreet(item.id)
                    housesAnswered = false
                    lookup = nil
                }
            }

            SearchablePickerField(
                label: AppStrings.addrHouseLabel(lang),
                value: house,
                placeholder: AppStrings.addrHousePlaceholder(lang),
                items: houses.map { PickerItem(id: $0.house, label: $0.house) },
                selectedId: house.ktIsBlank ? nil : house,
                lang: lang,
                enabled: currentStreet != nil && !noHouses && !noStreets,
                loading: housesState.loading,
                loadFailed: housesState.failed && currentStreet != nil,
                onRetry: { housesState.retry += 1 },
                kind: .HOUSE,
                disabledHint: noHouses ? AppStrings.noHousesHint(lang) : AppStrings.pickerChooseFirst(lang)
            ) { item in
                house = item.id
                lookup = nil
            }

            if let mode = placeMode {
                placeCard(mode)
            } else if !house.ktIsBlank, let record = matchedRecord {
                resultCard(record)
            }
        }
        .padding(20)
        .background {
            RoundedRectangle(cornerRadius: 24).fill(Color(argb: 0x0DFFFFFF))
                .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(Color.white.opacity(0.25), lineWidth: 2))
        }
    }

    private func resultCard(_ record: PoeHouseLookupResult) -> some View {
        // while the site answers, an address without a known queue cannot be confirmed yet
        let several = record.severalConnections && record.queue.ktIsBlank
        let canApply = !(checking && record.queue.ktIsBlank) && (!several || chosenQueue != nil)
        return VStack(alignment: .leading, spacing: 10) {
            if !selectedAddressStr.ktIsBlank {
                Text(verbatim: selectedAddressStr).ztText(ZtType.label).foregroundStyle(UiColors.textSecondaryHi)
            }
            if checking {
                HStack(spacing: 10) {
                    ProgressView().tint(ZtColors.accent).controlSize(.small)
                    Text(verbatim: AppStrings.addrChecking(lang)).ztText(ZtType.caption).foregroundStyle(ZtColors.textSecondary)
                }
            } else if checkFailed {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.circle").foregroundStyle(ZtChipTone.amber.text)
                    Text(verbatim: AppStrings.addrCheckFailed(lang)).ztText(ZtType.caption).foregroundStyle(ZtChipTone.amber.text)
                }
            }
            if !record.queue.ktIsBlank {
                HStack(spacing: 12) {
                    Text(verbatim: AppStrings.addrFoundQueue(lang)).ztText(ZtType.label).foregroundStyle(UiColors.textTertiaryHi)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(verbatim: "\(AppStrings.queue(lang)) \(record.queue)").ztText(ZtType.timeMono.weight(.heavy))
                        .foregroundStyle(Color.white).fixedSize()
                }
            }
            if let status = record.statusText, !status.ktIsBlank {
                Text(verbatim: status).ztText(ZtType.label.weight(.bold)).foregroundStyle(Color.white)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background {
                        RoundedRectangle(cornerRadius: 16).fill(Color(argb: 0x0FFFFFFF))
                            .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color(argb: 0x33FFFFFF), lineWidth: 2))
                    }
            }
            // several connections: POE names no queue; the catalogue's queues, or all twelve, to choose from
            if several {
                Text(verbatim: AppStrings.severalConnections(lang)).ztText(ZtType.label.weight(.bold)).foregroundStyle(Color.white)
                queueChoices(hints: record.hints, selected: chosenQueue) { chosenQueue = $0 }
            }
            Button {
                let query = SelectedAddressQuery(remId: remId, settlementId: settlementId, streetId: streetId, house: house)
                let address = selectedAddressStr.ktIsBlank ? record.addressLabel : selectedAddressStr
                if several, let picked = chosenQueue {
                    onApply(picked, nil, address, query)
                    onBanner("\(AppStrings.queue(lang)) \(picked)")
                } else if !record.queue.ktIsBlank {
                    onApply(record.queue, nil, address, query)
                    onBanner("\(AppStrings.queue(lang)) \(record.queue)")
                } else {
                    onApply("", record.statusText, address, query)
                    onBanner(record.statusText ?? AppStrings.addrSaved(lang))
                }
            } label: {
                Text(verbatim: several && chosenQueue != nil ? AppStrings.addrApplyQueue(lang, chosenQueue!)
                     : record.queue.ktIsBlank ? AppStrings.addrConfirm(lang) : AppStrings.addrApplyQueue(lang, record.queue))
                    .ztText(ZtType.subhead.weight(.heavy))
                    .foregroundStyle(Color.white)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, minHeight: ZtMinTouch)
                    .padding(.vertical, 4)
                    .background { RoundedRectangle(cornerRadius: 16).fill(canApply ? ZtColors.accent : Color(argb: 0x66FF5E3A)) }
            }
            .buttonStyle(ZtPressStyle())
            .disabled(!canApply)
        }
        .padding(16)
        .background {
            RoundedRectangle(cornerRadius: 16).fill(Color(argb: 0xD9141A29))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.25), lineWidth: 2))
        }
        .padding(.top, 6)
    }

    /// The catalogue's queues (best first, with what matched), then the other queues; all twelve without hints.
    @ViewBuilder
    private func queueChoices(hints: [QueueCatalogue.Hint], selected: String?, onSelect: @escaping (String) -> Void) -> some View {
        Text(verbatim: hints.isEmpty ? AppStrings.chooseQueueTitle(lang) : AppStrings.catalogueHintsTitle(lang))
            .ztText(ZtType.caption).foregroundStyle(ZtColors.textSecondary)
        QueueChoiceChips(
            choices: hints.isEmpty ? POE_QUEUE_IDS.map { QueueChoice(queue: $0) }
                : hints.map { QueueChoice(queue: $0.queue, caption: hintCaption(lang, $0.kind)) },
            selected: selected, lang: lang, onSelect: onSelect
        )
        if !hints.isEmpty {
            Text(verbatim: AppStrings.chooseQueueTitle(lang)).ztText(ZtType.caption).foregroundStyle(ZtColors.textTertiary)
            QueueChoiceChips(
                choices: POE_QUEUE_IDS.filter { q in !hints.contains { $0.queue == q } }.map { QueueChoice(queue: $0) },
                selected: selected, lang: lang, onSelect: onSelect
            )
        }
    }

    /// A settlement without streets, or a street POE lists no houses for (spec/POE_API.md 8.11): the
    /// catalogue's queue for the whole place, added as a queue-only entry named after it.
    private func placeCard(_ mode: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(verbatim: placeLabel).ztText(ZtType.label).foregroundStyle(UiColors.textSecondaryHi)
            Text(verbatim: mode == "settlement" ? AppStrings.noStreetsHint(lang) : AppStrings.noHousesHint(lang))
                .ztText(ZtType.label.weight(.bold)).foregroundStyle(Color.white)
            queueChoices(hints: placeHints, selected: placeQueue) { placeQueue = $0 }
            Text(verbatim: AppStrings.placeQueueHint(lang)).ztText(ZtType.caption).foregroundStyle(ZtColors.textTertiary)
            ActionButton(
                text: placeQueue.map { AppStrings.addCompanyQueue(lang, $0) } ?? AppStrings.chooseQueueTitle(lang),
                icon: "plus", filled: placeQueue != nil
            ) {
                if let q = placeQueue { onAddCompany(q, placeLabel) }
            }
        }
        .padding(16)
        .background {
            RoundedRectangle(cornerRadius: 16).fill(Color(argb: 0xD9141A29))
                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color.white.opacity(0.25), lineWidth: 2))
        }
        .padding(.top, 6)
    }

    /// Search by workplace: companies named in POE's hourly-schedule PDF (spec/POE_API.md 8.11).
    private var companyCard: some View {
        let company = companies.first { $0.id == selectedCompany }
        return VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: AppStrings.companyTitle(lang).uppercased())
                .ztText(ZtType.label.weight(.heavy).tracking(0.05))
                .foregroundStyle(Color.white)
            SearchablePickerField(
                label: AppStrings.companyLabel(lang),
                value: company?.name,
                placeholder: AppStrings.companyPlaceholder(lang),
                items: companies.map { c in
                    PickerItem(id: c.id, label: [c.name, c.town, c.queues.joined(separator: ", ")].compactMap { $0 }.joined(separator: " · "),
                               search: c.search, context: c.context)
                },
                selectedId: selectedCompany,
                lang: lang,
                contextLabel: AppStrings.companyRowMatch(lang)
            ) { item in
                selectedCompany = item.id
                let queues = companies.first { $0.id == item.id }?.queues ?? []
                companyQueue = queues.count == 1 ? queues[0] : nil
            }
            Text(verbatim: AppStrings.companyHint(lang)).ztText(ZtType.caption).foregroundStyle(ZtColors.textTertiary)
            if let company {
                if company.queues.count > 1 {
                    QueueChoiceChips(choices: company.queues.map { QueueChoice(queue: $0) }, selected: companyQueue, lang: lang) { companyQueue = $0 }
                }
                ActionButton(
                    text: companyQueue.map { AppStrings.addCompanyQueue(lang, $0) } ?? AppStrings.chooseQueueTitle(lang),
                    icon: "plus", filled: companyQueue != nil
                ) {
                    if let q = companyQueue { onAddCompany(q, company.label) }
                }
            }
        }
        .padding(20)
        .background {
            RoundedRectangle(cornerRadius: 24).fill(Color(argb: 0x0DFFFFFF))
                .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(Color.white.opacity(0.25), lineWidth: 2))
        }
    }

    /// "Немає вашої адреси?": scoped refresh, never a crawl of POE from the phone (plan section 4.4).
    private var missingCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: AppStrings.addrMissingTitle(lang)).ztText(ZtType.label.weight(.bold)).foregroundStyle(Color.white)
            ActionButton(text: AppStrings.refreshSettlements(lang), icon: "arrow.clockwise", subdued: true,
                         busy: refreshing == "settlements", busyText: AppStrings.refreshing(lang)) {
                let rem = remId
                runRefresh("settlements", { await PoeAddressLookup.refreshSettlements(rem) ? true : nil }) { _ in AppStrings.refreshListDone(lang) }
            }
            if !settlementId.ktIsBlank {
                ActionButton(text: AppStrings.refreshStreets(lang), icon: "arrow.clockwise", subdued: true,
                             busy: refreshing == "streets", busyText: AppStrings.refreshing(lang)) {
                    let rem = remId
                    let city = settlementId
                    runRefresh("streets", { await PoeAddressLookup.refreshStreets(rem, city) ? true : nil }) { _ in AppStrings.refreshListDone(lang) }
                }
            }
            ActionButton(text: AppStrings.refreshDirectory(lang), icon: "arrow.clockwise", subdued: true,
                         busy: refreshing == "directory", busyText: AppStrings.refreshing(lang)) {
                runRefresh("directory", {
                    switch await PoeAddressLookup.updateDirectory() {
                    case .UPDATED: return true
                    case .UP_TO_DATE: return false
                    case .FAILED: return nil
                    }
                }) { updated in updated ? AppStrings.directoryUpdated(lang) : AppStrings.directoryUpToDate(lang) }
            }
        }
        .padding(.horizontal, 4)
    }

    /// Runs one scoped refresh; `work` gives nil when POE (or the repository) could not be asked.
    private func runRefresh(_ kind: String, _ work: @escaping () async -> Bool?, okText: @escaping (Bool) -> String) {
        guard refreshing == nil else { return }
        refreshing = kind
        Task {
            let ok = await work()
            refreshing = nil
            if ok != nil { directoryVersion += 1 }
            onBanner(ok.map(okText) ?? AppStrings.refreshListFailed(lang))
        }
    }

    /// Numbered instructions 1-4, text unchanged from AppStrings.queueHelpSteps; only the address is a link.
    private var steps: some View {
        VStack(spacing: 12) {
            ForEach(Array(AppStrings.queueHelpSteps(lang).enumerated()), id: \.offset) { idx, step in
                HStack(alignment: .top, spacing: 14) {
                    Text(verbatim: "\(idx + 1)").ztText(ZtType.captionMono).foregroundStyle(Color.white)
                        .padding(.horizontal, 6)
                        .frame(minWidth: 24, minHeight: 24)
                        .background { Capsule().fill(Color(argb: 0x26FFFFFF)) }
                        .padding(.top, 2)
                        .accessibilityHidden(true)
                    Text(Self.linked(step)).ztText(ZtType.body).foregroundStyle(Color(argb: 0xFFF4F4F5))
                        .tint(ZtColors.accent)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(16)
                .background {
                    RoundedRectangle(cornerRadius: 16).fill(Color(argb: 0x0AFFFFFF))
                        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Color(argb: 0x26FFFFFF), lineWidth: 2))
                }
            }
        }
    }

    static func linked(_ step: String) -> AttributedString {
        var s = AttributedString(step)
        if let range = s.range(of: POE_SEARCH_URL) {
            s[range].link = URL(string: POE_SEARCH_URL)
            // the SwiftUI scope: UIKit has attributes with the same names
            s[range].swiftUI.underlineStyle = Text.LineStyle(pattern: .solid)
            s[range].swiftUI.foregroundColor = ZtColors.accent
        }
        return s
    }

    // MARK: - Loading

    /// The directory may still be loading at the first frame: parse it off the main thread first.
    private func ensureDirectory() async {
        await Task.detached(priority: .userInitiated) { PoeAddressLookup.initialize() }.value
    }

    private func loadSettlements() async {
        await ensureDirectory()
        if Task.isCancelled { return }
        settlements = PoeAddressLookup.getSettlementsForRem(remId)
        settlementsState.failed = PoeAddressLookup.indexOrNull() == nil
        settlementsState.loading = false
    }

    private func loadStreets() async {
        if settlementId.ktIsBlank {
            streets = []
            streetsState.loading = false
            streetsState.failed = false
            return
        }
        streetsState.loading = true
        await ensureDirectory()
        if Task.isCancelled { return }
        streets = PoeAddressLookup.getStreetsForSettlement(settlementId)
        streetsState.failed = PoeAddressLookup.indexOrNull() == nil
        streetsState.loading = false
        streetsFor = "\(settlementId)|\(directoryVersion)"
    }

    private func loadPlaceHints() {
        guard let mode = placeMode, catalogueReady else {
            placeHints = []
            placeQueue = nil
            return
        }
        placeHints = PoeQueues.queuesFor(SelectedAddressQuery(remId: remId, settlementId: settlementId,
                                                              streetId: mode == "street" ? streetId : "", house: ""))
        placeQueue = placeHints.first?.queue
    }

    private func loadCompanies() async {
        let built: [CompanyChoice] = await Task.detached(priority: .utility) {
            PoeQueues.initialize()
            // one entry per name and town: «Школа № 27» of Кременчук and of Полтава are two
            var order: [String] = []
            var groups: [String: [PoeCompany]] = [:]
            for c in PoeQueues.companies() {
                let id = "\(c.name)|\(c.settlement ?? "")"
                if groups[id] == nil { order.append(id) }
                groups[id, default: []].append(c)
            }
            return order.compactMap { id -> CompanyChoice? in
                guard let rows = groups[id], let first = rows.first else { return nil }
                let hasAliases = rows.contains { !$0.aliases.ktIsBlank }
                var queues = Array(Set(rows.map(\.queue)))
                queues.sort()
                var search: [String] = []
                for t in [first.name] + rows.map(\.aliases) where !t.ktIsBlank && !search.contains(t) { search.append(t) }
                var context: [String] = []
                for t in rows.map(\.rowText) where !t.ktIsBlank && !context.contains(t) { context.append(t) }
                return CompanyChoice(
                    id: id, name: first.name,
                    label: first.settlement != nil && hasAliases ? "\(first.name), \(first.settlement!)" : first.name,
                    town: first.settlement, queues: queues,
                    search: search.joined(separator: " "), context: context.joined(separator: "; ")
                )
            }.sorted { $0.name.lowercased() < $1.name.lowercased() }
        }.value
        if Task.isCancelled { return }
        companies = built
        catalogueReady = PoeQueues.current() != nil
    }

    private func loadHouses() async {
        if streetId.ktIsBlank {
            houses = []
            housesState.loading = false
            housesState.failed = false
            return
        }
        houses = PoeAddressLookup.getHousesForStreet(streetId)
        housesState.loading = true
        housesState.failed = false
        let fetched = await PoeAddressLookup.fetchHousesForStreet(remId, settlementId, streetId)
        if Task.isCancelled { return }
        if let fetched, !fetched.isEmpty { houses = fetched }
        housesAnswered = fetched != nil
        // an answer with no houses is not a failure: the street has no house numbers
        housesState.failed = fetched == nil && houses.isEmpty
        housesState.loading = false
    }

    private func checkAddress() async {
        lookup = nil
        checkFailed = false
        chosenQueue = nil
        if streetId.ktIsBlank || house.ktIsBlank {
            checking = false
            return
        }
        checking = true
        let res = await PoeAddressLookup.checkAddress(
            SelectedAddressQuery(remId: remId, settlementId: settlementId, streetId: streetId, house: house)
        )
        if Task.isCancelled { return }
        checking = false
        lookup = res
        checkFailed = res == nil
        guard let res else { return }
        // the catalogue's best queue is pre-selected; the user confirms or picks another
        if res.severalConnections { chosenQueue = res.hints.first?.queue }
        if let i = houses.firstIndex(where: { $0.house.caseInsensitiveCompare(res.house) == .orderedSame }) {
            var h = houses[i]
            if !res.queue.isEmpty { h.queue = res.queue }
            if let s = res.statusText { h.statusText = s }
            if !res.addressLabel.isEmpty { h.addressLabel = res.addressLabel }
            houses[i] = h
        } else {
            houses.append(res)
        }
    }
}
