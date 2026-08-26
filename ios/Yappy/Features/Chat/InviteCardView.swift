import SwiftUI

/// An invite link, drawn as the group it opens.
///
/// What this replaces was the app reading its own website: the link went out
/// through the generic unfurler, which fetched yappy.gg as an anonymous
/// stranger and got back the only thing that page tells strangers — "Join a
/// group on yappy. You have been invited to a group on yappy." Two sentences
/// that name neither the group nor anybody in it, on a card whose only action
/// was to leave for a browser.
///
/// The server resolves the code against the database now, so the card knows
/// which group, how many people are in it, and what it looks like. Joining
/// happens in the app: the button hands the code to the same pending-link path
/// a tapped invite uses, which opens the sheet that already knows how to join
/// and where to navigate afterwards. Nobody should have to visit a website to
/// accept an invitation to the app they are holding.
///
/// Kept in step with android/.../ui/chat/InviteEmbedCard.kt.
struct InviteCardView: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let invite: EmbedInvite

    private var kind: String {
        switch invite.type {
        case "space": return "Space"
        case "channel": return "Channel"
        default: return "Group"
        }
    }

    private var name: String {
        let trimmed = (invite.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "A group on yappy" : trimmed
    }

    var body: some View {
        NeuSurface(contentPadding: 14) {
            VStack(alignment: .leading, spacing: 0) {
                Text("YOU HAVE BEEN INVITED TO JOIN")
                    .font(YappyFont.labelSmall)
                    .kerning(0.8)
                    .foregroundStyle(colors.textTertiary)
                    .padding(.bottom, 10)

                HStack(spacing: 12) {
                    // A squircle, not a circle. The rule the whole app follows:
                    // circles are people, squircles are places, and an invite is
                    // always to a place.
                    Avatar(
                        url: invite.avatarUrl,
                        name: name,
                        id: invite.code,
                        size: 46,
                        shape: .place
                    )
                    VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: 4) {
                            Text(name)
                                .font(YappyFont.titleSmall)
                                .foregroundStyle(colors.textPrimary)
                                .lineLimit(1)
                            BadgeMark(badge: invite.badge, size: 13)
                        }
                        Text("\(kind) · \(invite.memberCount) \(invite.memberCount == 1 ? "member" : "members")")
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.textTertiary)
                    }
                    Spacer(minLength: 0)
                }

                if let description = invite.description, !description.isEmpty {
                    Text(description)
                        .font(YappyFont.bodySmall)
                        .foregroundStyle(colors.textSecondary)
                        .lineLimit(2)
                        .padding(.top, 10)
                }

                NeuButton(accent: true, action: {
                    // The same pending-link path a tapped invite link takes:
                    // RootView consumes it and presents the InviteSheet, which
                    // already knows how to join and where to navigate after.
                    container.pendingLink = .invite(invite.code)
                }) {
                    Text("Join")
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(colors.onAccent)
                }
                .padding(.top, 12)
            }
        }
        .frame(maxWidth: 300)
    }
}
