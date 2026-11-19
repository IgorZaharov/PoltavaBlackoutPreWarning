import SwiftUI

/// «Ремонти й пошкодження поруч» (docs/POLTAVA_PORT_PLAN.md 5.4, spec/POE_API.md 8.10; port of Android
/// NearbyOutagesCard.kt): today's registry rows of the address's settlement, above the hero card. Display
/// only; a row expands to its streets and houses. When a branch could not be asked, the time of the shown
/// data is named.
struct NearbyOutagesCard: View {
    let nearby: NearbySnapshot
    let lang: String

    var body: some View {
        ZtGlassCard(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Circle().fill(ZtChipTone.amber.fill).frame(width: 28, height: 28)
                        .overlay { Image(systemName: "wrench.and.screwdriver.fill").font(.system(size: 13, weight: .semibold)).foregroundStyle(ZtChipTone.amber.text) }
                        .accessibilityHidden(true)
                    Text(verbatim: AppStrings.nearbyTitle(lang))
                        .ztText(ZtType.label.weight(.bold))
                        .foregroundStyle(Color.white)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityAddTraits(.isHeader)
                    if let stale = NearbyFormat.staleChip(lang, nearby) {
                        Text(verbatim: stale).ztText(ZtType.captionMono).foregroundStyle(ZtChipTone.amber.text).fixedSize()
                    }
                }
                ForEach(nearby.items, id: \.self) { item in
                    NearbyRow(item: item, lang: lang)
                }
                Text(verbatim: AppStrings.nearbyHint(lang)).ztText(ZtType.caption).foregroundStyle(ZtColors.textTertiary)
            }
        }
    }
}

private struct NearbyRow: View {
    let item: PoeMapper.NearbyOutage
    let lang: String
    @State private var expanded = false

    var body: some View {
        let emergency = item.kind == .EMERGENCY
        let finished = item.status == .FINISHED
        let detail = [NearbyFormat.status(lang, item), NearbyFormat.duration(lang, item)].compactMap { $0 }.joined(separator: " · ")
        Button {
            withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(verbatim: NearbyFormat.kind(lang, item))
                        .ztText(ZtType.caption.weight(.bold))
                        .foregroundStyle(emergency ? ZtChipTone.red.text : ZtChipTone.grey.text)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background { RoundedRectangle(cornerRadius: ZtRadius.badge).fill(emergency ? ZtChipTone.red.fill : ZtChipTone.grey.fill) }
                        .fixedSize()
                    Text(verbatim: NearbyFormat.timeRange(item))
                        .ztText(ZtType.label.monospaced().weight(.bold))
                        .foregroundStyle(Color.white)
                        .fixedSize()
                    Text(verbatim: detail)
                        .ztText(ZtType.caption)
                        .foregroundStyle(ZtColors.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(ZtColors.textSecondary)
                        .accessibilityHidden(true)
                }
                if let yours = NearbyFormat.yours(lang, item) {
                    Text(verbatim: yours).ztText(ZtType.caption.weight(.bold)).foregroundStyle(ZtChipTone.amber.text)
                }
                if expanded {
                    ForEach(Array(item.streets.enumerated()), id: \.offset) { _, s in
                        VStack(alignment: .leading, spacing: 0) {
                            Text(verbatim: s.name)
                                .ztText(ZtType.caption.weight(s.mine ? .bold : .regular))
                                .foregroundStyle(s.mine ? ZtChipTone.amber.text : Color.white)
                            Text(verbatim: NearbyFormat.houses(lang, s)).ztText(ZtType.caption).foregroundStyle(ZtColors.textSecondary)
                        }
                    }
                } else {
                    Text(verbatim: item.streets.map(\.name).joined(separator: ", "))
                        .ztText(ZtType.caption)
                        .foregroundStyle(ZtColors.textSecondary)
                        .lineLimit(2)
                }
            }
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background { RoundedRectangle(cornerRadius: ZtRadius.row).fill(ZtColors.innerRow) }
            .opacity(finished ? 0.55 : 1)
        }
        .buttonStyle(ZtPressStyle())
        .accessibilityValue(Text(verbatim: expanded ? AppStrings.nearbyCollapse(lang) : AppStrings.nearbyExpand(lang)))
    }
}
