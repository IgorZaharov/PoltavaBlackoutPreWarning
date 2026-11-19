package ua.blackout.prewarning.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ua.blackout.prewarning.core.PoeMapper
import ua.blackout.prewarning.data.KYIV_ZONE
import ua.blackout.prewarning.data.repository.NearbySnapshot
import ua.blackout.prewarning.ui.AppStrings
import ua.blackout.prewarning.ui.theme.ZtColors
import ua.blackout.prewarning.ui.theme.ZtShapes
import ua.blackout.prewarning.ui.theme.ZtType
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime

private fun hhmm(t: LocalDateTime): String = "%02d:%02d".format(t.hour, t.minute)

/** The texts of one card row, kept apart from Compose so they are easy to check. */
object NearbyFormat {
    fun timeRange(o: PoeMapper.NearbyOutage): String = "${hhmm(o.start)} – ${o.end?.let { hhmm(it) } ?: "--:--"}"

    fun status(lang: String, o: PoeMapper.NearbyOutage): String = when (o.status) {
        PoeMapper.NearbyStatus.ACTIVE -> AppStrings.nearbyNow(lang)
        PoeMapper.NearbyStatus.UPCOMING -> AppStrings.nearbyAt(lang, hhmm(o.start))
        PoeMapper.NearbyStatus.FINISHED -> AppStrings.rowFinished(lang)
    }

    fun duration(lang: String, o: PoeMapper.NearbyOutage): String? =
        o.end?.let { AppStrings.durationText(lang, Duration.between(o.start, it).toMinutes()) }

    fun kind(lang: String, o: PoeMapper.NearbyOutage): String =
        if (o.kind == PoeMapper.RegistryKind.EMERGENCY) AppStrings.nearbyKindEmergency(lang) else AppStrings.nearbyKindRepair(lang)

    /** "Ваш будинок у списку", "Ваша вулиця у списку" or null. */
    fun yours(lang: String, o: PoeMapper.NearbyOutage): String? = when {
        o.match == PoeMapper.Match.CONFIRMED -> AppStrings.nearbyYourHouse(lang)
        o.streets.any { it.mine } -> AppStrings.nearbyYourStreet(lang)
        else -> null
    }

    fun houses(lang: String, s: PoeMapper.NearbyStreet): String =
        if (s.houses.isEmpty()) AppStrings.nearbyWholeStreet(lang) else "${AppStrings.addrHousePrefix(lang)} ${s.houses.joinToString(", ")}"
}

/**
 * «Ремонти й пошкодження поруч» (docs/POLTAVA_PORT_PLAN.md 5.4, spec/POE_API.md 8.10): today's
 * registry rows of the address's settlement, above the hero card. Display only; a row expands to its
 * streets and houses. When a branch could not be asked, the time of the shown data is named.
 */
@Composable
fun NearbyOutagesCard(nearby: NearbySnapshot, lang: String, modifier: Modifier = Modifier) {
    GlassCard(modifier = modifier.fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(14.dp)) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(
                    modifier = Modifier.size(28.dp).clip(CircleShape).background(ZtColors.ChipAmber),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(Icons.Default.Build, contentDescription = null, tint = ZtColors.ChipAmberText, modifier = Modifier.size(16.dp))
                }
                Text(
                    text = AppStrings.nearbyTitle(lang),
                    style = ZtType.label.copy(fontWeight = FontWeight.Bold),
                    color = Color.White,
                    modifier = Modifier.weight(1f)
                )
                if (!nearby.complete) {
                    val at = Instant.ofEpochMilli(nearby.fetchedMs).atZone(KYIV_ZONE).toLocalDateTime()
                    Text(text = AppStrings.staleChip(lang, hhmm(at)), style = ZtType.captionMono, color = ZtColors.ChipAmberText)
                }
            }
            nearby.items.forEach { item ->
                key(item.id, item.start) { NearbyRow(item, lang) }
            }
            Text(text = AppStrings.nearbyHint(lang), style = ZtType.caption, color = ZtColors.TextTertiary)
        }
    }
}

@Composable
private fun NearbyRow(o: PoeMapper.NearbyOutage, lang: String) {
    var expanded by rememberSaveable(o.id) { mutableStateOf(false) }
    val emergency = o.kind == PoeMapper.RegistryKind.EMERGENCY
    val finished = o.status == PoeMapper.NearbyStatus.FINISHED
    val yours = NearbyFormat.yours(lang, o)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(ZtShapes.Row)
            .background(ZtColors.InnerRow)
            .clickable(role = Role.Button) { expanded = !expanded }
            .semantics { stateDescription = if (expanded) AppStrings.nearbyCollapse(lang) else AppStrings.nearbyExpand(lang) }
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .alpha(if (finished) 0.55f else 1f),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(
                modifier = Modifier
                    .clip(ZtShapes.Badge)
                    .background(if (emergency) ZtColors.ChipRed else ZtColors.ChipGrey)
                    .padding(horizontal = 8.dp, vertical = 2.dp)
            ) {
                Text(
                    text = NearbyFormat.kind(lang, o),
                    style = ZtType.caption.copy(fontWeight = FontWeight.Bold),
                    color = if (emergency) ZtColors.ChipRedText else ZtColors.ChipGreyText
                )
            }
            Text(
                text = NearbyFormat.timeRange(o),
                style = ZtType.label.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold),
                color = Color.White
            )
            Text(
                text = listOfNotNull(NearbyFormat.status(lang, o), NearbyFormat.duration(lang, o)).joinToString(" · "),
                style = ZtType.caption,
                color = ZtColors.TextSecondary,
                modifier = Modifier.weight(1f)
            )
            Icon(
                if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                contentDescription = null,
                tint = ZtColors.TextSecondary,
                modifier = Modifier.size(20.dp)
            )
        }
        if (yours != null) {
            Text(text = yours, style = ZtType.caption.copy(fontWeight = FontWeight.Bold), color = ZtColors.ChipAmberText)
        }
        if (!expanded) {
            Text(
                text = o.streets.joinToString(", ") { it.name },
                style = ZtType.caption,
                color = ZtColors.TextSecondary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        } else {
            o.streets.forEach { s ->
                Column {
                    Text(
                        text = s.name,
                        style = ZtType.caption.copy(fontWeight = if (s.mine) FontWeight.Bold else FontWeight.Normal),
                        color = if (s.mine) ZtColors.ChipAmberText else Color.White
                    )
                    Text(text = NearbyFormat.houses(lang, s), style = ZtType.caption, color = ZtColors.TextSecondary)
                }
            }
        }
    }
}
