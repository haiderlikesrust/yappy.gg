import SwiftUI

enum StatusText {
    static func visible(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }

    /// The API measures UTF-16 units. Keep whole emoji/graphemes when limiting.
    static func limited(_ text: String) -> String {
        var result = text
        while result.utf16.count > 128 { result.removeLast() }
        return result
    }
}

/// The tail has layout space of its own, so it survives scroll-view clipping.
struct StatusBubble: View {
    @Environment(\.neu) private var colors
    let text: String
    var placeholder = false

    var body: some View {
        VStack(alignment: .center, spacing: 0) {
            Text(text)
                .font(YappyFont.labelSmall)
                .foregroundStyle(placeholder ? colors.textTertiary : colors.textPrimary)
                .multilineTextAlignment(.center)
                .lineLimit(3)
                .padding(.horizontal, 10).padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .background(colors.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(colors.textTertiary.opacity(0.18), lineWidth: 1)
                }
                .shadow(color: Color.black.opacity(colors.isDark ? 0.18 : 0.07), radius: 5, y: 2)
            Circle().fill(colors.surface).frame(width: 7, height: 7).offset(x: 13)
            Circle().fill(colors.surface).frame(width: 4, height: 4).offset(x: 9).padding(.top, 2)
        }
        .padding(.horizontal, 3)
        .padding(.top, 5)
    }
}
