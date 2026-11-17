package ua.blackout.prewarning.ui.components

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import ua.blackout.prewarning.ui.AppStrings
import ua.blackout.prewarning.ui.theme.ZtColors
import ua.blackout.prewarning.ui.theme.ZtMinTouch
import ua.blackout.prewarning.ui.theme.ZtType

/**
 * Spotlight overlay of the first-run tour (spec/ONBOARDING.md), mirrored by src/components/CoachTour.tsx.
 *
 * Controls mark themselves with [coachTarget]; [CoachOverlay] dims its window except the lit targets, points
 * an arrow with a tip at a target (outside it) and rings the control to use next, after scrolling the target
 * into view. The dim layer has no pointer input, so touches on the lit controls reach them; a window that
 * wants "a tap outside goes on" puts [coachOutsideTaps] on its root, which takes every touch outside the lit
 * controls and the tips while an overlay is shown.
 * A dialog is its own window, so the address lookup dialog has its own [CoachTargets] and overlay.
 */
class CoachTargets {
    /** Target bounds in the coordinates of their window's root. */
    val rects = mutableStateMapOf<String, Rect>()

    /** Scrolls a target into view (the tour shows a tip at it). */
    @OptIn(ExperimentalFoundationApi::class)
    internal val requesters = mutableMapOf<String, BringIntoViewRequester>()

    /** While an overlay is shown: the lit holes and the tips, in root coordinates. Touches there go through. */
    internal var passThrough by mutableStateOf<List<Rect>?>(null)
    internal val tipRects = mutableStateMapOf<Int, Rect>()

    /** The smallest rectangle around all the [keys] that are on screen; null when none is. */
    fun union(keys: List<String>): Rect? {
        val found = keys.mapNotNull { rects[it] }
        if (found.isEmpty()) return null
        return Rect(found.minOf { it.left }, found.minOf { it.top }, found.maxOf { it.right }, found.maxOf { it.bottom })
    }
}

val LocalCoachTargets = staticCompositionLocalOf<CoachTargets?> { null }

/** Registers this element as tour target [key] (no effect outside a [LocalCoachTargets] provider). */
@OptIn(ExperimentalFoundationApi::class)
fun Modifier.coachTarget(key: String): Modifier = composed {
    val targets = LocalCoachTargets.current ?: return@composed this
    val requester = remember { BringIntoViewRequester() }
    DisposableEffect(targets, key) {
        targets.requesters[key] = requester
        onDispose {
            targets.rects.remove(key)
            if (targets.requesters[key] === requester) targets.requesters.remove(key)
        }
    }
    bringIntoViewRequester(requester).onGloballyPositioned { coordinates ->
        val p = coordinates.positionInRoot()
        targets.rects[key] = Rect(p, androidx.compose.ui.geometry.Size(coordinates.size.width.toFloat(), coordinates.size.height.toFloat()))
    }
}

/**
 * On a window's root: while an overlay of [targets] is shown and [onOutside] is set, a tap outside the lit
 * controls and the tips is taken (it reaches nothing underneath, not even a scroll) and calls [onOutside].
 */
fun Modifier.coachOutsideTaps(targets: CoachTargets, onOutside: (() -> Unit)?): Modifier = composed {
    var origin by remember { mutableStateOf(Offset.Zero) }
    val current = androidx.compose.runtime.rememberUpdatedState(onOutside)
    onGloballyPositioned { origin = it.positionInRoot() }.pointerInput(targets) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val action = current.value ?: return@awaitEachGesture
            val open = targets.passThrough ?: return@awaitEachGesture
            val p = down.position + origin
            if (open.any { it.contains(p) }) return@awaitEachGesture
            down.consume()
            var tapped = true
            while (true) {
                val event = awaitPointerEvent(PointerEventPass.Initial)
                event.changes.forEach { it.consume() }
                if (event.changes.none { it.pressed }) break
                if (event.changes.any { (it.position - down.position).getDistance() > viewConfiguration.touchSlop }) tapped = false
            }
            if (tapped) action()
        }
    }
}

/** One tip: an arrow and a text next to [anchor] (the union of its keys), outside it. */
data class CoachTip(
    val anchor: List<String>,
    val text: String,
    /** The control to use next, ringed in the accent colour. */
    val ring: String? = null,
    /** «Далі» goes on to the next step. */
    val next: Boolean = false,
    /** «Зрозуміло» ends the tour. */
    val done: Boolean = false,
    /** «Пропустити підказки» (one tip per step). */
    val skip: Boolean = false
)

private val HolePad = 6.dp
private val HoleRadius = 14.dp
private val ArrowSize = 32.dp
private val TipWidth = 260.dp
private val DimColor = Color(0xC705080F)

/**
 * Dims the window except the [holes] (each the union of its keys) and draws the [tips]. Draws nothing until
 * a tip's anchor is on screen.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun CoachOverlay(
    targets: CoachTargets,
    holes: List<List<String>>,
    tips: List<CoachTip>,
    lang: String,
    onSkip: () -> Unit,
    onNext: () -> Unit = {},
    onDone: () -> Unit = {},
    modifier: Modifier = Modifier
) {
    // the overlay may sit inside a padded box: target rects are moved into its own coordinates
    var origin by remember { mutableStateOf(Offset.Zero) }
    val local = { r: Rect -> r.translate(-origin.x, -origin.y) }
    val shown = tips.mapNotNull { tip -> targets.union(tip.anchor)?.let { tip to local(it) } }
    // the first tip's controls are scrolled into view (Settings is a long page)
    val scrollKeys = tips.firstOrNull()?.anchor.orEmpty()
    LaunchedEffect(scrollKeys) {
        delay(300)
        scrollKeys.forEach { key -> targets.requesters[key]?.bringIntoView() }
    }
    val holePadPx = with(LocalDensity.current) { HolePad.toPx() }
    SideEffect {
        targets.passThrough = if (shown.isEmpty()) {
            null
        } else {
            holes.mapNotNull { targets.union(it)?.inflate(holePadPx) } + targets.tipRects.values
        }
    }
    DisposableEffect(targets) {
        onDispose {
            targets.passThrough = null
            targets.tipRects.clear()
        }
    }
    BoxWithConstraints(
        modifier = modifier
            .fillMaxSize()
            .onGloballyPositioned { origin = it.boundsInRoot().topLeft }
    ) {
        if (shown.isEmpty()) return@BoxWithConstraints
        val density = LocalDensity.current
        val pad = with(density) { HolePad.toPx() }
        val radius = with(density) { HoleRadius.toPx() }
        val holeRects = holes.mapNotNull { keys -> targets.union(keys)?.let(local) }
        Canvas(modifier = Modifier.fillMaxSize()) {
            val path = Path().apply {
                fillType = PathFillType.EvenOdd
                addRect(Rect(0f, 0f, size.width, size.height))
                holeRects.forEach { addRoundRect(RoundRect(it.inflate(pad), CornerRadius(radius, radius))) }
            }
            drawPath(path, DimColor)
        }
        val width = with(density) { constraints.maxWidth.toDp() }
        val height = with(density) { constraints.maxHeight.toDp() }
        shown.forEachIndexed { index, (tip, anchor) ->
            TipMark(
                onBounds = { targets.tipRects[index] = it },
                tip = tip,
                anchor = anchor,
                ring = tip.ring?.let { targets.rects[it] }?.let(local),
                screenWidth = width,
                screenHeight = height,
                lang = lang,
                onSkip = onSkip,
                onNext = onNext,
                onDone = onDone
            )
        }
    }
}

@Composable
private fun TipMark(
    onBounds: (Rect) -> Unit,
    tip: CoachTip,
    anchor: Rect,
    ring: Rect?,
    screenWidth: androidx.compose.ui.unit.Dp,
    screenHeight: androidx.compose.ui.unit.Dp,
    lang: String,
    onSkip: () -> Unit,
    onNext: () -> Unit,
    onDone: () -> Unit
) {
    val density = LocalDensity.current
    val context = LocalContext.current
    val animate = remember { !reducedMotion(context) }
    val a = with(density) { Rect(anchor.left.toDp().value, anchor.top.toDp().value, anchor.right.toDp().value, anchor.bottom.toDp().value) }
    val cx = (a.left + a.right) / 2f
    val above = (a.top + a.bottom) / 2f > screenHeight.value * 0.45f
    val arrowTop = if (above) a.top - HolePad.value - 4f - ArrowSize.value else a.bottom + HolePad.value + 4f
    val bubbleWidth = minOf(TipWidth.value, screenWidth.value - 24f)
    val bubbleLeft = (cx - bubbleWidth / 2f).coerceIn(12f, maxOf(12f, screenWidth.value - 12f - bubbleWidth))
    var bubbleHeight by remember { mutableIntStateOf(0) }
    val nudge: State<Float>? = if (animate) {
        rememberInfiniteTransition(label = "coach").animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(700, easing = FastOutSlowInEasing), RepeatMode.Reverse),
            label = "coachNudge"
        )
    } else {
        null
    }

    if (ring != null) {
        val r = with(density) { Rect(ring.left.toDp().value, ring.top.toDp().value, ring.right.toDp().value, ring.bottom.toDp().value) }
        Box(
            modifier = Modifier
                .offset((r.left - 3f).dp, (r.top - 3f).dp)
                .size((r.width + 6f).dp, (r.height + 6f).dp)
                .border(2.dp, ZtColors.Accent, RoundedCornerShape(16.dp))
        )
    }
    Icon(
        imageVector = if (above) Icons.Default.ArrowDownward else Icons.Default.ArrowUpward,
        contentDescription = null,
        tint = ZtColors.Accent,
        modifier = Modifier
            .offset((cx - ArrowSize.value / 2f).dp, arrowTop.dp)
            .size(ArrowSize)
            .graphicsLayer { translationY = (nudge?.value ?: 0f) * 8.dp.toPx() * if (above) 1f else -1f }
    )
    Column(
        modifier = Modifier
            .offset {
                val top = if (above) arrowTop.dp.toPx() - 2.dp.toPx() - bubbleHeight else (arrowTop + ArrowSize.value + 2f).dp.toPx()
                IntOffset(bubbleLeft.dp.roundToPx(), top.roundToInt())
            }
            .width(bubbleWidth.dp)
            .onSizeChanged { bubbleHeight = it.height }
            .onGloballyPositioned { onBounds(it.boundsInRoot()) }
            .background(ZtColors.CardSolid, RoundedCornerShape(16.dp))
            .border(1.dp, Color(0x33FFFFFF), RoundedCornerShape(16.dp))
            .padding(horizontal = 16.dp, vertical = 12.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Text(text = tip.text, style = ZtType.body.copy(fontWeight = FontWeight.Bold), color = Color.White, textAlign = TextAlign.Center)
        if (tip.next || tip.done) {
            Box(
                modifier = Modifier
                    .heightIn(min = 44.dp)
                    .background(ZtColors.Accent, RoundedCornerShape(12.dp))
                    .clickable(role = Role.Button) { if (tip.done) onDone() else onNext() }
                    .padding(horizontal = 20.dp, vertical = 10.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = if (tip.done) AppStrings.tourGotIt(lang) else AppStrings.tourNext(lang),
                    style = ZtType.label.copy(fontWeight = FontWeight.ExtraBold),
                    color = Color.White
                )
            }
        }
        if (tip.skip) {
            Box(
                modifier = Modifier
                    .heightIn(min = ZtMinTouch)
                    .clickable(role = Role.Button, onClick = onSkip)
                    .padding(horizontal = 12.dp),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = AppStrings.tourSkip(lang),
                    style = ZtType.caption.copy(textDecoration = TextDecoration.Underline, fontWeight = FontWeight.SemiBold),
                    color = ZtColors.TextSecondary
                )
            }
        }
    }
}
