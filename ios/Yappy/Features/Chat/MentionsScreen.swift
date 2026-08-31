import SwiftUI

/**
 * Everywhere you were called.
 *
 * One list across every group, so "where was I pinged while I was away" is a
 * question with an answer — before this it could only be reconstructed by
 * opening each room and looking for the badge, which is exactly the work a
 * notification list exists to save.
 */
struct MentionsScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let onBack: () -> Void
    /// Opens the room *at* the message, not merely at the bottom of it.
    let onOpenMessage: (String, Int64) -> Void

    @State private var entries: [MentionEntry]?
    @State private var loadFailed = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                NeuIconButton(systemName: "chevron.left", label: "Back", action: onBack)
                Text("Mentions")
                    .font(YappyFont.headlineSmall)
                    .foregroundStyle(colors.textPrimary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            if loadFailed {
                empty("Couldn’t load your mentions.")
            } else if entries == nil {
                empty("Loading…")
            } else if entries?.isEmpty == true {
                empty(
                    "Nobody has called you yet. When somebody uses your name, a role you hold, "
                        + "or @everyone, it lands here."
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(entries ?? [], id: \.rowId) { entry in
                            row(entry)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                }
                .refreshable {
                    await load()
                    Haptics.success()
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(colors.surface)
        .navigationBarBackButtonHidden(true)
        .task { await load() }
    }

    private func load() async {
        do {
            entries = try await container.repo.mentions().mentions
            loadFailed = false
        } catch {
            // A failed refresh over a list already on screen keeps the list;
            // the flag only shows its message when there is nothing better.
            if entries == nil { loadFailed = true }
        }
    }

    private func empty(_ text: String) -> some View {
        Text(text)
            .font(YappyFont.bodyMedium)
            .foregroundStyle(colors.textTertiary)
            .multilineTextAlignment(.center)
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    private func row(_ entry: MentionEntry) -> some View {
        HStack(alignment: .top, spacing: 10) {
            /*
             * A mention still waiting for you.
             *
             * A bar down the leading edge and a tint behind the row, rather
             * than a bolder row: the list is already dense with names and
             * room titles, and making half of it heavier makes the whole
             * thing harder to scan. The bar is what the eye finds; the tint
             * says where the run ends.
             */
            if entry.unread {
                Capsule()
                    .fill(colors.accent)
                    .frame(width: 2, height: 36)
            }
            Avatar(
                url: entry.message?.sender?.avatarUrl,
                name: entry.message?.sender?.label,
                id: entry.message?.senderId ?? entry.conversation.id,
                size: 36
            )
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    // A channel names its space: "#general" alone is the title
                    // of half the channels anybody is in.
                    Text(entry.conversation.label)
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(colors.textPrimary)
                        .lineLimit(1)
                    // A direct mention and a broadcast are not the same event
                    // to the person receiving one — somebody used your name, or
                    // you were in a room that got called.
                    if entry.isBroadcast {
                        Text("GROUP")
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.textTertiary)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(colors.veil, in: RoundedRectangle(cornerRadius: 5))
                    }
                    Spacer(minLength: 0)
                    if let created = entry.message?.createdAt {
                        Text(YappyTime.relative(created))
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.textTertiary)
                    }
                }
                Text(entry.preview)
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(colors.textSecondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        /*
         * `accentSoft` rather than a fixed colour: it is defined per theme
         * — a pale violet on the light surface and a deep one on the dark —
         * so this is legible in both. A hardcoded rgba would have been right
         * in exactly one of them.
         */
        .background(
            entry.unread ? colors.accentSoft : Color.clear,
            in: NeuShape(radius: Neu.cornerMedium)
        )
        .contentShape(Rectangle())
        .softTap {
            guard let seq = entry.message?.seq else { return }
            onOpenMessage(entry.conversation.id, seq)
        }
    }
}

private extension MentionEntry {
    /// Stable across a reload; the message is what the row is about.
    var rowId: String { message?.id ?? conversation.id }

    var preview: String {
        let said = message?.content?.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = (said?.isEmpty == false ? said! : "sent something")
        guard let who = message?.sender?.label else { return body }
        return "\(who)  \(body)"
    }
}

private extension MentionConversation {
    var label: String {
        let here = title ?? (type == "dm" ? "Direct message" : "Untitled")
        guard let parentTitle else { return here }
        return "\(parentTitle) / \(here)"
    }
}
