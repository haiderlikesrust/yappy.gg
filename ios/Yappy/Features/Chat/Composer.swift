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
    /// The sibling channels a `#` can point at. Already filtered by the
    /// server to the ones this account may see.
    var channels: [ChannelEntry] = []
    /// The roles this person may ping — already filtered by the model.
    var mentionableRoles: [RoleEntry] = []
    /// Whether `@everyone` is theirs to send.
    var canMentionAll: Bool = false

    let onSend: () -> Void
    let onCancelReply: () -> Void
    let onCancelEdit: () -> Void
    let onTogglePicker: () -> Void
    let onOpenPoll: () -> Void
    let onOpenLocation: () -> Void
    let onPickMedia: (AttachmentUploader.Picked) -> Void
    let onSendVoice: (Data, Int) -> Void
    let onSendVideoNote: (URL, Int) -> Void

    @State private var photo: PhotosPickerItem?
    /// The + menu, holding everything that used to be its own button.
    @State private var attachOpen = false
    @State private var libraryOpen = false
    /// What a hold on the note button records. Tap toggles, Telegram-style.
    @State private var noteMode: NoteMode = .voice
    /// The note button while a finger holds it — it swells so the hold reads
    /// as "armed" before the recording bar arrives.
    @State private var notePressing = false
    @State private var videoNoteOpen = false
    @StateObject private var recorder = VoiceRecorder()

    enum NoteMode { case voice, video }

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

    /// The channels a `#` can point at, prefix-matched on the token so far.
    ///
    /// A title can contain spaces, so this matches on what has been typed
    /// since the `#` — one token — and the tap inserts the whole title. The
    /// list arrives already filtered to what this account can see.
    private var channelSuggestions: [ChannelEntry] {
        guard lastToken.hasPrefix("#") else { return [] }
        let query = String(lastToken.dropFirst()).lowercased()
        return channels
            .filter { ($0.title ?? "").lowercased().hasPrefix(query) }
            .prefix(6)
            .map { $0 }
    }

    /// Roles and the room, ahead of people.
    ///
    /// There are far fewer of them, they are the answer more often when
    /// somebody types `@` in a space, and a role behind six usernames that
    /// happen to share a prefix is a role nobody finds.
    private var roleSuggestions: [RoleEntry] {
        guard lastToken.hasPrefix("@") else { return [] }
        let query = String(lastToken.dropFirst()).lowercased()
        return mentionableRoles.filter { $0.name.lowercased().hasPrefix(query) }.prefix(4).map { $0 }
    }

    private var suggestsEveryone: Bool {
        guard canMentionAll, lastToken.hasPrefix("@") else { return false }
        return "everyone".hasPrefix(String(lastToken.dropFirst()).lowercased())
    }

    var body: some View {
        VStack(spacing: 0) {
            if !suggestions.isEmpty || !roleSuggestions.isEmpty || suggestsEveryone
                || !channelSuggestions.isEmpty { mentionStrip }
            if replyTo != nil || editing != nil { contextBar }

            if recorder.isRecording {
                recordingBar
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else {
                composerRow
            }

            if attachOpen {
                attachTray
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.18), value: suggestions.count)
        .animation(.easeInOut(duration: 0.18), value: replyTo?.id)
        .animation(.easeInOut(duration: 0.18), value: editing?.id)
        .animation(.easeInOut(duration: 0.15), value: recorder.isRecording)
        .animation(.easeInOut(duration: 0.2), value: attachOpen)
        // The send arrow's entrance. A spring rather than a fade because the
        // swap is the composer's one moment of theatre: the first character
        // typed makes the send button *arrive*.
        .animation(.spring(response: 0.3, dampingFraction: 0.65), value: canSend)
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task {
                if let picked = await item.picked() { onPickMedia(picked) }
                photo = nil
            }
        }
        // Photos *and* videos — the one library entry point, behind the +.
        .photosPicker(
            isPresented: $libraryOpen,
            selection: $photo,
            matching: .any(of: [.images, .videos]),
            photoLibrary: .shared()
        )
        .fullScreenCover(isPresented: $videoNoteOpen) {
            VideoNoteRecorderScreen(
                onSend: onSendVideoNote,
                onDismiss: { videoNoteOpen = false }
            )
        }
        .alert("Microphone access is off", isPresented: $recorder.permissionDenied) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Allow the microphone in Settings to record a voice note.")
        }
    }

    /// One row: picker, +, the field, and a button that is send / mic / camera.
    ///
    /// The poll button left the field and the photo button became part of the
    /// + menu, so adding two whole recording features leaves the text field
    /// *wider* than it was.
    private var composerRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            NeuIconButton(
                systemName: "face.smiling",
                label: "Stickers, GIFs and emoji",
                size: 42,
                iconSize: 20,
                active: pickerOpen,
                action: onTogglePicker
            )

            NeuIconButton(
                systemName: "plus",
                label: "Attach",
                size: 42,
                iconSize: 20,
                active: attachOpen,
                action: { attachOpen.toggle() }
            )

            NeuTextField(
                text: $draft,
                placeholder: "Message",
                radius: Neu.cornerLarge,
                multiline: true,
                lineLimit: 5,
                leading: { EmptyView() },
                trailing: { EmptyView() }
            )

            if canSend {
                NeuIconButton(
                    systemName: "arrow.up",
                    label: "Send",
                    size: 44,
                    iconSize: 20,
                    accent: true,
                    fillColor: accentOverride,
                    action: onSend
                )
                .transition(.scale(scale: 0.5).combined(with: .opacity))
            } else {
                // Tap swaps mic and camera; holding records. The same slot the
                // send arrow uses, so recording costs the field no width.
                Image(systemName: noteMode == .voice ? "mic.fill" : "video.fill")
                    .font(.system(size: 19, weight: .medium))
                    .foregroundStyle(colors.textSecondary)
                    .frame(width: 44, height: 44)
                    .neu(Circle(), colors, state: .raised, elevation: 6)
                    .scaleEffect(notePressing ? 1.3 : 1)
                    .animation(.spring(response: 0.25, dampingFraction: 0.6), value: notePressing)
                    .contentShape(Circle())
                    .accessibilityLabel(noteMode == .voice
                        ? "Record a voice note. Tap to switch to video."
                        : "Record a video note. Tap to switch to voice.")
                    .onTapGesture {
                        noteMode = noteMode == .voice ? .video : .voice
                        Haptics.tap()
                    }
                    .onLongPressGesture(minimumDuration: 0.3) {
                        Haptics.thud()
                        // Reset here, not in the pressing callback alone: the
                        // hold replaces this row (or covers it, for video), so
                        // the release can arrive with nobody listening and the
                        // button would come back still swollen.
                        notePressing = false
                        if noteMode == .voice {
                            Task { await recorder.start() }
                        } else {
                            videoNoteOpen = true
                        }
                    } onPressingChanged: { pressing in
                        notePressing = pressing
                    }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    /// Replaces the whole composer row while a voice note records: bin to
    /// throw it away, elapsed time, arrow to send. Sticky rather than
    /// hold-to-talk — an explicit send forgives a slipped finger.
    ///
    /// The waveform is the "recording" indicator: bars that move with the
    /// voice say it better than a caption did, and double as a mic check —
    /// flat bars while talking means something is wrong *before* the note is
    /// sent. It is also this screen's one piece of ambient motion, and it is
    /// driven by the meter, never by a timer of its own.
    private var recordingBar: some View {
        HStack(spacing: 12) {
            NeuIconButton(systemName: "trash", label: "Discard recording", size: 42, iconSize: 18) {
                recorder.cancel()
            }

            Text(recordingLabel)
                .font(YappyFont.titleSmall)
                .monospacedDigit()
                .foregroundStyle(colors.textPrimary)

            LiveWaveform(levels: recorder.levels, from: colors.danger, to: colors.accent)
                .frame(maxWidth: .infinity)
                .accessibilityLabel("Recording")

            NeuIconButton(
                systemName: "arrow.up",
                label: "Send voice note",
                size: 44,
                iconSize: 20,
                accent: true,
                fillColor: accentOverride
            ) {
                if let note = recorder.finish() {
                    onSendVoice(note.data, note.durationMs)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var recordingLabel: String {
        let seconds = Int(recorder.elapsed)
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    // ── Attach tray ──────────────────────────────────────────────────────────

    /// The + menu as a drawer instead of a system dialog. A confirmation
    /// dialog is for consequences; three friendly destinations deserve the
    /// same language the sticker picker already taught — a tray recessed into
    /// the sheet, rounded along its top edge. Tapping + again or the X closes
    /// it; picking a tile closes it on the way to the action.
    private var attachTray: some View {
        VStack(spacing: 2) {
            HStack {
                Spacer(minLength: 0)
                NeuIconButton(systemName: "xmark", label: "Close attach menu", size: 28, iconSize: 12) {
                    attachOpen = false
                }
            }

            HStack(spacing: 26) {
                attachTile("photo.on.rectangle.angled", "Photo", colors.accent) {
                    libraryOpen = true
                }
                attachTile("mappin.and.ellipse", "Location", Color(hex: 0x00CEC9), onOpenLocation)
                attachTile("chart.bar.xaxis", "Poll", colors.warning, onOpenPoll)
            }
            .frame(maxWidth: .infinity)
            .padding(.bottom, 16)
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
        .neu(
            NeuCorners(topLeading: Neu.cornerLarge, topTrailing: Neu.cornerLarge),
            colors,
            state: .pressed,
            elevation: 6
        )
    }

    /// One destination: a raised square wearing a whisper of its own colour
    /// behind the glyph — tinted light on the tile, not a painted button.
    private func attachTile(
        _ systemName: String, _ label: String, _ tint: Color, _ action: @escaping () -> Void
    ) -> some View {
        VStack(spacing: 8) {
            Image(systemName: systemName)
                .font(.system(size: 23, weight: .medium))
                .foregroundStyle(tint)
                .frame(width: 64, height: 64)
                .background(tint.opacity(0.12), in: NeuShape(radius: Neu.cornerMedium))
                .neu(NeuShape(radius: Neu.cornerMedium), colors, state: .raised, elevation: 5)

            Text(label)
                .font(YappyFont.labelMedium)
                .foregroundStyle(colors.textSecondary)
        }
        .contentShape(Rectangle())
        .softTap {
            attachOpen = false
            action()
        }
    }

    // ── Autocomplete ─────────────────────────────────────────────────────────

    private var mentionStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if suggestsEveryone {
                    HStack(spacing: 5) {
                        Image(systemName: "megaphone.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(colors.accent)
                        Text("@everyone")
                            .font(YappyFont.labelMedium)
                            .foregroundStyle(colors.accent)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .neu(NeuShape(radius: Neu.cornerPill), colors, state: .raised, elevation: 3)
                    .softTap {
                        draft = String(draft.dropLast(lastToken.count)) + "@everyone "
                    }
                }

                ForEach(channelSuggestions) { channel in
                    HStack(spacing: 6) {
                        Image(systemName: "number")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(colors.accent)
                        Text(channel.title ?? "channel")
                            .font(YappyFont.labelMedium)
                            .foregroundStyle(colors.accent)
                        if channel.isPrivate {
                            Image(systemName: "lock.fill")
                                .font(.system(size: 9))
                                .foregroundStyle(colors.textTertiary)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .neu(NeuShape(radius: Neu.cornerPill), colors, state: .raised, elevation: 3)
                    .softTap {
                        // The whole title, spaces and all — the send path
                        // matches it back the way it does a role name.
                        draft = String(draft.dropLast(lastToken.count))
                            + "#\(channel.title ?? "channel") "
                    }
                }

                ForEach(roleSuggestions) { role in
                    let tint = role.color.flatMap { Color(hexString: $0) } ?? colors.accent
                    HStack(spacing: 6) {
                        Circle().fill(tint).frame(width: 7, height: 7)
                        Text("@\(role.name)")
                            .font(YappyFont.labelMedium)
                            .foregroundStyle(tint)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .neu(NeuShape(radius: Neu.cornerPill), colors, state: .raised, elevation: 3)
                    .softTap {
                        // A role name can hold spaces, so the draft carries
                        // the whole thing — the send path matches it back.
                        draft = String(draft.dropLast(lastToken.count)) + "@\(role.name) "
                    }
                }

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

/// The live meter behind the recording bar: a fixed rank of bars whose heights
/// are the recorder's rolling levels, newest at the trailing edge so speech
/// scrolls in from the send button's side. The colour runs danger to accent
/// across the rank — the hot "this is live" red cooling into the app's own
/// violet — mixed per bar rather than laid over as one gradient, so a tall bar
/// keeps its colour as its neighbours move.
private struct LiveWaveform: View {
    let levels: [CGFloat]
    let from: Color
    let to: Color

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(levels.indices, id: \.self) { index in
                Capsule()
                    .fill(from.mix(with: to, by: Double(index) / Double(max(levels.count - 1, 1))))
                    .frame(width: 3, height: max(26 * levels[index], 3))
            }
        }
        .frame(height: 26)
        // One tick long, so each bar glides to its next height instead of
        // stepping — the metering cadence does the rest.
        .animation(.linear(duration: 0.08), value: levels)
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
                        // Whose command this is. With one bot it is a gentle
                        // signature; with several it is the difference between
                        // a picker and a guessing game. The server has always
                        // sent these three fields and this panel threw two of
                        // them away — Android has drawn them since the picker
                        // shipped.
                        if let botId = command.botId {
                            Avatar(
                                url: command.botAvatarUrl,
                                name: command.botUsername,
                                id: botId,
                                size: 22
                            )
                        }
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
                        // Trailing, so the eye reads command-then-owner and the
                        // names line up down the right edge when several bots
                        // answer the same word.
                        if let botUsername = command.botUsername {
                            Text(botUsername)
                                .font(YappyFont.labelSmall)
                                .foregroundStyle(colors.textTertiary)
                                .lineLimit(1)
                        }
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
        .frame(height: min(CGFloat(matches.count) * 40 + 16, 264))
        /*
         * Glass, and this is the one honest place for it on the chat screen:
         * every other bar is a stack sibling the timeline never passes under,
         * but this panel genuinely floats over the conversation — so the
         * conversation ghosts through, a whisper, while the raised shadows
         * keep saying "pane above the page". The old opaque `incoming` fill
         * existed because the neu default read straight through; the glass
         * wash answers the same problem without going deaf to what's beneath.
         */
        .neuGlass(colors, radius: Neu.cornerMedium)
        .clipShape(NeuShape(radius: Neu.cornerMedium))
        // The raised pair, by hand: `.neu` casts its shadows from the fill's
        // alpha, and a glass fill would cast almost none. Same elevation-6
        // numbers (offset 0.8x, blur 1.2x) so the pane sits under the one
        // lamp everything else does.
        .shadow(color: colors.dark.opacity(colors.isDark ? 0.42 : 0.55), radius: 7.2, x: 4.8, y: 4.8)
        .shadow(color: colors.light.opacity(colors.isDark ? 0.42 : 0.55), radius: 7.2, x: -4.8, y: -4.8)
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
    /// This room's own emoji, drawn above the unicode ones.
    var customEmojis: [CustomEmoji] = []

    @State private var tab: PickerTab = .stickers
    @State private var query = ""
    /// Home for the thumb that slides between tab labels.
    @Namespace private var pillSlide

    var body: some View {
        VStack(spacing: 0) {
            tabBar
                .padding(.bottom, 10)

            // The pages share the pill's selection, so a horizontal swipe down
            // here and a tap up there are the same gesture — and the thumb
            // follows a swipe just as it follows a tap.
            TabView(selection: $tab) {
                stickerTab.tag(PickerTab.stickers)
                gifTab.tag(PickerTab.gifs)
                emojiTab.tag(PickerTab.emoji)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
        }
        .onChange(of: tab) { Haptics.select() }
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

    /// One segmented pill instead of three chips taking turns being pressed.
    /// The selected background is a single raised thumb that slides between
    /// labels — the switch's grammar of a knob in a groove, stretched to three
    /// positions, which is also what makes the drawer's pages read as one
    /// surface the thumb points into rather than three separate panels.
    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(PickerTab.allCases, id: \.self) { candidate in
                Text(candidate.rawValue)
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(tab == candidate ? colors.accent : colors.textSecondary)
                    .padding(.vertical, 7)
                    .frame(maxWidth: .infinity)
                    .background {
                        if tab == candidate {
                            Capsule()
                                .fill(Color.clear)
                                .neu(NeuShape(radius: Neu.cornerPill), colors, state: .raised, elevation: 3)
                                .matchedGeometryEffect(id: "picker-tab-thumb", in: pillSlide)
                        }
                    }
                    .contentShape(Capsule())
                    .onTapGesture {
                        // The transaction is for the TabView — it is what makes
                        // the page slide over instead of cutting.
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) {
                            tab = candidate
                        }
                    }
                    .accessibilityAddTraits(tab == candidate ? [.isButton, .isSelected] : .isButton)
            }
        }
        .padding(3)
        .neu(NeuShape(radius: Neu.cornerPill), colors, state: .pressed, elevation: 4)
        // Keyed to the value rather than left to the tap's transaction, because
        // a page swipe also moves `tab` and arrives with no transaction of its
        // own — the thumb must glide either way.
        .animation(.spring(response: 0.32, dampingFraction: 0.85), value: tab)
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
            /*
             * The group's own, first and under their own heading.
             *
             * Picking one inserts `:name:` as text rather than anything
             * special — the composer turns a shortcode into an entity on the
             * way out, so a picked emoji and a typed one are the same
             * message. That is also what makes the shortcode a sensible
             * thing to leave in the body for readers who cannot resolve it.
             */
            if !customEmojis.isEmpty {
                HStack {
                    Text("This group")
                        .font(YappyFont.labelMedium)
                        .foregroundStyle(colors.textTertiary)
                    Spacer()
                }
                .padding(.bottom, 4)
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 46), spacing: 4)], spacing: 4) {
                    ForEach(customEmojis) { emoji in
                        RemoteImage(url: emoji.url)
                            .frame(width: 30, height: 30)
                            .frame(width: 46, height: 46)
                            .contentShape(Circle())
                            .softTap { onEmoji(":\(emoji.name):") }
                    }
                }
                HStack {
                    Text("Emoji")
                        .font(YappyFont.labelMedium)
                        .foregroundStyle(colors.textTertiary)
                    Spacer()
                }
                .padding(.top, 8)
                .padding(.bottom, 4)
            }
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
    /// Opens the full grid, for the feelings the quick eight don't cover.
    var onMore: (() -> Void)? = nil

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
                if let onMore {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(colors.textSecondary)
                        .frame(width: 42, height: 42)
                        .background(colors.veil, in: Circle())
                        .contentShape(Circle())
                        .softTap(action: onMore)
                        .accessibilityLabel("More reactions")
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
        }
        .neu(NeuShape(radius: Neu.cornerPill), colors, state: .raised, elevation: 6)
    }
}

/// Every emoji the composer's picker offers, as a reaction grid. Shares
/// `emojiGrid` with the composer so the two vocabularies cannot drift.
struct ReactionEmojiGrid: View {
    let onPick: (String) -> Void

    var body: some View {
        ScrollView {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 8), spacing: 4) {
                ForEach(emojiGrid, id: \.self) { emoji in
                    Text(emoji)
                        .font(.system(size: 26))
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Circle())
                        .softTap { onPick(emoji) }
                }
            }
        }
        .frame(maxHeight: 340)
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
