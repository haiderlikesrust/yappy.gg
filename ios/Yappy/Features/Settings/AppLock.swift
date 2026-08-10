import LocalAuthentication
import SwiftUI

/// Face ID / passcode in front of the app.
///
/// Deliberately a *screen* lock and not an encryption boundary: the messages
/// are already on the device and the tokens are already in the keychain, so
/// what this buys is privacy from someone holding your unlocked phone, not
/// protection from someone imaging its storage. Saying so plainly in the
/// subtitle is better than implying a guarantee it cannot make.
@MainActor
final class AppLockGate: ObservableObject {
    /// True when the lock screen should be covering everything.
    @Published private(set) var locked: Bool
    /// Set when the last attempt failed, so the screen can offer a retry
    /// rather than sitting there looking broken.
    @Published private(set) var failed = false

    private let store: SessionStore
    /// Guards against the double prompt you get when `scenePhase` reports
    /// `.active` twice, which it does when the Face ID sheet itself resigns
    /// and restores the scene.
    private var authenticating = false

    var enabled: Bool { store.appLock }

    init(store: SessionStore) {
        self.store = store
        // Locked from the first frame when the setting is on. Starting unlocked
        // and locking in `onAppear` shows the conversation list for a frame,
        // which is exactly the thing the lock exists to prevent.
        locked = store.appLock
    }

    /// Whether this device can do it at all. A device with no passcode set
    /// cannot, and offering the switch there would strand someone in a lock
    /// they cannot open.
    static var available: Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    func setEnabled(_ on: Bool) {
        store.setAppLock(on)
        // Turning it on must not lock you out of the screen you just used to
        // turn it on; it takes effect the next time the app is backgrounded.
        if !on { locked = false }
        objectWillChange.send()
    }

    func lockIfEnabled() {
        guard store.appLock else { return }
        locked = true
        failed = false
    }

    func unlock() async {
        guard locked, !authenticating else { return }
        authenticating = true
        defer { authenticating = false }

        let context = LAContext()
        context.localizedCancelTitle = "Cancel"

        do {
            // `deviceOwnerAuthentication`, not `…WithBiometrics`: it falls back
            // to the passcode on its own, so a failed or unavailable Face ID
            // still has a way through.
            let ok = try await context.evaluatePolicy(
                .deviceOwnerAuthentication,
                localizedReason: "Unlock yappy"
            )
            locked = !ok
            failed = !ok
        } catch {
            failed = true
        }
    }
}

/// The cover shown while locked.
struct AppLockScreen: View {
    @Environment(\.neu) private var colors

    let failed: Bool
    let onUnlock: () -> Void

    var body: some View {
        ZStack {
            colors.surface.ignoresSafeArea()

            VStack(spacing: 18) {
                LogoMark(height: 40)

                Text("yappy is locked")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textPrimary)

                Text(failed ? "That didn't work. Try again." : "Unlock to see your chats.")
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(failed ? colors.danger : colors.textTertiary)

                NeuButton(accent: true, action: onUnlock) {
                    Image(systemName: "faceid")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(colors.onAccent)
                    Text("Unlock")
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(colors.onAccent)
                }
                .frame(maxWidth: 220)
                .padding(.top, 4)
            }
            .padding(24)
        }
    }
}
