import SwiftUI

/// Moderation surfaces that are too big to live inside the settings scroll:
/// the ban list, and invite-link management.

// ── Shared permission arithmetic ─────────────────────────────────────────────

/// The conversation-wide permission floor, as the server computes it.
///
/// Duplicated from `packages/shared/src/permissions.ts` for the same reason
/// `Perm` in GroupSettingsScreen is: these bits are part of the wire format and
/// cannot move without a coordinated release. Only the two floors the UI can
/// actually set are mirrored — the full table stays server-side.
enum BaseFloor {
    private static func bit(_ index: Int64) -> Int64 { Int64(1) << index }

    /// What an ordinary group gives everyone: read, write, react, call, invite.
    static let member: Int64 = {
        let send = bit(2) | bit(3) | bit(4) | bit(5) | bit(6) | bit(7) | bit(8) | bit(10)
        let own = bit(11) | bit(12)
        return bit(0) | bit(1) | send | own | bit(20) | bit(21) | bit(23) | bit(30)
    }()

    /// Announcement mode: everyone may read and react, nobody may post. Roles
    /// hand posting back to the people who should still have it, which is why
    /// this works as a *floor* rather than as a lock.
    static let announcement: Int64 = bit(0) | bit(1) | bit(8)

    /// A conversation with no explicit base inherits `member`, so nil reads as
    /// "everyone can post".
    static func isAnnouncement(_ raw: String?) -> Bool {
        guard let raw, let bits = Int64(raw) else { return false }
        return bits & bit(2) == 0
    }
}

// ── Ban list ─────────────────────────────────────────────────────────────────

/// Who has been thrown out, and the way back in.
///
/// Until this existed a ban was a one-way door: the API could set one and clear
/// one, but nothing could tell you a ban was there, so an accidental ban was
/// unrecoverable from inside the app.
struct BanListSheet: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let conversationId: String

    @State private var bans: [BanEntry]?
    @State private var working: Set<String> = []

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Banned")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textPrimary)

                Text("Someone who is banned cannot rejoin, even with an invite link.")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
                    .padding(.top, 4)
                    .padding(.bottom, 14)

                if bans == nil {
                    NeuSpinner().frame(maxWidth: .infinity).padding(.vertical, 30)
                } else if bans?.isEmpty == true {
                    Text("Nobody is banned.")
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.textTertiary)
                        .padding(.vertical, 20)
                }

                ForEach(bans ?? []) { ban in
                    row(ban)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 28)
        }
        .task { bans = (try? await container.repo.bans(conversationId).bans) ?? [] }
    }

    private func row(_ ban: BanEntry) -> some View {
        HStack(spacing: 12) {
            Avatar(url: ban.user.avatarUrl, name: ban.user.label, id: ban.user.id, size: 38)

            VStack(alignment: .leading, spacing: 1) {
                Text(ban.user.label)
                    .font(YappyFont.bodyLarge)
                    .foregroundStyle(colors.textPrimary)
                if let reason = ban.reason, !reason.isEmpty {
                    Text(reason)
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                        .lineLimit(1)
                } else if let when = ban.createdAt {
                    Text(YappyTime.relative(when))
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Text(working.contains(ban.id) ? "…" : "Unban")
                .font(YappyFont.labelMedium)
                .foregroundStyle(colors.accent)
                .softTap(enabled: !working.contains(ban.id)) {
                    working.insert(ban.id)
                    Task {
                        try? await container.repo.unban(conversationId, userId: ban.user.id)
                        bans?.removeAll { $0.id == ban.id }
                        working.remove(ban.id)
                    }
                }
        }
        .padding(.vertical, 8)
    }
}

// ── Invite links ─────────────────────────────────────────────────────────────

private let expiryChoices: [(String, Int?)] = [
    ("Never", nil),
    ("1 day", 86_400),
    ("7 days", 604_800),
    ("30 days", 2_592_000),
]

private let usesChoices: [(String, Int)] = [
    ("Unlimited", 0),
    ("1 use", 1),
    ("5 uses", 5),
    ("25 uses", 25),
]

/// Create, share and revoke invite links.
///
/// A group with one permanent unlimited link has no way to un-share it once it
/// leaks, which is the actual failure mode for a public group — hence revoke,
/// and hence expiry as the default-shaped option rather than a buried one.
struct InviteManagerSheet: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let conversationId: String

    @State private var invites: [Invite]?
    @State private var expiry: Int?
    @State private var uses = 0
    @State private var busy = false
    @State private var copiedCode: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Invite links")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textPrimary)
                    .padding(.bottom, 14)

                creator

                if invites == nil {
                    NeuSpinner().frame(maxWidth: .infinity).padding(.vertical, 26)
                } else if invites?.isEmpty == true {
                    Text("No links yet.")
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.textTertiary)
                        .padding(.top, 20)
                }

                ForEach(invites ?? []) { invite in
                    row(invite).padding(.top, 10)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 30)
        }
        .task { invites = (try? await container.repo.invites(conversationId).invites) ?? [] }
    }

    private var creator: some View {
        NeuSurface(radius: Neu.cornerMedium, contentPadding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                chips("Expires", expiryChoices.map(\.0), selected: expiryChoices.firstIndex { $0.1 == expiry } ?? 0) {
                    expiry = expiryChoices[$0].1
                }
                chips("Uses", usesChoices.map(\.0), selected: usesChoices.firstIndex { $0.1 == uses } ?? 0) {
                    uses = usesChoices[$0].1
                }

                NeuButton(enabled: !busy, accent: true) {
                    busy = true
                    Task {
                        if let created = try? await container.repo.createInvite(
                            conversationId, maxUses: uses, expiresInSeconds: expiry
                        ).invite {
                            invites?.insert(created, at: 0)
                        }
                        busy = false
                    }
                } content: {
                    Text(busy ? "Creating…" : "Create link")
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(colors.onAccent)
                }
            }
        }
    }

    private func chips(
        _ label: String,
        _ options: [String],
        selected: Int,
        onPick: @escaping (Int) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(label)
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                        NeuChip(label: option, selected: index == selected) { onPick(index) }
                    }
                }
            }
        }
    }

    private func row(_ invite: Invite) -> some View {
        NeuSurface(radius: Neu.cornerMedium, contentPadding: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Image(systemName: "link")
                        .font(.system(size: 13))
                        .foregroundStyle(colors.accent)
                    Text(invite.url)
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.textSecondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(copiedCode == invite.code ? "copied" : "copy")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.accent)
                        .softTap {
                            UIPasteboard.general.string = invite.url
                            copiedCode = invite.code
                        }
                }

                HStack(spacing: 8) {
                    Text(describe(invite))
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                    Spacer(minLength: 0)
                    Text("revoke")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.danger)
                        .softTap {
                            Task {
                                try? await container.repo.revokeInvite(conversationId, code: invite.code)
                                invites?.removeAll { $0.code == invite.code }
                            }
                        }
                }
            }
        }
    }

    private func describe(_ invite: Invite) -> String {
        var parts: [String] = []
        parts.append(invite.maxUses == 0 ? "\(invite.uses) uses" : "\(invite.uses)/\(invite.maxUses) used")
        if let expires = invite.expiresAt { parts.append("expires \(YappyTime.relative(expires))") }
        return parts.joined(separator: " · ")
    }
}

/// Pick a bot to add to this group.
///
/// Adding goes through the ordinary add-members call rather than anything
/// bot-specific: a bot is a user row, so it lands with the same permission
/// check and the same "X added Y" system message a person would. The group can
/// see it arrive, which for something that reads every message is the point.
struct BotPickerSheet: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let conversationId: String

    @State private var bots: [DirectoryBot]?
    @State private var adding: String?
    @State private var added: Set<String> = []
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Add a bot")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textPrimary)

                Text("It will be able to read this group's messages and post in it.")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
                    .padding(.top, 4)
                    .padding(.bottom, 14)

                if bots == nil {
                    NeuSpinner().frame(maxWidth: .infinity).padding(.vertical, 30)
                } else if bots?.isEmpty == true {
                    Text("No public bots yet. Build one in the developer portal and mark it public.")
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.textTertiary)
                        .padding(.vertical, 20)
                }

                ForEach(bots ?? []) { bot in
                    row(bot).padding(.bottom, 10)
                }

                if let error {
                    Text(error)
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.danger)
                        .padding(.top, 12)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 28)
        }
        .task { bots = (try? await container.repo.botDirectory().bots) ?? [] }
    }

    private func row(_ bot: DirectoryBot) -> some View {
        let isAdded = added.contains(bot.botUserId)
        let blurb = bot.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let subtitle = blurb.isEmpty
            ? (bot.commandCount > 0 ? "\(bot.commandCount) commands" : "Bot")
            : blurb

        return NeuSurface(radius: Neu.cornerMedium, contentPadding: 14) {
            HStack(spacing: 12) {
                Avatar(url: bot.user?.avatarUrl, name: bot.name, id: bot.botUserId, size: 40)

                VStack(alignment: .leading, spacing: 2) {
                    Text(bot.name)
                        .font(YappyFont.bodyLarge)
                        .foregroundStyle(colors.textPrimary)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.textTertiary)
                        .lineLimit(2)
                }

                Spacer(minLength: 0)

                if isAdded {
                    Text("Added")
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(colors.success)
                } else {
                    NeuButton(enabled: adding == nil, accent: true) {
                        add(bot)
                    } content: {
                        if adding == bot.botUserId {
                            NeuSpinner(tint: colors.onAccent)
                        } else {
                            Text("Add")
                                .font(YappyFont.labelLarge)
                                .foregroundStyle(colors.onAccent)
                        }
                    }
                    .frame(width: 96)
                }
            }
        }
    }

    private func add(_ bot: DirectoryBot) {
        guard adding == nil else { return }
        adding = bot.botUserId
        error = nil
        Task {
            do {
                try await container.repo.addMembers(conversationId, userIds: [bot.botUserId])
                added.insert(bot.botUserId)
            } catch {
                self.error = "Could not add \(bot.name)."
            }
            adding = nil
        }
    }
}
