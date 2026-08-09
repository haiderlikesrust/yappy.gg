import SwiftUI

struct ProfileScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let userId: String
    let onBack: () -> Void
    let onOpenChat: (String) -> Void

    @State private var user: FullUser?
    @State private var busy = false
    @State private var blocked = false
    @State private var reported = false

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                HStack {
                    NeuIconButton(systemName: "chevron.left", label: "Back", size: 42, iconSize: 18, action: onBack)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)

                if let user {
                    identity(user)
                    actions.padding(.top, 8)
                } else {
                    NeuSpinner().frame(height: 300)
                }
            }
            .padding(.bottom, 40)
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .task {
            user = try? await container.repo.user(userId).user
        }
    }

    @ViewBuilder
    private func identity(_ user: FullUser) -> some View {
        VStack(spacing: 0) {
            Avatar(url: user.avatarUrl, name: user.displayName, id: user.id, size: 112)
                .padding(.bottom, 16)

            HStack(spacing: 8) {
                Text(user.displayName ?? "Someone")
                    .font(YappyFont.headlineMedium)
                    .headlineTracking()
                    .foregroundStyle(colors.textPrimary)
                BadgeMark(badge: user.badge, size: 20)
            }

            if let username = user.username {
                Text("@\(username)")
                    .font(YappyFont.bodyLarge)
                    .foregroundStyle(colors.textTertiary)
            }

            // The profile is the one place with room to say what a mark means,
            // so it does — in words, not a second glyph.
            if let description = badgeDescription(user.badge) {
                HStack(spacing: 7) {
                    BadgeMark(badge: user.badge, size: 14)
                    Text(description)
                        .font(YappyFont.labelMedium)
                        .foregroundStyle(colors.accent)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(colors.accentSoft, in: Capsule())
                .padding(.top, 10)
            }

            if let affiliation = user.affiliation {
                HStack(spacing: 8) {
                    AffiliateMark(affiliation: affiliation, size: 18)
                    Text("Affiliated with \(affiliation.title ?? "a group")")
                        .font(YappyFont.labelMedium)
                        .foregroundStyle(colors.textSecondary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(colors.accentSoft.opacity(0.6), in: Capsule())
                .padding(.top, 10)
            }

            HStack(spacing: 6) {
                PresenceDot(status: user.presence.status, size: 10)
                Text(presenceLabel(user))
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(colors.textTertiary)
            }
            .padding(.top, 8)

            if let bio = user.bio, !bio.isEmpty {
                Text(bio)
                    .font(YappyFont.bodyLarge)
                    .foregroundStyle(colors.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 14)
            }

            HStack(spacing: 14) {
                NeuIconButton(
                    systemName: "bubble.left.fill",
                    label: "Message",
                    size: 56,
                    iconSize: 22,
                    accent: true,
                    enabled: !busy
                ) {
                    busy = true
                    Task {
                        if let id = try? await container.repo.createDm(userId: user.id).conversation.id {
                            onOpenChat(id)
                        }
                        busy = false
                    }
                }
                NeuIconButton(systemName: "phone.fill", label: "Call", size: 56, iconSize: 22) {}
            }
            .padding(.top, 24)
        }
        .padding(24)
    }

    private func presenceLabel(_ user: FullUser) -> String {
        if user.presence.status == "online" { return "Online" }
        if let lastSeen = user.presence.lastSeenAt {
            return "Last seen \(YappyTime.relative(lastSeen))"
        }
        // The backend suppresses both status and last-seen together when privacy
        // forbids it, so there is nothing to show rather than a misleading
        // "Offline".
        return ""
    }

    private var actions: some View {
        NeuSurface(radius: Neu.cornerMedium, contentPadding: 6) {
            VStack(spacing: 0) {
                actionRow(
                    blocked ? "hand.raised.slash" : "hand.raised",
                    blocked ? "Unblock" : "Block",
                    danger: !blocked
                ) {
                    Task {
                        do {
                            if blocked {
                                try await container.repo.unblock(userId)
                            } else {
                                try await container.repo.block(userId)
                            }
                            blocked.toggle()
                        } catch {}
                    }
                }

                actionRow("flag", reported ? "Reported" : "Report", danger: !reported) {
                    guard !reported else { return }
                    reported = true
                    Task {
                        try? await container.repo.report(
                            targetType: "user", targetId: userId, reason: "spam", detail: nil
                        )
                    }
                }
            }
        }
        .padding(.horizontal, 16)
    }

    private func actionRow(
        _ symbol: String,
        _ label: String,
        danger: Bool,
        action: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 17))
                .foregroundStyle(danger ? colors.danger : colors.textSecondary)
                .frame(width: 22)
            Text(label)
                .font(YappyFont.bodyLarge)
                .foregroundStyle(danger ? colors.danger : colors.textPrimary)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 10)
        .contentShape(Rectangle())
        .softTap(action: action)
    }
}
