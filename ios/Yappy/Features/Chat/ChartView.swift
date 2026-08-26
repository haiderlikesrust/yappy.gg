import SwiftUI

/// Inline charts for embeds — the whole family, drawn by hand.
///
/// No chart library: a message-sized chart needs exactly one series, no pan,
/// no zoom, no tooltips, and a look that matches the app rather than a
/// spreadsheet. Axis chrome is kept to a whisper (min/max, first/last label)
/// because in a chat bubble the *shape* is the message; anyone who wants the
/// numbers has them in the text beside it.
///
/// Kept in step with android/.../ui/chat/ChartView.kt, which draws the same set.

private let seriesColors: [Color] = [
    Color(hex: 0x8B7CFF), // violet
    Color(hex: 0x00CEC9), // teal
    Color(hex: 0xFF9F43), // orange
    Color(hex: 0xFF6B81), // pink
    Color(hex: 0xFCCE09), // yellow
    Color(hex: 0x6BCB77), // green
    Color(hex: 0x4FC3F7), // sky
    Color(hex: 0xB39DDB), // lavender
]

struct ChartView: View {
    @Environment(\.neu) private var colors

    let chart: EmbedChart

    var body: some View {
        let points = chart.points.filter { $0.value.isFinite }
        if points.count >= 2 {
            if chart.kind == "pie" || chart.kind == "donut" {
                PieChartView(chart: chart, donut: chart.kind == "donut")
            } else {
                linear(points)
            }
        }
    }

    private func linear(_ points: [EmbedChartPoint]) -> some View {
        let minValue = points.map(\.value).min() ?? 0
        let maxValue = points.map(\.value).max() ?? 0

        return VStack(alignment: .leading, spacing: 0) {
            Text(compactNumber(maxValue))
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)

            Canvas { context, size in
                draw(points, minValue: minValue, maxValue: maxValue, in: &context, size: size)
            }
            .frame(height: 120)
            .padding(.vertical, 4)

            HStack(spacing: 0) {
                Text(firstLabel(points, minValue: minValue))
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(lastLabel(points))
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func firstLabel(_ points: [EmbedChartPoint], minValue: Double) -> String {
        let label = points[0].label
        return label.isEmpty ? compactNumber(minValue) : label
    }

    private func lastLabel(_ points: [EmbedChartPoint]) -> String {
        let last = points[points.count - 1]
        return last.label.isEmpty ? compactNumber(last.value) : last.label
    }

    private func draw(
        _ points: [EmbedChartPoint],
        minValue: Double,
        maxValue: Double,
        in context: inout GraphicsContext,
        size: CGSize
    ) {
        let w = size.width
        let h = size.height

        // Bars measure from zero — a bar's whole language is "how much", and
        // scaling from the series minimum turns the smallest value into
        // nothing. Lines show shape, so they stretch over the data's own range.
        let floorValue = chart.kind == "bar" ? Swift.min(minValue, 0) : minValue
        let rawSpan = maxValue - floorValue
        let span = rawSpan == 0 ? 1 : rawSpan
        // A flat series still draws mid-height instead of on the floor.
        func yFor(_ v: Double) -> CGFloat {
            h * (1 - CGFloat((v - floorValue) / span) * 0.92 - 0.04)
        }

        // Whisper gridlines: top and bottom of the data range.
        for frac in [0.04, 0.96] as [CGFloat] {
            var line = Path()
            line.move(to: CGPoint(x: 0, y: h * frac))
            line.addLine(to: CGPoint(x: w, y: h * frac))
            context.stroke(
                line,
                with: .color(colors.textTertiary.opacity(0.25)),
                style: StrokeStyle(lineWidth: 1, dash: [3, 4])
            )
        }

        switch chart.kind {
        case "bar":
            let slot = w / CGFloat(points.count)
            let bar = slot * 0.62
            let zero = yFor(Swift.min(Swift.max(minValue, 0), maxValue))
            for (i, p) in points.enumerated() {
                let top = yFor(p.value)
                let left = slot * CGFloat(i) + (slot - bar) / 2
                let (y0, y1) = top <= zero ? (top, zero) : (zero, top)
                let rect = CGRect(x: left, y: y0, width: bar, height: Swift.max(y1 - y0, 2))
                context.fill(
                    Path(roundedRect: rect, cornerRadius: bar * 0.25, style: .continuous),
                    with: .color(seriesColors[i % seriesColors.count])
                )
            }

        case "scatter":
            for (i, p) in points.enumerated() {
                let x = points.count == 1
                    ? w * 0.5
                    : w * CGFloat(i) / CGFloat(points.count - 1)
                let y = yFor(p.value)
                context.fill(
                    Path(ellipseIn: CGRect(x: x - 3, y: y - 3, width: 6, height: 6)),
                    with: .color(seriesColors[0].opacity(0.9))
                )
            }

        default: // line and area share the path
            var path = Path()
            for (i, p) in points.enumerated() {
                let point = CGPoint(
                    x: w * CGFloat(i) / CGFloat(points.count - 1),
                    y: yFor(p.value)
                )
                if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
            }

            if chart.kind == "area" {
                var fill = path
                fill.addLine(to: CGPoint(x: w, y: h))
                fill.addLine(to: CGPoint(x: 0, y: h))
                fill.closeSubpath()
                context.fill(
                    fill,
                    with: .linearGradient(
                        Gradient(colors: [seriesColors[0].opacity(0.35), seriesColors[0].opacity(0.02)]),
                        startPoint: .zero,
                        endPoint: CGPoint(x: 0, y: h)
                    )
                )
            }

            context.stroke(
                path,
                with: .color(seriesColors[0]),
                style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
            )

            // The "you are here" dot on the last point.
            let lastY = yFor(points[points.count - 1].value)
            context.fill(
                Path(ellipseIn: CGRect(x: w - 3.5, y: lastY - 3.5, width: 7, height: 7)),
                with: .color(seriesColors[0])
            )
            context.fill(
                Path(ellipseIn: CGRect(x: w - 1.5, y: lastY - 1.5, width: 3, height: 3)),
                with: .color(colors.surface)
            )
        }
    }
}

/// Pie and donut: arcs on the left, a legend on the right, because at this
/// size labels *on* the slices would be unreadable.
private struct PieChartView: View {
    @Environment(\.neu) private var colors

    let chart: EmbedChart
    let donut: Bool

    var body: some View {
        let points = Array(chart.points.filter { $0.value.isFinite && $0.value > 0 }.prefix(8))
        let total = points.reduce(0.0) { $0 + $1.value }

        if points.count >= 2, total > 0 {
            HStack(spacing: 14) {
                Canvas { context, size in
                    let radius = min(size.width, size.height) / 2
                    let center = CGPoint(x: size.width / 2, y: size.height / 2)
                    let strokeWidth = min(size.width, size.height) * 0.16
                    var start: Double = -90

                    for (i, p) in points.enumerated() {
                        let sweep = p.value / total * 360
                        // A hair of separation, so slices read as slices.
                        let drawn = Swift.max(sweep - 2, 1)
                        let color = seriesColors[i % seriesColors.count]

                        // In the flipped coordinate space `clockwise: false`
                        // sweeps clockwise on screen, matching a positive
                        // Android sweepAngle.
                        if donut {
                            var arc = Path()
                            arc.addArc(
                                center: center,
                                radius: radius - strokeWidth / 2,
                                startAngle: .degrees(start),
                                endAngle: .degrees(start + drawn),
                                clockwise: false
                            )
                            context.stroke(arc, with: .color(color), style: StrokeStyle(lineWidth: strokeWidth))
                        } else {
                            var wedge = Path()
                            wedge.move(to: center)
                            wedge.addArc(
                                center: center,
                                radius: radius,
                                startAngle: .degrees(start),
                                endAngle: .degrees(start + drawn),
                                clockwise: false
                            )
                            wedge.closeSubpath()
                            context.fill(wedge, with: .color(color))
                        }
                        start += sweep
                    }
                }
                .frame(width: 102, height: 102)
                .padding(4)

                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(points.enumerated()), id: \.offset) { i, p in
                        HStack(spacing: 0) {
                            Circle()
                                .fill(seriesColors[i % seriesColors.count])
                                .frame(width: 8, height: 8)
                            Text(p.label.isEmpty ? "#\(i + 1)" : p.label)
                                .font(YappyFont.labelSmall)
                                .foregroundStyle(colors.textSecondary)
                                .lineLimit(1)
                                .padding(.leading, 7)
                            Spacer(minLength: 6)
                            Text("\(Int(p.value / total * 100))%")
                                .font(YappyFont.labelSmall)
                                .foregroundStyle(colors.textTertiary)
                        }
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .frame(maxWidth: .infinity)
        }
    }
}

/// 118000 -> 118k; keeps axis labels the size of a word.
private func compactNumber(_ v: Double) -> String {
    let a = abs(v)
    if a >= 1_000_000 { return trimZero(v / 1_000_000) + "m" }
    if a >= 1_000 { return trimZero(v / 1_000) + "k" }
    if v.truncatingRemainder(dividingBy: 1) == 0 { return String(Int(v)) }
    return String(format: "%.1f", v)
}

private func trimZero(_ x: Double) -> String {
    x.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(x)) : String(format: "%.1f", x)
}
