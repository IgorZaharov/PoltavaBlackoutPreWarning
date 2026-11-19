package ua.blackout.prewarning.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import ua.blackout.prewarning.core.QueueCatalogue
import ua.blackout.prewarning.ui.AppStrings
import ua.blackout.prewarning.ui.theme.ZtColors
import ua.blackout.prewarning.ui.theme.ZtMinTouch
import ua.blackout.prewarning.ui.theme.ZtShapes
import ua.blackout.prewarning.ui.theme.ZtType

/** "будинок у списку", "уся вулиця" ... for a catalogue hint (spec/POE_API.md 8.11). */
fun hintCaption(lang: String, kind: QueueCatalogue.Kind): String = when (kind) {
    QueueCatalogue.Kind.HOUSE -> AppStrings.hintHouse(lang)
    QueueCatalogue.Kind.RANGE -> AppStrings.hintRange(lang)
    QueueCatalogue.Kind.STREET -> AppStrings.hintStreet(lang)
    QueueCatalogue.Kind.SETTLEMENT -> AppStrings.hintSettlement(lang)
}

/**
 * One selectable chip per queue ("Черга 3.1" with an optional caption), for an address whose queue POE
 * does not name and for a company with several queues. A radio group for TalkBack.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun QueueChoiceChips(
    choices: List<Pair<String, String?>>,
    selected: String?,
    lang: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    FlowRow(
        modifier = modifier.selectableGroup(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        choices.forEach { (queue, caption) ->
            val on = queue == selected
            Column(
                modifier = Modifier
                    .heightIn(min = ZtMinTouch)
                    .clip(ZtShapes.Chip)
                    .background(if (on) ZtColors.Accent else Color(0x14FFFFFF))
                    .border(1.dp, if (on) Color(0x40FFFFFF) else ZtColors.CardBorder, ZtShapes.Chip)
                    .selectable(selected = on, role = Role.RadioButton) { onSelect(queue) }
                    .padding(horizontal = 12.dp, vertical = 8.dp)
            ) {
                Text(
                    text = "${AppStrings.queue(lang)} $queue",
                    style = ZtType.label.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold),
                    color = Color.White
                )
                if (caption != null) {
                    Text(text = caption, style = ZtType.caption, color = if (on) Color.White else ZtColors.TextSecondary)
                }
            }
        }
    }
}
