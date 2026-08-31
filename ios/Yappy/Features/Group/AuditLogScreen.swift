import SwiftUI

/**
 * Who changed what, newest first.
 *
 * A full screen rather than a sheet: a log is something you scroll back
 * through, and a sheet is for a glance. It reads
 * `GET /conversations/:id/audit` and composes the sentences here from
 * `action` + `metadata` — the server records facts, the client owns phrasing.
 * Metadata carries labels snapshotted at write time, so a renamed or deleted
 * role still reads as what it was called when the thing happened.
 */
struct AuditLogScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let conversationId: String
    let onBack: () -> Void

    @State private var entries: [AuditEntry]?
    @State private var cursor: String?
    @State private var busy = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                NeuIconButton(systemName: "chevron.left", label: "Back", action: onBack)
                Text("Audit log")
                    .font(YappyFont.headlineSmall)
                    .foregroundStyle(colors.textPrimary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            if entries == nil {
                empty("Loading…")
            } else if entries?.isEmpty == true {
                empty(
                    "Nothing yet. Admin actions — roles, channels, kicks, bans, invites — "
                        + "land here as they happen."
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(entries ?? [], id: \.id) { entry in
                            row(entry)
                        }
                        if cursor != nil {
                            Text(busy ? "Loading…" : "Older")
                                .font(YappyFont.labelLarge)
                                .foregroundStyle(colors.accent)
                                .padding(10)
                                .contentShape(Rectangle())
                                .softTap { loadOlder() }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .neuBackdrop(colors)
        .navigationBarBackButtonHidden(true)
        .task {
            do {
                let page = try await container.repo.audit(conversationId)
                entries = page.entries
                cursor = page.nextCursor
            } catch {
                entries = []
            }
        }
    }

    private func empty(_ text: String) -> some View {
        Text(text)
            .font(YappyFont.bodyMedium)
            .foregroundStyle(colors.textTertiary)
            .multilineTextAlignment(.leading)
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func row(_ entry: AuditEntry) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Avatar(
                url: nil,
                name: entry.actor?.displayName ?? entry.actor?.username,
                id: entry.actor?.id ?? entry.id,
                size: 28
            )
            (
                Text(entry.actor?.displayName ?? entry.actor?.username ?? "someone")
                    .fontWeight(.semibold)
                + Text(" \(auditSentence(entry))")
            )
            .font(YappyFont.bodyMedium)
            .foregroundStyle(colors.textSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(YappyTime.relative(entry.createdAt))
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)
        }
        .padding(.vertical, 8)
    }

    private func loadOlder() {
        guard !busy, let before = cursor else { return }
        busy = true
        Task {
            if let page = try? await container.repo.audit(conversationId, before: before) {
                entries = (entries ?? []) + page.entries
                cursor = page.nextCursor
            }
            busy = false
        }
    }
}

/// One entry, as a sentence. The actor's name is rendered separately.
private func auditSentence(_ entry: AuditEntry) -> String {
    func meta(_ key: String) -> String {
        if case let .string(value)? = entry.metadata?[key] { return value }
        return ""
    }
    func metaList(_ key: String) -> [String] {
        guard case let .array(items)? = entry.metadata?[key] else { return [] }
        return items.compactMap { if case let .string(v) = $0 { return v } else { return nil } }
    }

    let target = entry.targetUser?.displayName ?? entry.targetUser?.username ?? "someone"
    switch entry.action {
    case "role.create": return "created the role \(meta("name"))"
    case "role.update":
        let was = meta("was")
        return was.isEmpty || was == meta("name")
            ? "updated the role \(meta("name"))"
            : "renamed the role \(was) to \(meta("name"))"
    case "role.delete": return "deleted the role \(meta("name"))"
    case "member.roles_set":
        let roles = metaList("roles")
        return roles.isEmpty
            ? "removed all of \(target)'s roles"
            : "set \(target)'s roles to \(roles.joined(separator: ", "))"
    case "channel.create": return "created #\(meta("title"))"
    case "channel.delete": return "deleted #\(meta("title"))"
    case "channel.overwrite_set": return "changed who can use #\(meta("channel")) (\(meta("role")))"
    case "channel.overwrite_remove": return "removed a role's access to #\(meta("channel"))"
    case "invite.create":
        return meta("role").isEmpty ? "created an invite" : "created an invite that grants \(meta("role"))"
    case "invite.revoke": return "revoked an invite"
    case "member.role_changed": return "made \(target) a \(meta("role"))"
    case "member.kicked": return "removed \(target)"
    case "member.banned":
        return meta("reason").isEmpty ? "banned \(target)" : "banned \(target) — \(meta("reason"))"
    case "member.unbanned": return "unbanned \(target)"
    case "member.muted": return "muted \(target)"
    case "member.unmuted": return "unmuted \(target)"
    case "conversation.update":
        let channel = meta("channel")
        let whereText = channel.isEmpty ? "" : " on #\(channel)"
        let changed = metaList("changed").joined(separator: ", ")
        return "changed settings\(whereText): \(changed.isEmpty ? "nothing" : changed)"
    default:
        // A build older than the action that produced the row: name it rather
        // than hide it — an audit log that omits what it does not understand
        // is an audit log with holes.
        return entry.action
    }
}
