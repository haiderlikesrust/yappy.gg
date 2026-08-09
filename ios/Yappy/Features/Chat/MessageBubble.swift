import SwiftUI

/// A message bubble.
///
/// Bubbles are deliberately *flat* — no neumorphic shadows. The style's own rule
/// is "few raised elements per screen", and a chat breaks it by definition:
/// dozens of bubbles each casting two shadows reads as a wall of pillows.
/// Hierarchy comes from colour instead: outgoing is the accent, incoming a tone
/// one step off the surface. The chrome around the timeline (composer, buttons)
/// is what keeps the soft look.
struct MessageBubble: View {
    @Environment(\.neu) private var colors

    let message: Message
    let isMine: Bool
    var showAvatar: Bool = true
    var isGrouped: Bool = false
    var isPinned: Bool = false
    /// The group's flair. Inside a flaired group, *its* colours carry your
    /// bubbles — the group's identity follows you into the conversation.
    var appearance: ConversationAppearance?
    /// Needed to tell whether a button addressed to one person is for you.
    var myUserId: String?
    /// customId of the button currently awaiting a server answer, if any.
    var pressingComponent: String?

    var onLongPress: () -> Void = {}
    var onReaction: (String) -> Void = { _ in }
    var onVote: (String) -> Void = { _ in }
    var onOpenThread: (() -> Void)?
    /// Opening media is the screen's job — the bubble only reports the tap.
    var onOpenMedia: () -> Void = {}
    var onPressComponent: (MessageButton) -> Void = { _ in }

    var body: some View {
        if message.isSystem {
            SystemLine(message: message)
        } else {
            bubbleRow
        }
    }

    private var bubbleRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if !isMine {
                if showAvatar {
                    Avatar(
                        url: message.sender?.avatarUrl,
                        name: message.sender?.label,
                        id: message.senderId ?? message.id,
                        size: 32
                    )
                } else {
                    Color.clear.frame(width: 32, height: 1)
                }
            }

            VStack(alignment: isMine ? .trailing : .leading, spacing: 0) {
                if !isMine, showAvatar, let sender = message.sender {
                    senderLine(sender)
                }

                if hasSpokenBody || !hasCard {
                    bubble
                }

                // Embeds sit *outside* the bubble: a link preview is about the
                // message, not part of what was said.
                if !message.embeds.isEmpty, !message.isDeleted {
                    ForEach(message.embeds.prefix(4)) { embed in
                        EmbedCard(embed: embed).padding(.top, 4)
                    }
                }

                if !message.components.isEmpty, !message.isDeleted {
                    ComponentRows(
                        rows: message.components,
                        myUserId: myUserId,
                        pressing: pressingComponent,
                        onPress: onPressComponent
                    )
                    .padding(.top, 6)
                }

                // The bubble normally carries the time. When it was suppressed
                // because the message is only a card, put it back underneath —
                // "when" is not a detail worth dropping to tidy the layout.
                if !hasSpokenBody, hasCard {
                    Text(YappyTime.clockTime(message.createdAt))
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                        .padding(.top, 3)
                        .padding(.leading, 2)
                }

                if !message.reactions.isEmpty {
                    reactionRow.padding(.top, 4)
                }
            }
            // `maxWidth` alone, with no `Spacer`: a spacer expands the row to the
            // full width and then pushes the bubble to the opposite edge, which
            // is how an outgoing bubble ends up hugging the *left* margin. The
            // outer frame's alignment is what puts the row on the right side.
            .frame(maxWidth: 300, alignment: isMine ? .trailing : .leading)
        }
        .frame(maxWidth: .infinity, alignment: isMine ? .trailing : .leading)
        .padding(.top, isGrouped ? 2 : 10)
    }

    // ── The bubble itself ────────────────────────────────────────────────────

    /// A bot's card often *is* the whole message, with nothing said around it.
    /// Drawing the bubble anyway leaves an empty rounded box holding only a
    /// timestamp, hovering above the card it belongs to.
    private var hasSpokenBody: Bool {
        message.isDeleted
            || ["sticker", "gif", "poll", "call"].contains(message.type)
            || !message.attachments.isEmpty
            || !(message.content ?? "").isEmpty
    }

    private var hasCard: Bool {
        !message.isDeleted && (!message.embeds.isEmpty || !message.components.isEmpty)
    }

    private var bubble: some View {
        // Corner radii are asymmetric on the tail side, and only on the last
        // bubble of a run — that is what visually groups consecutive messages.
        let corner: CGFloat = 16
        let shape = NeuCorners(
            topLeading: (isMine || isGrouped) ? corner : 5,
            topTrailing: (!isMine || isGrouped) ? corner : 5,
            bottomLeading: corner,
            bottomTrailing: corner
        )

        return VStack(alignment: .leading, spacing: 0) {
            if let reply = message.replyTo {
                ReplyPreview(preview: reply.preview, isMine: isMine).padding(.bottom, 6)
            }

            body(for: message)

            // A thread grows from this message.
            if message.threadReplyCount > 0, let onOpenThread {
                Text("💬 \(message.threadReplyCount) \(message.threadReplyCount == 1 ? "reply" : "replies") ›")
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(isMine ? colors.onOutgoing : colors.accent)
                    .padding(.top, 5)
                    .softTap(action: onOpenThread)
            }

            meta.padding(.top, 3)
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 9)
        .background(bubbleBackground, in: shape)
        .opacity(message.isPending ? 0.6 : 1)
        .contentShape(shape)
        .onLongPressGesture(minimumDuration: 0.4, maximumDistance: 18) { onLongPress() }
    }

    /// `AnyShapeStyle` rather than `some View`, so it can be handed to
    /// `background(_:in:)` and clipped to the bubble's asymmetric corners in one
    /// step instead of being layered behind them.
    private var bubbleBackground: AnyShapeStyle {
        if isMine, let gradient = appearance?.bubbleGradient {
            return AnyShapeStyle(gradient)
        }
        if isMine {
            return AnyShapeStyle(Color(hexString: appearance?.accent) ?? colors.outgoing)
        }
        return AnyShapeStyle(colors.incoming)
    }

    @ViewBuilder
    private func body(for message: Message) -> some View {
        if message.isDeleted {
            Text("This message was deleted")
                .font(YappyFont.bodyMedium)
                .italic()
                .foregroundStyle(isMine ? colors.onOutgoing.opacity(0.7) : colors.textTertiary)
        } else {
            switch message.type {
            case "sticker":
                RemoteImage(url: message.attachments.first?.url ?? message.gif?.url, contentMode: .fit)
                    .frame(width: 132, height: 132)

            case "gif":
                gifBody

            case "poll":
                PollBody(message: message, isMine: isMine, onVote: onVote)

            case "call":
                CallBody(message: message, isMine: isMine)

            default:
                if !message.attachments.isEmpty {
                    AttachmentBody(message: message, isMine: isMine, onOpen: onOpenMedia)
                } else {
                    // No `.textSelection(.enabled)`: the timeline is drawn
                    // inverted, and selection handles and the magnifier render
                    // inside that flipped layer — they come out upside down.
                    // "Copy text" in the long-press sheet does the same job,
                    // and is what Android offers too.
                    Text(styledContent)
                        .font(YappyFont.bodyLarge)
                        .foregroundStyle(isMine ? colors.onOutgoing : colors.textPrimary)
                }
            }
        }
    }

    @ViewBuilder
    private var gifBody: some View {
        if let gif = message.gif {
            let ratio = gif.height > 0 ? CGFloat(gif.width) / CGFloat(gif.height) : 1.4
            RemoteImage(url: gif.url)
                .frame(width: 240, height: 240 / min(max(ratio, 0.5), 2.5))
                .clipShape(NeuShape(radius: Neu.cornerSmall))
        }
    }

    @ViewBuilder
    private func senderLine(_ sender: PublicUser) -> some View {
        HStack(spacing: 4) {
            Text(sender.label)
                .font(YappyFont.labelSmall)
                // A role colour is the one thing allowed to override the name's
                // tint — it is how a group signals "this person speaks for us"
                // at a glance.
                .foregroundStyle(Color(hexString: message.senderRoleColor) ?? colors.textTertiary)

            // The timeline is where impersonation actually happens, so the marks
            // ride next to the name rather than living only on a profile nobody
            // opens mid-conversation.
            IdentityMarks(user: sender, size: 13)

            // Knowing a message came from software is not a nicety — it is the
            // difference between advice and an advertisement.
            if sender.isBot {
                Text("BOT")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.onAccent)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(colors.accent, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
            }
        }
        .padding(.leading, 6)
        .padding(.bottom, 3)
    }

    private var meta: some View {
        HStack(spacing: 4) {
            if isPinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(isMine ? colors.onOutgoing.opacity(0.6) : colors.textTertiary)
            }
            if message.editedAt != nil {
                Text("edited")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(isMine ? colors.onOutgoing.opacity(0.6) : colors.textTertiary)
            }
            Text(YappyTime.clockTime(message.createdAt))
                .font(YappyFont.labelSmall)
                .foregroundStyle(isMine ? colors.onOutgoing.opacity(0.7) : colors.textTertiary)
            if isMine {
                Image(systemName: message.isPending ? "clock" : "checkmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(colors.onOutgoing.opacity(0.7))
                    .accessibilityLabel(message.isPending ? "Sending" : "Sent")
            }
        }
        // No `maxWidth: .infinity` here. This row is the widest child of a
        // bubble that is supposed to hug its text, and stretching it stretches
        // the bubble — which is how a three-letter message ended up 300pt wide.
    }

    private var reactionRow: some View {
        HStack(spacing: 5) {
            ForEach(
                message.reactions.sorted { $0.value > $1.value }.prefix(6),
                id: \.key
            ) { emoji, count in
                let mine = message.myReactions.contains(emoji)
                HStack(spacing: 4) {
                    Text(emoji).font(YappyFont.labelMedium)
                    if count > 1 {
                        Text("\(count)")
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(mine ? colors.accent : colors.textTertiary)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                // Flat, like the bubbles they belong to. Yours are tinted with
                // the accent — colour is the "you did this" signal.
                .background(mine ? colors.accentSoft : colors.incoming, in: Capsule())
                .softTap { onReaction(emoji) }
            }
        }
    }

    /// Highlights @mention tokens, and a leading slash command.
    ///
    /// A command is not prose — it is an instruction addressed to software, and
    /// it reads wrong in the same face as the sentence around it. Only a command
    /// at the *start* of a message is treated as one, matching how the composer
    /// offers completion: a slash anywhere else is a date, a fraction, or a path.
    private var styledContent: AttributedString {
        let text = message.content ?? ""
        // On the accent bubble the accent colour vanishes, so weight alone
        // carries the mention and the command there.
        let highlight = isMine ? colors.onOutgoing : colors.accent

        var result = AttributedString(text)
        result.foregroundColor = isMine ? colors.onOutgoing : colors.textPrimary

        if let command = text.range(of: #"^/[a-zA-Z][a-zA-Z0-9_-]{0,31}"#, options: .regularExpression),
           let mapped = Range(command, in: result) {
            // No background: a rectangular highlight has no padding and fights
            // the rounded bubble it sits inside. Weight and colour do the same
            // job without drawing a second shape.
            result[mapped].foregroundColor = highlight
            result[mapped].font = YappyFont.body(16, weight: .bold)
        }

        var cursor = text.startIndex
        while let match = text.range(of: #"@[A-Za-z0-9_]{2,32}"#, options: .regularExpression, range: cursor ..< text.endIndex) {
            if let mapped = Range(match, in: result) {
                result[mapped].foregroundColor = highlight
                result[mapped].font = YappyFont.body(16, weight: .semibold)
            }
            cursor = match.upperBound
        }

        return result
    }
}

// ── Parts ────────────────────────────────────────────────────────────────────

private struct ReplyPreview: View {
    @Environment(\.neu) private var colors
    let preview: String?
    let isMine: Bool

    var body: some View {
        HStack(spacing: 7) {
            RoundedRectangle(cornerRadius: 2)
                .fill(isMine ? colors.onOutgoing : colors.accent)
                .frame(width: 2.5, height: 18)
            Text(preview ?? "Message unavailable")
                .font(YappyFont.labelMedium)
                .foregroundStyle(isMine ? colors.onOutgoing.opacity(0.85) : colors.textSecondary)
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
            isMine ? Color.white.opacity(0.16) : colors.dark.opacity(0.10),
            in: RoundedRectangle(cornerRadius: 8, style: .continuous)
        )
    }
}

private struct AttachmentBody: View {
    @Environment(\.neu) private var colors
    let message: Message
    let isMine: Bool
    let onOpen: () -> Void

    var body: some View {
        let attachment = message.attachments[0]
        // Honour the real aspect ratio rather than cropping everything to a
        // letterbox — a portrait photo cropped to 4:3 loses the subject's head.
        let ratio: CGFloat = {
            if let width = attachment.width, let height = attachment.height, height > 0 {
                return min(max(CGFloat(width) / CGFloat(height), 0.6), 1.8)
            }
            return 1.33
        }()

        VStack(alignment: .leading, spacing: 6) {
            ZStack {
                RemoteImage(url: attachment.thumbnailUrl ?? attachment.url)
                    .frame(width: 240, height: 240 / ratio)
                    .clipShape(NeuShape(radius: Neu.cornerSmall))
                    // Not while it is still uploading — there is nothing on the
                    // server to open yet.
                    .softTap(enabled: !message.isPending, action: onOpen)

                // Still uploading: the picture is already on screen (it is the
                // local file), so the only thing missing is a sign of progress.
                if message.isPending {
                    ProgressView()
                        .tint(.white)
                        .frame(width: 36, height: 36)
                        .background(Color.black.opacity(0.45), in: Circle())
                }
            }

            if let caption = message.content, !caption.isEmpty {
                Text(caption)
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(isMine ? colors.onOutgoing : colors.textPrimary)
            }
        }
    }
}

private struct PollBody: View {
    @Environment(\.neu) private var colors
    let message: Message
    let isMine: Bool
    let onVote: (String) -> Void

    var body: some View {
        if let poll = message.poll {
            let total = max(poll.options.reduce(0) { $0 + $1.voteCount }, 1)
            let onColor = isMine ? colors.onOutgoing : colors.textPrimary

            VStack(alignment: .leading, spacing: 0) {
                Text(poll.question)
                    .font(YappyFont.titleSmall)
                    .foregroundStyle(onColor)
                    .padding(.bottom, 8)

                ForEach(poll.options) { option in
                    optionRow(option, poll: poll, total: total, onColor: onColor)
                }

                Text(footer(poll))
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(onColor.opacity(0.65))
                    .padding(.top, 5)
            }
            .frame(width: 250, alignment: .leading)
        }
    }

    private func optionRow(_ option: PollOption, poll: Poll, total: Int, onColor: Color) -> some View {
        let chosen = poll.myVotes.contains(option.id)
        let fraction = CGFloat(option.voteCount) / CGFloat(total)

        return GeometryReader { geometry in
            ZStack(alignment: .leading) {
                // The bar is a background fill rather than a separate progress
                // widget, so the row stays one tap target.
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(isMine ? Color.white.opacity(0.20) : colors.accent.opacity(0.20))
                    .frame(width: max(geometry.size.width * fraction, 0))

                HStack(spacing: 5) {
                    Text(option.label)
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(onColor)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if chosen {
                        Image(systemName: "checkmark")
                            .font(.system(size: 11, weight: .bold))
                            .foregroundStyle(onColor)
                    }
                    Text("\(option.voteCount)")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(onColor.opacity(0.75))
                }
                .padding(.horizontal, 10)
            }
        }
        .frame(height: 32)
        .background(
            isMine ? Color.white.opacity(0.14) : colors.dark.opacity(0.08),
            in: RoundedRectangle(cornerRadius: 9, style: .continuous)
        )
        .padding(.vertical, 3)
        .softTap(enabled: !poll.isClosed) { onVote(option.id) }
    }

    private func footer(_ poll: Poll) -> String {
        var text = "\(poll.totalVoters) vote\(poll.totalVoters == 1 ? "" : "s")"
        if poll.isClosed { text += " · closed" }
        if poll.multiSelect { text += " · multiple choice" }
        return text
    }
}

private struct CallBody: View {
    @Environment(\.neu) private var colors
    let message: Message
    let isMine: Bool

    var body: some View {
        if let summary = message.callSummary {
            let missed = summary.outcome == "missed" || summary.outcome == "declined"
            let onColor = isMine ? colors.onOutgoing : colors.textPrimary

            HStack(spacing: 8) {
                Image(systemName: missed ? "phone.arrow.down.left.fill" : "phone.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(missed ? colors.danger : onColor)

                VStack(alignment: .leading, spacing: 0) {
                    Text(label(summary))
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(onColor)
                    if summary.durationSeconds > 0 {
                        Text(YappyTime.duration(summary.durationSeconds))
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(onColor.opacity(0.7))
                    }
                }
            }
        }
    }

    private func label(_ summary: CallSummary) -> String {
        switch summary.outcome {
        case "missed": return "Missed \(summary.mode) call"
        case "declined": return "Call declined"
        case "cancelled": return "Call cancelled"
        default: return "\(summary.mode.prefix(1).uppercased() + summary.mode.dropFirst()) call"
        }
    }
}

/// Group activity ("Alex added Sam").
///
/// Centred, small, no bubble: it is part of the timeline but not part of the
/// conversation, and giving it a bubble makes people try to reply to it.
struct SystemLine: View {
    @Environment(\.neu) private var colors
    let message: Message

    var body: some View {
        if let system = message.system {
            Text(text(system))
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(colors.dark.opacity(0.10), in: Capsule())
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
        }
    }

    private func text(_ system: SystemPayload) -> String {
        switch system.event {
        case "conversation_created": return "Group created"
        case "member_added": return "Someone was added"
        case "member_joined": return "Someone joined"
        case "member_left": return "Someone left"
        case "member_removed": return "Someone was removed"
        case "member_promoted", "member_demoted": return "Role updated"
        case "title_changed":
            return "Group renamed" + (system.value.map { " to \"\($0)\"" } ?? "")
        case "avatar_changed": return "Group photo updated"
        case "message_pinned": return "A message was pinned"
        // Worth spelling out: someone scrolling up will find the group's whole
        // history above this line and should know why it is here.
        case "upgraded_to_space": return "This group became a space — its history lives here now"
        case "channel_created":
            return "Channel created" + (system.value.map { " · #\($0)" } ?? "")
        case "disappearing_changed":
            return system.value == "0" ? "Disappearing messages off" : "Disappearing messages on"
        default:
            return system.event.replacingOccurrences(of: "_", with: " ")
        }
    }
}
