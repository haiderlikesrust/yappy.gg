package gg.yappy.app.ui.chat

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.PumpCandle
import gg.yappy.app.data.PumpFun
import gg.yappy.app.data.PumpRange
import gg.yappy.app.data.PumpSnapshot
import gg.yappy.app.data.TokenVenue
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

/**
 * A pasted contract address, drawn as a live coin card.
 *
 * Android-only. The message stays the address; this is a local read of
 * public APIs, not something stored on the message. iOS keeps the raw text.
 *
 * Not a trading screen. Copy the CA (the common action) or open the
 * launchpad / DexScreener page — we do not route a swap from chat.
 *
 * LIVE polls while the card is composed. Leaving the message (or switching
 * range) cancels the loop.
 */
@Composable
fun PumpChartCard(
    mint: String,
    onOpenUrl: (String) -> Unit,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    val http = LocalContainer.current.api.http
    val clipboard = LocalClipboardManager.current
    val colors = neuColors
    var range by remember(mint) { mutableStateOf(PumpRange.LIVE) }
    var snap by remember(mint) { mutableStateOf<PumpSnapshot?>(null) }
    var copied by remember(mint) { mutableStateOf(false) }

    LaunchedEffect(mint, range) {
        while (true) {
            val next = PumpFun.load(http, mint, range, fresh = range == PumpRange.LIVE)
            if (next != null) snap = next
            if (range != PumpRange.LIVE) break
            delay(3_000)
        }
    }

    LaunchedEffect(copied) {
        if (!copied) return@LaunchedEffect
        delay(1_400)
        copied = false
    }

    val card = snap ?: return

    val up = (card.changePct ?: 0.0) >= 0
    val tone = if (up) colors.success else colors.danger
    val status = when {
        card.venue == TokenVenue.PUMP && card.complete -> "bonded"
        card.venue == TokenVenue.PUMP -> "on curve"
        else -> card.venue.label
    }
    val cta = when (card.venue) {
        TokenVenue.DEX -> "Open DexScreener"
        else -> "Buy on ${card.venue.label}"
    }

    NeuSurface(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(Neu.CornerMedium),
        contentPadding = if (compact) 10.dp else 12.dp,
    ) {
        Column {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Avatar(
                    url = card.imageUrl,
                    name = card.symbol.ifBlank { card.name },
                    id = card.mint,
                    size = if (compact) 32.dp else 36.dp,
                )
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            card.name,
                            style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                            color = colors.textPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier
                                .weight(1f, fill = false)
                                .softClickable { onOpenUrl(card.tradeUrl) },
                        )
                        Spacer(Modifier.width(6.dp))
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .background(colors.veil, CircleShape)
                                .softClickable {
                                    clipboard.setText(AnnotatedString(card.mint))
                                    copied = true
                                }
                                .padding(horizontal = 8.dp, vertical = 3.dp),
                        ) {
                            Icon(
                                Icons.Rounded.ContentCopy,
                                contentDescription = "Copy contract address",
                                tint = if (copied) colors.success else colors.textSecondary,
                                modifier = Modifier.size(11.dp),
                            )
                            Spacer(Modifier.width(4.dp))
                            Text(
                                if (copied) "Copied" else "Copy",
                                style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                                color = if (copied) colors.success else colors.textSecondary,
                            )
                        }
                    }
                    Text(
                        buildString {
                            if (card.symbol.isNotBlank()) {
                                append(card.symbol)
                                append(" · ")
                            }
                            append(status)
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(
                        usd(card.marketCapUsd),
                        style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.textPrimary,
                    )
                    card.changePct?.let { pct ->
                        Text(
                            (if (pct >= 0) "+" else "") + "%.2f".format(pct) + "%",
                            style = MaterialTheme.typography.labelSmall,
                            color = tone,
                        )
                    }
                }
            }

            card.bondProgress?.let { progress ->
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        Modifier
                            .weight(1f)
                            .height(4.dp)
                            .clip(CircleShape)
                            .background(colors.veil),
                    ) {
                        Box(
                            Modifier
                                .fillMaxHeight()
                                .fillMaxWidth(progress)
                                .clip(CircleShape)
                                .background(colors.success),
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "${(progress * 100).toInt()}% to bond",
                        style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.textSecondary,
                    )
                }
            }

            card.priceUsd?.let { price ->
                Spacer(Modifier.height(8.dp))
                Text(
                    tokenPrice(price),
                    style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.SemiBold),
                    color = colors.textPrimary,
                )
            }

            if (card.candles.size >= 2) {
                Spacer(Modifier.height(8.dp))
                CandleChart(
                    candles = card.candles,
                    upColor = colors.success,
                    downColor = colors.danger,
                    grid = colors.textTertiary.copy(alpha = 0.28f),
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(if (compact) 88.dp else 132.dp),
                )
            }

            Spacer(Modifier.height(8.dp))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                PumpRange.entries.forEach { tab ->
                    val on = tab == range
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .background(
                                if (on) colors.veil else colors.veil.copy(alpha = 0f),
                                CircleShape,
                            )
                            .padding(horizontal = 10.dp, vertical = 5.dp)
                            .softClickable { range = tab },
                    ) {
                        if (tab == PumpRange.LIVE) {
                            LiveDot(on = on, color = colors.success)
                            Spacer(Modifier.width(5.dp))
                        }
                        Text(
                            tab.label,
                            style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold),
                            color = if (on) colors.textPrimary else colors.textTertiary,
                        )
                    }
                }
            }

            if (!compact) {
                Spacer(Modifier.height(10.dp))
                Box(
                    Modifier
                        .fillMaxWidth()
                        .background(colors.success, RoundedCornerShape(Neu.CornerMedium))
                        .softClickable { onOpenUrl(card.tradeUrl) }
                        .padding(vertical = 11.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        cta,
                        style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold),
                        color = colors.onAccent,
                    )
                }
            }
        }
    }
}

@Composable
private fun LiveDot(on: Boolean, color: androidx.compose.ui.graphics.Color) {
    val pulse by rememberInfiniteTransition(label = "live").animateFloat(
        initialValue = 1f,
        targetValue = 0.35f,
        animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse),
        label = "live-alpha",
    )
    Box(
        Modifier
            .size(7.dp)
            .alpha(if (on) pulse else 0.45f)
            .background(color, CircleShape),
    )
}

@Composable
private fun CandleChart(
    candles: List<PumpCandle>,
    upColor: androidx.compose.ui.graphics.Color,
    downColor: androidx.compose.ui.graphics.Color,
    grid: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier) {
        val lo = candles.minOf { it.low }
        val hi = candles.maxOf { it.high }
        val span = (hi - lo).takeIf { it != 0.0 } ?: 1.0
        val topPad = size.height * 0.06f
        val usable = size.height * 0.88f
        fun y(v: Double): Float = topPad + ((hi - v) / span).toFloat() * usable

        val dash = PathEffect.dashPathEffect(floatArrayOf(6f, 8f))
        drawLine(grid, Offset(0f, y(hi)), Offset(size.width, y(hi)), 1f, pathEffect = dash)
        drawLine(grid, Offset(0f, y(lo)), Offset(size.width, y(lo)), 1f, pathEffect = dash)

        val slot = size.width / candles.size
        val body = max(slot * 0.55f, 2.5f)
        candles.forEachIndexed { i, c ->
            val x = slot * i + slot / 2f
            val color = if (c.close >= c.open) upColor else downColor
            drawLine(color, Offset(x, y(c.high)), Offset(x, y(c.low)), strokeWidth = 2f)
            val top = min(y(c.open), y(c.close))
            val bot = max(y(c.open), y(c.close))
            drawRect(
                color = color,
                topLeft = Offset(x - body / 2f, top),
                size = Size(body, max(bot - top, 2f)),
            )
        }

        val last = candles.last()
        val lastY = y(last.close)
        drawLine(
            (if (last.close >= last.open) upColor else downColor).copy(alpha = 0.7f),
            Offset(0f, lastY),
            Offset(size.width, lastY),
            strokeWidth = 1.5f,
            pathEffect = dash,
        )
        drawCircle(
            color = if (last.close >= last.open) upColor else downColor,
            radius = 4.5f,
            center = Offset(size.width - 3f, lastY),
            style = Stroke(width = 2f),
        )
    }
}

/** $68.9M / $2.5K — market-cap size, not a ledger. */
private fun usd(v: Double): String {
    val a = abs(v)
    return when {
        a >= 1_000_000_000 -> "$" + trimZero(v / 1_000_000_000) + "B"
        a >= 1_000_000 -> "$" + trimZero(v / 1_000_000) + "M"
        a >= 1_000 -> "$" + trimZero(v / 1_000) + "K"
        a >= 1 -> "$" + "%.2f".format(v)
        else -> "$" + "%.2f".format(v)
    }
}

/** $0.0690 or $0.00000214 — token prices span many orders. */
private fun tokenPrice(v: Double): String {
    val a = abs(v)
    return when {
        a >= 1 -> "$" + "%.2f".format(v)
        a >= 0.01 -> "$" + "%.4f".format(v)
        a >= 0.0001 -> "$" + "%.6f".format(v)
        else -> "$" + "%.8f".format(v).trimEnd('0').trimEnd('.')
    }
}

private fun trimZero(x: Double): String =
    if (x % 1.0 == 0.0) x.toInt().toString() else "%.1f".format(x)
