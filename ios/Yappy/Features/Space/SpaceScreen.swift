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
            NotificationLevels(channel: target) { level in
                Task {
                    _ = try? await container.repo.setNotificationLevel(target.id, level: level)
                    notifyTarget = nil
                    reloadToken += 1
                }
            }
            .presentationDetents([.medium])
            .presentationBackground(colors.surface)
        }
    }

    private func load() async {
        // Last visit's channel list paints the rooms immediately; the fetch
        // that follows corrects it.
        if channels.isEmpty,
           let cached = DiskCache.decode(ChannelsEnvelope.self, key: "channels_\(spaceId)") {
            channels = cached.channels
            loading = false
        }

        // Two independent fetches — the channel list must not queue behind the
        // header's conversation row.
        async let spaceTask = try? await container.repo.conversation(spaceId).conversation
        async let channelsTask = try? await container.repo.channels(spaceId).channels
        space = await spaceTask
        channels = (await channelsTask) ?? []
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
                        .softTap { newIsAnnouncement.toggle() }

                        Spacer(minLength: 0)

                        Text("Cancel")
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(colors.textTertiary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .softTap {
                                creating = false
                                newTitle = ""
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
                spaceId, title: name, isAnnouncement: newIsAnnouncement, position: channels.count
            )
            busy = false
            newTitle = ""
            newIsAnnouncement = false
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
                Image(systemName: channel.isAnnouncement ? "megaphone.fill" : "number")
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
    let onPick: (String) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: channel.isAnnouncement ? "megaphone.fill" : "number")
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
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 30)
        }
    }
}
