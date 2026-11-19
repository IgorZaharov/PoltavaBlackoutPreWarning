package ua.blackout.prewarning.ui.components

import ua.blackout.prewarning.data.model.BlackoutSlot
import ua.blackout.prewarning.data.model.SlotStatus

/**
 * One half-hour cell of the drum, reduced to what is drawn (spec/UI_DRUM.md section 1). `switching`
 * is the POE switching half-hour (power may still be off): never together with `planned`.
 */
data class DrumCell(val planned: Boolean, val emergency: Boolean, val switching: Boolean = false)

/**
 * The one classification the main drum ([TimelineBar]) and the widget bitmap
 * (`BlackoutGlanceWidget.renderAnalogCounterBitmap`) both draw, so they cannot disagree.
 * Mirrored by `drumCells` / `drumSignature` in `src/components/DrumChart.tsx`.
 */
object DrumCells {
    /**
     * 48 cells from [slots]: 48 half-hour slots, or 24 hourly slots (legacy, each used twice). Anything
     * else yields null and the drum shows the grey "unclear" bar. `isPlanned` and `isEmergency` are
     * separate so a planned outage overlapped by an emergency one shows both.
     */
    fun of(slots: List<BlackoutSlot>): List<DrumCell>? {
        val src = when (slots.size) {
            48 -> slots
            24 -> slots.flatMap { listOf(it, it) }
            else -> return null
        }
        return src.map { cell(it) }
    }

    fun cell(s: BlackoutSlot): DrumCell {
        val off = s.status == SlotStatus.POWER_OFF
        val planned = off && (s.isPlanned || !s.isEmergency)
        return DrumCell(
            planned = planned,
            emergency = off && s.isEmergency,
            switching = s.isSwitching && !planned
        )
    }

    /**
     * The 48 states as one string: "0" on, "1" planned, "2" emergency, "3" both, "4" switching,
     * "5" switching with an emergency; "UNCLEAR" when there is no drum.
     */
    fun signature(slots: List<BlackoutSlot>): String {
        val cells = of(slots) ?: return "UNCLEAR"
        return buildString(cells.size) { for (c in cells) append(code(c)) }
    }

    fun code(c: DrumCell): Char = when {
        c.planned && c.emergency -> '3'
        c.planned -> '1'
        c.switching && c.emergency -> '5'
        c.switching -> '4'
        c.emergency -> '2'
        else -> '0'
    }
}
