import SwiftUI

/// Mentions and platform notices share one chronological inbox.
/// The existing route name is kept so saved navigation remains valid.
struct MentionsScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let onBack: () -> Void
    /// Opens the room *at* the message, not merely at the bottom of it.
    let onOpenMessage: (String, Int64) -> Void
    let onOpenGroup: (String) -> Void
    let onOpenProfile: (String) -> Void

    @State private var entries: [InboxEntry]?
    @State private var loadFailed = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                NeuIconButton(systemName: "chevron.left", label: "Back", action: onBack)
                Text("Notifications")
                    .font(YappyFont.headlineSmall)
                    .foregroundStyle(colors.textPrimary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            if loadFailed {
                empty("Couldn’t load your notifications.")
            } else if entries == nil {
                empty("Loading…")
            } else if entries?.isEmpty == true {
                empty(
                    "Nothing yet. Mentions, verification updates, affiliations, and new roles land here."
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 4) {
                        ForEach(entries ?? []) { entry in
                            switch entry {
                            case .mention(let mention):
                                row(mention)
                            case .notice(let notice):
                                NotificationRow(
                                    entry: notice, onOpenGroup: onOpenGroup, onOpenProfile: onOpenProfile, onOpenMessage: onOpenMessage
                                )
                            }
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
        .neuBackdrop(colors)
        .navigationBarBackButtonHidden(true)
        .task { await load() }
    }

    @MainActor
    private func load() async {
        // Either source may fail independently without hiding the other one.
        async let noticeRequest: NotificationsEnvelope? = try? container.repo.notifications()
        async let mentionRequest: MentionsEnvelope? = try? container.repo.mentions()
        let (notices, mentions) = await (noticeRequest, mentionRequest)
        guard !Task.isCancelled else { return }
        guard notices != nil || mentions != nil else {
            if entries == nil { loadFailed = true }
            return
        }

        // A partial refresh keeps the failed source's already-visible rows.
        let old = entries ?? []
        let noticeRows = notices.map { result in
            result.notifications.filter { NotificationCopy($0) != nil }.map(InboxEntry.notice)
        } ?? old.filter {
            if case .notice = $0 { return true }
            return false
        }
        let mentionRows = mentions.map { $0.mentions.map(InboxEntry.mention) }
            ?? old.filter {
                if case .mention = $0 { return true }
                return false
            }
        entries = (noticeRows + mentionRows).sorted {
            $0.createdAt == $1.createdAt ? $0.id > $1.id : $0.createdAt > $1.createdAt
        }
        loadFailed = false

        // A failed notice fetch must not acknowledge notices the user never saw.
        // Keep this visit's highlight, and clear the home count only after the server agrees.
        if notices != nil {
            do {
                _ = try await container.repo.readNotifications()
                container.setUnreadNotifications(0)
            } catch {
                // Keep the server's count when acknowledgement fails.
            }
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

private enum InboxEntry: Identifiable {
    case mention(MentionEntry)
    case notice(NotificationEntry)

    var id: String {
        switch self {
        case .mention(let entry): return "mention:\(entry.rowId)"
        case .notice(let entry): return "notice:\(entry.id)"
        }
    }

    var createdAt: Date {
        switch self {
        case .mention(let entry): return YappyTime.parse(entry.message?.createdAt) ?? .distantPast
        case .notice(let entry): return YappyTime.parse(entry.createdAt) ?? .distantPast
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
