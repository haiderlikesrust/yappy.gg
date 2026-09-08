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

    @StateObject private var model = NotificationInboxModel()

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

            List {
                if !model.loaded && model.loading {
                    ProgressView("Loading…")
                        .frame(maxWidth: .infinity)
                } else if model.loaded && model.entries.isEmpty && model.error == nil {
                    Text("Nothing yet. Mentions, verification updates, affiliations, and new roles land here.")
                        .foregroundStyle(colors.textTertiary)
                        .padding(.vertical, 24)
                }
                ForEach(model.entries) { entry in
                    Group {
                        switch entry {
                        case .mention(let mention): row(mention)
                        case .notice(let notice):
                            NotificationRow(entry: notice, onOpenGroup: onOpenGroup,
                                            onOpenProfile: onOpenProfile, onOpenMessage: onOpenMessage)
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 12))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        Button(entry.dismissLabel, systemImage: "xmark") { dismiss(entry) }
                            .tint(colors.textSecondary)
                            .disabled(model.loading || model.dismissing.contains(entry.id))
                    }
                    .contextMenu {
                        Button(entry.dismissLabel, systemImage: "xmark") { dismiss(entry) }
                            .disabled(model.loading || model.dismissing.contains(entry.id))
                    }
                    .accessibilityAction(named: Text(entry.dismissLabel)) { dismiss(entry) }
                }
                if let error = model.error {
                    VStack(spacing: 12) {
                        Text(error).font(YappyFont.bodyMedium)
                        Button("Retry") { Task { await load() } }
                            .disabled(model.loading)
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                } else if model.hasMore && model.loaded {
                    Button("Load more") { Task { await load() } }
                        .disabled(model.loading)
                        .frame(maxWidth: .infinity)
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .onAppear { Task { await load() } }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .refreshable { await load(refresh: true) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .neuBackdrop(colors)
        .navigationBarBackButtonHidden(true)
        .task { await load() }
    }

    @MainActor
    private func load(refresh: Bool = false) async {
        guard let userId = container.session.userId else { return }
        let generation = container.session.generation
        await model.load(container.repo, userId: userId, refresh: refresh,
                         isCurrent: { container.session.generation == generation })
        guard !Task.isCancelled else { return }
        await container.refreshBadge()
    }

    private func dismiss(_ entry: InboxEntry) {
        Task {
            await model.dismiss(entry, api: container.repo)
            await container.refreshBadge()
        }
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
