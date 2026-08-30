import Combine
import SwiftUI

/// level, label, and what it actually means — the third column is the point.
private let notifyLevels: [(String, String, String)] = [
    ("all", "Everything", "Every message in this channel"),
    ("mentions", "Only mentions", "When someone names you"),
    ("none", "Nothing", "Still unread, just silent"),
]

/// A space: its channels, and the way into its people and settings.
///
/// This is the screen that makes a space feel like a *place with rooms* rather
/// than a folder. The channel list is the content — everything else (members,
/// settings, voice) is chrome around it — so the channels get the full-width
/// rows and the accent, and the rest is deliberately quiet.
struct SpaceScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let spaceId: String
    let onBack: () -> Void
    let onOpenChannel: (String) -> Void
    let onOpenMembers: () -> Void
    let onOpenSettings: () -> Void

    @State private var space: Conversation?
    @State private var channels: [ChannelEntry] = []
    @State private var loading = true
    @State private var creating = false
    @State private var newTitle = ""
    @State private var newIsAnnouncement = false
    @State private var newIsBoard = false
    @State private var busy = false
    @State private var reordering = false
    @State private var notifyTarget: ChannelEntry?
    @State private var reloadToken = 0
    @State private var listener: AnyCancellable?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                topBar

                if let space {
                    header(space)
                    channelHeader
                    channelList
                    newChannel
                } else {
                    Group {
                        if loading {
                            NeuSpinner()
                        } else {
                            Text("Space not found").foregroundStyle(colors.textTertiary)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 280)
                }
            }
            .padding(.bottom, 36)
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .task(id: reloadToken) { await load() }
        .onAppear(perform: observe)
        .onDisappear { listener?.cancel() }
        // Popping back from a channel does not re-run `task`, so the badge would
        // sit there until something else reloaded the space.
        .onReceive(container.conversationRead) { id in
            guard let index = channels.firstIndex(where: { $0.id == id }) else { return }
            channels[index].unreadCount = 0
            channels[index].mentionCount = 0
        }
        .sheet(item: $notifyTarget) { target in
            // Mirrors the server: MANAGE_ROLES, or administrator, which holds
            // everything.
            let bits = Int64(space?.permissions ?? "0") ?? 0
            let canManage = bits & (1 << 35) != 0 || bits & (1 << 62) != 0
            NotificationLevels(
                channel: target,
                spaceId: spaceId,
                canManage: canManage,
                onAccessChanged: { reloadToken += 1 }
            ) { level in
                Task {
                    _ = try? await container.repo.setNotificationLevel(target.id, level: level)
                    // The in-app banner reads this map, not the channel list.
                    // Without the write, muting a channel here kept banners
                    // coming until the conversation list happened to refetch.
                    container.notificationLevels[target.id] = level
                    notifyTarget = nil
                    reloadToken += 1
                }
            }
            .presentationDetents([.medium])
            .presentationBackground(colors.surface)
        }
    }

    private func load() async {
        // Last visit's snapshot paints the whole screen immediately; the
        // fetches that follow correct it. Both halves are seeded, because the
        // body renders nothing until `space` exists — cached channels with no
        // cached space used to clear `loading` early and flash "Space not
        // found" for the beat the header fetch was still in flight. The
        // absence branch is only allowed to render once a *completed* fetch
        // has actually said absent.
        if channels.isEmpty,
           let cached = DiskCache.decode(ChannelsEnvelope.self, key: "channels_\(spaceId)") {
            channels = cached.channels
        }
        if space == nil,
           let cached = DiskCache.decode(ConversationEnvelope.self, key: "conversation_\(spaceId)") {
            space = cached.conversation
            loading = false
        }

        // Two independent fetches — the channel list must not queue behind the
        // header's conversation row.
        //
        // Unstructured tasks rather than `async let`, and that is the whole of
        // the crash on opening a space. `async let` children live on a stack
        // and have to unwind in reverse; these were awaited in declaration
        // order, which only survives while nothing interrupts it. `.task(id:)`
        // cancels the moment `reloadToken` changes, and `observe()` bumps that
        // token on `conversation.update` for this very space — an event that
        // arrives within milliseconds of opening one. The cancellation unwound
        // the two children out of order and the concurrency runtime aborted the
        // process: SIGABRT inside `swift_task_dealloc`, no message, instant.
        //
        // `Task` has no such ordering rule. It also does not inherit the
        // cancellation, so a token bump now lets these finish and be discarded
        // rather than tearing them down halfway — which is what `ChatModel`
        // already does for the same reason.
        let spaceTask = Task { try? await container.repo.conversation(spaceId, cacheTo: true).conversation }
        let channelsTask = Task { try? await container.repo.channels(spaceId).channels }
        // A failed refetch keeps the cached space rather than replacing it
        // with nil — going offline must not turn a screen you were just
        // looking at into "Space not found".
        if let fresh = await spaceTask.value { space = fresh }
        channels = await channelsTask.value ?? channels
        loading = false

        // Leave each channel's name behind, so hopping between them draws the
        // header immediately instead of "…" on every hop.
        if let space {
            container.headerSeeds.remember(space)
            for channel in channels { container.headerSeeds.remember(channel: channel, in: space) }
        }
    }

    /// Reload when the space's rooms change shape under us.
    ///
    /// Every channel create, delete and reorder emits `conversation.update` on
    /// the *space's* id with `channelsChanged` set — a signal built for exactly
    /// this screen, which nothing here consumed. A channel someone else
    /// created appeared only after backing all the way out and re-entering,
    /// which read as "restart the app".
    private func observe() {
        listener = container.gateway.events.sink { event in
            switch event.type {
            case "conversation.update":
                guard event.data["id"]?.stringValue == spaceId else { return }
                reloadToken += 1
            case "member.add", "member.remove":
                // The member count in the header.
                guard event.data["conversationId"]?.stringValue == spaceId else { return }
                reloadToken += 1
            default:
                break
            }
        }
    }

    // ── Chrome ───────────────────────────────────────────────────────────────

    private var topBar: some View {
        HStack(spacing: 10) {
            NeuIconButton(systemName: "chevron.left", label: "Back", size: 42, iconSize: 18, action: onBack)
            Spacer()
            NeuIconButton(systemName: "person.2.fill", label: "Members", size: 42, iconSize: 18, action: onOpenMembers)
            NeuIconButton(
                systemName: "slider.horizontal.3",
                label: "Space settings",
                size: 42,
                iconSize: 18,
                action: onOpenSettings
            )
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private func header(_ space: Conversation) -> some View {
        VStack(spacing: 0) {
            FlairAvatar(
                appearance: space.appearance,
                url: space.displayAvatar,
                name: space.displayName,
                id: space.avatarSeed,
                size: 88,
                shape: .place
            )
            .padding(.bottom, 12)

            HStack(spacing: 8) {
                Text(space.displayName)
                    .font(YappyFont.headlineMedium)
                    .headlineTracking()
                    .foregroundStyle(space.appearance?.titleColor ?? colors.textPrimary)
                BadgeMark(badge: space.badge, size: 19)
            }

            Text("\(space.memberCount) members · \(channels.count) \(channels.count == 1 ? "channel" : "channels")")
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textTertiary)
                .padding(.top, 4)

            if let description = space.description, !description.isEmpty {
                Text(description)
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(colors.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.bottom, 22)
    }

    private var channelHeader: some View {
        HStack {
            SectionLabel(text: "Channels")
            if channels.count > 1 {
                Text(reordering ? "Done" : "Reorder")
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(colors.accent)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .softTap { reordering.toggle() }
            }
        }
        .padding(.horizontal, 24)
        .padding(.bottom, 6)
    }

    private var channelList: some View {
        VStack(spacing: 8) {
            ForEach(Array(channels.enumerated()), id: \.element.id) { index, channel in
                ChannelRow(
                    channel: channel,
                    accent: space?.appearance?.titleColor,
                    reordering: reordering,
                    canMoveUp: index > 0,
                    canMoveDown: index < channels.count - 1,
                    onTap: { if !reordering { onOpenChannel(channel.id) } },
                    onLongPress: { if !reordering { notifyTarget = channel } },
                    onMove: { delta in move(from: index, by: delta) }
                )
            }
        }
        .padding(.horizontal, 16)
    }

    private func move(from index: Int, by delta: Int) {
        // Reordered locally first so the list does not jump under the finger
        // while the round trip completes.
        let destination = index + delta
        guard channels.indices.contains(destination) else { return }
        var next = channels
        let moved = next.remove(at: index)
        next.insert(moved, at: destination)
        channels = next

        Task {
            do {
                try await container.repo.reorderChannels(spaceId, channelIds: next.map(\.id))
            } catch {
                reloadToken += 1
            }
        }
    }

    /// Inline rather than behind a dialog: creating channels is something people
    /// do in bursts while setting a space up.
    @ViewBuilder
    private var newChannel: some View {
        if creating {
            NeuSurface(radius: Neu.cornerLarge, contentPadding: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    NeuTextField(text: $newTitle, placeholder: "channel-name", autocapitalization: .never)

                    HStack(spacing: 6) {
                        HStack(spacing: 6) {
                            Image(systemName: "megaphone.fill")
                                .font(.system(size: 13))
                            Text("Announcements only")
                                .font(YappyFont.labelMedium)
                        }
                        .foregroundStyle(newIsAnnouncement ? colors.accent : colors.textTertiary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(newIsAnnouncement ? colors.accentSoft : colors.incoming, in: Capsule())
                        .softTap {
                            newIsAnnouncement.toggle()
                            if newIsAnnouncement { newIsBoard = false }
                        }

                        HStack(spacing: 6) {
                            Image(systemName: "pin.fill")
                                .font(.system(size: 13))
                            Text("Board")
                                .font(YappyFont.labelMedium)
                        }
                        .foregroundStyle(newIsBoard ? colors.accent : colors.textTertiary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(newIsBoard ? colors.accentSoft : colors.incoming, in: Capsule())
                        // A board brings the announcement floor with it rather
                        // than making somebody set two switches: a page of
                        // notices with a composer under it is a page nobody
                        // can keep tidy.
                        .softTap {
                            newIsBoard.toggle()
                            if newIsBoard { newIsAnnouncement = false }
                        }

                        Spacer(minLength: 0)

                        Text("Cancel")
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(colors.textTertiary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .softTap {
                                creating = false
                                newTitle = ""
                                newIsBoard = false
                            }

                        Text(busy ? "Creating…" : "Create")
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(newTitle.isEmpty ? colors.textTertiary : colors.accent)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .softTap(enabled: !newTitle.isEmpty && !busy, action: createChannel)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
        } else {
            NeuSurface(radius: Neu.cornerLarge, contentPadding: 14, onTap: { creating = true }) {
                HStack(spacing: 10) {
                    Image(systemName: "plus")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(colors.accent)
                    Text("New channel")
                        .font(YappyFont.bodyLarge)
                        .foregroundStyle(colors.accent)
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
        }
    }

    private func createChannel() {
        let name = newTitle.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, !busy else { return }
        busy = true
        Task {
            _ = try? await container.repo.createChannel(
                spaceId,
                title: name,
                isAnnouncement: newIsAnnouncement,
                isBoard: newIsBoard,
                position: channels.count
            )
            busy = false
            newTitle = ""
            newIsAnnouncement = false
            newIsBoard = false
            creating = false
            reloadToken += 1
        }
    }
}

// ── Channel row ──────────────────────────────────────────────────────────────

private struct ChannelRow: View {
    @Environment(\.neu) private var colors

    let channel: ChannelEntry
    let accent: Color?
    let reordering: Bool
    let canMoveUp: Bool
    let canMoveDown: Bool
    let onTap: () -> Void
    let onLongPress: () -> Void
    let onMove: (Int) -> Void

    var body: some View {
        // A muted channel does not get to shout: the unread state is still
        // tracked, it just stops driving the row's emphasis.
        let silenced = channel.isMuted || channel.notificationLevel == "none"
        let unread = silenced ? 0 : channel.unreadCount

        NeuSurface(
            radius: Neu.cornerLarge,
            state: unread > 0 ? .raised : .flat,
            elevation: unread > 0 ? 4 : 0,
            contentPadding: 13,
            onTap: reordering ? nil : onTap,
            onLongPress: reordering ? nil : onLongPress
        ) {
            HStack(spacing: 11) {
                // Before the announcement case: a board is
                // announcement-floored, and left to the megaphone it reads
                // as "an announcement channel" in every list, which is the
                // one thing it is not.
                Image(systemName: channel.isBoard ? "pin.fill" : channel.isAnnouncement ? "megaphone.fill" : "number")
                    .font(.system(size: 17, weight: .medium))
                    // An unread channel takes the space's own accent — the same
                    // signal the conversation list uses, so it reads the same way.
                    .foregroundStyle(unread > 0 ? (accent ?? colors.accent) : colors.textTertiary)

                VStack(alignment: .leading, spacing: 1) {
                    Text(channel.title ?? "channel")
                        .font(unread > 0 ? YappyFont.titleSmallBold : YappyFont.titleSmall)
                        .foregroundStyle(colors.textPrimary)
                        .lineLimit(1)
                    if let preview = channel.lastMessagePreview, !preview.isEmpty {
                        Text(preview)
                            .font(YappyFont.bodyMedium)
                            .foregroundStyle(colors.textTertiary)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if reordering {
                    // Explicit arrows rather than drag-to-reorder: a list this
                    // short does not need a gesture, and arrows work for anyone
                    // who cannot hold and drag.
                    Image(systemName: "chevron.up")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(canMoveUp ? colors.accent : colors.textTertiary.opacity(0.4))
                        .frame(width: 30, height: 30)
                        .contentShape(Circle())
                        .softTap(enabled: canMoveUp) { onMove(-1) }
                        .accessibilityLabel("Move up")
                    Image(systemName: "chevron.down")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(canMoveDown ? colors.accent : colors.textTertiary.opacity(0.4))
                        .frame(width: 30, height: 30)
                        .contentShape(Circle())
                        .softTap(enabled: canMoveDown) { onMove(1) }
                        .accessibilityLabel("Move down")
                } else {
                    trailing(silenced: silenced, unread: unread)
                }
            }
        }
    }

    @ViewBuilder
    private func trailing(silenced: Bool, unread: Int) -> some View {
        if silenced {
            Image(systemName: "bell.slash.fill")
                .font(.system(size: 13))
                .foregroundStyle(colors.textTertiary)
                .accessibilityLabel("Muted")
        } else if channel.notificationLevel == "mentions" {
            Image(systemName: "at")
                .font(.system(size: 13))
                .foregroundStyle(colors.textTertiary)
                .accessibilityLabel("Mentions only")
        }

        // Mentions outrank a plain unread count: being named is the one thing
        // worth interrupting someone for.
        if channel.mentionCount > 0 {
            Text("@\(channel.mentionCount)")
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.onAccent)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(colors.danger, in: Capsule())
        } else if unread > 0 {
            Text(unread > 99 ? "99+" : "\(unread)")
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.onAccent)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(colors.accent, in: Capsule())
        }
    }
}

// ── Per-channel notifications ────────────────────────────────────────────────

private struct NotificationLevels: View {
    @Environment(\.neu) private var colors
    let channel: ChannelEntry
    /// Where the roles live — a channel has none of its own.
    let spaceId: String
    /// MANAGE_ROLES, or administrator. Anyone else sees notifications only.
    let canManage: Bool
    let onPick: (String) -> Void
    let onAccessChanged: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    // Before the announcement case: a board is
                    // announcement-floored, and left to the megaphone it
                    // reads as "an announcement channel" in every list,
                    // which is the one thing it is not.
                    Image(systemName: channel.isBoard ? "pin.fill" : channel.isAnnouncement ? "megaphone.fill" : "number")
                        .font(.system(size: 16))
                        .foregroundStyle(colors.textTertiary)
                    Text(channel.title ?? "channel")
                        .font(YappyFont.titleMedium)
                        .foregroundStyle(colors.textPrimary)
                    Spacer(minLength: 0)
                }
                .padding(.bottom, 4)

                Text("Applies to this channel only. Muting the whole space still wins.")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
                    .padding(.bottom, 10)

                ForEach(notifyLevels, id: \.0) { level, label, blurb in
                    let picked = !channel.isMuted && channel.notificationLevel == level

                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(label)
                                .font(YappyFont.bodyLarge)
                                .foregroundStyle(picked ? colors.accent : colors.textPrimary)
                            Text(blurb)
                                .font(YappyFont.labelSmall)
                                .foregroundStyle(colors.textTertiary)
                        }
                        Spacer(minLength: 0)
                        if picked {
                            Image(systemName: "checkmark")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(colors.accent)
                        }
                    }
                    .padding(.vertical, 12)
                    .padding(.horizontal, 8)
                    .contentShape(Rectangle())
                    .softTap { onPick(level) }
                }

                /*
                 * Who the channel is for.
                 *
                 * This sheet is where a channel is configured on a phone —
                 * there is no separate channel settings screen — so access
                 * belongs here beside notifications rather than behind a
                 * second long press somewhere else.
                 */
                if canManage {
                    Divider()
                        .overlay(colors.textTertiary.opacity(0.22))
                        .padding(.vertical, 12)
                    ChannelAccessRows(
                        conversationId: channel.id,
                        spaceId: spaceId,
                        isPrivate: channel.isPrivate,
                        onChanged: onAccessChanged
                    )
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 30)
        }
    }
}

/// Who a channel is for.
///
/// Two settings that only mean something together. The floor applies to
/// everybody, so lowering it closes the channel to the whole space; a role
/// overwrite then lets one role back in *here*, which a space-wide role cannot
/// do because it applies everywhere.
///
/// The bitfields stay out of the UI. "Only these roles" is what somebody
/// actually wants, and the two patterns behind it — floor at nothing, allow
/// view/read/send per role — are an implementation of that sentence rather than
/// a thing to configure.
struct ChannelAccessRows: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let conversationId: String
    let spaceId: String
    /// The floor as it stood when the sheet opened.
    let isPrivate: Bool
    let onChanged: () -> Void

    @State private var roles: [RoleEntry]?
    @State private var overwrites: [ChannelOverwrite] = []
    @State private var gated: Bool
    @State private var busy = false

    init(
        conversationId: String,
        spaceId: String,
        isPrivate: Bool,
        onChanged: @escaping () -> Void
    ) {
        self.conversationId = conversationId
        self.spaceId = spaceId
        self.isPrivate = isPrivate
        self.onChanged = onChanged
        _gated = State(initialValue: isPrivate)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Who can see this channel")
                .font(YappyFont.titleSmall)
                .foregroundStyle(colors.textPrimary)
            Text(
                gated
                    ? "Only the roles you pick, plus admins."
                    : "Everyone in the space, like every other channel."
            )
            .font(YappyFont.labelSmall)
            .foregroundStyle(colors.textTertiary)
            .padding(.bottom, 10)

            HStack(spacing: 8) {
                ForEach([false, true], id: \.self) { want in
                    let picked = gated == want
                    Text(want ? "Only these roles" : "Everyone")
                        .font(YappyFont.labelMedium)
                        .foregroundStyle(picked ? colors.accent : colors.textSecondary)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(picked ? colors.accentSoft : colors.incoming, in: Capsule())
                        .softTap { if !busy, !picked { setGated(want) } }
                }
                Spacer(minLength: 0)
            }

            if gated {
                if roles == nil {
                    Text("Loading roles…")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                        .padding(.vertical, 10)
                } else if roles?.isEmpty == true {
                    Text(
                        "This space has no roles yet. Make one first — a channel for nobody "
                            + "is a channel nobody can read, including you tomorrow."
                    )
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
                    .padding(.vertical, 10)
                } else {
                    ForEach(roles ?? []) { role in
                        let on = allowed(role.id)
                        HStack(spacing: 10) {
                            Circle()
                                .fill(Color(hexString: role.color) ?? colors.textTertiary)
                                .frame(width: 7, height: 7)
                            Text(role.name)
                                .font(YappyFont.bodyLarge)
                                .foregroundStyle(Color(hexString: role.color) ?? colors.textPrimary)
                            Spacer(minLength: 0)
                            if on {
                                Image(systemName: "checkmark")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(colors.accent)
                            }
                        }
                        .padding(.vertical, 10)
                        .contentShape(Rectangle())
                        .softTap { if !busy { toggle(role, on: on) } }
                    }
                }
            }
        }
        .padding(.horizontal, 8)
        .task {
            roles = (try? await container.repo.roles(spaceId).roles) ?? []
            overwrites = (try? await container.repo.channelOverwrites(conversationId).overwrites) ?? []
        }
    }

    private func allowed(_ roleId: String) -> Bool {
        let allow = Int64(overwrites.first { $0.roleId == roleId }?.allow ?? "0") ?? 0
        return allow & channelViewBit != 0
    }

    private func setGated(_ want: Bool) {
        busy = true
        Task {
            do {
                if want {
                    _ = try await container.repo.setBasePermissions(conversationId, bits: "0")
                } else {
                    _ = try await container.repo.clearBasePermissions(conversationId)
                }
                gated = want
                onChanged()
            } catch {}
            busy = false
        }
    }

    private func toggle(_ role: RoleEntry, on: Bool) {
        busy = true
        Task {
            do {
                if on {
                    try await container.repo.removeChannelOverwrite(conversationId, roleId: role.id)
                    overwrites.removeAll { $0.roleId == role.id }
                } else {
                    let saved = try await container.repo.setChannelOverwrite(
                        conversationId,
                        roleId: role.id,
                        allow: String(channelAccessBits)
                    ).overwrite
                    overwrites.removeAll { $0.roleId == role.id }
                    overwrites.append(saved)
                }
                onChanged()
            } catch {}
            busy = false
        }
    }
}

/// What "let this role in" grants: see it, read it, speak in it.
private let channelViewBit: Int64 = 1 << 0
private let channelAccessBits: Int64 = (1 << 0) | (1 << 1) | (1 << 2)
