import Foundation

/// The texts of one row of «Ремонти й пошкодження поруч», kept apart from SwiftUI so they are easy to
/// check (mirror of Android `NearbyFormat` in NearbyOutagesCard.kt).
public enum NearbyFormat {
    private static func hhmm(_ t: LocalDateTime) -> String { String(format: "%02d:%02d", t.hour, t.minute) }

    public static func timeRange(_ o: PoeMapper.NearbyOutage) -> String {
        "\(hhmm(o.start)) – \(o.end.map(hhmm) ?? "--:--")"
    }

    public static func status(_ lang: String, _ o: PoeMapper.NearbyOutage) -> String {
        switch o.status {
        case .ACTIVE: return AppStrings.nearbyNow(lang)
        case .UPCOMING: return AppStrings.nearbyAt(lang, hhmm(o.start))
        case .FINISHED: return AppStrings.rowFinished(lang)
        }
    }

    public static func duration(_ lang: String, _ o: PoeMapper.NearbyOutage) -> String? {
        o.end.map { AppStrings.durationText(lang, KyivTime.minutesBetween(o.start, $0)) }
    }

    public static func kind(_ lang: String, _ o: PoeMapper.NearbyOutage) -> String {
        o.kind == .EMERGENCY ? AppStrings.nearbyKindEmergency(lang) : AppStrings.nearbyKindRepair(lang)
    }

    /// "Ваш будинок у списку", "Ваша вулиця у списку" or nil.
    public static func yours(_ lang: String, _ o: PoeMapper.NearbyOutage) -> String? {
        if o.match == .CONFIRMED { return AppStrings.nearbyYourHouse(lang) }
        if o.streets.contains(where: \.mine) { return AppStrings.nearbyYourStreet(lang) }
        return nil
    }

    public static func houses(_ lang: String, _ s: PoeMapper.NearbyStreet) -> String {
        s.houses.isEmpty ? AppStrings.nearbyWholeStreet(lang) : "\(AppStrings.addrHousePrefix(lang)) \(s.houses.joined(separator: ", "))"
    }

    /// "дані за 14:05" when a branch could not be asked on the last attempt, else nil.
    public static func staleChip(_ lang: String, _ nearby: NearbySnapshot) -> String? {
        if nearby.complete { return nil }
        let at = KyivTime.localDateTime(of: Date(timeIntervalSince1970: TimeInterval(nearby.fetchedMs) / 1000))
        return AppStrings.staleChip(lang, hhmm(at))
    }
}
