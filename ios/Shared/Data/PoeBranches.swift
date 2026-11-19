import Foundation

/// One POE branch (філія / дільниця) with its two id spaces (spec/branches.json, spec/POE_API.md section 2).
public struct PoeBranch: Hashable, Sendable {
    public var slug: String
    public var cabinetId: Int
    public var registryId: Int
    public var nameUk: String
    public var nameEn: String
}

/// The 28 branches of spec/branches.json (mirror of android PoeBranches.kt); PoeDataTests checks that
/// both stay identical.
public enum PoeBranches {
    public static let ALL: [PoeBranch] = [
        PoeBranch(slug: "velykokokhnivska", cabinetId: 102, registryId: 2, nameUk: "Великокохнівська дільниця", nameEn: "Velykokokhnivka district"),
        PoeBranch(slug: "hadiatska", cabinetId: 103, registryId: 3, nameUk: "Гадяцька дільниця", nameEn: "Hadiach district"),
        PoeBranch(slug: "hlobynska", cabinetId: 104, registryId: 4, nameUk: "Глобинська дільниця", nameEn: "Hlobyne district"),
        PoeBranch(slug: "horishnoplavnivska", cabinetId: 112, registryId: 12, nameUk: "Горішньоплавнівська дільниця", nameEn: "Horishni Plavni district"),
        PoeBranch(slug: "hrebinkivska", cabinetId: 105, registryId: 5, nameUk: "Гребінківська дільниця", nameEn: "Hrebinka district"),
        PoeBranch(slug: "dykanska", cabinetId: 106, registryId: 6, nameUk: "Диканська дільниця", nameEn: "Dykanka district"),
        PoeBranch(slug: "zinkivska", cabinetId: 108, registryId: 8, nameUk: "Зіньківська дільниця", nameEn: "Zinkiv district"),
        PoeBranch(slug: "karlivska", cabinetId: 109, registryId: 9, nameUk: "Карлівська дільниця", nameEn: "Karlivka district"),
        PoeBranch(slug: "kobeliatska", cabinetId: 110, registryId: 10, nameUk: "Кобеляцька дільниця", nameEn: "Kobeliaky district"),
        PoeBranch(slug: "kozelshchynska", cabinetId: 111, registryId: 11, nameUk: "Козельщинська дільниця", nameEn: "Kozelshchyna district"),
        PoeBranch(slug: "kotelevska", cabinetId: 113, registryId: 13, nameUk: "Котелевська дільниця", nameEn: "Kotelva district"),
        PoeBranch(slug: "krasnohorivska", cabinetId: 114, registryId: 14, nameUk: "Красногорівська дільниця", nameEn: "Krasnohorivka district"),
        PoeBranch(slug: "kremenchutska", cabinetId: 115, registryId: 15, nameUk: "Кременчуцька об'єднана філія", nameEn: "Kremenchuk united branch"),
        PoeBranch(slug: "lokhvytska", cabinetId: 116, registryId: 16, nameUk: "Лохвицька дільниця", nameEn: "Lokhvytsia district"),
        PoeBranch(slug: "lubenska", cabinetId: 117, registryId: 17, nameUk: "Лубенська об'єднана філія", nameEn: "Lubny united branch"),
        PoeBranch(slug: "mashivska", cabinetId: 118, registryId: 18, nameUk: "Машівська дільниця", nameEn: "Mashivka district"),
        PoeBranch(slug: "myrhorodska", cabinetId: 119, registryId: 19, nameUk: "Миргородська об'єднана філія", nameEn: "Myrhorod united branch"),
        PoeBranch(slug: "novosanzharska", cabinetId: 120, registryId: 20, nameUk: "Новосанжарська дільниця", nameEn: "Novi Sanzhary district"),
        PoeBranch(slug: "orzhytska", cabinetId: 121, registryId: 21, nameUk: "Оржицька дільниця", nameEn: "Orzhytsia district"),
        PoeBranch(slug: "pyriatynska", cabinetId: 122, registryId: 22, nameUk: "Пирятинська дільниця", nameEn: "Pyriatyn district"),
        PoeBranch(slug: "poltavska-rem", cabinetId: 131, registryId: 31, nameUk: "Полтавська дільниця районних електромереж", nameEn: "Poltava district grid section"),
        PoeBranch(slug: "poltavska", cabinetId: 123, registryId: 23, nameUk: "Полтавська об'єднана філія", nameEn: "Poltava united branch"),
        PoeBranch(slug: "reshetylivska", cabinetId: 124, registryId: 24, nameUk: "Решетилівська дільниця", nameEn: "Reshetylivka district"),
        PoeBranch(slug: "semenivska", cabinetId: 125, registryId: 25, nameUk: "Семенівська дільниця", nameEn: "Semenivka district"),
        PoeBranch(slug: "khorolska", cabinetId: 126, registryId: 26, nameUk: "Хорольська дільниця", nameEn: "Khorol district"),
        PoeBranch(slug: "chornukhynska", cabinetId: 127, registryId: 27, nameUk: "Чорнухинська дільниця", nameEn: "Chornukhy district"),
        PoeBranch(slug: "chutivska", cabinetId: 128, registryId: 28, nameUk: "Чутівська дільниця", nameEn: "Chutove district"),
        PoeBranch(slug: "shyshatska", cabinetId: 129, registryId: 29, nameUk: "Шишацька дільниця", nameEn: "Shyshaky district")
    ]

    public static func bySlug(_ slug: String?) -> PoeBranch? { ALL.first { $0.slug == slug } }

    public static func byCabinetId(_ id: Int) -> PoeBranch? { ALL.first { $0.cabinetId == id } }
}
