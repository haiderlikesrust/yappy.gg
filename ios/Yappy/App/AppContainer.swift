import Combine
import SwiftUI

/// Manual dependency container.
///
/// One HTTP client, one repository, one socket — a graph this shallow does not
/// need a framework. A single container created at launch and read through the
/// environment is less machinery and no less testable: swap the container, swap
/// the world.
@MainActor
final class AppContainer: ObservableObject {
    /// Nil while the stored token is still being read — used to hold the splash
    /// rather than flash the sign-in screen at someone who is already signed in.
    @Published private(set) var signedIn: Bool?
    @Published var theme: ThemePreference
    /// The signed-in profile, held once and shared.
    ///
    /// Every screen that draws your face reads this. Keeping a private copy per
    /// screen is why changing your picture in Settings left the home header on
    /// the old one until the app was relaunched.
    @Published private(set) var me: FullUser?

    /// One store, shared. Two instances would each hold their own in-memory
    /// token cache, and a refresh written through one would leave the other
    /// handing out a token the server has already rotated away.
    let session: SessionStore
    let api: ApiClient
    let repo: YappyRepository
    let uploader: AttachmentUploader
    let gateway: GatewayClient
    /// The one media engine, container-owned rather than screen-owned, because
    /// a CallKit answer from the lock screen brings audio up before any screen
    /// exists. `CallScreen` adopts this engine; it never makes its own.
    let callEngine = CallEngine { LiveKitTransport() }
    /// Names and avatars picked up from lists, so a chat header does not flash a
    /// placeholder while its own fetch is in flight.
    let headerSeeds = HeaderSeedCache()
    /// A conversation has been read. The server echoes this back over the
    /// gateway too, but not reliably before the user is looking at the list
    /// again — so the list clears its own badge on the way out of a chat.
    let conversationRead = PassthroughSubject<String, Never>()
    /// A link or a tapped notification asked for somewhere. Held rather than
    /// acted on directly because it can arrive before the signed-in navigation
    /// stack exists — a cold start from a notification does exactly that.
    @Published var pendingLink: DeepLink?
    /// conversationId → notification level, kept current by the list model.
    /// The in-app banner reads it to honour mutes; unknown means "all", which
    /// errs on the side of telling you about a chat this device has not seen.
    var notificationLevels: [String: String] = [:]

    /// The timeline each chat had on screen when it was last closed.
    ///
    /// The disk snapshot is only rewritten when a history *fetch* completes, so
    /// it goes stale the moment you send anything. Re-entering a chat repainted
    /// that older list and then let the fetch put your message back, which
    /// looked exactly like the message sending itself twice. This is what the
    /// person actually last saw, and it costs a dictionary.
    ///
    /// Bounded, because a long session visits a lot of chats and a timeline is
    /// not small.
    struct TimelineSnapshot {
        var messages: [Message]
        /// Kept with the messages because the ticks are drawn from it. Reloading
        /// a chat with an empty receipt map renders every one of your own
        /// bubbles as a single grey check, and then the fetch turns them blue —
        /// the read marks appear to arrive again every time you open the chat.
        var receipts: [String: ReceiptEntry]
    }

    private var timelines: [String: TimelineSnapshot] = [:]
    private var timelineOrder: [String] = []

    func rememberTimeline(
        _ messages: [Message],
        receipts: [String: ReceiptEntry],
        for conversationId: String
    ) {
        guard !messages.isEmpty else { return }
        // Only the tail is worth keeping — the next visit fetches a page of
        // fifty anyway, and this exists to fill one frame.
        timelines[conversationId] = TimelineSnapshot(
            messages: Array(messages.suffix(50)),
            receipts: receipts
        )
        timelineOrder.removeAll { $0 == conversationId }
        timelineOrder.append(conversationId)
        while timelineOrder.count > 8 {
            timelines.removeValue(forKey: timelineOrder.removeFirst())
        }
    }

    func timeline(for conversationId: String) -> TimelineSnapshot? {
        timelines[conversationId]
    }

    /**
     * Keep a closed chat's snapshot current as messages arrive.
     *
     * `rememberTimeline` runs when you *leave* a chat, which froze the snapshot
     * at that moment. Everything the socket delivered afterwards — the five
     * messages the list is at that very moment badging — went to the list's
     * unread count and nowhere else. So opening the chat repainted the page as
     * it was when you left, and the new messages only appeared when the history
     * fetch came back: the badge said five, and you sat looking at the old
     * conversation for as long as the round trip took.
     *
     * The event already carries the whole message. Appending it here means the
     * snapshot is what the room actually looks like now, and the fetch that
     * follows confirms it rather than revealing it.
     *
     * Only for chats already in the cache: this is for keeping a snapshot
     * honest, not for building one for a room that has never been opened.
     */
    func appendToTimeline(_ message: Message, for conversationId: String) {
        guard var snapshot = timelines[conversationId] else { return }
        // The socket can repeat a message (a resumed session replays), and the
        // sender's own echo arrives for a row that is already on screen.
        if let existing = snapshot.messages.firstIndex(where: { $0.id == message.id }) {
            snapshot.messages[existing] = message
        } else {
            // By seq, not appended: a resumed socket replays a backlog, and a
            // message that arrives after one with a higher seq would otherwise
            // sit at the bottom of the snapshot out of order.
            let at = snapshot.messages.firstIndex { $0.seq > message.seq }
            snapshot.messages.insert(message, at: at ?? snapshot.messages.endIndex)
            snapshot.messages = Array(snapshot.messages.suffix(50))
        }
        timelines[conversationId] = snapshot
    }

    func rememberNotificationLevels(_ conversations: [Conversation]) {
        for conversation in conversations {
            notificationLevels[conversation.id] = conversation.selfState?.notificationLevel ?? "all"
        }
    }

    /// Primary and backup domains, shared by the API client and the gateway so
    /// they fail over together.
    private let endpoints = Endpoints(
        apiUrls: AppConfig.apiUrls,
        gatewayUrls: AppConfig.gatewayUrls
    )

    /// This device's published identity. Nothing is encrypted yet — see DeviceKeys.
    private(set) lazy var deviceKeys = DeviceKeys(repo: repo)

    /// Encrypted sends, behind a debug build and a per-chat flag. See E2E.
    /// Ratchet sessions and opened messages, on disk. See E2EStore.
    private(set) lazy var e2eStore = E2EStore()

    private(set) lazy var e2e = E2E(repo: repo, session: session, keys: deviceKeys, store: e2eStore)

    private var cancellables = Set<AnyCancellable>()

    init() {
        let session = SessionStore()
        let api = ApiClient(session: session, endpoints: endpoints)
        let repo = YappyRepository(api: api)

        self.session = session
        self.api = api
        self.repo = repo
        uploader = AttachmentUploader(repo: repo, http: api.http)
        gateway = GatewayClient(
            session: session,
            endpoints: endpoints,
            ticketProvider: { try await repo.gatewayTicket() }
        )
        theme = session.theme
        signedIn = nil

        /**
         * The image pipeline reads the token from *this* session, not one of
         * its own.
         *
         * It used to build a second `SessionStore` in `YappyApp.init()`, which
         * looked harmless because both read the same keychain. It was not:
         * `loadIfNeeded()` reads the keychain once and latches, and only the
         * instance that `saveTokens` is called on updates its cache. So the
         * second store served whatever access token happened to exist at first
         * use and never saw another one. After the first refresh — minutes —
         * every private attachment went out with an expired token, got 401, and
         * `RemoteImage` turned that into nil, which renders as an empty bubble.
         *
         * Avatars hid it: they come from the public bucket via Caddy and carry
         * no token at all, so only message attachments ever broke. Android was
         * never affected because its Coil interceptor asks the live session on
         * every request rather than holding a snapshot.
         *
         * Wired here rather than in the `App` initialiser because this is where
         * the real session exists, and it runs before any view can ask for an
         * image.
         */
        ImageLoader.shared.attach { [weak session] in session?.accessToken }
        VoiceNotePlayer.shared.attach { [weak session] in session?.accessToken }
        // After every stored property exists: CallSystem immediately creates
        // the PushKit registry and CallKit provider, and both need the
        // container to answer with. Done here, not in a view, because a VoIP
        // push can launch the app with no view ever built.
        CallSystem.shared.attach(container: self)

        /**
         * Your own profile, kept live.
         *
         * `user.update` is published to your own topic for every profile write,
         * including the ones made *outside this app* — another device, or
         * yapper's /name and /username commands. `me` was loaded once at boot
         * and nothing consumed the event, so yapper could say "You are @new"
         * while the home header displayed the old name until a relaunch.
         * Refetched rather than patched: the event carries the public shape,
         * and `me` is the full one.
         */
        gateway.events
            .sink { [weak self] event in
                guard let self,
                      event.type == "user.update",
                      let id = event.data["id"]?.stringValue,
                      id == session.userId
                else { return }
                Task { await self.loadMe() }
            }
            .store(in: &cancellables)

        /**
         * Closed chats' snapshots, kept current.
         *
         * Subscribed here, for the container's whole life, rather than on the
         * conversations list: messages arrive for Mark's chat while you are
         * reading Anna's, and the snapshot has to be right whichever screen
         * you happened to be on when they landed. See `appendToTimeline`.
         */
        gateway.events
            .sink { [weak self] event in
                guard let self,
                      event.type == "message.create",
                      let conversationId = event.data["conversationId"]?.stringValue,
                      let message = event.data.decoded(as: Message.self)
                else { return }
                appendToTimeline(message, for: conversationId)
            }
            .store(in: &cancellables)

        // Refresh failed for good. Tear down local state so the UI cannot keep
        // issuing requests that will all 401.
        api.onSignedOut = { [weak self] in
            await MainActor.run { [weak self] in
                guard let self else { return }
                session.clear()
                gateway.disconnect(forgetting: true)
                resetAccountState()
                signedIn = false
            }
        }
    }

    func bootstrap() {
        wirePush()
        signedIn = session.accessToken != nil
        guard signedIn == true else { return }
        gateway.connect()
        // Last launch's profile paints the header while the fresh one is
        // fetched — the difference between a face and a grey circle on frame
        // one of every cold start.
        if me == nil, let cached = DiskCache.decode(UserEnvelope.self, key: "me") {
            me = cached.user
        }
        // Fetched here rather than by whichever screen happens to need it
        // first, so the home header and Settings both have a name and a face on
        // their first frame.
        Task { await loadMe() }
        Task { await PushService.shared.register() }
        publishDeviceKeys()
    }

    func onAuthenticated() {
        signedIn = true
        gateway.connect()
        Task { await loadMe() }
        // Asked for here rather than at first launch: a prompt shown before the
        // person has seen a single message is the one most reliably denied, and
        // iOS only lets you ask once.
        Task { await PushService.shared.register() }
        publishDeviceKeys()
    }

    /// Register this device's public keys, once.
    ///
    /// Fire-and-forget on purpose: it is groundwork for encryption that does
    /// not exist yet (see DeviceKeys) and must never sit between somebody and
    /// their messages.
    private func publishDeviceKeys() {
        guard let deviceId = session.deviceId, let userId = session.userId else { return }
        Task { await deviceKeys.ensurePublished(deviceId: deviceId, userId: userId) }
    }

    /// A link from outside the app, or a tapped notification.
    func open(url: URL) {
        guard let link = DeepLink(url: url) else { return }
        pendingLink = link
    }

    private func wirePush() {
        let push = PushService.shared
        push.configure()
        push.onToken = { [weak self] token, voipToken in
            guard let self else { return }
            _ = try? await repo.registerPush(token: token, voipToken: voipToken)
        }
        push.onOpen = { [weak self] link in
            self?.pendingLink = link
        }
        // A token can be issued before this wiring exists on a cold start.
        push.flush()
    }

    /// Adopt a freshly-returned profile.
    ///
    /// The old picture's bytes are dropped from the image cache as well: the API
    /// can hand back the same URL for a replaced avatar, and a cache keyed on
    /// the URL would happily serve the previous photo for ever.
    func setMe(_ user: FullUser?) {
        if let previous = me?.avatarUrl, previous != user?.avatarUrl {
            ImageLoader.shared.invalidate(previous)
        }
        if let current = user?.avatarUrl {
            ImageLoader.shared.invalidate(current)
        }
        me = user
    }

    func loadMe() async {
        guard let user = try? await repo.me().user else { return }
        // The server just said who this is, so write it down. The id used to be
        // recorded only at sign-in, and a reinstall keeps the keychain (so you
        // stay signed in) while emptying the app's own folder (so the note
        // saying who you are is gone) — after which nothing ever asked again.
        session.saveIdentity(userId: user.id, deviceId: nil)
        me = user
    }

    func setTheme(_ preference: ThemePreference) {
        theme = preference
        session.setTheme(preference)
        Task { try? await repo.updateTheme(preference.rawValue) }
    }

    func signOut() async {
        _ = try? await repo.logout()
        gateway.disconnect(forgetting: true)
        session.clear()
        resetAccountState()
        signedIn = false
    }

    /// Forget everything that belonged to the account that just left.
    ///
    /// `me` in particular: it survived a sign-out, so the next person to sign in
    /// on this device saw the previous user's name and face in the home header
    /// and in Settings until their own profile happened to load — and if that
    /// fetch failed it is never retried, because the only thing that asks again
    /// is a nil `me`.
    private func resetAccountState() {
        // Any call this account was in ends now — the CallKit UI must not
        // survive into the next account's session.
        CallSystem.shared.reset()
        me = nil
        pendingLink = nil
        // The next account on this device must not see this one's chats, even
        // as a first-frame flash.
        DiskCache.clear()
        timelines.removeAll()
        timelineOrder.removeAll()
        notificationLevels.removeAll()
    }

    // ── Foreground lifecycle ─────────────────────────────────────────────────

    /// The socket lives with the foreground. Holding it open in the background
    /// drains battery for events push already covers, and iOS suspends the
    /// process anyway.
    ///
    /// `reconnectNow` rather than `connect`: after a suspension the socket we
    /// hold is usually already dead, and `connect` would see a non-nil handle
    /// and decline to replace it.
    func enterForeground() {
        guard session.accessToken != nil else { return }
        gateway.reconnectNow()
    }

    func enterBackground() {
        gateway.disconnect()
    }
}

// Reached through `@EnvironmentObject` rather than an `EnvironmentKey`: a key
// needs a default value, and the only honest default here is "a second, empty
// container", which would silently give a view its own signed-out world.
