import SwiftUI

/// The yappy mark.
///
/// Stored as a white silhouette with an alpha channel — no colour of its own —
/// so a single asset serves the light theme, the dark theme, the gradient lockup
/// and the launcher icon. Tinting one file beats shipping four that can drift
/// apart.
///
/// Sized by height rather than a square box: the mark is noticeably wider than
/// it is tall, and forcing it square would either letterbox it or crop the
/// tongue.
struct LogoMark: View {
    @Environment(\.neu) private var colors
    var height: CGFloat = 24
    var tint: Color?

    var body: some View {
        Image("LogoMark")
            .renderingMode(.template)
            .resizable()
            .scaledToFit()
            .frame(height: height)
            .foregroundStyle(tint ?? colors.textPrimary)
            .accessibilityLabel("yappy")
    }
}

/// The mark painted with the brand gradient, for the two places that are about
/// the product itself: the sign-in screen and the home header.
struct LogoMarkGradient: View {
    @Environment(\.neu) private var colors
    var height: CGFloat = 24

    var body: some View {
        LogoMark(height: height, tint: .white)
            .gradientFill(brandGradient(colors))
    }
}
