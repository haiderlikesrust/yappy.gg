import SwiftUI

/// Neumorphism has one hard requirement: the surface, the light shadow and the
/// dark shadow must all derive from the *same* base colour. The illusion is that
/// every element is extruded from a single sheet of material, and it collapses
/// the moment a card sits on a different background than its shadows assume.
///
/// So there is exactly one surface colour per theme. Elevation is expressed with
/// shadows, never with a lighter or darker fill — which is why this palette has
/// none of the tonal-elevation ladder a system palette would give us for free.
struct NeuColors {
    let surface: Color
    /// Highlight, cast from the top-left.
    let light: Color
    /// Shadow, cast to the bottom-right.
    let dark: Color
    let textPrimary: Color
    let textSecondary: Color
    let textTertiary: Color
    let accent: Color
    let accentSoft: Color
    let onAccent: Color
    let success: Color
    let danger: Color
    let warning: Color
    /// Bubble for messages you sent.
    let outgoing: Color
    let onOutgoing: Color
    /// Flat fill for received bubbles and other *content* tints. Content is the
    /// one deliberate exception to the single-surface rule: dozens of bubbles
    /// each casting two shadows is visual noise, so bubbles are flat and only
    /// the chrome (composer, buttons, cards) keeps the neumorphic treatment.
    let incoming: Color

    /// Fills for extruded and recessed chrome.
    ///
    /// In the light theme both are the surface itself, and the shadows do all
    /// the work — that is the single-surface rule above, and it holds there
    /// because a shadow on a near-white sheet is a large *visible* change while
    /// being a small relative one.
    ///
    /// The dark theme cannot honour it. Against #232030 the same shadows are a
    /// ±40% relative luminance swing, so at a strength that makes an input
    /// legible the raised controls grow halos, and at a strength that kills the
    /// halos an input becomes an invisible rectangle. No single intensity
    /// satisfies both. So in the dark theme these carry a small tonal offset
    /// and the shadows only sculpt what the fill has already separated.
    let surfaceRaised: Color
    let surfaceRecessed: Color

    /// A barely-there fill for flat *content* chrome: bot buttons, the pinned
    /// bar, chips inside a card.
    ///
    /// Tinted from the text side rather than the shadow side, which is the
    /// whole point. Call sites reached for `dark.opacity(0.1)` because on the
    /// light theme that reads as a faint grey wash — but `dark` is the
    /// neumorphic shadow, and on the dark theme's near-black surface a wash of
    /// it is invisible. A secondary bot button rendered as a floating label
    /// with no button around it. This token is the one that works on both,
    /// because each theme picks its own direction.
    let veil: Color

    let isDark: Bool
}

extension NeuColors {
    /// Light theme.
    ///
    /// The surface is a desaturated *lavender*-grey rather than a neutral or
    /// pure white: neumorphism needs headroom on both sides of the base colour,
    /// and the violet cast is the brand — the accent gradient reads as native to
    /// the sheet instead of printed on it.
    static let light = NeuColors(
        surface: Color(hex: 0xEBE9F4),
        light: Color(hex: 0xFFFFFF),
        dark: Color(hex: 0xACA5C8),
        textPrimary: Color(hex: 0x2B2739),
        textSecondary: Color(hex: 0x5D5876),
        textTertiary: Color(hex: 0x8F8AA8),
        accent: Color(hex: 0x6C5CE7),
        accentSoft: Color(hex: 0xE1DCFB),
        onAccent: Color(hex: 0xFFFFFF),
        success: Color(hex: 0x17B978),
        danger: Color(hex: 0xE5484D),
        warning: Color(hex: 0xF5A524),
        outgoing: Color(hex: 0x6C5CE7),
        onOutgoing: Color(hex: 0xFFFFFF),
        incoming: Color(hex: 0xF8F7FD),
        // Identical to the surface: the light theme keeps the single-surface rule.
        surfaceRaised: Color(hex: 0xEBE9F4),
        surfaceRecessed: Color(hex: 0xEBE9F4),
        // Ink-tinted, matching Android's light `veil`.
        veil: Color(hex: 0xACA5C8, alpha: 0.09),
        isDark: false
    )

    /// Dark theme: violet-charcoal, not anonymous near-black-blue.
    ///
    /// The classic mistake is a near-black surface: with nothing above it, the
    /// highlight cannot read and every element looks merely embossed on one
    /// side. #232030 keeps that headroom while carrying the brand's violet
    /// undertone — this is the single biggest "whose app is this" signal in the
    /// dark theme.
    static let dark = NeuColors(
        surface: Color(hex: 0x232030),
        light: Color(hex: 0x302C40),
        dark: Color(hex: 0x14121D),
        textPrimary: Color(hex: 0xEFEDF6),
        textSecondary: Color(hex: 0xACA7C2),
        textTertiary: Color(hex: 0x746E8E),
        accent: Color(hex: 0x8B7CFF),
        accentSoft: Color(hex: 0x35304F),
        onAccent: Color(hex: 0x14121F),
        success: Color(hex: 0x3DD68C),
        danger: Color(hex: 0xFF6369),
        warning: Color(hex: 0xFFB224),
        outgoing: Color(hex: 0x6C5CE7),
        onOutgoing: Color(hex: 0xFFFFFF),
        incoming: Color(hex: 0x2D2940),
        // Small steps on purpose. Enough that a field has an edge without
        // looking at it directly; not so much that the sheet turns into stacked
        // panels.
        surfaceRaised: Color(hex: 0x2A2638),
        surfaceRecessed: Color(hex: 0x1B1926),
        // White-tinted, matching Android's dark `veil`. This is the direction
        // flip that makes the token work on both themes.
        veil: Color(hex: 0xFFFFFF, alpha: 0.08),
        isDark: true
    )
}

// ── Colour helpers ───────────────────────────────────────────────────────────

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }

    /// Parses the `#RRGGBB` / `#AARRGGBB` strings the API sends for role
    /// colours, group flair and embed accents.
    ///
    /// Returns nil rather than a fallback so call sites can decide what a
    /// missing colour means — a role with no colour inherits the text colour,
    /// while an embed with no colour takes the app accent, and those are
    /// different answers.
    init?(hexString: String?) {
        guard var raw = hexString?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        if raw.hasPrefix("#") { raw.removeFirst() }
        guard let value = UInt32(raw, radix: 16) else { return nil }

        switch raw.count {
        case 6:
            self.init(hex: value)
        case 8:
            // Android's #AARRGGBB order, which is what the backend mirrors.
            self.init(hex: value & 0x00FF_FFFF, alpha: Double((value >> 24) & 0xFF) / 255)
        default:
            return nil
        }
    }
}
