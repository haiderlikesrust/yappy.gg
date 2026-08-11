import SwiftUI

/// Group settings — identity, flair, access.
///
/// Flair edits are staged locally and rendered in a live "how it shows on the
/// list" preview, then applied in one PATCH. Staging matters: someone trying
/// five gradients should not broadcast five conversation.update events to every
/// member's phone.

private let gradientPresets: [(String, String)?] = [
    nil, // no flair
    ("#6C5CE7", "#00CEC9"),
    ("#FF7675", "#FDCB6E"),
    ("#00B894", "#55EFC4"),
    ("#0984E3", "#74B9FF"),
    ("#E84393", "#FD79A8"),
    ("#2D3436", "#6C5CE7"),
]

private let emojiPresets: [String?] = [nil, "⚡", "🔥", "🌊", "🌸", "👾", "🎮", "🚀", "💜"]

/// Permission bits, mirrored from the server's `Permission` map.
///
/// Duplicated rather than fetched because they are part of the wire format and
/// cannot change without a coordinated release anyway — and a client that has to
/// round-trip before it can render a checkbox is a client that renders nothing
/// offline.
private enum Perm {
    static let pinMessages: Int64 = 1 << 14
    static let deleteAnyMessage: Int64 = 1 << 13
    static let mentionAll: Int64 = 1 << 9
    static let kickMembers: Int64 = 1 << 32
    static let muteMembers: Int64 = 1 << 34
    static let banMembers: Int64 = 1 << 33
    static let manageInvites: Int64 = 1 << 31
    static let manageConversation: Int64 = 1 << 36
}

/// What roles are actually used for, rather than every bit the server knows.
///
/// A phone-sized screen cannot present forty independent switches usefully, and
/// a badly-configured role is worse than a coarse one — so this offers three
/// shapes people recognise. The API takes arbitrary bitfields for anyone who
/// needs something else.
private let rolePresets: [(String, Int64)] = [
    ("Cosmetic", 0),
    ("Trusted", Perm.pinMessages | Perm.mentionAll),
    ("Moderator", Perm.pinMessages | Perm.mentionAll | Perm.deleteAnyMessage
        | Perm.muteMembers | Perm.kickMembers),
]

private let roleColors = ["#8B7CFF", "#22C55E", "#F59E0B", "#EF4444", "#06B6D4", "#EC4899"]

/// Key, label, and the blurb shown under the picker.
private let notifyLevels: [(String, String, String)] = [
    ("all", "All", "Every message"),
    ("mentions", "Mentions", "Only when named"),
    ("none", "None", "Nothing"),
]

private let muteDurations: [(String, TimeInterval)] = [
    ("8 hours", 8 * 3_600),
    ("1 week", 7 * 86_400),
    ("1 year", 365 * 86_400),
]

private let slowModes: [(String, Int)] = [
    ("Off", 0), ("5s", 5), ("30s", 30), ("1m", 60), ("5m", 300), ("1h", 3_600),
]

/// Must match the server's `DISAPPEARING_PRESETS` — anything else is rejected.
private let disappearing: [(String, Int)] = [
    ("Off", 0), ("1 hour", 3_600), ("1 day", 86_400), ("1 week", 604_800),
    ("30 days", 2_592_000), ("90 days", 7_776_000),
]

private func permissionSummary(_ permissions: String) -> String {
    let bits = Int64(permissions) ?? 0
    if bits == 0 { return "Colour and label only" }

    var names: [String] = []
    if bits & Perm.pinMessages != 0 { names.append("pin") }
    if bits & Perm.deleteAnyMessage != 0 { names.append("delete any") }
    if bits & Perm.mentionAll != 0 { names.append("mention all") }
    if bits & Perm.muteMembers != 0 { names.append("mute") }
    if bits & Perm.kickMembers != 0 { names.append("kick") }
    if bits & Perm.banMembers != 0 { names.append("ban") }
    if bits & Perm.manageInvites != 0 { names.append("invites") }
    if bits & Perm.manageConversation != 0 { names.append("settings") }

    return names.isEmpty ? "Custom permissions" : names.joined(separator: " · ")
}

struct GroupSettingsScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let conversationId: String
    let onBack: () -> Void

    @State private var conversation: Conversation?
    @State private var title = ""
    @State private var description = ""
    @State private var staged: ConversationAppearance?
    @State private var inviteUrl: String?
    @State private var roles: [RoleEntry] = []
    @State private var newRoleName = ""
    @State private var newRoleColor: String? = roleColors.first
    @State private var newRolePerms: Int64 = rolePresets[0].1
    @State private var firstChannel = "general"
    @State private var confirmUpgrade = false
    @State private var upgrading = false
    @State private var busy = false
    @State private var savedTick = false
    @State private var logoBusy = false
    @State private var copied = false

    // Your own notification state for this group.
    @State private var notifyLevel = "all"
    @State private var mutedUntil: String?

    // Group-wide settings.
    @State private var announcementOnly = false
    @State private var slowMode = 0
    @State private var fullHistory = false
    @State private var disappearingSeconds = 0
    @State private var bansOpen = false
    @State private var invitesOpen = false
    @State private var botPickerOpen = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header

                if let conversation {
                    logo(conversation)
                    preview(conversation)
                    // First, because it is the only section every member can
                    // change — everything below it needs MANAGE_CONVERSATION.
                    notifications
                    identity
                    flair
                    access(conversation)
                    posting(conversation)
                    moderation
                    rolesSection
                    botsSection
                    if conversation.type == "group", conversation.selfState?.role == "owner" {
                        upgradeSection
                    }
                    saveButton
                } else {
                    NeuSpinner().frame(maxWidth: .infinity).frame(height: 280)
                }
            }
            .padding(.bottom, 40)
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .scrollDismissesKeyboard(.interactively)
        .sheet(isPresented: $bansOpen) {
            BanListSheet(conversationId: conversationId)
                .presentationDetents([.medium, .large])
                .presentationBackground(colors.surface)
        }
        .sheet(isPresented: $botPickerOpen) {
            BotPickerSheet(conversationId: conversationId)
                .presentationDetents([.medium, .large])
                .presentationBackground(colors.surface)
        }
        .sheet(isPresented: $invitesOpen, onDismiss: {
            // The Access card shows the newest link; a create or revoke inside
            // the sheet changes which one that is.
            Task { inviteUrl = try? await container.repo.invites(conversationId).invites.first?.url }
        }) {
            InviteManagerSheet(conversationId: conversationId)
                .presentationDetents([.medium, .large])
                .presentationBackground(colors.surface)
        }
        .task { await load() }
    }

    private func load() async {
        // The cached copy paints the editor immediately; the fresh copy
        // replaces it a beat later. The clobber window (typing into a field
        // during that beat) existed before the seed too — fields always
        // populated whenever the fetch happened to land.
        if conversation == nil,
           let cached = DiskCache.decode(ConversationEnvelope.self, key: "conversation_\(conversationId)") {
            apply(cached.conversation)
        }

        if let loaded = try? await container.repo.conversation(conversationId, cacheTo: true).conversation {
            apply(loaded)
        }

        inviteUrl = try? await container.repo.invites(conversationId).invites.first?.url
        roles = (try? await container.repo.roles(conversationId).roles) ?? []
    }

    private func apply(_ loaded: Conversation) {
        conversation = loaded
        title = loaded.title ?? ""
        description = loaded.description ?? ""
        staged = loaded.appearance

        notifyLevel = loaded.selfState?.notificationLevel ?? "all"
        mutedUntil = loaded.selfState?.mutedUntil
        announcementOnly = BaseFloor.isAnnouncement(loaded.basePermissions)
        slowMode = loaded.slowModeSeconds ?? 0
        fullHistory = loaded.historyVisibility == "full"
        disappearingSeconds = loaded.disappearingSeconds ?? 0
    }

    // ── Sections ─────────────────────────────────────────────────────────────

    private var header: some View {
        HStack(spacing: 14) {
            NeuIconButton(systemName: "chevron.left", label: "Back", size: 42, iconSize: 18, action: onBack)
            Text(conversation?.isSpace == true ? "Space settings" : "Group settings")
                .font(YappyFont.headlineSmall)
                .foregroundStyle(colors.textPrimary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    /// Above the preview, because it is the thing the preview is previewing.
    private func logo(_ conversation: Conversation) -> some View {
        EditableAvatar(
            url: conversation.displayAvatar,
            name: title.isEmpty ? conversation.displayName : title,
            id: conversation.avatarSeed,
            size: 92,
            shape: .place,
            busy: logoBusy
        ) { picked in
            Task {
                logoBusy = true
                if let uploaded = try? await container.uploader.upload(picked, purpose: "conversation_avatar"),
                   let updated = try? await container.repo.setConversationAvatar(
                       conversationId, mediaId: uploaded.mediaId
                   ).conversation {
                    self.conversation = updated
                }
                logoBusy = false
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 8)
        .padding(.bottom, 16)
    }

    /// Exactly the row the list will render.
    private func preview(_ conversation: Conversation) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "How it shows on the list")
                .padding(.leading, 24)
                .padding(.top, 6)

            HStack(spacing: 13) {
                FlairAvatar(
                    appearance: staged,
                    url: conversation.displayAvatar,
                    name: title.isEmpty ? conversation.displayName : title,
                    id: conversation.avatarSeed,
                    size: 52,
                    shape: .place
                )

                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(title.isEmpty ? conversation.displayName : title)
                            .font(YappyFont.titleMedium)
                            .foregroundStyle(staged?.titleColor ?? colors.textPrimary)
                            .lineLimit(1)
                        if let emoji = staged?.emoji {
                            Text(emoji).font(YappyFont.titleMedium)
                        }
                    }
                    Text("the last message shows here")
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.textTertiary)
                }
                Spacer(minLength: 0)
            }
            .padding(12)
            .background(colors.incoming, in: NeuShape(radius: Neu.cornerMedium))
            .padding(.horizontal, 20)
        }
    }

    /// Per-member, not per-group: this is *your* mute, and nobody else sees it.
    private var notifications: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Notifications")
                .padding(.leading, 24)
                .padding(.top, 22)

            NeuSurface(radius: Neu.cornerMedium, contentPadding: 14) {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        ForEach(notifyLevels, id: \.0) { key, label, _ in
                            NeuChip(label: label, selected: notifyLevel == key) {
                                notifyLevel = key
                                mutedUntil = nil
                                Task {
                                    _ = try? await container.repo.setNotificationLevel(conversationId, level: key)
                                    container.notificationLevels[conversationId] = key
                                }
                            }
                        }
                        Spacer(minLength: 0)
                    }

                    Text(notifyBlurb)
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)

                    NeuHairline()

                    Text("Mute for a while")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)

                    HStack(spacing: 8) {
                        ForEach(muteDurations, id: \.0) { label, seconds in
                            NeuChip(label: label, selected: false) { mute(for: seconds) }
                        }
                        Spacer(minLength: 0)
                    }

                    if let until = mutedUntil {
                        HStack(spacing: 6) {
                            Image(systemName: "bell.slash")
                                .font(.system(size: 12))
                                .foregroundStyle(colors.accent)
                            Text("Muted until \(YappyTime.relative(until))")
                                .font(YappyFont.labelSmall)
                                .foregroundStyle(colors.textSecondary)
                            Spacer(minLength: 0)
                            Text("unmute")
                                .font(YappyFont.labelSmall)
                                .foregroundStyle(colors.accent)
                                .softTap { mute(for: nil) }
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
        }
    }

    private var notifyBlurb: String {
        switch notifyLevel {
        case "mentions": return "Only when someone says your name or @everyone."
        case "none": return "Nothing at all. The group still shows unread messages."
        default: return "Every message."
        }
    }

    /// Nil clears the timed mute and leaves the level alone.
    private func mute(for seconds: TimeInterval?) {
        let until = seconds.map { Date().addingTimeInterval($0) }
        mutedUntil = until.map { ISO8601DateFormatter().string(from: $0) }
        Task {
            try? await container.repo.setConversationState(conversationId, mutedUntil: mutedUntil)
        }
    }

    /// Who may speak. Modelled as the permission floor, because that is what
    /// the server actually stores — a boolean here would be a second source of
    /// truth that a role edit could silently contradict.
    private func posting(_ conversation: Conversation) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Posting")
                .padding(.leading, 24)
                .padding(.top, 22)

            NeuSurface(radius: Neu.cornerMedium, contentPadding: 14) {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Only admins can post")
                                .font(YappyFont.bodyLarge)
                                .foregroundStyle(colors.textPrimary)
                            Text("Everyone can still read and react. Roles can hand posting back.")
                                .font(YappyFont.labelSmall)
                                .foregroundStyle(colors.textTertiary)
                        }
                        Spacer(minLength: 0)
                        NeuSwitch(isOn: Binding(
                            get: { announcementOnly },
                            set: { next in
                                announcementOnly = next
                                Task {
                                    _ = try? await container.repo.setBasePermissions(
                                        conversationId,
                                        String(next ? BaseFloor.announcement : BaseFloor.member)
                                    )
                                }
                            }
                        ))
                    }

                    NeuHairline()

                    Text("Slow mode")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(slowModes, id: \.1) { label, seconds in
                                NeuChip(label: label, selected: slowMode == seconds) {
                                    slowMode = seconds
                                    Task { _ = try? await container.repo.setSlowMode(conversationId, seconds: seconds) }
                                }
                            }
                        }
                    }

                    if slowMode > 0 {
                        Text("Members must wait between messages. Moderators are exempt.")
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.textTertiary)
                    }
                }
            }
            .padding(.horizontal, 20)
        }
    }

    private var moderation: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Members and history")
                .padding(.leading, 24)
                .padding(.top, 22)

            NeuSurface(radius: Neu.cornerMedium, contentPadding: 14) {
                VStack(alignment: .leading, spacing: 14) {
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("New members can read old messages")
                                .font(YappyFont.bodyLarge)
                                .foregroundStyle(colors.textPrimary)
                            // Says the part people get wrong: it is not
                            // retroactive, in either direction.
                            Text("Applies to people who join from now on. It does not open history to anyone already here, and turning it off does not take it away.")
                                .font(YappyFont.labelSmall)
                                .foregroundStyle(colors.textTertiary)
                        }
                        Spacer(minLength: 0)
                        NeuSwitch(isOn: Binding(
                            get: { fullHistory },
                            set: { next in
                                fullHistory = next
                                Task {
                                    _ = try? await container.repo.setHistoryVisibility(
                                        conversationId, next ? "full" : "since_join"
                                    )
                                }
                            }
                        ))
                    }

                    NeuHairline()

                    Text("Disappearing messages")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(disappearing, id: \.1) { label, seconds in
                                NeuChip(label: label, selected: disappearingSeconds == seconds) {
                                    disappearingSeconds = seconds
                                    Task {
                                        _ = try? await container.repo.setDisappearing(conversationId, seconds: seconds)
                                    }
                                }
                            }
                        }
                    }

                    NeuHairline()

                    Button { bansOpen = true } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "nosign")
                                .font(.system(size: 15))
                                .foregroundStyle(colors.textSecondary)
                            Text("Banned members")
                                .font(YappyFont.bodyLarge)
                                .foregroundStyle(colors.textPrimary)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(colors.textTertiary)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 20)
        }
    }

    private var identity: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: "Identity")
                .padding(.leading, 24)
                .padding(.top, 22)

            NeuTextField(text: $title, placeholder: "Group name").padding(.horizontal, 20)
            NeuTextField(text: $description, placeholder: "Description", multiline: true, lineLimit: 3)
                .padding(.horizontal, 20)
        }
    }

    private var flair: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Flair")
                .padding(.leading, 24)
                .padding(.top, 22)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(Array(gradientPresets.enumerated()), id: \.offset) { _, preset in
                        gradientSwatch(preset)
                    }
                }
                .padding(.horizontal, 20)
            }

            HStack(spacing: 8) {
                ForEach([("none", "Still"), ("glow", "Glow"), ("shimmer", "Shimmer")], id: \.0) { key, label in
                    NeuChip(label: label, selected: (staged?.effect ?? "none") == key) {
                        var next = staged ?? ConversationAppearance()
                        next.effect = key
                        staged = next
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(emojiPresets.enumerated()), id: \.offset) { _, emoji in
                        let selected = staged?.emoji == emoji
                        Text(emoji ?? "–")
                            .font(YappyFont.titleSmall)
                            .frame(width: 38, height: 38)
                            .background(selected ? colors.accentSoft : colors.incoming, in: Circle())
                            .softTap {
                                var next = staged ?? ConversationAppearance()
                                next.emoji = emoji
                                staged = next
                            }
                    }
                }
                .padding(.horizontal, 20)
            }
            .padding(.top, 12)
        }
    }

    private func gradientSwatch(_ preset: (String, String)?) -> some View {
        let selected: Bool = {
            guard let preset else { return staged?.gradient == nil }
            return staged?.gradient?.first == preset.0 && staged?.gradient?.last == preset.1
        }()

        return ZStack {
            if let preset {
                Circle().fill(
                    LinearGradient(
                        colors: [
                            Color(hexString: preset.0) ?? colors.accent,
                            Color(hexString: preset.1) ?? colors.accent,
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
            } else {
                Circle().fill(colors.incoming)
            }

            if selected {
                Image(systemName: "checkmark")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(preset == nil ? colors.textSecondary : .white)
            }
        }
        .frame(width: 40, height: 40)
        .softTap {
            if let preset {
                var next = staged ?? ConversationAppearance()
                next.gradient = [preset.0, preset.1]
                next.accent = preset.0
                staged = next
            } else {
                var next = staged ?? ConversationAppearance()
                next.gradient = nil
                next.accent = nil
                staged = next
            }
        }
    }

    private func access(_ conversation: Conversation) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Access")
                .padding(.leading, 24)
                .padding(.top, 22)

            NeuSurface(radius: Neu.cornerMedium, contentPadding: 14) {
                VStack(spacing: 14) {
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Public group")
                                .font(YappyFont.bodyLarge)
                                .foregroundStyle(colors.textPrimary)
                            Text("Anyone with the link can join")
                                .font(YappyFont.labelSmall)
                                .foregroundStyle(colors.textTertiary)
                        }
                        Spacer(minLength: 0)
                        NeuSwitch(isOn: Binding(
                            get: { conversation.isPublic },
                            set: { next in
                                Task {
                                    if let updated = try? await container.repo.setPublic(
                                        conversationId, next
                                    ).conversation {
                                        self.conversation = updated
                                    }
                                }
                            }
                        ))
                    }

                    if let url = inviteUrl {
                        HStack(spacing: 10) {
                            Image(systemName: "link")
                                .font(.system(size: 14))
                                .foregroundStyle(colors.accent)
                            Text(url)
                                .font(YappyFont.bodyMedium)
                                .foregroundStyle(colors.textSecondary)
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(copied ? "copied" : "copy")
                                .font(YappyFont.labelSmall)
                                .foregroundStyle(colors.accent)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(colors.incoming, in: NeuShape(radius: Neu.cornerSmall))
                        .softTap {
                            UIPasteboard.general.string = url
                            copied = true
                        }
                    }

                    // Expiry, use limits and revoke live behind this — a group
                    // whose only link is permanent and unlimited has no way to
                    // un-share it once it leaks.
                    NeuButton { invitesOpen = true } content: {
                        Image(systemName: "link")
                            .font(.system(size: 15))
                            .foregroundStyle(colors.textSecondary)
                        Text(inviteUrl == nil ? "Create invite link" : "Manage invite links")
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(colors.textSecondary)
                    }
                }
            }
            .padding(.horizontal, 20)
        }
    }

    private var rolesSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Roles")
                .padding(.leading, 24)
                .padding(.top, 22)

            NeuSurface(radius: Neu.cornerMedium, contentPadding: 14) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Roles say what someone can do. Who outranks whom is still owner, admin, then moderator.")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                        .padding(.bottom, 12)

                    if roles.isEmpty {
                        Text("No roles yet.")
                            .font(YappyFont.bodyMedium)
                            .foregroundStyle(colors.textTertiary)
                            .padding(.vertical, 6)
                    }

                    ForEach(roles) { role in
                        roleRow(role)
                    }

                    NeuTextField(text: $newRoleName, placeholder: "New role name")
                        .padding(.top, 10)

                    HStack(spacing: 8) {
                        ForEach(roleColors, id: \.self) { hex in
                            let picked = newRoleColor == hex
                            Circle()
                                .fill(Color(hexString: hex) ?? colors.accent)
                                .frame(width: picked ? 30 : 26, height: picked ? 30 : 26)
                                .softTap { newRoleColor = hex }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.top, 10)

                    // A short list of what a role is usually *for*. The full
                    // 40-bit matrix belongs on a bigger screen than a phone.
                    HStack(spacing: 8) {
                        ForEach(rolePresets, id: \.0) { label, bits in
                            let picked = newRolePerms == bits
                            Text(label)
                                .font(YappyFont.labelMedium)
                                .foregroundStyle(picked ? colors.accent : colors.textTertiary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                                .background(picked ? colors.accentSoft : colors.incoming, in: Capsule())
                                .softTap { newRolePerms = bits }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.top, 10)

                    NeuButton(action: addRole) {
                        Text("Add role")
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(colors.textSecondary)
                    }
                    .padding(.top, 12)
                }
            }
            .padding(.horizontal, 20)
        }
    }

    private func roleRow(_ role: RoleEntry) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(Color(hexString: role.color) ?? colors.textTertiary)
                .frame(width: 11, height: 11)

            VStack(alignment: .leading, spacing: 1) {
                Text(role.name)
                    .font(YappyFont.bodyLarge)
                    .foregroundStyle(Color(hexString: role.color) ?? colors.textPrimary)
                Text(permissionSummary(role.permissions))
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Text("remove")
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.danger)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .softTap {
                    Task {
                        try? await container.repo.deleteRole(conversationId, roleId: role.id)
                        roles = (try? await container.repo.roles(conversationId).roles) ?? roles
                    }
                }
        }
        .padding(.vertical, 7)
    }

    private func addRole() {
        let name = newRoleName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        Task {
            _ = try? await container.repo.createRole(
                conversationId,
                name: name,
                color: newRoleColor,
                permissions: String(newRolePerms),
                position: roles.count,
                isHoisted: true
            )
            newRoleName = ""
            roles = (try? await container.repo.roles(conversationId).roles) ?? roles
        }
    }

    /// Only for an ordinary group, and only for its owner. Presented with what
    /// actually happens spelled out — it moves everyone's history, and there is
    /// Bots you can add here.
    ///
    /// The warning is not decoration. A bot in a group receives every message
    /// in it over a webhook, and that is worth saying in front of the button
    /// rather than in documentation nobody opens.
    private var botsSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Bots")
                .padding(.leading, 24)
                .padding(.top, 22)

            NeuSurface(radius: Neu.cornerMedium, contentPadding: 16) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("A bot you add here reads every message in this group and can post its own. Only add one you trust.")
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.textTertiary)

                    NeuButton {
                        botPickerOpen = true
                    } content: {
                        Text("Add a bot")
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(colors.textSecondary)
                    }
                    .padding(.top, 12)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 8)
        }
    }

    /// no button to undo it.
    private var upgradeSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Channels")
                .padding(.leading, 24)
                .padding(.top, 22)

            NeuSurface(radius: Neu.cornerMedium, contentPadding: 14) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("Turn this group into a space")
                        .font(YappyFont.bodyLarge)
                        .foregroundStyle(colors.textPrimary)

                    Text("A space holds several channels. Everyone stays a member, roles and invite links keep working, and this group's messages move into its first channel. It cannot be undone.")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                        .padding(.top, 4)

                    NeuTextField(text: $firstChannel, placeholder: "general")
                        .padding(.top, 12)

                    NeuButton(enabled: !upgrading, accent: confirmUpgrade) {
                        guard !upgrading else { return }
                        // Two taps, because it is irreversible and the first tap
                        // is often curiosity rather than intent.
                        guard confirmUpgrade else {
                            confirmUpgrade = true
                            return
                        }
                        upgrading = true
                        Task {
                            let name = firstChannel.trimmingCharacters(in: .whitespaces)
                            if (try? await container.repo.upgradeToSpace(
                                conversationId, firstChannelTitle: name.isEmpty ? "general" : name
                            )) != nil {
                                onBack()
                            }
                            upgrading = false
                        }
                    } content: {
                        Text(upgradeLabel)
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(confirmUpgrade ? colors.onAccent : colors.textSecondary)
                    }
                    .padding(.top, 10)
                }
            }
            .padding(.horizontal, 20)
        }
    }

    private var upgradeLabel: String {
        if upgrading { return "Converting…" }
        return confirmUpgrade ? "Tap again to convert" : "Convert to a space"
    }

    private var saveButton: some View {
        NeuButton(enabled: !busy, accent: true, action: save) {
            if savedTick {
                Image(systemName: "checkmark")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(colors.onAccent)
            }
            Text(savedTick ? "Saved" : "Save changes")
                .font(YappyFont.labelLarge)
                .foregroundStyle(colors.onAccent)
        }
        .padding(.horizontal, 20)
        .padding(.top, 26)
    }

    private func save() {
        guard let current = conversation, !busy else { return }
        busy = true
        savedTick = false

        Task {
            let trimmedTitle = title.trimmingCharacters(in: .whitespaces)
            let newTitle = (!trimmedTitle.isEmpty && trimmedTitle != current.title) ? trimmedTitle : nil
            let newDescription = description != (current.description ?? "") ? description : nil

            // An empty PATCH is a server error, not a no-op — skip it.
            if newTitle != nil || newDescription != nil {
                _ = try? await container.repo.updateConversation(
                    conversationId, title: newTitle, description: newDescription
                )
            }
            if let fresh = try? await container.repo.setAppearance(conversationId, staged).conversation {
                conversation = fresh
                staged = fresh.appearance
                savedTick = true
            }
            busy = false
        }
    }
}
