import SwiftUI
import UserNotifications

struct NotificationPermissionCard: View {
    @Environment(\.neu) private var colors
    @Environment(\.openURL) private var openURL
    @State private var status: UNAuthorizationStatus?

    var body: some View {
        if let status, status == .denied || status == .notDetermined {
            VStack(alignment: .leading, spacing: 10) {
                Label(status == .denied ? "Notifications are off on this iPhone" : "Allow notifications",
                      systemImage: "bell.slash")
                    .font(.headline).foregroundStyle(colors.textPrimary)
                Text("Enable alerts to hear about messages when yappy isn't open.")
                    .font(.subheadline).foregroundStyle(colors.textSecondary)
                Button(status == .denied ? "Open iPhone settings" : "Enable notifications") {
                    if status == .denied {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    } else {
                        Task {
                            let allowed = (try? await UNUserNotificationCenter.current()
                                .requestAuthorization(options: [.alert, .badge, .sound])) == true
                            if allowed { UIApplication.shared.registerForRemoteNotifications() }
                            await refresh()
                        }
                    }
                }.buttonStyle(.bordered).tint(colors.accent)
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(colors.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))
            .padding(.bottom, 12)
            .task { await refresh() }
            .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                Task { await refresh() }
            }
        } else {
            Color.clear.frame(height: 0)
                .task { await refresh() }
                .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
                    Task { await refresh() }
                }
        }
    }

    private func refresh() async {
        status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }
}
