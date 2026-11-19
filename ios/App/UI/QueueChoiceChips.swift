import SwiftUI

/// "будинок у списку", "уся вулиця" ... for a catalogue hint (spec/POE_API.md 8.11).
func hintCaption(_ lang: String, _ kind: QueueCatalogue.Kind) -> String {
    switch kind {
    case .HOUSE: return AppStrings.hintHouse(lang)
    case .RANGE: return AppStrings.hintRange(lang)
    case .STREET: return AppStrings.hintStreet(lang)
    case .SETTLEMENT: return AppStrings.hintSettlement(lang)
    }
}

/// The twelve POE queues, for an address whose queue POE does not name.
let POE_QUEUE_IDS = PoeSchedule.QUEUES

/// One chip of `QueueChoiceChips`: a queue and an optional caption ("будинок у списку").
struct QueueChoice: Hashable {
    let queue: String
    var caption: String? = nil
}

/// One selectable chip per queue ("Черга 3.1" with an optional caption), for an address whose queue POE
/// does not name and for a company with several queues (port of Android QueueChoiceChips.kt). A radio
/// group for VoiceOver.
struct QueueChoiceChips: View {
    let choices: [QueueChoice]
    let selected: String?
    let lang: String
    let onSelect: (String) -> Void

    var body: some View {
        FlowLayout(spacing: 8, lineSpacing: 8) {
            ForEach(choices, id: \.queue) { choice in
                let on = choice.queue == selected
                Button { onSelect(choice.queue) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: "\(AppStrings.queue(lang)) \(choice.queue)")
                            .ztText(ZtType.label.monospaced().weight(.bold))
                            .foregroundStyle(Color.white)
                        if let caption = choice.caption {
                            Text(verbatim: caption).ztText(ZtType.caption).foregroundStyle(on ? Color.white : ZtColors.textSecondary)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .frame(minHeight: ZtMinTouch)
                    .background {
                        RoundedRectangle(cornerRadius: ZtRadius.chip).fill(on ? ZtColors.accent : Color(argb: 0x14FFFFFF))
                            .overlay(RoundedRectangle(cornerRadius: ZtRadius.chip)
                                .strokeBorder(on ? Color(argb: 0x40FFFFFF) : ZtColors.cardBorder, lineWidth: 1))
                    }
                }
                .buttonStyle(ZtPressStyle())
                .accessibilityAddTraits(on ? [.isSelected] : [])
            }
        }
    }
}
