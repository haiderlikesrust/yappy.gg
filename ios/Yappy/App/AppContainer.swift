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

    /// Primary and backup domains, shared by the API client and the gateway so
    /// they fail over together.
    private let endpoints = Endpoints(
        apiUrls: AppConfig.apiUrls,
        gatewayUrls: AppConfig.gatewayUrls
    )

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

        // Refresh failed for good. Tear down local state so the UI cannot keep
        // issuing requests that will all 401.
        api.onSignedOut = { [weak self] in
            await MainActor.run { [weak self] in
                guard let self else { return }
                session.clear()
                gateway.disconnect()
                signedIn = false
            }
        }
    }

    func bootstrap() {
        wirePush()
        signedIn = session.accessToken != nil
        guard signedIn == true else { return }
        gateway.connect()
        // Fetched here rather than by whichever screen happens to need it
        // first, so the home header and Settings both have a name and a face on
        // their first frame.
        Task { await loadMe() }
        Task { await PushService.shared.register() }
    }

    func onAuthenticated() {
        signedIn = true
        gateway.connect()
        Task { await loadMe() }
        // Asked for here rather than at first launch: a prompt shown before the
        // person has seen a single message is the one most reliably denied, and
        // iOS only lets you ask once.
        Task { await PushService.shared.register() }
    }

    /// A link from outside the app, or a tapped notification.
    func open(url: URL) {
        guard let link = DeepLink(url: url) else { return }
        pendingLink = link
    }

    private func wirePush() {
        let push = PushService.shared
        push.configure()
        push.onToken = { [weak self] token in
            guard let self else { return }
            _ = try? await repo.registerPush(token: token)
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
        me = user
    }

    func setTheme(_ preference: ThemePreference) {
        theme = preference
        session.setTheme(preference)
        Task { try? await repo.updateTheme(preference.rawValue) }
    }

    func signOut() async {
        _ = try? await repo.logout()
        gateway.disconnect()
        session.clear()
        signedIn = false
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
