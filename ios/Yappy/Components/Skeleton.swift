import SwiftUI

/**
 * Placeholder shapes for content that is still loading.
 *
 * A centred spinner says "the app is busy"; a page of grey blocks in the shape
 * of the content says "here is where your things will be" — the second reads
 * as faster even when the fetch takes exactly as long. These stand in for the
 * *first* load of a screen only. Paging and overlays keep `NeuSpinner`: a
 * skeleton behind content that already exists would be claiming the page is
 * emptier than it is.
 *
 * One pulse for the whole arrangement, not one per block. Blocks breathing out
 * of phase with each other read as flicker; a page inhaling as one reads as
 * waiting.
 */
struct SkeletonPulse: ViewModifier {
    @State private var dimmed = false

    func body(content: Content) -> some View {
        content
            .opacity(dimmed ? 0.45 : 1)
            .animation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), value: dimmed)
            .onAppear { dimmed = true }
            .accessibilityHidden(true)
    }
}

/// One grey stand-in. Sized by the caller, coloured for both themes.
private struct SkeletonBlock: View {
    @Environment(\.neu) private var colors
    var radius: CGFloat = 7

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(colors.textTertiary.opacity(0.16))
    }
}

/// Rows the shape of a list: an avatar, a title, a quieter line under it.
/// Fits the conversation list, the forum, explore, and the member lists.
struct SkeletonRows: View {
    @Environment(\.neu) private var colors
    var count: Int = 8
    var avatarSize: CGFloat = 44

    var body: some View {
        VStack(spacing: 0) {
            ForEach(0 ..< count, id: \.self) { index in
                HStack(spacing: 12) {
                    Circle()
                        .fill(colors.textTertiary.opacity(0.16))
                        .frame(width: avatarSize, height: avatarSize)
                    VStack(alignment: .leading, spacing: 7) {
                        // Ragged edges on purpose: rows all cut to one length
                        // read as a table, and no list in the app is a table.
                        SkeletonBlock().frame(width: rowWidth(index, of: 150), height: 13)
                        SkeletonBlock().frame(width: rowWidth(index + 3, of: 210), height: 10)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
        }
        .modifier(SkeletonPulse())
    }

    /// Deterministic variety — the same skeleton every open, so a screen the
    /// user keeps returning to does not reshuffle its bones.
    private func rowWidth(_ index: Int, of base: CGFloat) -> CGFloat {
        base + CGFloat((index * 37) % 60)
    }
}

/// Bubbles the shape of a conversation — or cards the shape of a page.
///
/// The chat form alternates sides the way a conversation does; the page form
/// keeps everything against the leading edge, because a page only has a start
/// (see `MessageBubble.sidedness`).
struct SkeletonChat: View {
    @Environment(\.neu) private var colors
    var readsAsPage: Bool = false

    var body: some View {
        VStack(spacing: 12) {
            Spacer(minLength: 0)
            ForEach(0 ..< (readsAsPage ? 4 : 7), id: \.self) { index in
                let mine = !readsAsPage && index % 3 == 2
                HStack {
                    if mine { Spacer(minLength: 60) }
                    SkeletonBlock(radius: 16)
                        .frame(
                            maxWidth: readsAsPage ? .infinity : bubbleWidth(index),
                            alignment: .leading
                        )
                        .frame(height: readsAsPage ? 84 : bubbleHeight(index))
                    if !mine && !readsAsPage { Spacer(minLength: 60) }
                }
            }
            // A page starts at the top and a conversation ends at the bottom,
            // so the spacer above pins the chat form down; the page form gets
            // a second spacer's worth of room underneath instead.
            if readsAsPage { Spacer(minLength: 0) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 16)
        .modifier(SkeletonPulse())
    }

    private func bubbleWidth(_ index: Int) -> CGFloat {
        140 + CGFloat((index * 53) % 110)
    }

    private func bubbleHeight(_ index: Int) -> CGFloat {
        index % 3 == 1 ? 64 : 40
    }
}
