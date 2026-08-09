import SwiftUI
import UIKit

/// Type scale.
///
/// Two voices, on purpose:
///  - **Space Grotesk** for everything that names things — the wordmark,
///    headlines, titles, buttons. This is where the app sounds like itself.
///  - The system sans for body text, where reading speed beats personality.
///
/// One distinctive face used everywhere becomes noise; used only for display it
/// stays a signature. Slightly heavier weights than the platform defaults across
/// the board: on a low-contrast neumorphic sheet, Regular 14pt body text starts
/// to disappear. Medium is the floor below 16pt.
enum YappyFont {
    /// The shipped file is a *variable* font with a single `wght` axis running
    /// 300–700, and its only named instance is Light. Asking UIKit for
    /// `.semibold` would get a synthesised smear, so the weight is set on the
    /// axis itself and the real cut is what renders.
    private static let postScriptName = "SpaceGrotesk-Light"
    /// The 'wght' four-character code as the integer Core Text wants.
    private static let weightAxis = 0x7767_6874

    private static var cache: [String: Font] = [:]

    static func grotesk(_ size: CGFloat, weight: CGFloat) -> Font {
        let key = "\(size)-\(weight)"
        if let cached = cache[key] { return cached }

        let descriptor = UIFontDescriptor(fontAttributes: [
            .name: postScriptName,
            kCTFontVariationAttribute as UIFontDescriptor.AttributeName: [weightAxis: weight],
            // Naming a font explicitly opts *out* of the system's normal font
            // cascade, so every glyph Space Grotesk does not carry — which is
            // every emoji, and every non-Latin script — renders as a tofu box
            // instead of falling back. A group's flair emoji, the emoji picker
            // in group settings and a reaction list all go through here, so the
            // cascade has to be put back by hand.
            .cascadeList: [
                UIFontDescriptor(name: "AppleColorEmoji", size: size),
                UIFont.systemFont(ofSize: size).fontDescriptor,
            ],
        ])
        let font = Font(UIFont(descriptor: descriptor, size: size))
        cache[key] = font
        return font
    }

    /// Body text scales with the reader's Dynamic Type setting; display text is
    /// pinned. A headline that grows to 40pt wraps the header onto three lines
    /// and pushes the thing it labels off screen, whereas body text growing is
    /// exactly what the setting is for.
    static func body(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight)
    }

    // ── Display: Space Grotesk ───────────────────────────────────────────────
    static let displaySmall = grotesk(32, weight: 700)
    static let headlineMedium = grotesk(26, weight: 700)
    /// The home lockup wants to be heavier than a headline without being bigger.
    static let wordmark = grotesk(26, weight: 700)
    static let headlineSmall = grotesk(21, weight: 600)
    static let titleMedium = grotesk(17, weight: 600)
    static let titleMediumBold = grotesk(17, weight: 700)
    static let titleSmall = grotesk(15, weight: 500)
    static let titleSmallBold = grotesk(15, weight: 700)
    static let labelLarge = grotesk(15, weight: 600)

    // ── Reading: the system face ─────────────────────────────────────────────
    static let bodyLarge = body(16)
    static let bodyMedium = body(14)
    static let bodySmall = body(12)
    static let labelMedium = body(13, weight: .medium)
    static let labelSmall = body(11, weight: .medium)
}

extension View {
    /// Letter-spacing that matches the Compose scale. Applied as a modifier
    /// rather than baked into the `Font` because SwiftUI has no equivalent of
    /// `TextStyle.letterSpacing`.
    func displayTracking() -> some View { tracking(-0.5) }
    func headlineTracking() -> some View { tracking(-0.3) }
}
