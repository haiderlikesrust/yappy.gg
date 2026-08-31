import SwiftUI

/// The neumorphic surface treatments.
///
/// Three states, and the whole visual language is built from them:
///
///   raised  — light shadow top-left, dark shadow bottom-right, drawn *outside*
///             the shape. Reads as extruded. Used for cards, buttons at rest.
///   pressed — the same two shadows drawn *inside*. Reads as debossed. Used for
///             inputs, toggles that are on, and buttons while held.
///   flat    — no shadows. Used inside an already-recessed container, where a
///             second level of extrusion just looks noisy.
///
/// Compose has no inner-shadow primitive and has to punch one out by hand.
/// SwiftUI does: `ShapeStyle.shadow(.inner(…))` composes into the fill, so the
/// pressed state here is the same idea expressed in one line instead of a
/// saved layer and a DST_OUT pass.
enum NeuState {
    case raised
    case pressed
    case flat
}

enum Neu {
    static let cornerSmall: CGFloat = 12
    static let cornerMedium: CGFloat = 20
    static let cornerLarge: CGFloat = 28
    /// Anything at or above this radius is clamped to a capsule by the shape.
    static let cornerPill: CGFloat = 999
}

/// The shape language: **squircles are places, circles are people.** A group
/// avatar is a room icon; a person's avatar is a face. Rendering them with
/// different silhouettes makes the distinction legible at a glance anywhere in
/// the app, without a label.
///
/// The corner is a share of the smaller side rather than a fixed radius, so the
/// silhouette is the same object at 14pt in a badge and at 96pt on a profile.
struct PlaceShape: Shape {
    func path(in rect: CGRect) -> Path {
        let radius = min(rect.width, rect.height) * 0.32
        return Path(roundedRect: rect, cornerRadius: radius, style: .continuous)
    }
}

/// A rounded rectangle that degrades to a capsule, so `Neu.cornerPill` can be
/// passed anywhere a radius is expected without the caller switching shapes.
struct NeuShape: Shape {
    var radius: CGFloat = Neu.cornerMedium

    func path(in rect: CGRect) -> Path {
        let limit = min(rect.width, rect.height) / 2
        return Path(
            roundedRect: rect,
            cornerRadius: min(radius, limit),
            style: .continuous
        )
    }
}

/// Corner radii that differ per corner — the message bubble's tail, and the
/// picker drawer that is rounded only along its top edge.
struct NeuCorners: Shape {
    var topLeading: CGFloat = 0
    var topTrailing: CGFloat = 0
    var bottomLeading: CGFloat = 0
    var bottomTrailing: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        UnevenRoundedRectangle(
            topLeadingRadius: topLeading,
            bottomLeadingRadius: bottomLeading,
            bottomTrailingRadius: bottomTrailing,
            topTrailingRadius: topTrailing,
            style: .continuous
        )
        .path(in: rect)
    }
}

extension View {
    /// - Parameters:
    ///   - elevation: Both the blur radius and the offset. Keeping them locked
    ///     together is what keeps every element on the sheet lit by the same
    ///     imaginary lamp; letting callers set them independently is how
    ///     neumorphic UIs start looking incoherent.
    ///   - intensity: Softens both shadows. The default is deliberately well
    ///     below 1: at full strength every element competes for attention and a
    ///     busy screen reads as a wall of pillows. Shadows should be a whisper.
    ///
    ///     Lower in the dark theme, because the same RGB step is a far larger
    ///     *relative* change against a dark surface: the highlight is +37%
    ///     luminance on #232030 but only +8.5% on #EBE9F4. At one shared value
    ///     the dark theme grows visible halos, and where several controls sit in
    ///     a row — the composer — those halos merge into a slab that looks like
    ///     a container nobody drew.
    func neu<S: Shape>(
        _ shape: S,
        _ colors: NeuColors,
        state: NeuState = .raised,
        elevation: CGFloat = 6,
        fill: Color? = nil,
        gradient: LinearGradient? = nil,
        intensity: Double? = nil,
        glow: Color? = nil
    ) -> some View {
        background(
            NeuTreatment(
                shape: shape,
                colors: colors,
                state: state,
                elevation: elevation,
                fill: fill,
                gradient: gradient,
                intensity: intensity ?? (colors.isDark ? 0.42 : 0.55),
                glow: glow
            )
        )
    }

    /// Convenience for the common case of a soft, slightly-recessed divider:
    /// a dark hairline with a light one directly under it, so the line reads as
    /// etched into the sheet rather than drawn on top of it.
    func neuDivider(_ colors: NeuColors, thickness: CGFloat = 1) -> some View {
        overlay(alignment: .bottom) {
            VStack(spacing: 0) {
                Rectangle().fill(colors.dark.opacity(0.35)).frame(height: thickness)
                Rectangle().fill(colors.light.opacity(0.7)).frame(height: thickness)
            }
        }
    }

    /// Glass chrome, for a pane that genuinely floats over scrolling content.
    ///
    /// `ultraThinMaterial` alone is iOS's glass, not this sheet's: raw, it
    /// relays whatever passes beneath at full strength and the pane stops
    /// belonging to the surface it sits on. A near-opaque wash of the surface
    /// colour over the material keeps the pane in the sheet's own light —
    /// mostly sheet, a whisper of the conversation moving under it — and the
    /// etched hairline closes its bottom edge the way the divider closes every
    /// other fixture. A touch more opaque in the dark theme, where the
    /// material runs milky against the violet surfaces.
    ///
    /// One honesty rule rides along: glass only where content actually
    /// scrolls beneath. A bar the layout keeps clear of the timeline — a
    /// sibling in the screen's stack — would be tinting nothing, and material
    /// over nothing is just a greyer background.
    func neuGlass(_ colors: NeuColors, radius: CGFloat = 0) -> some View {
        background {
            ZStack {
                Rectangle().fill(.ultraThinMaterial)
                colors.surface.opacity(colors.isDark ? 0.82 : 0.78)
            }
            .neuDivider(colors)
            // Clipped as one, so the hairline's ends follow the rounded
            // silhouette instead of squaring it off.
            .clipShape(NeuShape(radius: radius))
        }
    }
}

private struct NeuTreatment<S: Shape>: View {
    let shape: S
    let colors: NeuColors
    let state: NeuState
    let elevation: CGFloat
    let fill: Color?
    let gradient: LinearGradient?
    let intensity: Double
    /// The colour this element casts as light, when it is more than furniture.
    /// See the raised branch: an accented control trades its dark shadow for
    /// its own colour, so the important thing on a screen glows instead of
    /// merely sitting higher.
    let glow: Color?

    var body: some View {
        // Per-state fill, so the dark theme can separate a control from the
        // sheet tonally instead of asking the shadows to do it alone. In the
        // light theme all three are the same colour and this is a no-op.
        let surface = fill ?? {
            switch state {
            case .raised: return colors.surfaceRaised
            case .pressed: return colors.surfaceRecessed
            case .flat: return colors.surface
            }
        }()

        // Offset trails the blur: a wide, faint, close shadow reads as ambient
        // light; a tight, offset one reads as an object held above the page.
        //
        // The blur factor is 1.2 rather than Compose's 2.1 because the two
        // platforms mean different things by "radius". Android's BlurMaskFilter
        // takes a radius it converts to roughly 0.577σ; SwiftUI's `radius` *is*
        // σ. 2.1 × 0.577 ≈ 1.2, so the same elevation produces the same shadow.
        let offset = elevation * 0.8
        let blur = max(elevation * 1.2, 0.1)

        switch state {
        case .raised:
            /*
             * The dark shadow is where an accented element's own light goes.
             * Furniture casts the sheet's grey; a control carrying a fill (or
             * an explicit glow) casts *itself*, slightly stronger than the
             * grey it replaces because coloured light at equal opacity reads
             * quieter than a neutral shadow. This is the one visual privilege
             * an accent gets — the elevation grammar is untouched.
             */
            let cast = glow ?? fill
            filled(surface, convex: true)
                .shadow(
                    color: (cast ?? colors.dark).opacity(cast == nil ? intensity : (colors.isDark ? 0.30 : 0.38)),
                    radius: blur, x: offset, y: offset
                )
                .shadow(color: colors.light.opacity(intensity), radius: blur, x: -offset, y: -offset)

        case .pressed:
            // Dark inside the top-left, light inside the bottom-right: the exact
            // inverse of raised, which is what sells the "pushed in" reading.
            shape.fill(
                surface
                    .shadow(.inner(color: colors.dark.opacity(intensity), radius: blur, x: offset, y: offset))
                    .shadow(.inner(color: colors.light.opacity(intensity), radius: blur, x: -offset, y: -offset))
            )

        case .flat:
            filled(surface, convex: false)
        }
    }

    /// A gradient fill wins over the solid one — that is how a group's flair
    /// reaches its own send button and outgoing bubbles.
    ///
    /// A raised element with no gradient of its own still gets a whisper of
    /// one: the same base colour tipped toward the lamp at the top-left and
    /// away at the bottom-right. That is what makes "raised" read as a curved
    /// surface catching light rather than a flat rectangle with shadows around
    /// it — and it stays inside the single-surface rule, because both stops
    /// are the surface. Pressed and flat stay solid, which sharpens the
    /// convex/concave distinction the three states exist to draw.
    @ViewBuilder
    private func filled(_ surface: Color, convex: Bool) -> some View {
        if let gradient {
            shape.fill(gradient)
        } else if convex {
            shape.fill(LinearGradient(
                colors: [
                    surface.mix(with: colors.light, by: colors.isDark ? 0.07 : 0.05),
                    surface.mix(with: colors.dark, by: colors.isDark ? 0.06 : 0.04),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ))
        } else {
            shape.fill(surface)
        }
    }
}

// ── Backdrop ─────────────────────────────────────────────────────────────────

/**
 * The sheet, lit from within.
 *
 * A flat `colors.surface` background is technically the brand colour and
 * emotionally printer paper. This is the same sheet with two enormous, very
 * soft glows under it — the accent past the top-leading corner, the brand's
 * teal past the bottom-trailing — so every screen sits in an atmosphere the
 * app owns rather than on a dead flat. The glows are anchored *past* the
 * corners and radii are huge on purpose: this must read as light under the
 * material, never as a gradient printed on it.
 *
 * One rule rides along: the backdrop is the only ambient colour a screen gets.
 * Elements on top of it still follow the elevation grammar.
 */
struct NeuBackdrop: View {
    let colors: NeuColors

    var body: some View {
        ZStack {
            colors.surface

            RadialGradient(
                colors: [colors.accent.opacity(colors.isDark ? 0.10 : 0.08), .clear],
                center: .init(x: -0.15, y: -0.10),
                startRadius: 0,
                endRadius: 520
            )

            RadialGradient(
                colors: [Color(hex: 0x00CEC9).opacity(colors.isDark ? 0.05 : 0.06), .clear],
                center: .init(x: 1.1, y: 1.05),
                startRadius: 0,
                endRadius: 480
            )
        }
        .ignoresSafeArea()
    }
}

extension View {
    /// The standard screen floor. Use wherever a screen currently sets
    /// `colors.surface` as its background.
    func neuBackdrop(_ colors: NeuColors) -> some View {
        background(NeuBackdrop(colors: colors))
    }
}

// ── Environment ──────────────────────────────────────────────────────────────

private struct NeuColorsKey: EnvironmentKey {
    static let defaultValue = NeuColors.light
}

extension EnvironmentValues {
    var neu: NeuColors {
        get { self[NeuColorsKey.self] }
        set { self[NeuColorsKey.self] = newValue }
    }
}

enum ThemePreference: String, CaseIterable {
    case system
    case light
    case dark

    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}
