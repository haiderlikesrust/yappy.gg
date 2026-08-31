import SwiftUI

/**
 * The words of a message, and any fenced code blocks among them.
 *
 * A `pre` entity is the one kind that changes the shape of the line it sits on
 * rather than the look of some words in it, so it cannot be an attribute on an
 * AttributedString: a background run there is a tight rectangle with no
 * padding, fighting the rounded bubble around it, and it would wrap. The body
 * is split at the block boundaries instead and each block gets a surface of
 * its own that scrolls sideways — a wrapped stack trace is an unreadable one.
 *
 * The common case, no blocks at all, is one `Text` and exactly the path it
 * always was.
 */
struct CodeBlockBody: View {
    @Environment(\.neu) private var colors

    let message: Message
    let onAccent: Bool
    /// The prose runs, built by the caller so this view does not have to know
    /// how a mention or a custom emoji is drawn.
    let prose: (String, [JSONValue]?) -> AnyView

    var body: some View {
        let text = message.content ?? ""
        let blocks = Self.codeSpans(message.entities, in: text)

        if blocks.isEmpty {
            prose(text, message.entities)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                let pieces = Self.split(text: text, blocks: blocks, entities: message.entities)
                ForEach(Array(pieces.enumerated()), id: \.offset) { _, piece in
                    switch piece {
                    case let .prose(slice, entities):
                        prose(slice, entities)
                    case let .code(slice, language):
                        CodeBlock(code: slice, language: language)
                    }
                }
            }
        }
    }

    enum Piece {
        case prose(String, [JSONValue]?)
        case code(String, String?)
    }

    struct Block {
        let range: Range<String.Index>
        let language: String?
    }

    /// Every `pre` span, sorted. Offsets arrive as UTF-16 code units.
    static func codeSpans(_ entities: [JSONValue]?, in text: String) -> [Block] {
        guard let entities, !entities.isEmpty else { return [] }
        let utf16 = text.utf16
        var out: [(Int, Block)] = []

        for entity in entities {
            guard case let .object(fields) = entity,
                  case let .string(kind)? = fields["type"], kind == "pre",
                  let offset = fields["offset"]?.intValue,
                  let length = fields["length"]?.intValue,
                  offset >= 0, length > 0,
                  let start = utf16.index(utf16.startIndex, offsetBy: offset, limitedBy: utf16.endIndex),
                  let end = utf16.index(start, offsetBy: length, limitedBy: utf16.endIndex),
                  let from = String.Index(start, within: text),
                  let to = String.Index(end, within: text)
            else { continue }

            var language: String?
            if case let .string(value)? = fields["language"] { language = value }
            out.append((offset, Block(range: from ..< to, language: language)))
        }
        out.sort { $0.0 < $1.0 }
        return out.map(\.1)
    }

    /// Alternating prose and code, in order.
    static func split(text: String, blocks: [Block], entities: [JSONValue]?) -> [Piece] {
        var pieces: [Piece] = []
        var cursor = text.startIndex

        for block in blocks where block.range.lowerBound >= cursor {
            if block.range.lowerBound > cursor {
                let slice = String(text[cursor ..< block.range.lowerBound])
                    .trimmingCharacters(in: .newlines)
                if !slice.isEmpty {
                    pieces.append(.prose(slice, rebase(entities, in: text, from: cursor, to: block.range.lowerBound)))
                }
            }
            pieces.append(.code(String(text[block.range]), block.language))
            cursor = block.range.upperBound
        }
        if cursor < text.endIndex {
            let slice = String(text[cursor...]).trimmingCharacters(in: .newlines)
            if !slice.isEmpty {
                pieces.append(.prose(slice, rebase(entities, in: text, from: cursor, to: text.endIndex)))
            }
        }
        return pieces
    }

    /**
     * The entities wholly inside a slice, moved to be offsets into it.
     *
     * Anything straddling a boundary is dropped rather than clamped: half a
     * mention is worse than none, and a `pre` never appears in a prose run by
     * construction.
     */
    static func rebase(
        _ entities: [JSONValue]?,
        in text: String,
        from: String.Index,
        to: String.Index
    ) -> [JSONValue]? {
        guard let entities, !entities.isEmpty else { return nil }
        let utf16 = text.utf16
        let lower = utf16.distance(from: utf16.startIndex, to: from.samePosition(in: utf16) ?? utf16.startIndex)
        let upper = utf16.distance(from: utf16.startIndex, to: to.samePosition(in: utf16) ?? utf16.endIndex)

        var out: [JSONValue] = []
        for entity in entities {
            guard case let .object(fields) = entity,
                  case let .string(kind)? = fields["type"], kind != "pre",
                  let offset = fields["offset"]?.intValue,
                  let length = fields["length"]?.intValue,
                  offset >= lower, offset + length <= upper
            else { continue }
            var moved = fields
            moved["offset"] = .int(offset - lower)
            out.append(.object(moved))
        }
        return out.isEmpty ? nil : out
    }
}

/**
 * A fenced block: monospace on its own dark surface, scrolling sideways.
 *
 * The colours are fixed rather than themed. A faint themed tint is right for
 * a container on the surface and wrong for one on an outgoing bubble — over
 * the accent violet, with dark text on it, it comes out as mush — and it
 * would make the block look like two different things depending on which side
 * of the conversation it landed on. Code is the same code either way.
 */
struct CodeBlock: View {
    /// Near-black with light monospace, in both themes and on both sides:
    /// what every editor does and what anyone reading a stack trace expects.
    private static let surface = Color(red: 0.086, green: 0.078, blue: 0.122)
    private static let ink = Color(red: 0.894, green: 0.882, blue: 0.941)
    private static let label = Color(red: 0.541, green: 0.522, blue: 0.627)

    let code: String
    let language: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let language, !language.isEmpty {
                Text(language)
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(Self.label)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(Self.ink)
                    // No wrapping: the scroll is what keeps a stack trace
                    // readable, and it lives inside the block so the timeline
                    // itself never moves sideways.
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Self.surface, in: NeuShape(radius: Neu.cornerSmall))
    }
}
