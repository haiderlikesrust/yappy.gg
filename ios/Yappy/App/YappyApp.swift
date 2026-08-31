import SwiftUI

@main
struct YappyApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var container: AppContainer
    @StateObject private var lock: AppLockGate
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let container = AppContainer()
        _container = StateObject(wrappedValue: container)
        _lock = StateObject(wrappedValue: AppLockGate(store: container.session))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(container)
                .environmentObject(lock)
                // Above everything, including sheets and the call cover: a lock
                // that a modal can sit on top of is not a lock.
                .overlay {
                    if lock.locked {
                        AppLockScreen(failed: lock.failed) { Task { await lock.unlock() } }
                            .transition(.opacity)
                    }
                }
                .animation(.easeOut(duration: 0.15), value: lock.locked)
                .preferredColorScheme(container.theme.colorScheme)
                .task { container.bootstrap() }
                .onOpenURL { container.open(url: $0) }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active:
                        container.enterForeground()
                        PushService.shared.clearBadge()
                        if lock.locked { Task { await lock.unlock() } }
                    // Background only. `.inactive` also fires for a Control
                    // Centre pull and for the Face ID sheet itself, so locking
                    // there means re-authenticating constantly and, worse, a
                    // prompt that re-arms the state it was trying to clear.
                    case .background:
                        container.enterBackground()
                        lock.lockIfEnabled()
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
            // The lit sheet, not a flat fill — see NeuBackdrop for why the
            // floor of every screen carries the brand's glow.
            NeuBackdrop(colors: colors)
            content()
        }
        .environment(\.neu, colors)
        .tint(colors.accent)
    }
}
