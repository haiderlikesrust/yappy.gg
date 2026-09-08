import SwiftUI

/// Shared header rhythm: one title and quiet, full-size secondary targets.
struct ScreenHeading: View {
    @Environment(\.neu) private var colors
    let title: String
    var subtitle: String = ""
    var branded = false

    var body: some View {
        VStack(spacing: 2) {
            HStack(spacing: 7) {
                if branded { LogoMarkGradient(height: 17) }
                Text(title).font(branded ? YappyFont.wordmark : YappyFont.titleMedium)
                    .foregroundStyle(branded ? colors.accent : colors.textPrimary)
                    .lineLimit(1)
            }
            if !subtitle.isEmpty {
                Text(subtitle).font(YappyFont.labelSmall).foregroundStyle(colors.textTertiary)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

struct QuietHeaderButton: View {
    @Environment(\.neu) private var colors
    let symbol: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 18, weight: .medium))
                .foregroundStyle(colors.textSecondary).frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel(label)
    }
}

struct ScreenHeader<Actions: View>: View {
    let backLabel: String
    var backSymbol = "chevron.left"
    let onBack: () -> Void
    @ViewBuilder var actions: () -> Actions

    var body: some View {
        HStack(spacing: 8) {
            QuietHeaderButton(symbol: backSymbol, label: backLabel, action: onBack)
            Spacer(minLength: 0)
            actions()
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
    }
}
