package ua.blackout.prewarning.data.poe

/** One POE branch (філія / дільниця) with its two id spaces (spec/branches.json, spec/POE_API.md section 2). */
data class PoeBranch(val slug: String, val cabinetId: Int, val registryId: Int, val nameUk: String, val nameEn: String)

/** The 28 branches of spec/branches.json; PoeBranchesTest checks that both stay identical. */
object PoeBranches {
    val ALL: List<PoeBranch> = listOf(
        PoeBranch("velykokokhnivska", 102, 2, "Великокохнівська дільниця", "Velykokokhnivka district"),
        PoeBranch("hadiatska", 103, 3, "Гадяцька дільниця", "Hadiach district"),
        PoeBranch("hlobynska", 104, 4, "Глобинська дільниця", "Hlobyne district"),
        PoeBranch("horishnoplavnivska", 112, 12, "Горішньоплавнівська дільниця", "Horishni Plavni district"),
        PoeBranch("hrebinkivska", 105, 5, "Гребінківська дільниця", "Hrebinka district"),
        PoeBranch("dykanska", 106, 6, "Диканська дільниця", "Dykanka district"),
        PoeBranch("zinkivska", 108, 8, "Зіньківська дільниця", "Zinkiv district"),
        PoeBranch("karlivska", 109, 9, "Карлівська дільниця", "Karlivka district"),
        PoeBranch("kobeliatska", 110, 10, "Кобеляцька дільниця", "Kobeliaky district"),
        PoeBranch("kozelshchynska", 111, 11, "Козельщинська дільниця", "Kozelshchyna district"),
        PoeBranch("kotelevska", 113, 13, "Котелевська дільниця", "Kotelva district"),
        PoeBranch("krasnohorivska", 114, 14, "Красногорівська дільниця", "Krasnohorivka district"),
        PoeBranch("kremenchutska", 115, 15, "Кременчуцька об'єднана філія", "Kremenchuk united branch"),
        PoeBranch("lokhvytska", 116, 16, "Лохвицька дільниця", "Lokhvytsia district"),
        PoeBranch("lubenska", 117, 17, "Лубенська об'єднана філія", "Lubny united branch"),
        PoeBranch("mashivska", 118, 18, "Машівська дільниця", "Mashivka district"),
        PoeBranch("myrhorodska", 119, 19, "Миргородська об'єднана філія", "Myrhorod united branch"),
        PoeBranch("novosanzharska", 120, 20, "Новосанжарська дільниця", "Novi Sanzhary district"),
        PoeBranch("orzhytska", 121, 21, "Оржицька дільниця", "Orzhytsia district"),
        PoeBranch("pyriatynska", 122, 22, "Пирятинська дільниця", "Pyriatyn district"),
        PoeBranch("poltavska-rem", 131, 31, "Полтавська дільниця районних електромереж", "Poltava district grid section"),
        PoeBranch("poltavska", 123, 23, "Полтавська об'єднана філія", "Poltava united branch"),
        PoeBranch("reshetylivska", 124, 24, "Решетилівська дільниця", "Reshetylivka district"),
        PoeBranch("semenivska", 125, 25, "Семенівська дільниця", "Semenivka district"),
        PoeBranch("khorolska", 126, 26, "Хорольська дільниця", "Khorol district"),
        PoeBranch("chornukhynska", 127, 27, "Чорнухинська дільниця", "Chornukhy district"),
        PoeBranch("chutivska", 128, 28, "Чутівська дільниця", "Chutove district"),
        PoeBranch("shyshatska", 129, 29, "Шишацька дільниця", "Shyshaky district")
    )

    fun bySlug(slug: String?): PoeBranch? = ALL.firstOrNull { it.slug == slug }
    fun byCabinetId(id: Int): PoeBranch? = ALL.firstOrNull { it.cabinetId == id }
}
