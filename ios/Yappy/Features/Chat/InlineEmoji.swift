import SwiftUI

/**
 * Custom emoji drawn inside a line of prose.
 *
 * SwiftUI's `AttributedString` has no way to carry an image, but `Text` does:
 * `Text(a) + Text(Image(uiImage:)) + Text(b)` wraps across lines exactly like
 * one string would. So the styled body is built as an `AttributedString` the
 * way it always was, then *sliced* at the emoji spans and stitched back
 * together with pictures in the gaps — every other span keeps its styling
 * because the slices come from the finished thing.
 *
 * Image interpolation needs a `UIImage` in hand, synchronously. That is the
 * whole reason for the loader below: while a picture is still arriving, the
 * slice is left as it is and the reader sees `:party_parrot:` — the same
 * fallback an unresolvable id gets, and the reason the shortcode is kept in
 * the message body at all.
 */
@MainActor
final class InlineEmojiCache: ObservableObject {
    static let shared = InlineEmojiCache()

    /// Bumped when a picture finishes arriving, which is what redraws the
    /// bubbles waiting on it. One counter for all of them: an emoji is used a
    /// dozen times on a screen, and per-url observers would be a dozen
    /// subscriptions to say the same thing.
    @Published private(set) var generation = 0

    private var pending: Set<String> = []

    func image(for url: String) -> UIImage? {
        if let hit = ImageLoader.shared.cached(url) { return hit }
        guard !pending.contains(url) else { return nil }
        pending.insert(url)
        Task { [weak self] in
            let loaded = await ImageLoader.shared.load(url)
            guard let self else { return }
            self.pending.remove(url)
            if loaded != nil { self.generation &+= 1 }
        }
        return nil
    }
}

enum InlineEmoji {
    /// One `:shortcode:` span and the picture it resolved to.
    struct Span {
        let range: Range<String.Index>
        let url: String
    }

    /**
     * The body, with pictures where the resolved shortcodes were.
     *
     * Falls back to plain `Text(styled)` when there is nothing to replace,
     * which is the overwhelmingly common case and costs one array check.
     */
    static func text(
        styled: AttributedString,
        source: String,
        spans: [Span],
        cache: InlineEmojiCache
    ) -> Text {
        guard !spans.isEmpty else { return Text(styled) }

        var out = Text("")
        var cursor = source.startIndex

        for span in spans.sorted(by: { $0.range.lowerBound < $1.range.lowerBound }) {
            guard span.range.lowerBound >= cursor else { continue }
            if let before = Range(cursor..<span.range.lowerBound, in: styled) {
                out = out + Text(styled[before])
            }
            if let image = cache.image(for: span.url) {
                out = out + Text(Image(uiImage: image)).baselineOffset(-2)
            } else if let placeholder = Range(span.range, in: styled) {
                // Still arriving, or gone. Either way the shortcode reads.
                out = out + Text(styled[placeholder])
            }
            cursor = span.range.upperBound
        }
        if cursor < source.endIndex, let tail = Range(cursor..<source.endIndex, in: styled) {
            out = out + Text(styled[tail])
        }
        return out
    }
}
