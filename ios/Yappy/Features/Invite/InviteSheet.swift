import SwiftUI

/// What an invite link opens.
///
/// A preview and a button, never a silent join: following a link should show
/// you whose room it is and let you back out. The server's `/invites/:code`
/// endpoint exists for exactly this.
struct InviteSheet: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let code: String
    let onJoined: (String) -> Void
    let onDismiss: () -> Void

    @State private var preview: InvitePreview?
    @State private var failure: String?
    @State private var joining = false

    var body: some View {
        VStack(spacing: 0) {
            if let preview {
                content(preview)
            } else if let failure {
                message(failure)
            } else {
                NeuSpinner().frame(height: 180)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity)
        .task { await load() }
    }

    private func load() async {
        do {
            preview = try await container.repo.invitePreview(code: code)
        } catch let error as ApiError {
            failure = error.status == 404
                ? "That invite has expired or been revoked."
                : error.message
        } catch {
            failure = "Could not open that invite."
        }
    }

    @ViewBuilder
    private func content(_ preview: InvitePreview) -> some View {
        let target = preview.conversation

        Avatar(
            url: target.avatarUrl,
            name: target.title,
            id: target.id,
            size: 88,
            shape: .place
        )
        .padding(.bottom, 16)

        Text(target.title ?? "A group")
            .font(YappyFont.headlineSmall)
            .foregroundStyle(colors.textPrimary)
            .multilineTextAlignment(.center)

        Text(subtitle(preview))
            .font(YappyFont.labelMedium)
            .foregroundStyle(colors.textTertiary)
            .padding(.top, 4)

        if let description = target.description, !description.isEmpty {
            Text(description)
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.top, 12)
        }

        if let failure {
            Text(failure)
                .font(YappyFont.labelMedium)
                .foregroundStyle(colors.danger)
                .padding(.top, 12)
        }

        HStack(spacing: 10) {
            NeuButton(action: onDismiss) {
                Text("Not now")
                    .font(YappyFont.labelLarge)
                    .foregroundStyle(colors.textSecondary)
            }
            NeuButton(enabled: !joining, accent: true, action: join) {
                if joining {
                    NeuSpinner(tint: colors.onAccent)
                } else {
                    Text("Join")
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(colors.onAccent)
                }
            }
        }
        .padding(.top, 24)
    }

    private func subtitle(_ preview: InvitePreview) -> String {
        var text = "\(preview.conversation.memberCount) members"
        if let remaining = preview.usesRemaining {
            text += " · \(remaining) use\(remaining == 1 ? "" : "s") left"
        }
        return text
    }

    private func message(_ text: String) -> some View {
        VStack(spacing: 14) {
            Image(systemName: "link.badge.plus")
                .font(.system(size: 30, weight: .light))
                .foregroundStyle(colors.textTertiary)
            Text(text)
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textSecondary)
                .multilineTextAlignment(.center)
            NeuButton(action: onDismiss) {
                Text("Close")
                    .font(YappyFont.labelLarge)
                    .foregroundStyle(colors.textSecondary)
            }
            .padding(.top, 4)
        }
        .padding(.vertical, 20)
    }

    private func join() {
        guard !joining else { return }
        joining = true
        failure = nil

        Task {
            do {
                let result = try await container.repo.joinInvite(code: code)
                onJoined(result.conversationId)
            } catch let error as ApiError {
                failure = error.message
            } catch {
                failure = "Could not join. Try again."
            }
            joining = false
        }
    }
}
