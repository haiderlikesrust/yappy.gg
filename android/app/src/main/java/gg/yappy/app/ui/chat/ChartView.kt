package gg.yappy.app.ui.chat

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.background
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.yappy.app.data.EmbedChart
import gg.yappy.app.ui.theme.neuColors
import kotlin.math.abs

/**
 * Inline charts for embeds — the whole family, drawn by hand.
 *
 * No chart library: a message-sized chart needs exactly one series, no pan,
 * no zoom, no tooltips, and a look that matches the app rather than a
 * spreadsheet. Axis chrome is kept to a whisper (min/max, first/last label)
 * because in a chat bubble the *shape* is the message; anyone who wants the
 * numbers has them in the text beside it.
 */

private val SERIES = listOf(
    Color(0xFF8B7CFF), // violet
    Color(0xFF00CEC9), // teal
    Color(0xFFFF9F43), // orange
    Color(0xFFFF6B81), // pink
    Color(0xFFFCCE09), // yellow
    Color(0xFF6BCB77), // green
    Color(0xFF4FC3F7), // sky
    Color(0xFFB39DDB), // lavender
)

@Composable
fun ChartView(chart: EmbedChart, modifier: Modifier = Modifier) {
    val colors = neuColors
    val points = chart.points.filter { it.value.isFinite() }
    if (points.size < 2) return

    when (chart.kind) {
        "pie", "donut" -> PieChart(chart, donut = chart.kind == "donut", modifier)
        else -> {
            Column(modifier.fillMaxWidth()) {
                val min = points.minOf { it.value }
                val max = points.maxOf { it.value }
                Row(Modifier.fillMaxWidth()) {
                    Text(
                        compactNumber(max),
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                    )
                }
                Canvas(
                    Modifier
                        .fillMaxWidth()
                        .height(120.dp)
                        .padding(vertical = 4.dp),
                ) {
                    val w = size.width
                    val h = size.height
                    // Bars measure from zero — a bar's whole language is "how
                    // much", and scaling from the series minimum turns the
                    // smallest value into nothing. Lines show shape, so they
                    // stretch over the data's own range.
                    val floor = if (chart.kind == "bar") minOf(min, 0.0) else min
                    val span = (max - floor).takeIf { it != 0.0 } ?: 1.0
                    // A flat series still draws mid-height instead of on the floor.
                    fun yFor(v: Double): Float = (h * (1f - ((v - floor) / span).toFloat() * 0.92f - 0.04f))

                    // Whisper gridlines: top and bottom of the data range.
                    val grid = PathEffect.dashPathEffect(floatArrayOf(6f, 8f))
                    for (frac in listOf(0.04f, 0.96f)) {
                        drawLine(
                            colors.textTertiary.copy(alpha = 0.25f),
                            Offset(0f, h * frac),
                            Offset(w, h * frac),
                            strokeWidth = 1f,
                            pathEffect = grid,
                        )
                    }

                    when (chart.kind) {
                        "bar" -> {
                            val slot = w / points.size
                            val bar = slot * 0.62f
                            val zero = yFor(maxOf(min, 0.0).coerceAtMost(max))
                            points.forEachIndexed { i, p ->
                                val top = yFor(p.value)
                                val left = slot * i + (slot - bar) / 2f
                                val (y0, y1) = if (top <= zero) top to zero else zero to top
                                drawRoundRect(
                                    color = SERIES[i % SERIES.size],
                                    topLeft = Offset(left, y0),
                                    size = Size(bar, maxOf(y1 - y0, 3f)),
                                    cornerRadius = androidx.compose.ui.geometry.CornerRadius(bar * 0.25f),
                                )
                            }
                        }

                        "scatter" -> {
                            points.forEachIndexed { i, p ->
                                val x = w * (if (points.size == 1) 0.5f else i / (points.size - 1f))
                                drawCircle(
                                    color = SERIES[0].copy(alpha = 0.9f),
                                    radius = 7f,
                                    center = Offset(x, yFor(p.value)),
                                )
                            }
                        }

                        else -> { // line and area share the path
                            val path = Path()
                            points.forEachIndexed { i, p ->
                                val x = w * (i / (points.size - 1f))
                                val y = yFor(p.value)
                                if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
                            }
                            if (chart.kind == "area") {
                                val fill = Path().apply {
                                    addPath(path)
                                    lineTo(w, h)
                                    lineTo(0f, h)
                                    close()
                                }
                                drawPath(
                                    fill,
                                    Brush.verticalGradient(
                                        listOf(SERIES[0].copy(alpha = 0.35f), SERIES[0].copy(alpha = 0.02f)),
                                    ),
                                )
                            }
                            drawPath(path, SERIES[0], style = Stroke(width = 5f))
                            // The "you are here" dot on the last point.
                            val lastY = yFor(points.last().value)
                            drawCircle(SERIES[0], radius = 9f, center = Offset(w, lastY))
                            drawCircle(colors.surface, radius = 4f, center = Offset(w, lastY))
                        }
                    }
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        points.first().label.ifBlank { compactNumber(min) },
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                        maxLines = 1,
                    )
                    Spacer(Modifier.weight(1f))
                    Text(
                        points.last().label.ifBlank { compactNumber(points.last().value) },
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
private fun PieChart(chart: EmbedChart, donut: Boolean, modifier: Modifier = Modifier) {
    val colors = neuColors
    val points = chart.points.filter { it.value.isFinite() && it.value > 0 }.take(8)
    if (points.size < 2) return
    val total = points.sumOf { it.value }.takeIf { it > 0 } ?: return

    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Canvas(Modifier.size(110.dp).padding(4.dp)) {
            var start = -90f
            val stroke = size.minDimension * 0.16f
            points.forEachIndexed { i, p ->
                val sweep = (p.value / total * 360.0).toFloat()
                drawArc(
                    color = SERIES[i % SERIES.size],
                    startAngle = start,
                    // A hair of separation, so slices read as slices.
                    sweepAngle = maxOf(sweep - 2f, 1f),
                    useCenter = !donut,
                    style = if (donut) Stroke(width = stroke) else androidx.compose.ui.graphics.drawscope.Fill,
                )
                start += sweep
            }
        }
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            points.forEachIndexed { i, p ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    androidx.compose.foundation.layout.Box(
                        Modifier.size(8.dp).background(SERIES[i % SERIES.size], CircleShape),
                    )
                    Spacer(Modifier.width(7.dp))
                    Text(
                        p.label.ifBlank { "#${i + 1}" },
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        "${(p.value / total * 100).toInt()}%",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                    )
                }
                Spacer(Modifier.height(3.dp))
            }
        }
    }
}

/** 118000 -> 118k; keeps axis labels the size of a word. */
private fun compactNumber(v: Double): String {
    val a = abs(v)
    return when {
        a >= 1_000_000 -> trimZero(v / 1_000_000) + "m"
        a >= 1_000 -> trimZero(v / 1_000) + "k"
        v % 1.0 == 0.0 -> v.toInt().toString()
        else -> "%.1f".format(v)
    }
}

private fun trimZero(x: Double): String =
    if (x % 1.0 == 0.0) x.toInt().toString() else "%.1f".format(x)
