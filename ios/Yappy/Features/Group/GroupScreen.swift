import Combine
import SwiftUI

/// The group profile — the screen behind the group-first bet.
///
/// A group is a *place*, and a place answers three questions the moment you walk
/// in: who is here right now, what is happening (a call you can drop into), and
/// what have we collected together (pins, the media wall). The timeline answers
/// "what was said"; this screen answers everything else.
struct GroupScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let conversationId: String
    let onBack: () -> Void
    let onOpenProfile: (String) -> Void
    let onOpenCall: (String) -> Void
    let onOpenSettings: (String) -> Void

    @State private var conversation: Conversation?
    @State private var summary: GroupSummary?
    @State private var pinned: [Message] = []
    @State private var wall: [Message] = []
    /// Every role defined on this group, for the assignment chips.
    @State private var groupRoles: [RoleEntry] = []
    @State private var meId: String?
    @State private var callBusy = false
    @State private var memberTarget: SummaryMember?
    @State private var wallViewerAt: String?
    @State private var reloadToken = 0
    @State private var listener: AnyCancellable?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                topBar

                if let conversation {
                    header(conversation)

                    // Not for a space: a call ends by writing a summary card, and
                    // a space has no timeline. Voice happens in a channel.
                    if !conversation.isSpace {
                        callButton.padding(.horizontal, 20).padding(.top, 18)
                    }

                    hereNow
                    pinnedCanon
                    mediaWall
                    members(conversation)
                } else {
                    NeuSpinner().frame(maxWidth: .infinity).frame(height: 280)
                }
            }
            .padding(.bottom, 40)
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .task(id: reloadToken) { await load() }
        .onAppear(perform: observe)
        .onDisappear { listener?.cancel() }
        .sheet(item: $memberTarget) { target in
            MemberSheet(
                member: target,
                groupRoles: groupRoles,
                myRole: summary?.members.first { $0.user.id == meId }?.role ?? "member",
                isSelf: target.user.id == meId,
                groupIsBadged: conversation?.badge != nil,
                conversationId: conversationId,
                onOpenProfile: { id in
                    memberTarget = nil
                    onOpenProfile(id)
                },
                onChanged: {
                    memberTarget = nil
                    reloadToken += 1
                }
            )
            .presentationDetents([.medium, .large])
            .presentationBackground(colors.surface)
        }
        .fullScreenCover(item: Binding(
            get: { wallViewerAt.map(WallAnchor.init) },
            set: { wallViewerAt = $0?.id }
        )) { anchor in
            // The wall shows GIFs and videos; the viewer only knows how to show
            // stills. Tapping a tile it cannot render used to present a black
            // screen with nothing on it but a Close button — or, on a mixed
            // wall, silently open a different photo than the one tapped.
            if let start = wallItems.firstIndex(where: { $0.id == anchor.id }) {
                MediaViewer(
                    items: wallItems,
                    initialIndex: start,
                    onDismiss: { wallViewerAt = nil }
                )
            } else {
                Color.clear.onAppear { wallViewerAt = nil }
            }
        }
    }

    private func load() async {
        meId = container.session.userId
        // Five independent fetches; each section renders as its data lands
        // rather than the whole screen waiting on the slowest query.
        // Unstructured tasks, not `async let` — see the note in `SpaceScreen`.
        // Five children awaited in declaration order is the same out-of-order
        // unwind that aborts the process the moment `.task(id:)` cancels, and
        // this screen bumps its own token from a gateway listener too.
        let conversationTask = Task { try? await container.repo.conversation(conversationId).conversation }
        let summaryTask = Task { try? await container.repo.summary(conversationId).summary }
        let pinsTask = Task { try? await container.repo.pins(conversationId).pins.map(\.message) }
        let wallTask = Task { try? await container.repo.mediaWall(conversationId, limit: 12).messages }
        let rolesTask = Task { try? await container.repo.roles(conversationId).roles }

        conversation = await conversationTask.value
        summary = await summaryTask.value
        pinned = await pinsTask.value ?? []
        wall = await wallTask.value ?? []
        groupRoles = await rolesTask.value ?? []
    }

    /// Reload when this group's membership moves under us.
    ///
    /// Joins, leaves, kicks and role changes all dispatch member events, and
    /// this screen *is* the roster — without a listener it showed whoever was
    /// here when it appeared, for as long as it stayed on screen. The token
    /// bump reruns `load()`, which refetches every section; member changes are
    /// rare enough that patching instead would be complexity without a payoff.
    private func observe() {
        listener = container.gateway.events.sink { event in
            switch event.type {
            case "member.add", "member.update", "member.remove":
                guard event.data["conversationId"]?.stringValue == conversationId else { return }
                reloadToken += 1
            default:
                break
            }
        }
    }

    // ── Chrome ───────────────────────────────────────────────────────────────

    private var topBar: some View {
        HStack {
            NeuIconButton(systemName: "chevron.left", label: "Back", size: 42, iconSize: 18, action: onBack)
            Spacer()
            // Visible to everyone; the server rejects edits from members who
            // lack MANAGE_CONVERSATION, so gating the button adds nothing.
            NeuIconButton(systemName: "slider.horizontal.3", label: "Group settings", size: 42, iconSize: 18) {
                onOpenSettings(conversationId)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func header(_ conversation: Conversation) -> some View {
        let here = summary?.onlineCount ?? 0

        return VStack(spacing: 0) {
            FlairAvatar(
                appearance: conversation.appearance,
                url: conversation.displayAvatar,
                name: conversation.displayName,
                id: conversation.avatarSeed,
                size: 96,
                shape: .place
            )
            .padding(.bottom, 14)

            HStack(spacing: 8) {
                Text(conversation.displayName)
                    .font(YappyFont.headlineMedium)
                    .headlineTracking()
                    .foregroundStyle(colors.textPrimary)
                BadgeMark(badge: conversation.badge, size: 20)
                if let emoji = conversation.appearance?.emoji {
                    Text(emoji).font(YappyFont.headlineSmall)
                }
            }

            // Spelled out rather than left as a glyph to decode. A mark whose
            // meaning is guessed at is a mark that can be misread.
            if let label = badgeLabel(conversation.badge) {
                Text(label)
                    .font(YappyFont.labelLarge)
                    .foregroundStyle(colors.accent)
                    .padding(.top, 4)
            }

            Text(memberLine(conversation, here: here))
                .font(YappyFont.bodyMedium)
                // "Here now" is the pulse of the place — it earns the accent.
                .foregroundStyle(here > 0 ? colors.accent : colors.textTertiary)
                .padding(.top, 4)

            if let description = conversation.description, !description.isEmpty {
                Text(description)
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(colors.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 10)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
    }

    private func memberLine(_ conversation: Conversation, here: Int) -> String {
        var text = "\(conversation.memberCount) members"
        if here > 0 { text += " · \(here) here now" }
        return text
    }

    private var callButton: some View {
        let activeCall = summary?.activeCall

        return NeuButton(enabled: !callBusy, accent: activeCall != nil) {
            guard !callBusy else { return }
            callBusy = true
            Task {
                let id: String?
                if let activeCall {
                    id = activeCall.id
                } else {
                    id = try? await container.repo.startCall(conversationId, video: false).call.id
                }
                if let id { onOpenCall(id) }
                callBusy = false
            }
        } content: {
            Image(systemName: "phone.fill")
                .font(.system(size: 16))
                .foregroundStyle(activeCall != nil ? colors.onAccent : colors.textSecondary)
            Text(callLabel(activeCall))
                .font(YappyFont.labelLarge)
                .foregroundStyle(activeCall != nil ? colors.onAccent : colors.textSecondary)
        }
    }

    private func callLabel(_ activeCall: ActiveCall?) -> String {
        guard let activeCall else { return "Start a voice hangout" }
        return activeCall.participantCount > 0
            ? "Join the call · \(activeCall.participantCount) in"
            : "Join the call"
    }

    // ── Sections ─────────────────────────────────────────────────────────────

    @ViewBuilder
    private var hereNow: some View {
        let present = (summary?.members ?? []).filter(\.isHere)

        if !present.isEmpty {
            SectionLabel(text: "Here now")
                .padding(.leading, 24)
                .padding(.top, 20)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 12) {
                    ForEach(present.prefix(8)) { member in
                        VStack(spacing: 4) {
                            Avatar(
                                url: member.user.avatarUrl,
                                name: member.user.label,
                                id: member.user.id,
                                size: 48,
                                presence: member.presence
                            )
                            Text(member.user.displayName?.split(separator: " ").first.map(String.init)
                                ?? member.user.label)
                                .font(YappyFont.labelSmall)
                                .foregroundStyle(colors.textSecondary)
                                .lineLimit(1)
                        }
                        .frame(width: 56)
                        .softTap { onOpenProfile(member.user.id) }
                    }
                }
                .padding(.horizontal, 20)
            }
        }
    }

    @ViewBuilder
    private var pinnedCanon: some View {
        if !pinned.isEmpty {
            SectionLabel(text: "Pinned · \(pinned.count)")
                .padding(.leading, 24)
                .padding(.top, 22)

            VStack(spacing: 8) {
                ForEach(pinned.prefix(3)) { message in
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(colors.accent)
                            .padding(.top, 2)

                        VStack(alignment: .leading, spacing: 1) {
                            if let sender = message.sender {
                                Text(sender.label)
                                    .font(YappyFont.labelSmall)
                                    .foregroundStyle(colors.textTertiary)
                            }
                            Text(message.content ?? message.gif?.title ?? "Attachment")
                                .font(YappyFont.bodyMedium)
                                .foregroundStyle(colors.textPrimary)
                                .lineLimit(2)
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(colors.incoming, in: NeuShape(radius: Neu.cornerSmall))
                }
            }
            .padding(.horizontal, 20)
        }
    }

    @ViewBuilder
    private var mediaWall: some View {
        if !wall.isEmpty {
            SectionLabel(text: "Shared media" + (summary.map { " · \($0.counts.media)" } ?? ""))
                .padding(.leading, 24)
                .padding(.top, 22)

            // Chunked rows rather than a lazy grid: the screen scrolls as one
            // column, and twelve thumbnails do not need lazy composition.
            VStack(spacing: 4) {
                ForEach(Array(stride(from: 0, to: wall.count, by: 3)), id: \.self) { start in
                    let row = Array(wall[start ..< min(start + 3, wall.count)])
                    HStack(spacing: 4) {
                        ForEach(row) { message in
                            RemoteImage(url: thumbnail(message))
                                .aspectRatio(1, contentMode: .fill)
                                .frame(maxWidth: .infinity)
                                .clipped()
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .softTap { wallViewerAt = message.id }
                        }
                        // Keep a short row's cells square instead of stretching.
                        ForEach(0 ..< (3 - row.count), id: \.self) { _ in
                            Color.clear.frame(maxWidth: .infinity)
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
        }
    }

    private func thumbnail(_ message: Message) -> String? {
        message.gif?.previewUrl
            ?? message.attachments.first.map { $0.thumbnailUrl ?? $0.url }
    }

    /// GIFs are in the wall too but are not still images; the viewer pages
    /// through photos, so they are filtered out rather than shown frozen.
    private var wallItems: [ViewerItem] {
        wall.compactMap { message in
            guard let attachment = message.firstImage else { return nil }
            return ViewerItem(
                id: message.id,
                url: attachment.url,
                caption: message.content,
                senderName: message.sender?.label,
                filename: attachment.filename
            )
        }
    }

    @ViewBuilder
    private func members(_ conversation: Conversation) -> some View {
        let roster = summary?.members ?? []

        if !roster.isEmpty {
            SectionLabel(text: "Members · \(conversation.memberCount)")
                .padding(.leading, 24)
                .padding(.top, 22)

            VStack(spacing: 0) {
                ForEach(roster) { member in
                    MemberRow(member: member) { memberTarget = member }
                }
            }
            .padding(.horizontal, 12)
        }
    }
}

private struct WallAnchor: Identifiable {
    let id: String
}

// ── Member row ───────────────────────────────────────────────────────────────

private struct MemberRow: View {
    @Environment(\.neu) private var colors
    let member: SummaryMember
    let onTap: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Avatar(
                url: member.user.avatarUrl,
                name: member.user.label,
                id: member.user.id,
                size: 42,
                presence: member.presence
            )

            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 5) {
                    Text(member.nickname ?? member.user.label)
                        .font(YappyFont.body(16, weight: .medium))
                        .foregroundStyle(Color(hexString: member.roleColor) ?? colors.textPrimary)
                        .lineLimit(1)

                    IdentityMarks(user: member.user, size: 14)

                    // Only the top role, and only if it is hoisted: a member list
                    // where everyone carries four chips stops being a member list.
                    if let role = member.roles.first(where: \.isHoisted) {
                        let tint = Color(hexString: role.color) ?? colors.accent
                        Text(role.name)
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(tint)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(tint.opacity(0.16), in: Capsule())
                    }
                }
                if let username = member.user.username {
                    Text("@\(username)")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if member.role == "owner" || member.role == "admin" {
                Text(member.role)
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.accent)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 3)
                    .background(colors.accentSoft, in: Capsule())
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .softTap(action: onTap)
    }
}

// ── Member sheet: profile + role management ──────────────────────────────────

private struct MemberSheet: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let member: SummaryMember
    let groupRoles: [RoleEntry]
    let myRole: String
    let isSelf: Bool
    let groupIsBadged: Bool
    let conversationId: String
    let onOpenProfile: (String) -> Void
    let onChanged: () -> Void

    @State private var held: Set<String> = []

    private var amOwner: Bool { myRole == "owner" }
    private var amAdmin: Bool { myRole == "admin" || amOwner }

    /// Rank is enforced server-side too; the sheet just avoids offering actions
    /// that would 403.
    private var canManage: Bool {
        amAdmin && !isSelf && member.role != "owner" && (amOwner || member.role == "member")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 12) {
                    Avatar(url: member.user.avatarUrl, name: member.user.label, id: member.user.id, size: 44)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(member.user.label)
                            .font(YappyFont.titleMedium)
                            .foregroundStyle(colors.textPrimary)
                        Text(member.role)
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.textTertiary)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.bottom, 10)

                row("View profile") { onOpenProfile(member.user.id) }

                if amAdmin, !groupRoles.isEmpty { rolePicker }

                if canManage, amOwner {
                    let promoting = member.role != "admin"
                    row(promoting ? "Make admin" : "Remove admin") {
                        Task {
                            try? await container.repo.setMemberRole(
                                conversationId,
                                userId: member.user.id,
                                role: promoting ? "admin" : "member"
                            )
                            onChanged()
                        }
                    }
                }

                // Affiliation lends the group's own credibility to a person, so
                // it is owner/admin only and only offered by a badged group.
                if amAdmin, !isSelf, groupIsBadged {
                    let on = member.isAffiliate
                    row(on ? "Remove as affiliate" : "Mark as affiliate") {
                        Task {
                            try? await container.repo.setMemberAffiliate(
                                conversationId, userId: member.user.id, on: !on
                            )
                            onChanged()
                        }
                    }
                }

                if canManage {
                    row("Remove from group", danger: true) {
                        Task {
                            try? await container.repo.removeMember(conversationId, userId: member.user.id)
                            onChanged()
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 28)
        }
        .onAppear { held = Set(member.roles.map(\.id)) }
    }

    /// Tap to toggle. Saved immediately as a full set, which is what the
    /// endpoint takes — two admins editing at once then land on one intent
    /// rather than the union of both.
    private var rolePicker: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("ROLES")
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)
                .padding(.leading, 6)
                .padding(.top, 6)
                .padding(.bottom, 6)

            FlowLayout(spacing: 8) {
                ForEach(groupRoles) { role in
                    let on = held.contains(role.id)
                    let tint = Color(hexString: role.color) ?? colors.accent

                    Text(role.name)
                        .font(YappyFont.labelMedium)
                        .foregroundStyle(on ? tint : colors.textTertiary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(on ? tint.opacity(0.18) : colors.incoming, in: Capsule())
                        .softTap {
                            let previous = held
                            if on { held.remove(role.id) } else { held.insert(role.id) }
                            let next = held
                            Task {
                                do {
                                    _ = try await container.repo.setMemberRoles(
                                        conversationId, userId: member.user.id, roleIds: Array(next)
                                    )
                                } catch {
                                    held = previous
                                }
                            }
                        }
                }
            }
            .padding(.bottom, 8)
        }
    }

    private func row(_ label: String, danger: Bool = false, action: @escaping () -> Void) -> some View {
        Text(label)
            .font(YappyFont.bodyLarge)
            .foregroundStyle(danger ? colors.danger : colors.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 13)
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
            .softTap(action: action)
    }
}

/// Wrapping row layout, for the role chips.
///
/// SwiftUI has no `FlowRow`, and a plain `HStack` would push a group with six
/// roles off the edge of the sheet.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > width, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: width == .infinity ? x : width, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX, x > bounds.minX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
