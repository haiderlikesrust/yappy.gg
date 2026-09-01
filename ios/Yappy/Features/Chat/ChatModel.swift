import Combine
import Foundation
import SwiftUI

struct TypingUser {
    let userId: String
    let expiresAt: Date
}

/// The composer's own state, in its own object.
///
/// `draft` used to be `@Published` beside `messages`, so every character typed
/// published a change on the model the *whole* chat screen observes — re-running
/// its body, and with it the timeline, once per keystroke. Nothing above the
/// composer has any use for a half-typed sentence.
///
/// A nested `ObservableObject` does not forward its changes to its parent's
/// `objectWillChange`. Everywhere else that is the footgun people trip over;
/// here it is exactly the point. Only the two views that actually draw the
/// draft — the composer and the slash-command panel — observe this, and only
/// they redraw.
/// Two bits out of the permission bitfield, mirrored from the server.
///
/// Duplicated rather than fetched because they are part of the wire format and
/// cannot change without a coordinated release anyway — and a composer that has
/// to round-trip before it can decide whether to offer `@everyone` is a
/// composer that offers nothing offline.
private let chatMentionAll: Int64 = 1 << 9
private let chatAdministrator: Int64 = 1 << 62
@MainActor
final class ComposerState: ObservableObject {
    @Published var draft = ""
}

@MainActor
final class ChatModel: ObservableObject {
    /// What a client that cannot decrypt shows instead of the message —
    /// the same sentence the server stores in `content` for every encrypted
    /// message. Written out because the app has no import of the shared
    /// package.
    private static let encryptedNotice = "This message is encrypted. Update yappy to read it."
    @Published private(set) var conversation: Conversation?
    @Published private(set) var messages: [Message] = [] {
        didSet { rebuildTimeline() }
    }

    @Published private(set) var pinned: [Message] = [] {
        didSet { pinnedIds = Set(pinned.map(\.id)) }
    }

    @Published private(set) var loading = true
    @Published private(set) var loadingOlder = false
    @Published private(set) var hasMore = true
    @Published private(set) var members: [String: PublicUser] = [:] {
        didSet { rebuildMembers() }
    }

    @Published private(set) var commands: [BotCommand] = []

    /// Roles this viewer may ping, already filtered.
    ///
    /// A role marked mentionable can be called by anyone who can speak here;
    /// one that is not takes MENTION_ALL, the same permission `@everyone`
    /// needs — pinging every moderator is the same act as pinging the room,
    /// just aimed.
    @Published private(set) var mentionableRoles: [RoleEntry] = []
    /**
     * The sibling channels a `#` can point at.
     *
     * Already filtered by the server: `GET /:id/channels` omits the ones this
     * account cannot see, so offering the list is not a way to learn that a
     * private channel exists. Voice rooms and this channel itself are dropped
     * here — there is no timeline to land on in a call, and linking where you
     * already are is noise.
     *
     * Empty for a DM and for a plain group, which have no siblings.
     */
    @Published private(set) var mentionableChannels: [ChannelEntry] = []
    /// This room's own emoji: for the picker, and for turning a typed
    /// `:shortcode:` into an entity on the way out.
    @Published private(set) var customEmojis: [CustomEmoji] = []
    @Published private(set) var canMentionAll = false
    @Published private(set) var meId: String? {
        didSet { rebuildMembers(); rebuildReceipts() }
    }

    @Published private(set) var typing: [TypingUser] = []
    @Published private(set) var stickerPacks: [StickerPack] = []
    @Published private(set) var recentStickers: [Sticker] = []
    @Published private(set) var gifs: [GifResult] = []
    @Published private(set) var gifsLoading = false
    /// customId of a button waiting on the server, so it can show a spinner.
    @Published private(set) var pressingComponent: String?
    /// What the list that sent us here already knew, drawn until the real
    /// conversation lands.
    @Published private(set) var headerSeed: ChatHeaderSeed?

    /// Flair the bubbles, wash and composer wear before the conversation
    /// fetch lands — whatever the list that sent us here already knew.
    var appearance: ConversationAppearance? {
        conversation?.appearance ?? headerSeed?.appearance
    }

    /// A board's posture is on the space list's channel row. Waiting for the
    /// conversation fetch to say so draws a chat and then flips it into a page.
    var isBoard: Bool {
        conversation?.isBoard ?? headerSeed?.isBoard ?? false
    }

    var isForum: Bool {
        conversation?.isForum ?? headerSeed?.isForum ?? false
    }
    /// userId → their read/delivered watermarks. The ticks on outgoing bubbles
    /// and the seen-by sheet are both views over this one dictionary.
    @Published private(set) var receipts: [String: ReceiptEntry] = [:] {
        didSet { rebuildReceipts() }
    }
    /// Who else has this conversation open right now — ambient co-presence.
    /// Not "who is online": these people are looking at *this room*, which is
    /// the difference between a chat and a place.
    @Published private(set) var viewers: [PublicUser] = []
    /// messageId → where that share is now. Only the ones still moving.
    @Published private(set) var liveLocations: [String: LiveLocation] = [:]
    /// What was missed, when there is enough of it to be worth a card. Cleared
    /// on dismissal — by then they have caught up and it is just in the way.
    @Published private(set) var catchUp: CatchUp?
    @Published var error: String?

    /// Deliberately not `@Published` — see `ComposerState`.
    let composer = ComposerState()

    /// The draft, reachable exactly where it always was. Every send, edit,
    /// cancel and restore path in here writes through this and none of them
    /// need to know the storage moved.
    var draft: String {
        get { composer.draft }
        set { composer.draft = newValue }
    }

    @Published var replyTo: Message?
    @Published var editing: Message?
    /// The room's custom emoji, name → image URL — `:name:` reaction keys
    /// resolve here and draw as images.
    @Published var customEmoji: [String: URL] = [:]
    @Published var gifQuery = ""

    // ── Derived from `messages`, on write ────────────────────────────────────
    //
    // `ChatScreen`'s body re-runs on *any* published change on this model — a
    // keystroke in the composer, someone else's typing indicator, a read
    // receipt, a live location ping. It used to rebuild both of these itself
    // each time: two allocations the length of the loaded history, per
    // character typed, for an order that had not changed.

    /// `messages` newest-first, which is the order the flipped timeline draws.
    private(set) var orderedMessages: [Message] = []

    /// id → position in `orderedMessages`, so a row can find the messages
    /// either side of it — for day separators and bubble grouping — without
    /// the view materialising `Array(enumerated())` on every draw.
    private(set) var timelineIndex: [String: Int] = [:]

    private func rebuildTimeline() {
        orderedMessages = Array(messages.reversed())

        // Built by hand rather than with `Dictionary(uniqueKeysWithValues:)`,
        // which traps on a duplicate key — a transient double-insert while an
        // optimistic send settles would become a crash. First position wins.
        var index: [String: Int] = [:]
        index.reserveCapacity(orderedMessages.count)
        for (offset, message) in orderedMessages.enumerated() where index[message.id] == nil {
            index[message.id] = offset
        }
        timelineIndex = index
    }

    private var conversationId = ""
    private var container: AppContainer?
    private var cancellables = Set<AnyCancellable>()
    private var typingTask: Task<Void, Never>?
    private var readAckTask: Task<Void, Never>?
    /// The highest seq the user has actually had on screen, and the highest the
    /// server has been told about.
    private var highestRead: Int64 = 0
    private var ackedRead: Int64 = 0
    private var gifTask: Task<Void, Never>?
    private var sweeper: Task<Void, Never>?
    private var lastTypingSent = Date.distantPast
    private var started = false

    var typingLabel: String? {
        let now = Date()
        let active = typing.filter { $0.expiresAt > now }
        guard !active.isEmpty else { return nil }

        let names = active.compactMap { members[$0.userId]?.label }
        switch names.count {
        case 0: return "typing…"
        case 1: return "\(names[0]) is typing…"
        case 2: return "\(names[0]) and \(names[1]) are typing…"
        default: return "\(names.count) people are typing…"
        }
    }

    /// id → display name, so system lines can say who joined or was added.
    ///
    /// Stored, not computed. Every bubble is handed this, and the row builder
    /// runs per visible message per body pass — so a computed `mapValues` was
    /// a fresh dictionary the size of the membership, a dozen times over, for
    /// every character typed into the composer. It changes when the member list
    /// changes, which is roughly never.
    private(set) var memberNames: [String: String] = [:]

    /// The pinned set, for the "is this one pinned" question each row asks.
    /// `pinned` itself stays an array — the pinned *bar* draws it in order.
    private(set) var pinnedIds: Set<String> = []

    /// The read watermark as it stood when this visit opened — the seq the
    /// "New messages" divider sits above. Captured exactly once, because
    /// `flushRead` moves `lastReadSeq` forward the moment these messages are
    /// looked at, and the line marks where the *visit* started, not the latest
    /// thing the server believes. Not `@Published`: it is set in the same pass
    /// that publishes `conversation`, which already redraws the screen.
    private(set) var unreadMarkerSeq: Int64?

    /// Everyone who can be @-mentioned here — the composer's autocomplete pool.
    ///
    /// Stored for the same reason as `memberNames`: the composer redraws on
    /// every keystroke by definition, and it was sorting the entire membership
    /// each time to hand over a list that had not changed.
    private(set) var mentionable: [PublicUser] = []

    private func rebuildMembers() {
        memberNames = members.mapValues(\.label)
        mentionable = members.values
            .filter { $0.id != meId }
            .sorted { $0.label < $1.label }
    }


    // ── Receipts ─────────────────────────────────────────────────────────────

    /// The tick an outgoing bubble shows.
    ///
    /// DMs get the full WhatsApp ladder. Groups skip the delivered rung on
    /// purpose: "delivered to all" needs every member's watermark aggregated
    /// live, and the honest signals a group actually has are "it is on the
    /// server" and "everyone has read it" — the in-between is what the seen-by
    /// sheet is for.
    func receiptState(for message: Message) -> MessageReceiptState {
        guard message.senderId == meId else { return .none }
        if message.isPending { return .pending }
        guard otherReceiptCount > 0 else { return .sent }

        if conversation?.type == "dm" {
            guard let theirs = dmReceipt else { return .sent }
            if theirs.seq >= message.seq { return .read }
            if theirs.deliveredSeq >= message.seq { return .delivered }
            return .sent
        }

        return lowestReadSeq >= message.seq ? .read : .sent
    }

    // ── Derived from `receipts`, on write ────────────────────────────────────
    //
    // This is asked once per visible outgoing bubble, on every body pass. It
    // used to `filter` the dictionary's values into a fresh array each time —
    // an allocation per bubble, per keystroke — to answer two questions that do
    // not depend on the message at all.

    /// How many watermarks belong to somebody other than you.
    private(set) var otherReceiptCount = 0

    /// How far the *least* caught-up of them has read. Asking whether everyone
    /// has read a message is exactly asking whether this is past its seq, which
    /// is the `allSatisfy` walk without the walk.
    private(set) var lowestReadSeq: Int64 = 0

    /// The other party in a DM — where there is only ever one of them.
    private(set) var dmReceipt: ReceiptEntry?

    private func rebuildReceipts() {
        var count = 0
        var lowest = Int64.max
        var peer: ReceiptEntry?

        for entry in receipts.values where entry.user.id != meId {
            count += 1
            lowest = min(lowest, entry.seq)
            peer = entry
        }

        otherReceiptCount = count
        lowestReadSeq = count == 0 ? 0 : lowest
        dmReceipt = peer
    }

    /// Who has read this message — the seen-by sheet. Excludes the sender;
    /// members who turned read receipts off are absent from the source data.
    func seenBy(_ message: Message) -> [ReceiptEntry] {
        receipts.values
            .filter { $0.user.id != message.senderId && $0.seq >= message.seq }
            .sorted { $0.user.label < $1.user.label }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    func start(_ container: AppContainer, conversationId: String) {
        guard !started else {
            // Coming back — most often from group settings, where an emoji
            // may just have been made. There is no gateway event for that,
            // so re-appearing is the moment to ask again; otherwise a new
            // :shortcode: needs the whole chat closed and reopened to exist.
            refreshCustomEmojis()
            return
        }
        started = true
        self.container = container
        self.conversationId = conversationId
        meId = container.session.userId
        headerSeed = container.headerSeeds[conversationId]

        load()
        observeGateway(container)
        refreshPickers()
    }

    func stop() {
        container?.gateway.typing(conversationId, started: false)
        // Leaving the screen is leaving the room. Nil rather than another
        // conversation id, because what comes next may not be a chat at all.
        container?.gateway.setViewing(nil)
        typingTask?.cancel()
        readAckTask?.cancel()
        sweeper?.cancel()

        // Hand the timeline over before anything can return early below — this
        // is what the next visit draws, and it has to include the message that
        // was just sent. Pending rows are dropped: a placeholder restored as a
        // placeholder would sit there for ever with no request behind it.
        container?.rememberTimeline(
            messages.filter { !$0.isPending },
            receipts: receipts,
            for: conversationId
        )

        // Leaving is the last chance to record what was read — the 500ms
        // debounce is very often still pending when someone glances at a
        // channel and taps straight back.
        guard let container, highestRead > ackedRead else { return }
        let seq = highestRead
        let id = conversationId
        let repo = container.repo
        ackedRead = seq
        // Detached, because this model is being torn down with the view and a
        // task owned by it would be cancelled before the request went out.
        Task.detached { _ = try? await repo.markRead(id, seq: seq) }
        container.conversationRead.send(id)
    }

    private func load() {
        guard let container else { return }

        // Paint the last-seen page while the real one is fetched. Read marks
        // and the subscription wait for the fresh copy — acting on a cached
        // page would acknowledge messages the person has not seen yet.
        //
        // Memory first, disk only as the cold-start fallback. The disk slot is
        // written when a *fetch* completes, so it is a snapshot of the chat as
        // it was when you last opened it — send a message and it is instantly
        // out of date. Painting that on re-entry showed the timeline without
        // the message you had just sent, and then the fetch put it back: the
        // message appeared to send itself a second time. What you last had on
        // screen is the honest thing to redraw.
        if messages.isEmpty {
            if let remembered = container.timeline(for: conversationId) {
                messages = remembered.messages
                // Restored together with the messages, or every one of your own
                // bubbles would redraw as a single grey check and then turn
                // blue again as the receipts land.
                receipts = remembered.receipts
                for message in remembered.messages {
                    if let sender = message.sender { members[sender.id] = sender }
                }
                loading = false
            } else if let cached = DiskCache.decode(HistoryEnvelope.self, key: "history_\(conversationId)") {
                messages = cached.messages
                for message in cached.messages {
                    if let sender = message.sender { members[sender.id] = sender }
                }
                // The same reason the memory path restores them, on the path
                // that actually needs it. This is cold start — open the app,
                // open a chat — and receipts arrive on a *third* round trip
                // after the history one, so without this every bubble you have
                // ever sent painted as a single grey check and turned blue a
                // moment later. The memory path never showed it because a
                // return visit within the session still had them in hand.
                if let entries = DiskCache.decode([ReceiptEntry].self, key: "receipts_\(conversationId)") {
                    receipts = Dictionary(
                        entries.map { ($0.user.id, $0) },
                        uniquingKeysWith: { first, _ in first }
                    )
                }
                hasMore = cached.hasMore
                loading = false
            }

            /*
             * The chrome around the timeline, for whichever path painted it.
             *
             * These are a fresh model every time the screen opens, so neither
             * the memory nor the disk path arrives holding them — and both
             * land a fetch after the messages do. The pinned bar sits *above*
             * the timeline, so appearing late shoves every message down a row
             * while the chat is already on screen and being read; the emoji
             * map is the same idea one level down, where a `:name:` reaction
             * on a drawn bubble is its own literal text for a beat and then
             * turns into a picture.
             */
            if !messages.isEmpty {
                if pinned.isEmpty,
                   let cachedPins = DiskCache.decode(PinsEnvelope.self, key: "pins_\(conversationId)") {
                    pinned = cachedPins.pins.map(\.message)
                }
                if customEmoji.isEmpty,
                   let cachedEmoji = DiskCache.decode(GroupEmojisEnvelope.self, key: "emojis_\(conversationId)") {
                    customEmoji = Dictionary(
                        cachedEmoji.emojis.compactMap { emoji in
                            URL(string: emoji.url).map { (emoji.name, $0) }
                        },
                        uniquingKeysWith: { first, _ in first }
                    )
                }
            }
        }

        // Same snapshot GroupScreen and SpaceScreen already paint from.
        // Messages live in a different slot, so a return visit can put the
        // timeline on screen while appearance, isBoard and isForum still
        // wait on the network — a default chat that restyles a beat later.
        if conversation == nil,
           let cached = DiskCache.decode(ConversationEnvelope.self, key: "conversation_\(conversationId)") {
            conversation = cached.conversation
            container.headerSeeds.remember(cached.conversation)
            if headerSeed == nil {
                headerSeed = container.headerSeeds[conversationId]
            }
        }

        Task {
            do {
                // Four fetches, started together. Serially these were four
                // round trips end to end before the first bubble could settle.
                let conversationTask = Task { try await container.repo.conversation(self.conversationId, cacheTo: true).conversation }
                let historyTask = Task { try await container.repo.history(self.conversationId, limit: 50) }
                let pinsTask = Task { (try? await container.repo.pins(self.conversationId).pins.map(\.message)) ?? [] }
                let catchUpTask = Task { try? await container.repo.catchUp(self.conversationId) }

                /*
                 * The timeline lands the moment *its* fetch does.
                 *
                 * These four are started together, but they used to be
                 * collected together too — four `await`s in a row before a
                 * single new message reached the screen. Starting in parallel
                 * only helps if you also stop waiting for the slowest one, and
                 * `catchup` is by far the slowest: it aggregates up to 500
                 * missed messages, their participants, media and mentions, to
                 * draw one summary card. The messages themselves sat behind
                 * that, which is why opening a chat with unread messages
                 * showed the old page for about a second and then jumped.
                 *
                 * So: conversation and history first — the two the timeline
                 * genuinely cannot be drawn correctly without — then the card
                 * and the pins after, when they arrive.
                 */
                let conversation = try await conversationTask.value
                let history = try await historyTask.value

                var people: [String: PublicUser] = members
                if let other = conversation.otherUser { people[other.id] = other }
                for member in conversation.memberPreview { people[member.id] = member }
                for message in history.messages {
                    if let sender = message.sender { people[sender.id] = sender }
                }

                self.conversation = conversation
                // Before `markRead` below can advance the watermark. Zero means
                // a chat never read before — everything is new, and a divider
                // over the entire history says nothing.
                if unreadMarkerSeq == nil, let seq = conversation.selfState?.lastReadSeq, seq > 0 {
                    unreadMarkerSeq = seq
                }
                container.headerSeeds.remember(conversation)
                messages = history.messages
                hasMore = history.hasMore
                loading = false
                draft = conversation.selfState?.draft ?? ""
                members = people

                container.gateway.subscribe(conversationId)
                markRead(upTo: history.messages.last?.seq ?? 0)

                /*
                 * The two that are allowed to be late.
                 *
                 * Pins are painted from disk above on re-entry, so the bar has
                 * already reserved its row and this is a refresh rather than an
                 * arrival; on a genuinely cold chat it appears a beat later,
                 * which is the cost of not holding the messages hostage to it.
                 * The catch-up card is explicitly a summary of what is already
                 * on screen, so it has no business being in front of it.
                 */
                Task { [weak self] in
                    let pins = await pinsTask.value
                    self?.pinned = pins
                }
                Task { [weak self] in
                    let missed = await catchUpTask.value
                    self?.catchUp = missed.flatMap { $0.worthShowing ? $0 : nil }
                }

                // Anything still moving. The socket carries only *changes*, so
                // without this a share that started before we opened the chat
                // draws at the point it began and never moves again.
                Task { [weak self] in
                    guard let self, let container = self.container else { return }
                    if let live = try? await container.repo.liveLocations(self.conversationId).locations {
                        self.liveLocations = Dictionary(uniqueKeysWithValues: live.map { ($0.messageId, $0) })
                    }
                }

                // Ambient co-presence, both halves. The socket only carries
                // *changes*, so without the fetch a room somebody has been
                // sitting in for an hour looks empty; without the announce,
                // they never see us either.
                container.gateway.setViewing(conversationId)
                Task { [weak self] in
                    guard let self, let container = self.container else { return }
                    if let ids = try? await container.repo.viewersHere(self.conversationId).userIds {
                        self.viewers = ids.compactMap { self.members[$0] }
                    }
                }

                // Independent follow-ups, in parallel rather than one after the
                // other. Fetched once per conversation: the command list is
                // small, and the composer must answer a "/" keypress instantly.
                Task { [weak self] in
                    guard let self, let container = self.container else { return }
                    if let list = try? await container.repo.conversationCommands(self.conversationId).commands {
                        self.commands = list
                    }
                }

                /*
                 * The roles that apply here, for the @ picker.
                 *
                 * Asked of the channel; the server resolves it to the space,
                 * which is where roles live. A DM answers with an empty list
                 * and the picker simply has no roles in it.
                 */
                Task { [weak self] in
                    guard let self, let container = self.container else { return }
                    guard self.conversation?.type != "dm" else { return }
                    guard let list = try? await container.repo.roles(self.conversationId).roles else { return }
                    let bits = Int64(self.conversation?.permissions ?? "0") ?? 0
                    let mayAll = bits & chatMentionAll != 0 || bits & chatAdministrator != 0
                    self.canMentionAll = mayAll
                    self.mentionableRoles = list.filter { mayAll || $0.isMentionable }
                }

                // The space's other channels, for `#`. Only a channel has
                // siblings, so a DM or a plain group never asks.
                Task { [weak self] in
                    guard let self, let container = self.container,
                          let spaceId = self.conversation?.parentId
                    else { return }
                    guard let list = try? await container.repo.channels(spaceId).channels else { return }
                    self.mentionableChannels = list.filter {
                        !$0.isVoice && $0.id != self.conversationId
                    }
                }

                /*
                 * The room's own emoji.
                 *
                 * Asked of this conversation rather than its space: the
                 * endpoint answers with the space's too, and asking here is
                 * what makes a plain group work as well as a channel. A DM
                 * never has any — the server refuses to make one there.
                 */
                refreshCustomEmojis()

                // Everyone's read/delivered watermarks, for the ticks. Live
                // receipt events keep it current from here on.
                Task { [weak self] in
                    guard let self, let container = self.container else { return }
                    if let entries = try? await container.repo.receipts(self.conversationId).readBy {
                        self.receipts = Dictionary(
                            entries.map { ($0.user.id, $0) },
                            uniquingKeysWith: { first, _ in first }
                        )
                        // Kept beside the history slot so the next cold start
                        // can paint ticks with the messages rather than a beat
                        // behind them.
                        if let data = try? JSONEncoder().encode(entries) {
                            DiskCache.write(data, key: "receipts_\(self.conversationId)")
                        }
                    }
                }


                // Full member list for @-mention autocomplete. Groups only — a
                // DM's two participants are already in the map.
                if conversation.type != "dm" {
                    Task { [weak self] in
                        guard let self, let container = self.container else { return }
                        if let list = try? await container.repo.members(self.conversationId).members {
                            for entry in list { self.members[entry.user.id] = entry.user }
                        }
                    }
                }
            } catch let failure as ApiError {
                loading = false
                error = failure.message
            } catch {
                loading = false
            }
        }
    }

    /// Page in the previous fifty messages.
    ///
    /// Nothing here has to preserve a scroll position. The timeline is drawn
    /// inverted, so a prepend lands at the far end from the scroll anchor and
    /// the reader simply gains more history above them — which is also why this
    /// can be fired the moment the oldest bubble comes into view, with no
    /// "has the user scrolled yet" gate.
    func loadOlder() async {
        guard let container, !loadingOlder, hasMore, let oldest = messages.first?.seq else { return }
        loadingOlder = true
        defer { loadingOlder = false }

        guard let page = try? await container.repo.history(conversationId, before: oldest, limit: 50) else {
            return
        }
        // Prepend, and de-duplicate by id: a live event can land in the same
        // window a page request is covering.
        var seen = Set(messages.map(\.id))
        let fresh = page.messages.filter { seen.insert($0.id).inserted }
        guard !fresh.isEmpty else {
            hasMore = page.hasMore
            return
        }
        messages = fresh + messages
        hasMore = page.hasMore
        for message in fresh {
            if let sender = message.sender { members[sender.id] = sender }
        }
    }

    /// Called on chat start, and again every time the picker opens. The reopen
    /// matters: packs made mid-session (the @yapper flow) appeared only after
    /// an app restart, because this had run exactly once. The old data stays on
    /// screen while the refresh lands, so an open picker never blanks.
    func refreshPickers() {
        guard let container else { return }
        Task {
            if let packs = try? await container.repo.installedPacks().packs { stickerPacks = packs }
            if let recent = try? await container.repo.recentStickers().stickers { recentStickers = recent }
            if let recentGifs = try? await container.repo.recentGifs().results { gifs = recentGifs }
        }
        // The group's own emoji ride the same rule the comment above states
        // for packs: fresh on every open, so one made a minute ago is
        // already in the drawer.
        refreshCustomEmojis()
    }

    /**
     * Both halves of the custom-emoji vocabulary, re-asked together.
     *
     * `customEmojis` is what the picker lists and what the composer's
     * `:shortcode:` scan matches against; `customEmoji` is the name -> url
     * map reaction keys draw from. They were fetched once at start, which
     * meant an emoji added mid-session did not exist here until the chat was
     * closed and reopened: the picker missed it, and a typed `:name:` went
     * out as plain text because the scan had never heard of it.
     *
     * Failure costs nothing — the stale lists stay, unresolved keys stay text.
     */
    func refreshCustomEmojis() {
        guard let container, conversation?.type != "dm" else { return }
        Task { [weak self] in
            guard let self, let container = self.container else { return }
            if let list = try? await container.repo.customEmojis(self.conversationId).emojis {
                self.customEmojis = list
            }
            if let list = try? await container.repo.groupEmojis(self.conversationId).emojis {
                self.customEmoji = Dictionary(
                    list.compactMap { emoji in URL(string: emoji.url).map { (emoji.name, $0) } },
                    uniquingKeysWith: { first, _ in first }
                )
            }
        }
    }

    // ── Composing ────────────────────────────────────────────────────────────

    /**
     * The draft is spent — clear it here *and* on the server.
     *
     * Clearing the local one was all that happened, and the server kept the
     * text. Drafts are restored on open, so sending a message and then leaving
     * the chat put what you had just sent straight back into the composer when
     * you returned: `/badge @someone` typed once, sent, and waiting in the box
     * for ever after.
     *
     * The pending typing task would eventually have written the empty draft, so
     * this only bit people who left within four seconds of sending — which is
     * most people, most of the time, because sending is often the last thing
     * you do in a chat.
     *
     * Detached, because the common case is leaving immediately afterwards and a
     * task owned by this model is cancelled the moment the screen goes.
     */
    private func clearDraft() {
        guard let container else { return }
        draft = ""
        typingTask?.cancel()
        lastTypingSent = .distantPast
        container.gateway.typing(conversationId, started: false)

        let id = conversationId
        let repo = container.repo
        Task.detached { _ = try? await repo.setConversationState(id, draft: "") }
    }

    func draftChanged() {
        guard let container else { return }

        // Throttled to one every three seconds: the server refreshes an 8s TTL,
        // so anything faster is wasted frames on every other member's device.
        let now = Date()
        if !draft.isEmpty, now.timeIntervalSince(lastTypingSent) > 3 {
            lastTypingSent = now
            container.gateway.typing(conversationId, started: true)
        }

        typingTask?.cancel()
        typingTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard !Task.isCancelled, let self else { return }
            container.gateway.typing(conversationId, started: false)
            lastTypingSent = .distantPast
            // The draft is synced to the server so it follows the user across
            // devices, but only once they stop typing.
            _ = try? await container.repo.setConversationState(conversationId, draft: draft)
        }
    }

    /// Put the card away.
    func dismissCatchUp() {
        catchUp = nil
    }

    func setReplyTo(_ message: Message?) {
        replyTo = message
        editing = nil
    }

    func startEditing(_ message: Message) {
        editing = message
        draft = message.content ?? ""
        replyTo = nil
    }

    func cancelEditing() {
        editing = nil
        clearDraft()
    }

    /// Send with an optimistic bubble.
    ///
    /// The nonce is generated here and reused as the local message id, so when
    /// the server's copy arrives over the socket it replaces the placeholder
    /// instead of appearing beside it.
    func send() {
        guard let container else { return }
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }

        if let target = editing {
            clearDraft()
            editing = nil
            Task {
                if let updated = try? await container.repo.editMessage(
                    conversationId, messageId: target.id, content: text
                ) {
                    replace(updated.message)
                }
            }
            return
        }

        let nonce = YappyRepository.newNonce()
        let pendingReply = replyTo
        let optimistic = Message(
            id: nonce,
            conversationId: conversationId,
            seq: Message.pendingSeq,
            type: "text",
            content: text,
            sender: meId.flatMap { members[$0] },
            senderId: meId,
            replyTo: pendingReply.map {
                ReplyStub(id: $0.id, seq: $0.seq, senderId: $0.senderId, preview: $0.content, type: $0.type)
            },
            createdAt: YappyTime.now(),
            nonce: nonce
        )

        withAnimation(Self.arrival) { messages.append(optimistic) }
        clearDraft()
        replyTo = nil
        container.gateway.typing(conversationId, started: false)

        Task {
            do {
                /// A private send, when this chat is flagged and the build
                /// allows it. Nil envelopes means there was nobody to encrypt
                /// to, and the message goes out in the clear rather than being
                /// posted where nobody in the room can read it.
                let recipients = [container.session.userId, conversation?.otherUser?.id]
                    .compactMap { $0 }
                let envelopes = container.e2e.isPrivate(conversationId)
                    ? await container.e2e.sealFor(memberIds: recipients, plaintext: text)
                    : nil

                let sent = try await container.repo.sendText(
                    conversationId,
                    text: envelopes == nil ? text : Self.encryptedNotice,
                    nonce: nonce,
                    replyToId: pendingReply?.id,
                    mentions: envelopes == nil ? mentionSpans(in: text) : [],
                    envelopes: envelopes ?? []
                )

                // What we said, written down before anything else happens to it.
                // There is no envelope addressed to the sending device — a ratchet
                // cannot talk to itself — so this is the only copy of an outgoing
                // message that survives a relaunch.
                if envelopes != nil {
                    await container.e2e.rememberOwn(sent.message.id, text)
                }
                replacePending(nonce: nonce, with: sent.message)
            } catch let failure as ApiError {
                // Leave the bubble in place but surface the reason — silently
                // dropping a message the user watched appear is much worse.
                error = failure.message
            } catch {
                self.error = "Could not send that."
            }
        }
    }

    /// Send a picked photo.
    ///
    /// The bubble appears immediately showing the *local* file, so the upload
    /// happens behind something the user can already see. A failed upload
    /// removes the bubble and surfaces the reason rather than leaving a
    /// permanent ghost.
    /// Send a picked image or video.
    ///
    /// The caption arrives as an argument rather than being lifted off the
    /// draft. It used to be whatever happened to be in the composer when the
    /// picker was opened — text written before choosing the picture, silently
    /// attached to it and cleared from the box. It is now written on the
    /// preview, about the image visibly in front of you.
    func sendImage(_ picked: AttachmentUploader.Picked, caption captionText: String? = nil) {
        guard let container else { return }
        let nonce = YappyRepository.newNonce()
        let caption = (captionText ?? draft).trimmingCharacters(in: .whitespacesAndNewlines)
        let localUrl = LocalMediaCache.shared.store(picked.data, id: nonce)
        // The library picker hands over videos too, now that it accepts them.
        let isVideo = picked.mimeType.hasPrefix("video/")

        let optimistic = Message(
            id: nonce,
            conversationId: conversationId,
            seq: Message.pendingSeq,
            type: isVideo ? "video" : "image",
            content: caption.isEmpty ? nil : caption,
            sender: meId.flatMap { members[$0] },
            senderId: meId,
            attachments: [
                Attachment(
                    id: nonce,
                    url: localUrl,
                    mimeType: picked.mimeType,
                    width: picked.width,
                    height: picked.height,
                    durationMs: picked.durationMs
                ),
            ],
            createdAt: YappyTime.now(),
            nonce: nonce
        )

        withAnimation(Self.arrival) { messages.append(optimistic) }
        clearDraft()

        Task {
            do {
                let uploaded = try await container.uploader.upload(picked)
                let sent = try await container.repo.sendAttachment(
                    conversationId,
                    attachmentIds: [uploaded.mediaId],
                    caption: caption.isEmpty ? nil : caption,
                    type: isVideo ? "video" : "image",
                    nonce: nonce
                )
                replacePending(nonce: nonce, with: sent.message)
            } catch {
                withAnimation(Self.arrival) { messages.removeAll { $0.id == nonce } }
                self.error = (error as? ApiError)?.message ?? "Could not send that"
            }
            LocalMediaCache.shared.discard(id: nonce)
        }
    }

    /// Send a recorded voice note.
    func sendVoiceNote(data: Data, durationMs: Int) {
        guard let container else { return }
        let nonce = YappyRepository.newNonce()
        let localUrl = LocalMediaCache.shared.store(data, id: nonce)

        let optimistic = Message(
            id: nonce,
            conversationId: conversationId,
            seq: Message.pendingSeq,
            type: "audio",
            sender: meId.flatMap { members[$0] },
            senderId: meId,
            attachments: [
                Attachment(id: nonce, url: localUrl, mimeType: "audio/mp4", durationMs: durationMs),
            ],
            createdAt: YappyTime.now(),
            nonce: nonce
        )
        withAnimation(Self.arrival) { messages.append(optimistic) }

        Task {
            do {
                let picked = AttachmentUploader.Picked(
                    data: data,
                    filename: "voice-note-\(nonce).m4a",
                    mimeType: "audio/mp4",
                    durationMs: durationMs
                )
                let uploaded = try await container.uploader.upload(picked)
                let sent = try await container.repo.sendAttachment(
                    conversationId, attachmentIds: [uploaded.mediaId], type: "audio", nonce: nonce
                )
                replacePending(nonce: nonce, with: sent.message)
            } catch {
                withAnimation(Self.arrival) { messages.removeAll { $0.id == nonce } }
                self.error = (error as? ApiError)?.message ?? "Could not send the voice note"
            }
            LocalMediaCache.shared.discard(id: nonce)
        }
    }

    /// Send a just-recorded video note. The file is the recorder's temp .mov;
    /// consumed and deleted here.
    func sendVideoNote(fileUrl: URL, durationMs: Int) {
        guard let container, let data = try? Data(contentsOf: fileUrl) else { return }
        try? FileManager.default.removeItem(at: fileUrl)

        let nonce = YappyRepository.newNonce()
        let localUrl = LocalMediaCache.shared.store(data, id: nonce)

        let optimistic = Message(
            id: nonce,
            conversationId: conversationId,
            seq: Message.pendingSeq,
            type: "video",
            sender: meId.flatMap { members[$0] },
            senderId: meId,
            attachments: [
                // The filename is the marker that draws this as a circle
                // rather than a rectangle, here and on every other client.
                Attachment(
                    id: nonce,
                    url: localUrl,
                    mimeType: "video/quicktime",
                    durationMs: durationMs,
                    filename: "video-note-\(nonce).mov"
                ),
            ],
            createdAt: YappyTime.now(),
            nonce: nonce
        )
        withAnimation(Self.arrival) { messages.append(optimistic) }

        Task {
            do {
                let picked = AttachmentUploader.Picked(
                    data: data,
                    filename: "video-note-\(nonce).mov",
                    mimeType: "video/quicktime",
                    durationMs: durationMs
                )
                let uploaded = try await container.uploader.upload(picked)
                let sent = try await container.repo.sendAttachment(
                    conversationId, attachmentIds: [uploaded.mediaId], type: "video", nonce: nonce
                )
                replacePending(nonce: nonce, with: sent.message)
            } catch {
                withAnimation(Self.arrival) { messages.removeAll { $0.id == nonce } }
                self.error = (error as? ApiError)?.message ?? "Could not send the video note"
            }
            LocalMediaCache.shared.discard(id: nonce)
        }
    }

    func sendSticker(_ sticker: Sticker) {
        guard let container else { return }
        Task {
            if let sent = try? await container.repo.sendSticker(conversationId, stickerId: sticker.id) {
                appendIfMissing(sent.message)
            }
        }
    }

    func sendGif(_ gif: GifResult) {
        guard let container else { return }
        Task {
            if let sent = try? await container.repo.sendGif(conversationId, gif: gif) {
                appendIfMissing(sent.message)
            }
            _ = try? await container.repo.rememberGif(gif)
        }
    }

    func sendPoll(question: String, options: [String], multiSelect: Bool) {
        guard let container else { return }
        Task {
            if let sent = try? await container.repo.sendPoll(
                conversationId, question: question, options: options, multiSelect: multiSelect
            ) {
                appendIfMissing(sent.message)
            }
        }
    }

    /// Press a button on a bot's message.
    ///
    /// Not optimistic. Everywhere else in this app a local guess is right often
    /// enough to be worth it, but a button's effect is the bot's to decide — it
    /// may approve a sign-in, refuse, or find the request already expired — and
    /// showing an outcome we invented would sometimes be a lie about something
    /// that matters. So: spinner, then whatever the server says the message now
    /// is.
    func pressComponent(_ button: MessageButton, messageId: String) {
        guard let container, pressingComponent == nil else { return }
        pressingComponent = button.customId

        Task {
            defer { pressingComponent = nil }
            do {
                let updated = try await container.repo.pressComponent(
                    conversationId, messageId: messageId, customId: button.customId
                )
                replace(updated.message)
            } catch let failure as ApiError {
                error = failure.message
            } catch {}
        }
    }

    /// Mentions are derived from the final text rather than tracked while
    /// typing: whatever "@username" tokens survive editing are what gets sent,
    /// which matches what the user sees.
    /// Offsets are UTF-16 code units, not Swift `Character`s.
    ///
    /// The whole stack that reads these back is JavaScript, where a string is
    /// indexed by UTF-16 code unit, and Android emits `String.indexOf`, which is
    /// the same. Counting graphemes here meant any mention typed after an emoji
    /// was stored a unit or two short of where it actually is — one offset for
    /// "🎉", seven for a family emoji.
    /// Every `@` in a draft, resolved.
    ///
    /// Order matters. `@everyone` first, then roles longest-name-first — a
    /// role called `Mod` and a role called `Mod Team` both start at the same
    /// `@`, and the shorter one winning would leave ` Team` as prose — then
    /// usernames. A stretch already claimed is skipped, because the server
    /// and every renderer walk these as a flat, non-overlapping list.
    private func mentionSpans(in text: String) -> [YappyRepository.MentionSpan] {
        var spans: [YappyRepository.MentionSpan] = []
        var taken: [Range<Int>] = []

        func scan(
            _ needle: String,
            wordBounded: Bool,
            make: (Int, Int) -> YappyRepository.MentionSpan
        ) {
            var searchFrom = text.startIndex
            while let found = text.range(of: needle, range: searchFrom ..< text.endIndex) {
                searchFrom = found.upperBound
                let after = found.upperBound < text.endIndex ? text[found.upperBound] : nil
                // A trailing letter or digit means this is a longer name that
                // merely starts with ours.
                if wordBounded, let after, after.isLetter || after.isNumber { continue }
                let offset = text.utf16.distance(from: text.utf16.startIndex, to: found.lowerBound)
                let length = needle.utf16.count
                let range = offset ..< (offset + length)
                if taken.contains(where: { $0.overlaps(range) }) { continue }
                taken.append(range)
                spans.append(make(offset, length))
            }
        }

        if canMentionAll {
            scan("@everyone", wordBounded: true) { .init(offset: $0, length: $1) }
        }
        for role in mentionableRoles.sorted(by: { $0.name.count > $1.name.count }) {
            // Not word-bounded: a role name can end in a space, and the
            // picker inserts one after it.
            scan("@\(role.name)", wordBounded: false) {
                .init(offset: $0, length: $1, roleId: role.id)
            }
        }
        for user in members.values {
            guard let username = user.username, !username.isEmpty else { continue }
            scan("@\(username)", wordBounded: true) {
                .init(offset: $0, length: $1, userId: user.id)
            }
        }
        /*
         * `#channel`, longest title first, for the same reason roles are:
         * `#dev` and `#dev ops` both start at the same `#`, and letting the
         * short one win would leave ` ops` as prose.
         *
         * Not word-bounded, because a title can contain spaces and the picker
         * inserts one after it. Scanned against the visible channel list
         * rather than against what the picker happened to insert — typing
         * `#general` by hand should link, and unlike an `@` there is nobody to
         * accidentally ping.
         */
        for channel in mentionableChannels.sorted(by: { ($0.title?.count ?? 0) > ($1.title?.count ?? 0) }) {
            guard let title = channel.title, !title.isEmpty else { continue }
            scan("#\(title)", wordBounded: false) {
                .init(offset: $0, length: $1, channelId: channel.id)
            }
        }
        /*
         * `:party_parrot:`, one of this group's own emoji.
         *
         * Scanned from what was typed rather than only from what the picker
         * inserted, for the same reason `#channel` is: typing the shortcode
         * is how people reach for these. Longest name first so
         * `:parrot_fast:` is not eaten by `:parrot:`.
         */
        for emoji in customEmojis.sorted(by: { $0.name.count > $1.name.count }) {
            scan(":\(emoji.name):", wordBounded: false) {
                .init(offset: $0, length: $1, emojiId: emoji.id)
            }
        }
        return spans.sorted { $0.offset < $1.offset }
    }

    /// Load the window around a message and report where it landed.
    ///
    /// For opening a chat *at* something — a mention from the inbox. The
    /// server has `around` for exactly this; without it the only honest
    /// options were to open at the bottom and hope, or to page backwards
    /// until the message turned up.
    ///
    /// Returns the message id once it is loaded, so the screen can scroll to
    /// it. Nil means it could not be found — deleted since, most likely — and
    /// the chat simply opens where it always does.
    @discardableResult
    func focusOn(seq: Int64) async -> String? {
        if let already = messages.first(where: { $0.seq == seq }) { return already.id }
        guard let container,
              let page = try? await container.repo.history(conversationId, around: seq, limit: 50),
              !page.messages.isEmpty
        else { return nil }
        // The window replaces what was loaded rather than merging into it: a
        // page from the middle of history and the newest page share no edge,
        // and stitching them would leave a silent gap in the timeline.
        messages = page.messages.sorted { $0.seq < $1.seq }
        return page.messages.first { $0.seq == seq }?.id
    }

    func forward(_ message: Message, to conversationId: String) {
        guard let container else { return }
        Task {
            try? await container.repo.forward(messageIds: [message.id], toConversationIds: [conversationId])
        }
    }

    // ── Message actions ──────────────────────────────────────────────────────

    func toggleReaction(_ message: Message, emoji: String) {
        guard let container else { return }
        let had = message.myReactions.contains(emoji)

        // Applied locally first: a reaction that waits for a round trip feels
        // broken, and the server event will reconcile either way.
        patch(message.id) { current in
            let next = (current.reactions[emoji] ?? 0) + (had ? -1 : 1)
            if next <= 0 {
                current.reactions.removeValue(forKey: emoji)
            } else {
                current.reactions[emoji] = next
            }
            if had {
                current.myReactions.removeAll { $0 == emoji }
            } else {
                current.myReactions.append(emoji)
            }
        }

        Task {
            if had {
                try? await container.repo.unreact(conversationId, messageId: message.id, emoji: emoji)
            } else {
                try? await container.repo.react(conversationId, messageId: message.id, emoji: emoji)
            }
        }
    }

    // ── Location ─────────────────────────────────────────────────────────────

    /// Share a place. `duration` nil sends a pin; non-nil starts a live share.
    func shareLocation(duration: TimeInterval?) {
        guard let container else { return }
        Task {
            guard let fix = await Locator.shared.current() else {
                error = "Could not get your location"
                return
            }
            do {
                let envelope = try await container.repo.sendLocation(
                    conversationId,
                    latitude: fix.coordinate.latitude,
                    longitude: fix.coordinate.longitude,
                    name: nil,
                    liveUntil: duration.map { Date().addingTimeInterval($0) }
                )
                appendIfMissing(envelope.message)
                // Handed to something that outlives this screen: a share is a
                // promise until its end time, and this model dies on tapping
                // back. See `LiveShare`.
                if duration != nil {
                    LiveShare.shared.start(
                        repo: container.repo,
                        conversationId: conversationId,
                        messageId: envelope.message.id
                    )
                }
            } catch {
                self.error = "Could not share your location"
            }
        }
    }

    /// End our own live share.
    func stopSharing(messageId: String) {
        guard let container else { return }
        LiveShare.shared.stopIfSharing(messageId: messageId)
        Task {
            try? await container.repo.stopLocation(conversationId, messageId: messageId)
            liveLocations[messageId]?.endedAt = YappyTime.now()
        }
    }

    /// Report a screenshot of this conversation.
    ///
    /// Fire and forget, and silent on failure: the person who took it is not
    /// waiting on an answer, and an error toast about a notice they did not ask
    /// to send would be worse than the notice not arriving. The line comes back
    /// down the socket like any other system message.
    func reportScreenshot() {
        guard let container else { return }
        Task { try? await container.repo.reportScreenshot(conversationId) }
    }

    func togglePin(_ message: Message) {
        guard let container else { return }
        let currentlyPinned = pinned.contains { $0.id == message.id }
        Task {
            do {
                if currentlyPinned {
                    try await container.repo.unpin(conversationId, messageId: message.id)
                    pinned.removeAll { $0.id == message.id }
                } else {
                    try await container.repo.pin(conversationId, messageId: message.id)
                    pinned.append(message)
                }
            } catch {}
        }
    }

    /// - Parameter forEveryone: true removes it for the conversation and leaves
    ///   a tombstone everyone renders; false hides it for this account only, on
    ///   every device, and the row simply goes — there is nothing to tombstone,
    ///   because for everyone else the message is still there.
    ///
    /// The local change now waits on the request. It used to run regardless, so
    /// a failed delete still looked deleted until the next load.
    func deleteMessage(_ message: Message, forEveryone: Bool) {
        guard let container else { return }
        Task {
            do {
                try await container.repo.deleteMessage(
                    conversationId, messageId: message.id, forEveryone: forEveryone
                )
            } catch {
                self.error = "Could not delete that message."
                return
            }
            if forEveryone {
                patch(message.id) {
                    $0.deletedAt = YappyTime.now()
                    $0.content = nil
                }
            } else {
                withAnimation(Self.arrival) { messages.removeAll { $0.id == message.id } }
            }
        }
    }

    func vote(_ message: Message, optionId: String) {
        guard let container, let poll = message.poll else { return }
        let next: [String]
        if poll.multiSelect, poll.myVotes.contains(optionId) {
            next = poll.myVotes.filter { $0 != optionId }
        } else if poll.multiSelect {
            next = poll.myVotes + [optionId]
        } else if poll.myVotes.contains(optionId) {
            next = []
        } else {
            next = [optionId]
        }

        patch(message.id) { $0.poll?.myVotes = next }
        Task {
            try? await container.repo.votePoll(conversationId, messageId: message.id, optionIds: next)
        }
    }

    func reactionDetails(for message: Message) async -> [ReactionDetail] {
        guard let container else { return [] }
        return (try? await container.repo.reactionsFor(conversationId, messageId: message.id).reactions) ?? []
    }

    func forwardCandidates() async -> [Conversation] {
        guard let container else { return [] }
        return (try? await container.repo.conversations().conversations) ?? []
    }

    // ── GIF picker ───────────────────────────────────────────────────────────

    func searchGifs(_ query: String) {
        guard let container else { return }
        gifQuery = query
        gifsLoading = true
        gifTask?.cancel()

        gifTask = Task {
            try? await Task.sleep(for: .milliseconds(300)) // debounce keystrokes
            guard !Task.isCancelled, gifQuery == query else { return }
            let result = query.isEmpty
                ? try? await container.repo.recentGifs()
                : try? await container.repo.searchGifs(query)
            guard !Task.isCancelled else { return }
            gifs = result?.results ?? []
            gifsLoading = false
        }
    }

    // ── Read state ───────────────────────────────────────────────────────────

    /// Debounced: scrolling fires this constantly and only the highest matters.
    ///
    /// The highest is tracked rather than "whatever fired last". Rows report
    /// themselves as they appear, and scrolling *up* through history makes the
    /// most recent call the *oldest* message — acking that would move the read
    /// cursor backwards and leave the badge up.
    func markRead(upTo seq: Int64) {
        guard seq > highestRead else { return }
        highestRead = seq

        readAckTask?.cancel()
        readAckTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled, let self else { return }
            await flushRead()
        }
    }

    /// Records the highest message actually seen.
    ///
    /// Over the socket when it is up, because this fires on every scroll and a
    /// round-tripped request each time is wasteful for something nobody waits
    /// on. Over REST when it is not: a socket that is still connecting drops
    /// sends on the floor, and that is exactly the moment a chat opened from a
    /// cold start does its first ack — which is why a channel you had read
    /// still showed "1" until you typed in it.
    private func flushRead() async {
        guard let container, highestRead > ackedRead else { return }
        let seq = highestRead
        ackedRead = seq

        if container.gateway.state.isConnected {
            container.gateway.markRead(conversationId, seq: seq)
        } else if (try? await container.repo.markRead(conversationId, seq: seq)) == nil {
            // Let a later scroll or the flush on leaving try again.
            ackedRead = 0
            return
        }

        conversation?.selfState?.lastReadSeq = seq
        conversation?.selfState?.unreadCount = 0
        conversation?.selfState?.mentionCount = 0
        // The server echoes this back as conversation.state_update, but not
        // always before the user is looking at the list again.
        container.conversationRead.send(conversationId)
    }

    // ── Calls ────────────────────────────────────────────────────────────────

    func startCall(video: Bool) async -> String? {
        guard let container else { return nil }
        return try? await container.repo.startCall(conversationId, video: video).call.id
    }

    // ── Live events ──────────────────────────────────────────────────────────

    private func observeGateway(_ container: AppContainer) {
        container.gateway.events
            .sink { [weak self] event in self?.handle(event, container) }
            .store(in: &cancellables)

        // Reconnecting is the moment to reconcile.
        //
        // Anything the server dispatched while the socket was down was never
        // delivered, and READY carries sequence numbers and previews — not
        // message bodies. Nothing used to pull the difference, so an open chat
        // simply never showed what it missed: the conversation row's preview
        // updated in the list while the timeline sat unchanged, until the chat
        // was closed and reopened and `load()` refetched over REST. That is the
        // whole of "the bot never replied, but the reply is there when I go
        // back in".
        container.gateway.$state
            .map(\.isConnected)
            .removeDuplicates()
            .sink { [weak self] connected in
                guard let self, connected else { return }
                container.gateway.subscribe(conversationId)
                Task { await self.reconcile() }
            }
            .store(in: &cancellables)

        // Typing indicators expire client-side too; the stop event can be lost.
        sweeper = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                guard let self else { return }
                let now = Date()
                let live = typing.filter { $0.expiresAt > now }
                if live.count != typing.count { typing = live }
            }
        }
    }

    /// Pull whatever landed while the socket was down.
    ///
    /// Guarded on `loading` so the initial connect — `@Published` replays its
    /// current value the moment this subscribes — does not fire a second fetch
    /// on top of the one `load()` is already doing.
    private func reconcile() async {
        guard let container, !loading else { return }
        let head = messages.last(where: { !$0.isPending })?.seq ?? 0
        guard let page = try? await container.repo.history(conversationId, after: head, limit: 50) else {
            return
        }
        for message in page.messages { appendIfMissing(await readable(message)) }
        if let newest = page.messages.last?.seq { markRead(upTo: newest) }
    }

    private func handle(_ event: GatewayEvent, _ container: AppContainer) {
        let data = event.data
        let target = data["conversationId"]?.stringValue

        switch event.type {
        case "message.create":
            guard target == conversationId, let message = Self.decodeMessage(data) else { return }
            Task { appendIfMissing(await readable(message)) }
            markRead(upTo: message.seq)

        case "message.update":
            guard target == conversationId, let message = Self.decodeMessage(data) else { return }
            replace(message)

        case "message.delete":
            guard target == conversationId, let id = data["id"]?.stringValue else { return }
            // `forMe` arrives only on this account's own topic: another device
            // hid it, so it goes entirely rather than leaving a "message was
            // deleted" stub nobody else was ever meant to see.
            if data["forMe"]?.boolValue == true {
                withAnimation(Self.arrival) { messages.removeAll { $0.id == id } }
                return
            }
            patch(id) {
                $0.deletedAt = YappyTime.now()
                $0.content = nil
            }

        /// Disappearing messages, swept server-side in bulk. Without this the
        /// bubbles stay on screen until a cold refetch.
        case "message.bulk_delete":
            guard target == conversationId,
                  case .array(let ids)? = data["messageIds"]
            else { return }
            let gone = Set(ids.compactMap { $0.stringValue })
            withAnimation(Self.arrival) { messages.removeAll { gone.contains($0.id) } }

        /// Someone walked into, or out of, this room.
        case "presence.viewing":
            guard target == conversationId,
                  let userId = data["userId"]?.stringValue,
                  userId != meId,
                  let here = data["viewing"]?.boolValue
            else { return }
            var next = viewers.filter { $0.id != userId }
            // Only people already known get a face; a stranger's id with no
            // name to put on it would draw an empty circle.
            if here, let person = members[userId] { next.append(person) }
            viewers = next

        /// A live share moved.
        ///
        /// Its own event because a share is hundreds of these; treating each as
        /// a message update would re-render a bubble from scratch every few
        /// seconds for hours.
        case "location.update":
            guard target == conversationId,
                  let point = Self.decode(LiveLocation.self, from: data)
            else { return }
            liveLocations[point.messageId] = point

        case "location.end":
            guard target == conversationId,
                  let messageId = data["messageId"]?.stringValue
            else { return }
            // Kept, with an end time, rather than dropped: the card should say
            // "ended" over the last known point, not silently go back to
            // showing where the share began.
            liveLocations[messageId]?.endedAt = YappyTime.now()
            LiveShare.shared.stopIfSharing(messageId: messageId)

        /// Somebody joined or left while this screen was open.
        ///
        /// Two things go stale without this, and both were visible: the header
        /// count, which is read straight off the conversation loaded on open,
        /// and the names in "Alex added Sam" — rendered from `members`, which
        /// cannot contain somebody who arrived a second ago. The count is taken
        /// from the event rather than incremented locally so two people adding
        /// at once cannot drift it.
        ///
        /// `users` is identity, not membership: on a remove it carries the
        /// person who just left, precisely so the line about them has a name.
        case "member.add", "member.remove":
            guard target == conversationId else { return }
            if case .array(let people)? = data["users"] {
                for person in people {
                    guard let user = Self.decode(PublicUser.self, from: person) else { continue }
                    members[user.id] = user
                }
            }
            if let count = data["memberCount"]?.intValue {
                conversation?.memberCount = count
            }

        case "reaction.add", "reaction.remove":
            guard target == conversationId,
                  let id = data["messageId"]?.stringValue,
                  let emoji = data["emoji"]?.stringValue
            else { return }
            // Skip our own echo — the optimistic update already applied it, and
            // re-applying would double-count.
            if let userId = data["userId"]?.stringValue, userId == meId { return }

            let adding = event.type == "reaction.add"
            patch(id) { current in
                let next = (current.reactions[emoji] ?? 0) + (adding ? 1 : -1)
                if next <= 0 {
                    current.reactions.removeValue(forKey: emoji)
                } else {
                    current.reactions[emoji] = next
                }
            }

        case "typing.start":
            guard target == conversationId,
                  let userId = data["userId"]?.stringValue,
                  userId != meId
            else { return }
            typing.removeAll { $0.userId == userId }
            typing.append(TypingUser(userId: userId, expiresAt: Date().addingTimeInterval(8)))

        case "typing.stop":
            guard let userId = data["userId"]?.stringValue else { return }
            typing.removeAll { $0.userId == userId }

        case "pin.add", "pin.remove":
            guard target == conversationId else { return }
            Task {
                if let pins = try? await container.repo.pins(conversationId).pins.map(\.message) {
                    pinned = pins
                }
            }

        // Close rides the same refetch as a vote: the payload carries neither
        // tallies nor state, and the message row is the single source of both.
        // Without the close case a poll went on looking open — votes still
        // updating — until the chat was reopened.
        case "poll.vote", "poll.close":
            guard target == conversationId, let messageId = data["messageId"]?.stringValue else { return }
            Task {
                let around = messages.first { $0.id == messageId }?.seq
                if let refreshed = try? await container.repo.history(conversationId, around: around).messages
                    .first(where: { $0.id == messageId }) {
                    replace(refreshed)
                }
            }

        /**
         * Somebody's watermark moved. Monotonic by construction server-side,
         * but clamped here too — events can arrive out of order across a
         * reconnect, and a tick that goes backwards reads as a glitch.
         * A read at seq N implies delivery at N, which is also how the server
         * writes it.
         */
        case "read.receipt":
            guard target == conversationId,
                  let userId = data["userId"]?.stringValue,
                  userId != meId,
                  let seq = data["seq"]?.int64Value
            else { return }
            if var entry = receipts[userId] {
                entry.seq = max(entry.seq, seq)
                entry.deliveredSeq = max(entry.deliveredSeq, seq)
                entry.readAt = data["readAt"]?.stringValue ?? entry.readAt
                receipts[userId] = entry
            } else if let user = members[userId] {
                var entry = ReceiptEntry(user: user)
                entry.seq = seq
                entry.deliveredSeq = seq
                entry.readAt = data["readAt"]?.stringValue
                receipts[userId] = entry
            }

        case "delivery.receipt":
            guard target == conversationId,
                  let userId = data["userId"]?.stringValue,
                  userId != meId,
                  let seq = data["seq"]?.int64Value
            else { return }
            if var entry = receipts[userId] {
                entry.deliveredSeq = max(entry.deliveredSeq, seq)
                receipts[userId] = entry
            } else if let user = members[userId] {
                var entry = ReceiptEntry(user: user)
                entry.deliveredSeq = seq
                receipts[userId] = entry
            }

        /**
         * Someone in this chat changed their name or picture. Sender snapshots
         * ride on every message row, so the timeline keeps showing the old
         * identity until each row is told otherwise — the header and the
         * mention pool via `members`, the bubbles via their embedded sender.
         */
        case "user.update":
            guard let payload = try? JSONEncoder().encode(data),
                  let user = try? JSONDecoder().decode(PublicUser.self, from: payload)
            else { return }
            guard members[user.id] != nil || messages.contains(where: { $0.senderId == user.id }) else { return }
            members[user.id] = user
            // One assignment, not one per matching message: `messages` derives
            // the timeline ordering on write, and mutating in place through the
            // subscript would redo that work for every bubble this person has
            // in the history.
            var updated = messages
            for index in updated.indices where updated[index].senderId == user.id {
                updated[index].sender = user
            }
            messages = updated

        default:
            break
        }
    }

    // ── List helpers ─────────────────────────────────────────────────────────

    /// What this device can actually show for a message.
    ///
    /// An encrypted one arrives with a notice in `content` and its real body
    /// in `ciphertext`, addressed to a single device. If that is us, the words
    /// go where the timeline already looks for them. If not — the message
    /// predates this device, or the copy went elsewhere — the bubble says so
    /// rather than showing a notice about updating an app that is up to date.
    ///
    /// A message that arrived live has no ciphertext at all: one realtime
    /// event reaches every device and each needs a different one, so ours is
    /// fetched here.
    private func readable(_ message: Message) async -> Message {
        guard message.isEncrypted, let container else { return message }
        var copy = message
        if copy.ciphertext == nil {
            copy.ciphertext = try? await container.repo
                .messageEnvelope(conversationId, message.id).ciphertext
        }
        // The server's word for who wrote it. The signature inside the envelope
        // has to agree with it, or the message does not open — otherwise a sealed
        // body could be lifted off one message and shown under somebody else's
        // name.
        // Keyed by message id because a ratchet ciphertext opens exactly once:
        // after that, what this device wrote down is the only copy there is.
        copy.content = (await container.e2e.open(
            message.id,
            copy.ciphertext,
            authorId: message.senderId
        )) ?? "This device cannot read this message."
        return copy
    }

    private func appendIfMissing(_ message: Message) {
        guard !messages.contains(where: { $0.id == message.id }) else { return }
        // Replace the optimistic placeholder if this is our own message coming
        // back with a real id and seq.
        let settling = message.nonce.map { nonce in
            messages.contains { $0.nonce == nonce }
        } ?? false
        if let nonce = message.nonce {
            messages.removeAll { $0.nonce == nonce }
        }
        /**
         * A genuinely new message grows in (the rows carry the transition);
         * our own message settling into its server id does not. The settle is
         * a swap of identity under a bubble already on screen, and animating
         * it would tear down and re-grow the thing the sender is looking at
         * over a rename nobody can see.
         */
        if settling {
            messages.append(message)
        } else {
            withAnimation(Self.arrival) { messages.append(message) }
        }
        resort()
        if let sender = message.sender { members[sender.id] = sender }
    }

    /// The one spring every timeline insertion and removal shares. In the
    /// model rather than the view because these transactions open here, at
    /// the mutation — a blanket `.animation` on the stack re-laid the whole
    /// timeline whenever a history page landed, mid-drag included.
    static let arrival = Animation.spring(response: 0.32, dampingFraction: 0.8)

    /// Pending messages sort last so a placeholder stays at the bottom of the
    /// timeline until the server gives it a real seq.
    ///
    /// `createdAt` then `id` break the tie, because `sort` is not stable and two
    /// photos sent in quick succession are both pending and both key to
    /// `Int64.max` — without a tiebreak they can swap places on any resort.
    private func resort() {
        messages.sort { lhs, rhs in
            let left = lhs.isPending ? Int64.max : lhs.seq
            let right = rhs.isPending ? Int64.max : rhs.seq
            if left != right { return left < right }
            if lhs.createdAt != rhs.createdAt { return lhs.createdAt < rhs.createdAt }
            return lhs.id < rhs.id
        }
    }

    private func replacePending(nonce: String, with message: Message) {
        if let index = messages.firstIndex(where: { $0.id == nonce }) {
            var settled = message
            // Keep what the placeholder already knew and the reply is missing.
            //
            // A server that answers a send without the quote would otherwise
            // make a reply lose it the instant it was confirmed — the bubble
            // renders correctly for one frame and then drops to a plain
            // message, and only reopening the conversation brings it back.
            // The client is not guessing here: it is the side that chose the
            // message being replied to.
            if settled.replyTo == nil { settled.replyTo = messages[index].replyTo }
            messages[index] = settled
        } else {
            appendIfMissing(message)
        }
        // A socket echo can arrive before the HTTP response does, leaving both
        // the placeholder's replacement and the pushed copy in the list.
        var seen = Set<String>()
        messages = messages.filter { seen.insert($0.id).inserted }
        // The placeholder sorted last while it was pending; now that it has a
        // real seq it may belong further up. A bot that answers faster than our
        // own POST returns — which is most of them — otherwise left its reply
        // stranded above the message it was answering, permanently, because
        // settling in place never re-sorted.
        resort()
    }

    private func replace(_ message: Message) {
        guard let index = messages.firstIndex(where: { $0.id == message.id }) else { return }
        messages[index] = message
    }

    private func patch(_ id: String, _ transform: (inout Message) -> Void) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        transform(&messages[index])
    }

    private static func decodeMessage(_ value: JSONValue) -> Message? {
        decode(Message.self, from: value)
    }

    /// The shared implementation now lives on `JSONValue` as `decoded(as:)`,
    /// because the container needs the same message out of the same event.
    /// This stays as the local spelling every call site in here already uses.
    private static func decode<T: Decodable>(_ type: T.Type, from value: JSONValue) -> T? {
        value.decoded(as: type)
    }
}

/// Holds a picked photo's bytes on disk just long enough for the optimistic
/// bubble to render them.
///
/// The alternative — keeping the `Data` on the message — would pin a multi-
/// megabyte buffer inside published state that SwiftUI diffs on every keystroke.
/// A file URL is eight bytes and the image loader already knows how to read one.
final class LocalMediaCache {
    static let shared = LocalMediaCache()

    private let directory: URL

    private init() {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("outgoing", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    func store(_ data: Data, id: String) -> String {
        let url = directory.appendingPathComponent(id)
        try? data.write(to: url, options: .atomic)
        return url.absoluteString
    }

    func discard(id: String) {
        try? FileManager.default.removeItem(at: directory.appendingPathComponent(id))
    }
}
