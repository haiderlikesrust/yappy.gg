import PhotosUI
import SwiftUI

enum PickerTab: String, CaseIterable {
    case stickers = "Stickers"
    case gifs = "GIFs"
    case emoji = "Emoji"
}

/// Sensible one-tap reactions, matching the order most chat apps settled on.
let quickEmoji = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉"]

private let emojiGrid = [
    "😀", "😂", "🥲", "😊", "😍", "😘", "😜", "🤔", "😐", "😴",
    "😭", "😡", "🥳", "🤯", "😱", "🤗", "🙄", "😬", "🥶", "🤒",
    "👍", "👎", "👏", "🙌", "🤝", "💪", "🙏", "✌️", "🤞", "👋",
    "❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "💔", "💯", "✨",
    "🔥", "🎉", "🎂", "🍕", "☕", "🍺", "⚽", "🎮", "🎧", "📷",
    "🚀", "🌙", "⭐", "🌧️", "🌈", "🐶", "🐱", "🦊", "🐼", "🦄",
]

struct Composer: View {
    @Environment(\.neu) private var colors

    @Binding var draft: String
    let replyTo: Message?
    let editing: Message?
    let pickerOpen: Bool
    let canSend: Bool
    /// The group's accent — carries its identity onto the send button.
    var accentOverride: Color?
    /// Everyone who can be @-mentioned here.
    var mentionable: [PublicUser] = []

    let onSend: () -> Void
    let onCancelReply: () -> Void
    let onCancelEdit: () -> Void
    let onTogglePicker: () -> Void
    let onOpenPoll: () -> Void
    let onPickMedia: (AttachmentUploader.Picked) -> Void

    @State private var photo: PhotosPickerItem?

    /// Autocomplete keys off the last token: mentions are typed at the point of
    /// thought, which is almost always the end of the draft.
    private var lastToken: String {
        String(draft.split(separator: " ", omittingEmptySubsequences: false).last?
            .split(separator: "\n", omittingEmptySubsequences: false).last ?? "")
    }

    private var suggestions: [PublicUser] {
        guard lastToken.hasPrefix("@") else { return [] }
        let query = String(lastToken.dropFirst())
        return mentionable.filter { user in
            user.username?.lowercased().hasPrefix(query.lowercased()) == true
                || user.displayName?.lowercased().hasPrefix(query.lowercased()) == true
        }
        .prefix(6)
        .map { $0 }
    }

    var body: some View {
        VStack(spacing: 0) {
            if !suggestions.isEmpty { mentionStrip }
            if replyTo != nil || editing != nil { contextBar }

            HStack(alignment: .bottom, spacing: 8) {
                NeuIconButton(
                    systemName: "face.smiling",
                    label: "Stickers, GIFs and emoji",
                    size: 42,
                    iconSize: 20,
                    active: pickerOpen,
                    action: onTogglePicker
                )

                PhotosPicker(selection: $photo, matching: .images, photoLibrary: .shared()) {
                    Image(systemName: "photo.on.rectangle")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(colors.textSecondary)
                        .frame(width: 42, height: 42)
                        .neu(Circle(), colors, state: .raised, elevation: 6)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Send a photo")

                NeuTextField(
                    text: $draft,
                    placeholder: "Message",
                    radius: Neu.cornerLarge,
                    multiline: true,
                    lineLimit: 5,
                    leading: { EmptyView() },
                    trailing: {
                        NeuIconButton(
                            systemName: "chart.bar.fill",
                            label: "Create poll",
                            size: 30,
                            iconSize: 15,
                            action: onOpenPoll
                        )
                    }
                )

                NeuIconButton(
                    systemName: "arrow.up",
                    label: "Send",
                    size: 44,
                    iconSize: 20,
                    accent: canSend,
                    fillColor: canSend ? accentOverride : nil,
                    enabled: canSend,
                    action: onSend
                )
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
        .animation(.easeInOut(duration: 0.18), value: suggestions.count)
        .animation(.easeInOut(duration: 0.18), value: replyTo?.id)
        .animation(.easeInOut(duration: 0.18), value: editing?.id)
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task {
                if let picked = await item.picked() { onPickMedia(picked) }
                photo = nil
            }
        }
    }

    // ── Autocomplete ─────────────────────────────────────────────────────────

    private var mentionStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(suggestions) { user in
                    HStack(spacing: 6) {
                        Text("@\(user.username ?? "?")")
                            .font(YappyFont.labelMedium)
                            .foregroundStyle(colors.accent)
                        if let name = user.displayName {
                            Text(name)
                                .font(YappyFont.labelMedium)
                                .foregroundStyle(colors.textTertiary)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .neu(NeuShape(radius: Neu.cornerPill), colors, state: .raised, elevation: 3)
                    .softTap {
                        guard let username = user.username else { return }
                        draft = String(draft.dropLast(lastToken.count)) + "@\(username) "
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 4)
        }
    }

    private var contextBar: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 2)
                .fill(colors.accent)
                .frame(width: 3, height: 28)

            VStack(alignment: .leading, spacing: 1) {
                Text(editing != nil
                    ? "Editing message"
                    : "Replying to \(replyTo?.sender?.label ?? "message")")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.accent)
                Text((editing ?? replyTo)?.content ?? "")
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(colors.textSecondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            NeuIconButton(systemName: "xmark", label: "Cancel", size: 30, iconSize: 14) {
                if editing != nil { onCancelEdit() } else { onCancelReply() }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(colors.dark.opacity(0.08), in: NeuShape(radius: Neu.cornerSmall))
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }
}

// ── Slash commands ───────────────────────────────────────────────────────────

/// The list of commands a bot in this conversation answers.
///
/// Owned by the screen and floated over the *timeline*, not stacked above the
/// composer, for two reasons learned the hard way.
///
/// In the layout flow it was catastrophic: six rows are ~238pt, and the
/// timeline is the only flexible thing on the screen, so it surrendered all of
/// that on top of the keyboard's ~300pt. On a smaller phone the message area
/// was squeezed to nothing, and typing a single "/" emptied the chat.
///
/// Attached to the composer as an overlay it was worse — an overlay is
/// positioned inside its parent's bounds, and the alignment guide meant to lift
/// it clear did not take, so the panel drew *downward* from the composer's top
/// edge: it covered the composer and ran on underneath the keyboard. Anchored
/// to the bottom of the timeline it simply sits in the space above the
/// composer, over the messages, with no alignment trickery to get wrong.
struct CommandPanel: View {
    @Environment(\.neu) private var colors

    let matches: [BotCommand]
    let onPick: (BotCommand) -> Void

    var body: some View {
        // Scrolls internally, so the cap can never clip a row off the end.
        ScrollView {
            VStack(spacing: 0) {
                ForEach(matches) { command in
                    HStack(spacing: 10) {
                        Text("/\(command.name)")
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(colors.accent)
                        if !command.description.isEmpty {
                            Text(command.description)
                                .font(YappyFont.bodySmall)
                                .foregroundStyle(colors.textTertiary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .contentShape(Rectangle())
                    .softTap { onPick(command) }
                }
            }
            .padding(.vertical, 4)
        }
        .scrollBounceBehavior(.basedOnSize)
        // Sized to its rows, with a ceiling. A concrete height rather than
        // `maxHeight`, because a `ScrollView` accepts whatever height it is
        // proposed — `maxHeight` would make a single match as tall as the cap.
        // The ceiling has headroom over the six-row case so the last row is not
        // left half-cut at default text sizes; past that it scrolls.
        .frame(height: min(CGFloat(matches.count) * 38 + 16, 264))
        // Explicit fill: the neu default is the page background, so a panel
        // drawn over the timeline would be shadows around nothing and the
        // messages would read straight through it.
        .neu(NeuShape(radius: Neu.cornerMedium), colors, state: .raised, elevation: 6, fill: colors.incoming)
        .clipShape(NeuShape(radius: Neu.cornerMedium))
        .padding(.horizontal, 14)
        .padding(.bottom, 6)
    }
}

/// A slash command is only a command at the very start of a message, and only
/// while it is still the whole of it — once there is a space the person is
/// typing arguments, and a list of commands is in the way.
func matchingCommands(_ draft: String, in commands: [BotCommand]) -> [BotCommand] {
    guard draft.hasPrefix("/"), !draft.contains(" "), !draft.contains("\n") else { return [] }
    let query = String(draft.dropFirst()).lowercased()
    return commands.filter { $0.name.lowercased().hasPrefix(query) }.prefix(6).map { $0 }
}

// ── Picker drawer ────────────────────────────────────────────────────────────

struct PickerSheet: View {
    @Environment(\.neu) private var colors

    let packs: [StickerPack]
    let recentStickers: [Sticker]
    let gifs: [GifResult]
    let gifQuery: String
    let gifsLoading: Bool
    let onGifQueryChange: (String) -> Void
    let onSticker: (Sticker) -> Void
    let onGif: (GifResult) -> Void
    let onEmoji: (String) -> Void

    @State private var tab: PickerTab = .stickers
    @State private var query = ""

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                ForEach(PickerTab.allCases, id: \.self) { candidate in
                    NeuChip(label: candidate.rawValue, selected: tab == candidate) { tab = candidate }
                }
                Spacer(minLength: 0)
            }
            .padding(.bottom, 10)

            switch tab {
            case .stickers: stickerTab
            case .gifs: gifTab
            case .emoji: emojiTab
            }
        }
        .padding(12)
        // `maxHeight`, so the drawer yields rather than the timeline. A rigid
        // 300pt on top of the keyboard's ~300pt overflowed the screen on a
        // smaller phone and pushed the composer out of sight. Paired with the
        // keyboard being dismissed as the drawer opens, it gets its full height
        // in practice.
        .frame(maxHeight: 300)
        // Recessed: the picker is a drawer opened *into* the sheet, so everything
        // inside it sits at a lower level than the composer.
        .neu(
            NeuCorners(topLeading: Neu.cornerLarge, topTrailing: Neu.cornerLarge),
            colors,
            state: .pressed,
            elevation: 6
        )
    }

    @ViewBuilder
    private var stickerTab: some View {
        let all = uniqueStickers

        if all.isEmpty {
            Text("No sticker packs installed yet")
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textTertiary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 6)], spacing: 6) {
                    ForEach(all) { sticker in
                        RemoteImage(url: sticker.url, contentMode: .fit)
                            .frame(width: 72, height: 72)
                            .clipShape(NeuShape(radius: Neu.cornerSmall))
                            .softTap { onSticker(sticker) }
                    }
                }
            }
        }
    }

    private var uniqueStickers: [Sticker] {
        var seen = Set<String>()
        return (recentStickers + packs.flatMap(\.stickers)).filter { seen.insert($0.id).inserted }
    }

    @ViewBuilder
    private var gifTab: some View {
        VStack(spacing: 8) {
            NeuTextField(
                text: Binding(get: { query }, set: { query = $0; onGifQueryChange($0) }),
                placeholder: "Search GIFs",
                radius: Neu.cornerPill,
                autocapitalization: .never
            ) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 16))
                    .foregroundStyle(colors.textTertiary)
            }

            if gifs.isEmpty {
                Text(gifsLoading ? "Searching…" : "No GIFs found")
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(colors.textTertiary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
                        ForEach(gifs, id: \.listId) { gif in
                            RemoteImage(url: gif.previewUrl)
                                .frame(height: 100)
                                .frame(maxWidth: .infinity)
                                .clipShape(NeuShape(radius: Neu.cornerSmall))
                                .softTap { onGif(gif) }
                        }
                    }
                }
            }
        }
    }

    private var emojiTab: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 46), spacing: 4)], spacing: 4) {
                ForEach(emojiGrid, id: \.self) { emoji in
                    Text(emoji)
                        .font(.system(size: 26))
                        .frame(width: 46, height: 46)
                        .contentShape(Circle())
                        .softTap { onEmoji(emoji) }
                }
            }
        }
    }
}

/// The quick-reaction strip that appears above the message action sheet.
struct QuickReactions: View {
    @Environment(\.neu) private var colors
    let onPick: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(quickEmoji, id: \.self) { emoji in
                    Text(emoji)
                        .font(.system(size: 26))
                        .frame(width: 42, height: 42)
                        .contentShape(Circle())
                        .softTap { onPick(emoji) }
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .neu(NeuShape(radius: Neu.cornerPill), colors, state: .raised, elevation: 6)
    }
}

// ── Poll composer ────────────────────────────────────────────────────────────

struct PollComposer: View {
    @Environment(\.neu) private var colors

    let onDismiss: () -> Void
    let onCreate: (String, [String], Bool) -> Void

    @State private var question = ""
    @State private var options = ["", ""]
    @State private var multiSelect = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("New poll")
                    .font(YappyFont.headlineSmall)
                    .foregroundStyle(colors.textPrimary)
                    .padding(.bottom, 14)

                NeuTextField(text: $question, placeholder: "Ask a question")
                    .padding(.bottom, 10)

                ForEach(options.indices, id: \.self) { index in
                    NeuTextField(
                        text: Binding(
                            get: { options[index] },
                            set: { options[index] = $0 }
                        ),
                        placeholder: "Option \(index + 1)"
                    )
                    .padding(.bottom, 8)
                }

                if options.count < 12 {
                    Text("+ Add option")
                        .font(YappyFont.labelMedium)
                        .foregroundStyle(colors.accent)
                        .padding(.vertical, 6)
                        .softTap { options.append("") }
                }

                NeuChip(label: "Multiple answers", selected: multiSelect) { multiSelect.toggle() }
                    .padding(.top, 8)

                HStack(spacing: 10) {
                    NeuButton(action: onDismiss) {
                        Text("Cancel")
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(colors.textSecondary)
                    }
                    NeuButton(accent: true) {
                        let clean = options
                            .map { $0.trimmingCharacters(in: .whitespaces) }
                            .filter { !$0.isEmpty }
                        let trimmedQuestion = question.trimmingCharacters(in: .whitespaces)
                        guard !trimmedQuestion.isEmpty, clean.count >= 2 else { return }
                        onCreate(trimmedQuestion, clean, multiSelect)
                    } content: {
                        Text("Create")
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(colors.onAccent)
                    }
                }
                .padding(.top, 16)
            }
            .padding(16)
        }
    }
}
