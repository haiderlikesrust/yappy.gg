import SwiftUI

/// Everything a bubble can ask the screen around it to do.
///
/// One handler where there were nine closures, and that is not tidiness — it is
/// what makes a bubble skippable. SwiftUI decides whether to re-run a view's
/// body by comparing the view's stored properties, and a closure built fresh at
/// the call site never compares equal to the one before it. Nine of them meant
/// no bubble could ever compare equal to itself, so every visible message was
/// rebuilt on every pass — which is every keystroke in the composer, every
/// typing indicator, every read receipt. With a single handler that `==`
/// deliberately ignores, an unchanged bubble is left alone.
enum BubbleAction {
    case longPress
    /// A quick double-tap heart, the gesture everyone already has in their
    /// fingers. The long-press sheet still offers the full picker.
    case doubleTap
    /// Opening media is the screen's job — the bubble only reports the tap.
    case openMedia
    case openThread
    /// Only offered on your own live share.
    case stopLocation
    case react(String)
    case vote(String)
    case pressComponent(MessageButton)
    /// A tapped @mention, reported as the bare username. Resolution is the
    /// screen's job — the bubble does not know who is a member.
    case mention(String)
    /// A tapped @mention the *server* already resolved, reported as the user
    /// id. Preferred over `mention` wherever the entity carries one: it needs
    /// no lookup, and it still points at the right person after a rename or
    /// when the mention was written with a display name rather than a handle.
    case mentionUser(String)
    /// A tapped #channel signpost, reported as the channel id. Navigation is
    /// the screen's job — the bubble does not own a stack.
    case openChannel(String)
}

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
    /// Redraws this bubble when a custom emoji picture finishes arriving. See
    /// InlineEmoji: `Text` can only interpolate an image it has in hand, so the
    /// first pass draws the shortcode and this is what replaces it.
    @ObservedObject private var emojiCache = InlineEmojiCache.shared

    let message: Message
    let isMine: Bool
    /**
     * Drawn as a card on a page rather than a bubble in a conversation.
     *
     * A bubble says "somebody said this to you, at a time". A card says "this
     * is true until it changes" — so it has no surface, no side, and its
     * author is always named, because a notice nobody signed is a notice
     * nobody is accountable for.
     */
    var readsAsPage: Bool = false

    /// Whether this content sits on the accent surface.
    ///
    /// "Mine" decides two things in a chat: which side the bubble hugs, and
    /// whether the text is drawn for an accent background. A page has neither,
    /// so the second question always answers no — otherwise a card you wrote
    /// yourself is white text on the page.
    private var onAccent: Bool { isMine && !readsAsPage }

    /// Which edge this row sits against. A conversation has two sides; a board
    /// is a page, and a page only has a start.
    private var sidedness: Alignment { isMine && !readsAsPage ? .trailing : .leading }
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
    /// Sender-side delivery status, drawn beside the timestamp on own bubbles.
    var receipt: MessageReceiptState = .none
    /// id → display name, for turning "Someone joined" into "Rayyan joined".
    var names: [String: String] = [:]
    /// Where this share is *now*, when it is still moving. Nil on a plain pin
    /// and on a share that has finished — both of which draw their own point.
    var liveLocation: LiveLocation?

    /// Whether this message's replies can be opened.
    ///
    /// Separate from the handler because its *presence* is the UI: the reply
    /// count only draws where there is somewhere to go. A handler is always
    /// non-nil and so cannot say that.
    var canOpenThread = false

    /// A tapped author name or avatar.
    ///
    /// The name and the face are the two things in a timeline that look like
    /// they should open a profile, and until this they did nothing — you had to
    /// find the person in the member list instead, which is a strange detour
    /// from a message they just sent.
    var onOpenProfile: (String) -> Void = { _ in }

    /// Everything this bubble can ask its screen to do, through one door.
    var onAction: (BubbleAction) -> Void = { _ in }

    /// The burst in flight, if any. Local and cosmetic, so it stays out of
    /// `==` on purpose: it is feedback for a tap that just happened on this
    /// device, and it has no business keeping an unchanged bubble from being
    /// skipped. `@State` invalidates this view on its own regardless of what
    /// the comparison says.
    @State private var burst: Burst?

    private struct Burst: Identifiable {
        let id = UUID()
        let emoji: String
    }

    /// The heart at the fingertip: the burst plays the moment the gesture
    /// lands, before the reaction round-trips — the delight must not wait on
    /// the network. Only when the double-tap *adds* a heart; bursting while
    /// one is being taken back would celebrate the wrong thing.
    private func heartDoubleTap() {
        if !message.myReactions.contains("❤️") {
            playBurst("❤️")
        }
        onAction(.doubleTap)
    }

    private func playBurst(_ emoji: String) {
        let fired = Burst(emoji: emoji)
        burst = fired
        Task {
            // Just past the last glyph's fade, and guarded by id so a second
            // burst mid-flight is not torn down by the first one's cleanup.
            try? await Task.sleep(for: .milliseconds(850))
            if burst?.id == fired.id { burst = nil }
        }
    }

    @ViewBuilder
    private var burstOverlay: some View {
        if let burst {
            // A fresh id per burst, so a repeat plays again instead of
            // reusing the spent one.
            EmojiBurst(emoji: burst.emoji).id(burst.id)
        }
    }

    var body: some View {
        if message.isSystem {
            SystemLine(message: message, names: names)
        } else {
            bubbleRow
                // Mentions are AttributedString links in a private scheme;
                // catching them here keeps them out of the system's hands.
                .environment(\.openURL, OpenURLAction { url in
                    let body = { url.host() ?? url.absoluteString
                        .replacingOccurrences(of: "\(url.scheme ?? "")://", with: "") }
                    switch url.scheme {
                    case "yappy-user": onAction(.mentionUser(body()))
                    case "yappy-channel": onAction(.openChannel(body()))
                    case "yappy-mention": onAction(.mention(body()))
                    default: return .systemAction
                    }
                    return .handled
                })
        }
    }

    /// A sticker stands on its own — no bubble, the way every messenger draws
    /// them. The image *is* the message. A video note is the same idea: a
    /// circle inside a rounded rectangle reads as a mistake. A message that is
    /// nothing but emoji is the third case: at that size the bubble is a box
    /// drawn around a gesture.
    private var isBubbleless: Bool {
        !message.isDeleted
            && (message.type == "sticker" || isVideoNote || jumboEmoji != nil || jumboCustomEmoji != nil || isBareMedia)
    }

    /// A picture, a video or a GIF, sent with nothing said around it.
    ///
    /// The bubble around one of these was always doing nothing: a rounded box
    /// hugging a rectangle that already has its own corners, adding a rim of
    /// colour and nothing else. Every other messenger drops it, and the image
    /// reads better at the same size without one.
    ///
    /// A caption keeps the bubble, and that is the whole distinction — once
    /// there are words, the bubble is holding *them*, and a floating line of
    /// text under a photo has nothing to sit on.
    private var isBareMedia: Bool {
        guard (message.content ?? "").isEmpty else { return false }
        if message.type == "gif" { return true }
        // Exactly one: a grid of several is a block that needs an edge, and the
        // reply and forward rows above it need something to align to.
        guard message.attachments.count == 1 else { return false }
        return message.type == "image" || message.type == "video"
    }

    /// How many emoji, when the message is *only* emoji. Nil otherwise.
    ///
    /// Capped at three. Past that they wrap, the row stops reading as a single
    /// gesture, and every other messenger draws the line in about the same
    /// place. Anything else in the message — a quote, an attachment, a card, or
    /// one stray character of text — puts the bubble back, because then the
    /// emoji is punctuation rather than the whole point.
    private var jumboEmoji: Int? {
        guard message.type == "text",
              message.replyTo == nil,
              message.attachments.isEmpty,
              message.embeds.isEmpty,
              message.components.isEmpty,
              let raw = message.content?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty
        else { return nil }

        let characters = Array(raw)
        guard characters.count <= 3, characters.allSatisfy(\.isPureEmoji) else { return nil }
        return characters.count
    }

    /**
     * The custom-emoji counterpart: the pictures to draw large, when the
     * message is *only* resolved `:shortcodes:`. Same cap and the same
     * disqualifiers as `jumboEmoji`, and the same reasoning — a group's own
     * emoji sent alone is the same gesture as 🀄 sent alone, and drawing it
     * at line height inside a bubble makes the gesture mumble.
     *
     * Every shortcode must resolve. An unresolved one draws as text, and one
     * stray run of text means the bubble comes back — half a jumbo row next
     * to a `:name:` nobody could resolve would be worse than neither.
     */
    private var jumboCustomEmoji: [String]? {
        guard message.type == "text",
              message.replyTo == nil,
              message.attachments.isEmpty,
              message.embeds.isEmpty,
              message.components.isEmpty,
              let resolved = message.customEmojis, !resolved.isEmpty,
              let text = message.content,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }

        let spans = Self.styleSpans(message.entities, in: text)
            .filter { $0.kind == "custom_emoji" }
        guard !spans.isEmpty, spans.count <= 3 else { return nil }

        var urls: [String] = []
        for span in spans {
            guard let id = span.emojiId, let emoji = resolved[id] else { return nil }
            urls.append(emoji.url)
        }

        // Erase the spans and nothing but whitespace may remain. Back to
        // front, so each removal leaves the earlier ranges standing.
        var rest = text
        for span in spans.sorted(by: { $0.range.lowerBound > $1.range.lowerBound }) {
            rest.removeSubrange(span.range)
        }
        guard rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return urls
    }

    /// A recorded round video note, told apart from a video *file* by the
    /// filename its recorder stamps — the same marker every client uses.
    private var isVideoNote: Bool {
        message.type == "video"
            && message.attachments.first?.filename?.hasPrefix("video-note") == true
    }

    private var bubbleRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            // No avatar column on a page: an avatar per card reads as a
            // conversation, and the name alone does not.
            if !isMine, !readsAsPage {
                if showAvatar {
                    Avatar(
                        url: message.sender?.avatarUrl,
                        name: message.sender?.label,
                        id: message.senderId ?? message.id,
                        size: 32
                    )
                    .softTap { if let id = message.senderId { onOpenProfile(id) } }
                } else {
                    Color.clear.frame(width: 32, height: 1)
                }
            }

            VStack(alignment: isMine && !readsAsPage ? .trailing : .leading, spacing: 0) {
                // Own bubbles carry no name in a chat — you know who you are,
                // and the bubble is already on your side. A page has no sides.
                if readsAsPage || (!isMine && showAvatar), let sender = message.sender {
                    senderLine(sender)
                }

                // Above the bubble, outside it: attribution is about the
                // message's provenance, not part of what was said.
                if let forwarded = message.forwardedFrom, !message.isDeleted {
                    HStack(spacing: 4) {
                        Image(systemName: "arrowshape.turn.up.right.fill")
                            .font(.system(size: 9))
                        Text("Forwarded from \(forwarded.label)")
                            .font(YappyFont.labelSmall)
                            .italic()
                            .lineLimit(1)
                    }
                    .foregroundStyle(colors.textTertiary)
                    .padding(.bottom, 3)
                    .padding(sidedness == .trailing ? .trailing : .leading, 2)
                }

                if isBubbleless {
                    bubblelessBody
                } else if hasSpokenBody || !hasCard {
                    bubble
                }

                // Embeds sit *outside* the bubble: a link preview is about the
                // message, not part of what was said.
                if !message.embeds.isEmpty, !message.isDeleted {
                    ForEach(message.embeds.prefix(4)) { embed in
                        // An invite to one of our own groups is not a link
                        // preview and should not be read like one. The server
                        // only fills this in for a live invite, so a revoked or
                        // expired one falls back to the ordinary card rather
                        // than offering a join that cannot succeed.
                        if let invite = embed.invite {
                            InviteCardView(invite: invite)
                                .padding(.top, 4)
                        } else {
                            // The client's own half of the trust check. The server
                            // already strips `kind` from anyone who is not a badged
                            // bot; this makes a bug there insufficient on its own.
                            EmbedCard(
                                embed: embed,
                                trusted: message.sender?.isBot == true && message.sender?.badge == "staff"
                            )
                            .padding(.top, 4)
                        }
                    }
                }

                if !message.components.isEmpty, !message.isDeleted {
                    ComponentRows(
                        rows: message.components,
                        myUserId: myUserId,
                        pressing: pressingComponent,
                        onPress: { onAction(.pressComponent($0)) }
                    )
                    .padding(.top, 6)
                }

                // The bubble normally carries the time. When it was suppressed
                // because the message is only a card, put it back underneath —
                // "when" is not a detail worth dropping to tidy the layout.
                if !hasSpokenBody, hasCard, !readsAsPage {
                    Text(YappyTime.clockTime(message.createdAt))
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                        .padding(.top, 3)
                        .padding(.leading, 2)
                }

                if !message.reactions.isEmpty {
                    /**
                     * Overlapped onto the bubble's lower edge rather than
                     * stacked beneath it.
                     *
                     * As a plain sibling the chips read as a separate object
                     * floating near the message — on a short bubble with one
                     * reaction, a lone heart hanging in the margin with nothing
                     * connecting it to what it reacted to. Sitting on the edge
                     * is what says "this belongs to that", and it is what every
                     * other messenger does.
                     *
                     * The inset keeps them off the rounded corner, where a
                     * capsule crossing the curve looks like a mistake.
                     */
                    reactionRow
                        .padding(.top, -9)
                        .padding(readsAsPage || !isMine ? .leading : .trailing, 10)
                }
            }
            /**
             * `maxWidth` alone, with no `Spacer`: a spacer expands the row to
             * the full width and then pushes the bubble to the opposite edge,
             * which is how an outgoing bubble ends up hugging the *left*
             * margin. The outer frame's alignment is what puts the row on the
             * right side.
             *
             * `sidedness` rather than `isMine`, because a board has no sides.
             * A page of cards has no "mine" and "theirs" to sort left from
             * right — every card is an entry on the same page — and left is
             * where a page starts. These three frames were the ones missed
             * when the posture was added, so a card you wrote yourself was
             * still being shoved to the trailing edge.
             *
             * A card also takes the width it is given: 300pt is a bubble in a
             * conversation, not an entry on a page.
             */
            .frame(maxWidth: readsAsPage ? .infinity : 300, alignment: sidedness)
        }
        .frame(maxWidth: .infinity, alignment: sidedness)
        .padding(.top, isGrouped ? 2 : 10)
    }

    /// Stickers and video notes, drawn without the bubble: the media itself,
    /// with the time and ticks tucked underneath.
    private var bubblelessBody: some View {
        VStack(alignment: readsAsPage || !isMine ? .leading : .trailing, spacing: 2) {
            if let count = jumboEmoji {
                // Fewer glyphs, bigger glyphs — one emoji is a reaction, three
                // are a sentence, and they should not be set at the same size.
                Text(message.content ?? "")
                    .font(.system(size: count == 1 ? 56 : count == 2 ? 46 : 38))
                    .padding(.vertical, 2)
            } else if let urls = jumboCustomEmoji {
                // The same tiers the unicode row uses, as squares — a custom
                // emoji has no font to set, so the frame is its size.
                let side: CGFloat = urls.count == 1 ? 56 : urls.count == 2 ? 46 : 38
                HStack(spacing: 6) {
                    ForEach(urls, id: \.self) { url in
                        RemoteImage(url: url, contentMode: .fit)
                            .frame(width: side, height: side)
                    }
                }
                .padding(.vertical, 2)
            } else if isVideoNote {
                VideoNoteBody(message: message, isMine: isMine)
            } else if message.type == "gif" {
                gifBody
            } else if message.type == "video" {
                VideoBody(message: message, isMine: onAccent)
            } else if message.type == "image" {
                AttachmentBody(message: message, isMine: onAccent, onOpen: { onAction(.openMedia) })
            } else {
                RemoteImage(
                    url: message.sticker?.url ?? message.attachments.first?.url ?? message.gif?.url,
                    contentMode: .fit
                )
                .frame(width: 132, height: 132)
                .opacity(message.isPending ? 0.6 : 1)
            }

            // The author line above already says who and when. Repeating the
            // clock under a card whose own text reads "updated a moment ago"
            // gives three answers to one question — and delivery ticks mean
            // nothing on a notice board.
            if !readsAsPage { meta }
        }
        .contentShape(Rectangle())
        // A video note handles its own tap (to play); only stickers take the
        // double-tap heart here.
        .onTapGesture(count: 2) { if !isVideoNote { heartDoubleTap() } }
        .onLongPressGesture(minimumDuration: 0.4, maximumDistance: 18) { onAction(.longPress) }
        .overlay { burstOverlay }
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
            if message.threadReplyCount > 0, canOpenThread {
                Text("💬 \(message.threadReplyCount) \(message.threadReplyCount == 1 ? "reply" : "replies") ›")
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(onAccent ? colors.onOutgoing : colors.accent)
                    .padding(.top, 5)
                    .softTap { onAction(.openThread) }
            }

            if !readsAsPage { meta.padding(.top, 3) }
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 9)
        .background(bubbleBackground, in: shape)
        .opacity(message.isPending ? 0.6 : 1)
        .contentShape(shape)
        .onTapGesture(count: 2) { heartDoubleTap() }
        .onLongPressGesture(minimumDuration: 0.4, maximumDistance: 18) { onAction(.longPress) }
        .overlay { burstOverlay }
    }

    /// `AnyShapeStyle` rather than `some View`, so it can be handed to
    /// `background(_:in:)` and clipped to the bubble's asymmetric corners in one
    /// step instead of being layered behind them.
    private var bubbleBackground: AnyShapeStyle {
        // A card has no surface. Giving it one — even a flat bordered one —
        // is a bubble wearing a different coat.
        if readsAsPage { return AnyShapeStyle(Color.clear) }
        if isMine, let gradient = appearance?.bubbleGradient {
            return AnyShapeStyle(gradient)
        }
        if isMine {
            if let accent = Color(hexString: appearance?.accent) {
                return AnyShapeStyle(accent)
            }
            // A plain conversation's outgoing bubble wears the accent as
            // light rather than paint — the same gradient every primary
            // control carries. Still flat: no shadows, colour is the whole
            // treatment.
            return AnyShapeStyle(colors.outgoingGradient)
        }
        return AnyShapeStyle(colors.incoming)
    }

    @ViewBuilder
    private func body(for message: Message) -> some View {
        if message.isDeleted {
            Text("This message was deleted")
                .font(YappyFont.bodyMedium)
                .italic()
                .foregroundStyle(onAccent ? colors.onOutgoing.opacity(0.7) : colors.textTertiary)
        } else {
            switch message.type {
            case "sticker":
                RemoteImage(url: message.attachments.first?.url ?? message.gif?.url, contentMode: .fit)
                    .frame(width: 132, height: 132)

            case "gif":
                gifBody

            case "location":
                if let payload = message.location {
                    LocationBubble(
                        payload: payload,
                        live: liveLocation,
                        isMine: isMine,
                        onStop: { onAction(.stopLocation) },
                        onOpen: { openInMaps(payload, current: liveLocation) }
                    )
                }

            case "poll":
                PollBody(message: message, isMine: isMine, onVote: { onAction(.vote($0)) })

            case "call":
                CallBody(message: message, isMine: isMine)

            case "audio":
                VoiceNoteBody(message: message, isMine: isMine)

            case "video":
                // Video *notes* are drawn bubble-less (see `bubblelessBody`);
                // only video *files* reach here, as a rectangle.
                VideoBody(message: message, isMine: onAccent)

            default:
                if let file = message.attachments.first, !file.isViewableMedia {
                    // Anything that is not a picture or a video. Checked before
                    // the media branch, because that one hands every attachment
                    // to an image loader and a PDF through an image loader is an
                    // empty grey rectangle.
                    FileBody(attachment: file, isMine: onAccent)
                } else if !message.attachments.isEmpty {
                    AttachmentBody(message: message, isMine: onAccent, onOpen: { onAction(.openMedia) })
                } else {
                    // No `.textSelection(.enabled)`: the timeline is drawn
                    // inverted, and selection handles and the magnifier render
                    // inside that flipped layer — they come out upside down.
                    // "Copy text" in the long-press sheet does the same job,
                    // and is what Android offers too.
                    CodeBlockBody(
                        message: message,
                        onAccent: onAccent,
                        prose: { slice, entities in
                            /*
                             * A prose run between code blocks, or the whole
                             * message when there are none. Built here rather
                             * than inside CodeBlockBody so that view does not
                             * have to know how a mention or a custom emoji is
                             * drawn — it only knows where the blocks are.
                             */
                            AnyView(
                                InlineEmoji.text(
                                    styled: styledContent(for: slice, entities: entities),
                                    source: slice,
                                    spans: inlineEmojiSpans(in: slice, entities: entities),
                                    cache: emojiCache
                                )
                                .font(YappyFont.bodyLarge)
                                .foregroundStyle(onAccent ? colors.onOutgoing : colors.textPrimary)
                                // No `maxWidth: .infinity` — the meta row
                                // below already states the rule: the widest
                                // child sets the bubble, and stretching prose
                                // made every three-letter message a full-width
                                // slab. CodeBlockBody's own stack aligns
                                // leading without it.
                            )
                        }
                    )
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
            // The bubble draws its own BOT tag below, in the sender line it
            // already assembles.
            IdentityMarks(user: sender, size: 13, showsBot: false)

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

            // On a page this line is the only clock, so it carries the time
            // the meta row would otherwise repeat underneath.
            if readsAsPage {
                Text(YappyTime.clockTime(message.createdAt))
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
            }
        }
        .padding(.leading, 6)
        .padding(.bottom, 3)
        .softTap { if let id = message.senderId { onOpenProfile(id) } }
    }

    private var meta: some View {
        HStack(spacing: 4) {
            if isPinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 9))
                    .foregroundStyle(onAccent ? colors.onOutgoing.opacity(0.6) : colors.textTertiary)
            }
            if message.editedAt != nil {
                Text("edited")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(onAccent ? colors.onOutgoing.opacity(0.6) : colors.textTertiary)
            }
            Text(YappyTime.clockTime(message.createdAt))
                .font(YappyFont.labelSmall)
                .foregroundStyle(onAccent ? colors.onOutgoing.opacity(0.7) : colors.textTertiary)
            if isMine {
                ticks
            }
        }
        // No `maxWidth: .infinity` here. This row is the widest child of a
        // bubble that is supposed to hug its text, and stretching it stretches
        // the bubble — which is how a three-letter message ended up 300pt wide.
    }

    /**
     * The tick ladder, in the grammar WhatsApp taught everyone: a clock while
     * sending, one tick on the server, two when their device has it, and the
     * pair brightening to full white when they have read it. Colour carries
     * the read state rather than a hue swap because these sit on the accent
     * bubble, where a blue-on-violet pair would just look broken.
     *
     * There is no SF Symbol for a double check; two overlapped checkmarks are
     * how it is drawn.
     */
    private var ticks: some View {
        let dimmed = colors.onOutgoing.opacity(0.7)
        return Group {
            switch receipt {
            case .none, .sent:
                // `.none` falls back to the plain sent mark: a bubble with no
                // receipt information should not pretend to know more.
                Image(systemName: message.isPending ? "clock" : "checkmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(dimmed)
                    .accessibilityLabel(message.isPending ? "Sending" : "Sent")
            case .pending:
                Image(systemName: "clock")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(dimmed)
                    .accessibilityLabel("Sending")
            case .delivered, .read:
                ZStack(alignment: .leading) {
                    Image(systemName: "checkmark")
                    Image(systemName: "checkmark").offset(x: 4)
                }
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(receipt == .read ? colors.onOutgoing : dimmed)
                .padding(.trailing, 4)
                .accessibilityLabel(receipt == .read ? "Read" : "Delivered")
            }
        }
    }

    private var reactionRow: some View {
        HStack(spacing: 5) {
            // Ties broken on the emoji, because `sorted` is not stable: two
            // reactions on the same count could swap places between draws, and
            // the spring below turns that into a visible shuffle of chips
            // nobody touched.
            ForEach(
                message.reactions
                    .sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
                    .prefix(6),
                id: \.key
            ) { emoji, count in
                ReactionChip(
                    emoji: emoji,
                    count: count,
                    mine: message.myReactions.contains(emoji),
                    onTap: { onAction(.react(emoji)) }
                )
                .transition(.scale(scale: 0.4).combined(with: .opacity))
            }
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.55), value: message.reactions)
    }

    /**
     * Where the pictures go.
     *
     * Only the ids the server actually resolved: an unresolved one is left
     * out entirely, so the slice that covers it stays as text and the
     * reader sees `:party_parrot:`. That is the ordinary outcome for a
     * message forwarded in from another group, not an error.
     */
    private func inlineEmojiSpans(in slice: String, entities: [JSONValue]?) -> [InlineEmoji.Span] {
        guard let resolved = message.customEmojis, !resolved.isEmpty else { return [] }
        return Self.styleSpans(entities, in: slice).compactMap { span in
            guard span.kind == "custom_emoji",
                  let id = span.emojiId,
                  let emoji = resolved[id]
            else { return nil }
            return InlineEmoji.Span(range: span.range, url: emoji.url)
        }
    }

    /// Highlights @mention tokens, and a leading slash command.
    ///
    /// A command is not prose — it is an instruction addressed to software, and
    /// it reads wrong in the same face as the sentence around it. Only a command
    /// at the *start* of a message is treated as one, matching how the composer
    /// offers completion: a slash anywhere else is a date, a fraction, or a path.
    private func styledContent(for slice: String, entities: [JSONValue]?) -> AttributedString {
        let text = slice
        // On the accent bubble the accent colour vanishes, so weight alone
        // carries the mention and the command there.
        let highlight = onAccent ? colors.onOutgoing : colors.accent
        let base = onAccent ? colors.onOutgoing : colors.textPrimary

        return StyledText.value(text: text, isMine: isMine, highlight: highlight, base: base) {
            var result = AttributedString(text)
            result.foregroundColor = base

            /**
             * Spans the server computed — markdown on a board, or a bot saying
             * what it meant.
             *
             * They win over the regexes below, because the server has better
             * information: it knows a bot meant that word to be bold, where a
             * regex is guessing from punctuation. Nothing here parses markdown
             * — see packages/shared/src/markdown.ts for why that lives in one
             * place and not in three.
             */
            let spans = Self.styleSpans(entities, in: text)
            var claimed: [Range<String.Index>] = []
            if !spans.isEmpty {
                for span in spans {
                    claimed.append(span.range)
                    guard let mapped = Range(span.range, in: result) else { continue }
                    switch span.kind {
                    case "bold":
                        result[mapped].font = YappyFont.body(16, weight: .bold)
                    case "italic":
                        result[mapped].font = YappyFont.body(16).italic()
                    case "strike":
                        result[mapped].strikethroughStyle = .single
                    case "code":
                        result[mapped].font = .system(size: 15, design: .monospaced)
                    case "spoiler":
                        // No tap-to-reveal here yet, so it is drawn as marked-out
                        // text rather than as a promise the bubble cannot keep.
                        result[mapped].backgroundColor = highlight.opacity(0.25)
                    case "link":
                        result[mapped].foregroundColor = highlight
                        result[mapped].underlineStyle = .single
                        if let url = span.url.flatMap(URL.init(string:)) {
                            result[mapped].link = url
                        }
                    case "mention_channel":
                        /*
                         * A signpost, and a door only where the reader can
                         * walk through it.
                         *
                         * The server resolves a title only for channels this
                         * account may see, so an unresolved id is either a
                         * deleted channel or a private one — and both should
                         * read as the plain text that was typed rather than as
                         * a link into somewhere that will 404.
                         */
                        if let id = span.channelId, message.mentionedChannels?[id] != nil {
                            result[mapped].foregroundColor = highlight
                            result[mapped].font = YappyFont.body(16, weight: .semibold)
                            result[mapped].link = URL(string: "yappy-channel://\(id)")
                        }
                    case "mention_role":
                        // A role wears its own colour where it has one. Falling
                        // back to the highlight rather than to plain text
                        // matters: an uncoloured role is still a mention, and
                        // drawing it as prose hides that somebody was called.
                        let named = span.roleId.flatMap { message.mentionedRoles?[$0] }
                        result[mapped].foregroundColor =
                            named?.color.flatMap { Color(hexString: $0) } ?? highlight
                        result[mapped].font = YappyFont.body(16, weight: .semibold)
                    case "mention", "mention_all":
                        result[mapped].foregroundColor = highlight
                        result[mapped].font = YappyFont.body(16, weight: .semibold)
                        /**
                         * Tappable, which it was not.
                         *
                         * The regex fallback below has always made a mention a
                         * door — but it only runs when a message has *no*
                         * entities, and this branch returns before reaching it.
                         * So the well-formed mention, the one the server
                         * described precisely, was the one you could not tap,
                         * while an unparsed one worked. Backwards.
                         *
                         * `@everyone` is deliberately left as paint: it is the
                         * room, not a person, and there is no profile to open.
                         */
                        if span.kind == "mention" {
                            if let userId = span.userId {
                                result[mapped].link = URL(string: "yappy-user://\(userId)")
                            } else {
                                // Older payloads carried no id. The text in the
                                // span is the handle, same as the fallback reads.
                                let handle = String(text[span.range].dropFirst())
                                if !handle.isEmpty {
                                    result[mapped].link = URL(string: "yappy-mention://\(handle)")
                                }
                            }
                        }
                    default:
                        break
                    }
                }
            }

            /*
             * Bare URLs, in whichever text the spans above did not claim.
             *
             * This runs on both paths. Server spans still win where they
             * overlap — that is the whole point of preferring them — but a
             * board writes its markdown as spans and leaves a bare address
             * between them as ordinary text, so returning early here left
             * exactly those unlinked.
             */
            var urlRanges: [Range<String.Index>] = []
            var urlCursor = text.startIndex
            while let match = text.range(
                of: #"https?://[^\s<>"'()\[\]]+[^\s<>"'()\[\].,;:!?]"#,
                options: .regularExpression,
                range: urlCursor ..< text.endIndex
            ) {
                urlCursor = match.upperBound
                guard !claimed.contains(where: { $0.overlaps(match) }) else { continue }
                urlRanges.append(match)
                if let mapped = Range(match, in: result) {
                    result[mapped].foregroundColor = highlight
                    result[mapped].underlineStyle = .single
                    result[mapped].link = URL(string: String(text[match]))
                }
            }

            // Everything below is for a message the server said nothing about.
            // Where it did, its spans are the whole description.
            if !spans.isEmpty { return result }

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
                // Not inside a URL. "https://x.com/@someone" is one link, and
                // painting half of it as a mention would both look wrong and
                // steal the tap from the address it belongs to.
                let insideURL = urlRanges.contains { $0.lowerBound <= match.lowerBound && match.upperBound <= $0.upperBound }
                if !insideURL, let mapped = Range(match, in: result) {
                    result[mapped].foregroundColor = highlight
                    result[mapped].font = YappyFont.body(16, weight: .semibold)
                    // Tappable: the link is caught by the openURL action above and
                    // opens the profile, so a mention is a door, not just paint.
                    let username = String(text[match].dropFirst())
                    result[mapped].link = URL(string: "yappy-mention://\(username)")
                }
                cursor = match.upperBound
            }

            return result
        }
    }

    /// One span of styled text, as the server described it.
    private struct StyleSpan {
        let range: Range<String.Index>
        let kind: String
        let url: String?
        /// Set on a role mention, so the span can be drawn in that
        /// role's own colour without re-reading the entity.
        let roleId: String?
        /// Set on a person mention. Carried for the same reason `roleId` is —
        /// the entity knows exactly who was meant, and re-deriving it from the
        /// text is guesswork.
        let userId: String?
        /// Set on a `#channel` signpost. The title is resolved server-side and
        /// only for channels this reader may see, so an unresolved one means
        /// "draw it as prose", not "look it up yourself".
        let channelId: String?
        /// Set on a `:shortcode:`. Its picture is resolved server-side; an
        /// unresolved one is drawn as the text that was typed.
        let emojiId: String?
    }

    /**
     * The spans worth drawing, in order, clipped to the text.
     *
     * Offsets arrive as UTF-16 code units, which is what JavaScript and Kotlin
     * count in. Swift counts graphemes, so every offset is converted through
     * the UTF-16 view — skip that and one emoji earlier in a sentence shifts
     * every span after it.
     *
     * A span running past the end is dropped rather than clamped: it means the
     * text and the offsets came from different versions of the message, and
     * half-applying it would style the wrong words.
     */
    private static func styleSpans(_ entities: [JSONValue]?, in text: String) -> [StyleSpan] {
        guard let entities, !entities.isEmpty else { return [] }
        let utf16 = text.utf16
        var out: [(Int, StyleSpan)] = []

        for entity in entities {
            guard case let .object(fields) = entity,
                  case let .string(kind)? = fields["type"],
                  let offset = fields["offset"]?.intValue,
                  let length = fields["length"]?.intValue,
                  offset >= 0, length > 0,
                  let start = utf16.index(utf16.startIndex, offsetBy: offset, limitedBy: utf16.endIndex),
                  let end = utf16.index(start, offsetBy: length, limitedBy: utf16.endIndex),
                  let from = String.Index(start, within: text),
                  let to = String.Index(end, within: text)
            else { continue }

            var url: String?
            if case let .string(value)? = fields["url"] { url = value }
            var roleId: String?
            if case let .string(value)? = fields["roleId"] { roleId = value }
            var userId: String?
            if case let .string(value)? = fields["userId"] { userId = value }
            var channelId: String?
            if case let .string(value)? = fields["channelId"] { channelId = value }
            var emojiId: String?
            if case let .string(value)? = fields["emojiId"] { emojiId = value }
            out.append((
                offset,
                StyleSpan(
                    range: from ..< to,
                    kind: kind,
                    url: url,
                    roleId: roleId,
                    userId: userId,
                    channelId: channelId,
                    emojiId: emojiId
                )
            ))
        }

        // Sorted and de-overlapped: applying two spans to the same characters
        // is how one of them silently wins on one platform and loses on another.
        out.sort { $0.0 < $1.0 }
        var kept: [StyleSpan] = []
        for (_, span) in out where kept.last.map({ span.range.lowerBound >= $0.range.upperBound }) ?? true {
            kept.append(span)
        }
        return kept
    }
}

extension MessageBubble: Equatable {
    /// Everything the body reads, and nothing else.
    ///
    /// `onAction` is deliberately absent. It is rebuilt at the call site on
    /// every pass, so comparing it would make every comparison false and this
    /// conformance pointless — which is the whole problem it exists to solve.
    /// Skipping it is safe because the handler closes over the *screen's*
    /// state, not the bubble's: it captures a message that just compared equal,
    /// and dispatches into a model that is a reference either way. There is
    /// nothing in it that a newer copy would do differently.
    ///
    /// `names` is compared only for system lines, which are the only messages
    /// that read it. Everything else would be paying to compare a dictionary it
    /// never looks at.
    static func == (lhs: MessageBubble, rhs: MessageBubble) -> Bool {
        lhs.message == rhs.message
            && lhs.isMine == rhs.isMine
            && lhs.readsAsPage == rhs.readsAsPage
            && lhs.showAvatar == rhs.showAvatar
            && lhs.isGrouped == rhs.isGrouped
            && lhs.isPinned == rhs.isPinned
            && lhs.appearance == rhs.appearance
            && lhs.myUserId == rhs.myUserId
            && lhs.pressingComponent == rhs.pressingComponent
            && lhs.receipt == rhs.receipt
            && lhs.liveLocation == rhs.liveLocation
            && lhs.canOpenThread == rhs.canOpenThread
            && (!lhs.message.isSystem || lhs.names == rhs.names)
    }
}

/// Styled message text, kept.
///
/// Building it compiles two regexes and walks the string once per match, and
/// that was happening for every visible bubble on every body pass — which is
/// every keystroke in the composer, every typing indicator, every read receipt.
/// The answer depends only on the words, which side of the conversation they
/// are on, and the palette. None of those change while somebody scrolls or
/// types, so it is worth remembering.
///
/// Bounded and evicted oldest-first: a chat left open for a day would otherwise
/// hold an entry for every message ever scrolled past, which is a leak with a
/// slow fuse rather than no leak at all.
@MainActor
private enum StyledText {
    private struct Key: Hashable {
        let text: String
        let isMine: Bool
        let highlight: Color
        let base: Color
    }

    /// Comfortably more than a few screens of history either side of the
    /// viewport, which is all that gets asked for in a burst.
    private static let limit = 300

    private static var store: [Key: AttributedString] = [:]
    private static var order: [Key] = []

    static func value(
        text: String,
        isMine: Bool,
        highlight: Color,
        base: Color,
        build: () -> AttributedString
    ) -> AttributedString {
        let key = Key(text: text, isMine: isMine, highlight: highlight, base: base)
        if let hit = store[key] { return hit }

        let built = build()
        store[key] = built
        order.append(key)
        if order.count > limit { store.removeValue(forKey: order.removeFirst()) }
        return built
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

/// Whether this is something the media viewer can show.
extension Attachment {
    var isViewableMedia: Bool {
        mimeType.hasPrefix("image/") || mimeType.hasPrefix("video/") || mimeType.hasPrefix("audio/")
    }
}

/**
 * A file that is not a photo, a video, or a voice note.
 *
 * What it is, how big it is, and one obvious action. Size earns its place here
 * more than anywhere else in the app: the difference between a 40 KB contract
 * and a 180 MB archive decides whether somebody taps it on cellular, and it is
 * the one thing a filename never tells you.
 *
 * Tapping hands the URL to the system, which is the honest answer on a phone —
 * whatever app owns PDFs renders them better than a chat client will, and a
 * file the OS saved is one the person can find again.
 */
private struct FileBody: View {
    let attachment: Attachment
    let isMine: Bool

    @Environment(\.neu) private var colors
    @Environment(\.openURL) private var openURL

    /// Bytes as somebody would say them out loud.
    ///
    /// One decimal below ten and none above: "8.4 MB" is useful, "847.3 KB" is
    /// noise.
    private var humanSize: String? {
        let bytes = attachment.size
        guard bytes > 0 else { return nil }
        if bytes < 1000 { return "\(bytes) B" }
        var value = Double(bytes) / 1000
        let units = ["KB", "MB", "GB"]
        var unit = 0
        while value >= 1000, unit < units.count - 1 {
            value /= 1000
            unit += 1
        }
        let rounded = value < 10 ? String(format: "%.1f", value) : String(Int(value.rounded()))
        return "\(rounded) \(units[unit])"
    }

    /// The shape of the thing, in one word.
    ///
    /// Deliberately coarse: a dozen icons for a dozen archive formats repeats
    /// what the extension already said. This is for the glance that says
    /// "document" rather than "photo".
    private var label: String {
        let ext = (attachment.filename as NSString?)?.pathExtension.lowercased() ?? ""
        if attachment.mimeType == "application/pdf" || ext == "pdf" { return "PDF" }
        if attachment.mimeType == "application/zip" || ["zip", "rar", "7z", "tar", "gz"].contains(ext) {
            return "Archive"
        }
        if attachment.mimeType.hasPrefix("text/") || ["txt", "md", "csv", "log"].contains(ext) {
            return "Text"
        }
        return ext.isEmpty ? "File" : ext.uppercased()
    }

    var body: some View {
        let tint = isMine ? colors.onOutgoing : colors.accent

        Button {
            if let url = URL(string: attachment.url) { openURL(url) }
        } label: {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(tint.opacity(0.14))
                    Image(systemName: "doc")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(tint)
                }
                .frame(width: 34, height: 34)

                VStack(alignment: .leading, spacing: 1) {
                    Text(attachment.filename ?? "file")
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(isMine ? colors.onOutgoing : colors.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text([label, humanSize].compactMap { $0 }.joined(separator: " · "))
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(isMine ? colors.onOutgoing.opacity(0.7) : colors.textTertiary)
                }

                Spacer(minLength: 4)

                Image(systemName: "arrow.down.circle")
                    .font(.system(size: 16))
                    .foregroundStyle(isMine ? colors.onOutgoing.opacity(0.7) : colors.textTertiary)
            }
            .frame(maxWidth: 260)
        }
        .buttonStyle(.plain)
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
                    // The viewer is keyed on the message id (`viewerAt`), so
                    // the thumbnail wears the same value — the zoom and the
                    // pager cannot disagree about which photo was tapped. A
                    // no-op wherever no namespace was provided; a thread
                    // renders these bubbles without one.
                    .mediaZoomSource(message.id)
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
                    // A vote arriving moves every bar at once — sliding is
                    // what makes that read as redistribution, not repaint.
                    .animation(.spring(response: 0.35, dampingFraction: 0.85), value: fraction)

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
                        .contentTransition(.numericText(value: Double(option.voteCount)))
                        .animation(.snappy(duration: 0.25), value: option.voteCount)
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
    /// id → display name, so a line can say who rather than "Someone".
    var names: [String: String] = [:]

    var body: some View {
        if let system = message.system {
            Text(text(system))
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 14)
                .padding(.vertical, 6)
                .background(colors.dark.opacity(0.10), in: Capsule())
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
        }
    }

    /// The server's answer first, the roster second.
    ///
    /// The roster loads after the timeline does, so preferring it meant every
    /// system line flashed "Someone added someone" for as long as that request
    /// took — and settled there permanently for anyone who had since left, who
    /// appears in no roster to look up.
    private func name(_ id: String) -> String? {
        message.systemNames?[id] ?? names[id]
    }

    /// The actor's name, or a graceful fallback for someone no longer loaded.
    private func actor(_ system: SystemPayload) -> String {
        system.actorId.flatMap { name($0) } ?? "Someone"
    }

    /// The targets' names, joined — "Sam", "Sam and Alex", "Sam and 2 others".
    private func targets(_ system: SystemPayload) -> String {
        let resolved = system.targetIds.map { name($0) ?? "someone" }
        switch resolved.count {
        case 0: return "someone"
        case 1: return resolved[0]
        case 2: return "\(resolved[0]) and \(resolved[1])"
        default: return "\(resolved[0]) and \(resolved.count - 1) others"
        }
    }

    private func text(_ system: SystemPayload) -> String {
        switch system.event {
        case "conversation_created": return "\(actor(system)) created the group"
        case "member_added": return "\(actor(system)) added \(targets(system))"
        case "member_joined": return "\(actor(system)) joined"
        case "member_left": return "\(actor(system)) left"
        case "member_removed": return "\(actor(system)) removed \(targets(system))"
        case "member_promoted": return "\(actor(system)) promoted \(targets(system))"
        case "member_demoted": return "\(actor(system)) demoted \(targets(system))"
        case "title_changed":
            return "\(actor(system)) renamed the group" + (system.value.map { " to \"\($0)\"" } ?? "")
        case "avatar_changed": return "\(actor(system)) changed the group photo"
        case "message_pinned": return "\(actor(system)) pinned a message"
        // Worth spelling out: someone scrolling up will find the group's whole
        // history above this line and should know why it is here.
        case "upgraded_to_space": return "This group became a space — its history lives here now"
        case "channel_created":
            return "Channel created" + (system.value.map { " · #\($0)" } ?? "")
        case "disappearing_changed":
            return system.value == "0" ? "Disappearing messages off" : "Disappearing messages on"
        case "campfire_ending":
            return "🔥 This campfire is ending soon — say your goodbyes"
        // Deliberately plain. "Took a screenshot" is what happened; anything
        // warier would imply the room was sealed until this moment, and it
        // never was.
        case "screenshot_taken":
            return "📸 \(actor(system)) took a screenshot"
        default:
            return system.event.replacingOccurrences(of: "_", with: " ")
        }
    }
}

// ── Reaction chip ────────────────────────────────────────────────────────────

/// The room's custom emoji, name → image URL, provided by ChatScreen. An
/// environment value rather than a parameter because it would otherwise
/// thread through every surface that draws a bubble for one chip's benefit.
private struct CustomEmojiKey: EnvironmentKey {
    static let defaultValue: [String: URL] = [:]
}

extension EnvironmentValues {
    var customEmoji: [String: URL] {
        get { self[CustomEmojiKey.self] }
        set { self[CustomEmojiKey.self] = newValue }
    }
}

/// One emoji-and-count capsule under a bubble.
///
/// Its own view so it can own the pop: a spring overshoot whenever the count
/// moves or your own reaction lands, plus a tick of haptic on the tap itself.
/// Reactions are the most-pressed playful surface in the app, and they used to
/// just silently change.
private struct ReactionChip: View {
    @Environment(\.neu) private var colors
    @Environment(\.customEmoji) private var customEmoji

    let emoji: String
    let count: Int
    let mine: Bool
    let onTap: () -> Void

    @State private var pop = false
    /// The burst in flight when your own reaction lands. An id rather than a
    /// flag, so a second landing mid-flight starts a fresh burst instead of
    /// being swallowed by the first one's cleanup.
    @State private var burstId: UUID?

    /// A `:name:` key that resolves in this room draws as the image; one that
    /// does not falls back to its literal text, as every build always has.
    private var customUrl: URL? {
        guard emoji.count > 2, emoji.hasPrefix(":"), emoji.hasSuffix(":") else { return nil }
        return customEmoji[String(emoji.dropFirst().dropLast())]
    }

    var body: some View {
        HStack(spacing: 4) {
            if let url = customUrl {
                AsyncImage(url: url) { image in
                    image.resizable().scaledToFit()
                } placeholder: {
                    Color.clear
                }
                .frame(width: 18, height: 18)
            } else {
                Text(emoji).font(YappyFont.labelMedium)
            }
            if count > 1 {
                Text("\(count)")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(mine ? colors.accent : colors.textTertiary)
                    .contentTransition(.numericText())
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        // Flat, like the bubbles they belong to. Yours are tinted with
        // the accent — colour is the "you did this" signal.
        .background(mine ? colors.accentSoft : colors.incoming, in: Capsule())
        /**
         * A ring in the sheet colour, so the chip reads as a separate object
         * sitting on the bubble instead of a hole punched in it.
         *
         * Load-bearing on an incoming message, where the chip's own fill *is*
         * `colors.incoming` — the same colour as the bubble beneath it. Without
         * the ring the two merge into one blob the moment they overlap, and the
         * count appears to float inside the message.
         */
        .padding(1.5)
        .background(colors.surface, in: Capsule())
        .scaleEffect(pop ? 1.3 : 1)
        .animation(.spring(response: 0.26, dampingFraction: 0.45), value: pop)
        .overlay {
            if let burstId {
                EmojiBurst(emoji: emoji, copies: 2, glyphSize: 15).id(burstId)
            }
        }
        .softTap {
            Haptics.tap()
            onTap()
        }
        .onChange(of: count) { _, _ in bounce() }
        .onChange(of: mine) { was, now in
            bounce()
            // Only the false→true edge: that is *your* reaction landing, and
            // the one moment worth throwing the emoji in the air. Chips are
            // torn down and rebuilt as rows scroll, so anything keyed on mere
            // presence would burst at old reactions on the way past. A custom
            // `:name:` key sits this out — the burst draws text, and a
            // shortcode thrown in the air is just its spelling.
            if !was, now, customUrl == nil { launchBurst() }
        }
    }

    private func bounce() {
        pop = true
        Task {
            try? await Task.sleep(for: .milliseconds(130))
            pop = false
        }
    }

    private func launchBurst() {
        let fired = UUID()
        burstId = fired
        Task {
            try? await Task.sleep(for: .milliseconds(850))
            if burstId == fired { burstId = nil }
        }
    }
}

// ── Emoji detection ──────────────────────────────────────────────────────────

extension Character {
    /// True for a character that is *drawn* as emoji.
    ///
    /// `Unicode.Scalar.Properties.isEmoji` alone is not enough: it is true for
    /// plain ASCII digits and `#` and `*`, because those form the base of the
    /// keycap sequences (0️⃣, #️⃣). Taking it at face value makes "123" an
    /// emoji-only message and blows it up to 56pt.
    ///
    /// So: a multi-scalar grapheme carrying an emoji scalar is emoji (flags,
    /// skin tones, ZWJ families, keycaps). A single scalar is emoji only if it
    /// defaults to emoji presentation, which is exactly the set that excludes
    /// the ASCII bases.
    var isPureEmoji: Bool {
        guard let first = unicodeScalars.first, first.properties.isEmoji else { return false }
        return unicodeScalars.count > 1 || first.properties.isEmojiPresentation
    }
}
