import SwiftUI

@main
struct YappyApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var container = AppContainer()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // The image pipeline needs the token to fetch private attachments, but
        // must not hold a reference to the session store's lifetime — a closure
        // over the container is the smaller coupling.
        let session = SessionStore()
        ImageLoader.shared.attach { session.accessToken }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(container)
                .preferredColorScheme(container.theme.colorScheme)
                .task { container.bootstrap() }
                .onOpenURL { container.open(url: $0) }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        container.enterForeground()
                        PushService.shared.clearBadge()
                    case .background:
                        container.enterBackground()
                    default:
                        break
                    }
                }
        }
    }
}

/// Applies the palette for the resolved colour scheme and paints the sheet.
///
/// The background runs under the status bar rather than stopping at it —
/// otherwise the neumorphic surface reads as a card sitting on a backdrop, which
/// is exactly the illusion the whole style is trying to avoid.
struct ThemedSheet<Content: View>: View {
    @Environment(\.colorScheme) private var scheme
    @ViewBuilder var content: () -> Content

    var body: some View {
        let colors = scheme == .dark ? NeuColors.dark : NeuColors.light

        ZStack {
            colors.surface.ignoresSafeArea()
            content()
        }
        .environment(\.neu, colors)
        .tint(colors.accent)
    }
}
