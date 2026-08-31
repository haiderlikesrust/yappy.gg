import Combine
import SwiftUI
import UIKit

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
    @State private var newIsForum = false
    @State private var newIsPrivate = false
    @State private var busy = false
    /// Surfaced rather than swallowed. Creating a private channel needs
    /// MANAGE_ROLES on top of MANAGE_CONVERSATION, and a Create button that
    /// silently does nothing is the worst possible way to learn that.
    @State private var createError: String?
    @State private var categories: [ChannelCategory] = []
    /// A view preference, not a fact about the space — two people should be
    /// able to disagree about it. See CollapsedCategories.
    @State private var collapsed: Set<String> = CollapsedCategories.load()
    @State private var namingCategory = false
    @State private var newCategoryName = ""
    @State private var renamingCategory: String?
    @State private var renameDraft = ""
    @State private var newChannelCategoryId: String?
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
                            SkeletonRows(count: 4)
                                .frame(maxHeight: .infinity, alignment: .top)
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
        .sheet(isPresented: $namingCategory, onDismiss: { newCategoryName = "" }) {
            newCategorySheet
        }
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
            // `onPick` passed by name, not as a trailing closure. A trailing
            // closure binds to the *last* declared parameter, which here is
            // `onAccessChanged` — so written that way the level picker's
            // handler was being installed as the access-changed callback and
            // `onAccessChanged:` was a duplicate argument.
            NotificationLevels(
                channel: target,
                spaceId: spaceId,
                canManage: canManage,
                onPick: { level in
                    Task {
                        _ = try? await container.repo.setNotificationLevel(target.id, level: level)
                        // The in-app banner reads this map, not the channel
                        // list. Without the write, muting a channel here kept
                        // banners coming until the conversation list happened
                        // to refetch.
                        container.notificationLevels[target.id] = level
                        notifyTarget = nil
                        reloadToken += 1
                    }
                },
                onAccessChanged: { reloadToken += 1 }
            )
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
            // The dividers are part of the snapshot too: cached channels
            // drawn without their categories collapse into one flat list for
            // the beat before the fetch lands, and then visibly regroup.
            categories = cached.categories
        }
        if space == nil,
           let cached = DiskCache.decode(ConversationEnvelope.self, key: "conversation_\(spaceId)") {
            space = cached.conversation
            loading = false
        }
        // The conversation list already had this space. Use it when the
        // per-space slot has never been written, so the header is flaired
        // on the first visit instead of arriving unstyled and then snapping.
        if space == nil,
           let list = DiskCache.decode(ConversationsEnvelope.self, key: "conversations"),
           let found = list.conversations.first(where: { $0.id == spaceId }) {
            space = found
            loading = false
        }
        // The list that sent us here already knew each channel's posture and
        // the space's flair. Write those down *now*, not after the refetch —
        // tapping a board before that round trip used to open a normal chat.
        rememberSeeds()

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
        let channelsTask = Task { try? await container.repo.channels(spaceId) }
        // A failed refetch keeps the cached space rather than replacing it
        // with nil — going offline must not turn a screen you were just
        // looking at into "Space not found".
        if let fresh = await spaceTask.value { space = fresh }
        if let envelope = await channelsTask.value {
            channels = envelope.channels
            categories = envelope.categories
        }
        loading = false

        // Leave each channel's name, flair and posture behind, so hopping
        // between them draws the room immediately instead of a default chat.
        rememberSeeds()
    }

    private func rememberSeeds() {
        guard let space else { return }
        container.headerSeeds.remember(space)
        for channel in channels { container.headerSeeds.remember(channel: channel, in: space) }
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
                .contentTransition(.numericText())
                .animation(.snappy(duration: 0.25), value: space.memberCount)
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
            if canManage {
                Text("Category")
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(colors.accent)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .softTap { namingCategory = true }
            }
            // Worth offering as soon as there is more than one thing to
            // arrange: one channel and two categories is a list that needs
            // sorting just as much as three channels does.
            if channels.count > 1 || !categories.isEmpty {
                Text(reordering ? "Done" : "Arrange")
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

    /**
     * Whether this viewer may create and arrange channels and categories:
     * MANAGE_CONVERSATION, or ADMINISTRATOR, which holds everything. Mirrors
     * the server rather than guessing from the ladder role, because a role
     * overwrite can grant it to somebody who is not an admin.
     */
    private var canManage: Bool {
        let bits = UInt64(space?.permissions ?? "0") ?? 0
        return bits & (1 << 36) != 0 || bits & (1 << 62) != 0
    }

    /**
     * One row, wherever it is drawn.
     *
     * Categories group the list without being part of it, so a channel's row
     * is identical inside one and outside — the index it reports for the move
     * arrows is its index in the whole space, because that is what the server
     * reorders.
     */
    @ViewBuilder
    private func channelRow(_ channel: ChannelEntry) -> some View {
        let index = channels.firstIndex(where: { $0.id == channel.id }) ?? 0
        ChannelRow(
            channel: channel,
            accent: space?.appearance?.titleColor,
            reordering: reordering,
            canMoveUp: index > 0,
            canMoveDown: index < channels.count - 1,
            categories: categories,
            onFile: { categoryId in file(channel, into: categoryId) },
            onTap: { if !reordering { onOpenChannel(channel.id) } },
            onLongPress: { if !reordering { notifyTarget = channel } },
            onMove: { delta in move(from: index, by: delta) }
        )
    }

    /*
     * Naming a category, as a sheet.
     *
     * The inline version was a field and two text buttons materialising
     * between the header and the list — it shoved every row down, belonged
     * visually to nothing, and sat there until dismissed. A sheet keeps
     * the list still, and dismissing is a gesture everyone already knows.
     * Same treatment as Android.
     */
    private var newCategorySheet: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("New category")
                .font(YappyFont.titleMedium)
                .foregroundStyle(colors.textPrimary)
                .padding(.bottom, 4)
            Text("A divider that groups channels in the list. It holds no messages and changes nothing about who sees what.")
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.bottom, 14)
            NeuTextField(text: $newCategoryName, placeholder: "Category name")
                .padding(.bottom, 14)
            NeuButton(enabled: !newCategoryName.trimmingCharacters(in: .whitespaces).isEmpty,
                      accent: true,
                      action: addCategory) {
                Text("Add category")
                    .font(YappyFont.labelLarge)
                    .foregroundStyle(colors.onAccent)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 18)
        .padding(.bottom, 26)
        .presentationDetents([.height(280)])
        .presentationBackground(colors.surface)
    }

    private var channelList: some View {
        VStack(spacing: 8) {
            // Loose channels first — above every divider, which is where
            // #general belongs. Not under a nameless "Uncategorised".
            ForEach(channels.filter { $0.categoryId == nil }) { channel in
                channelRow(channel)
            }

            // Only categories with something in them, plus — for somebody who
            // can manage the space — the empty ones they are about to fill.
            ForEach(categories) { category in
                let inside = channels.filter { $0.categoryId == category.id }
                if !inside.isEmpty || canManage {
                    // Folding while rearranging would hide what is being moved.
                    let folded = collapsed.contains(category.id) && !reordering
                    CategoryHeader(
                        category: category,
                        folded: folded,
                        // Rolled up onto the header: without it, folding hides
                        // the only signal that something inside needs reading,
                        // which trains people not to fold anything.
                        hiddenUnread: folded
                            ? inside.filter { !$0.isMuted }.reduce(0) { $0 + $1.unreadCount }
                            : 0,
                        hiddenMentions: folded ? inside.reduce(0) { $0 + $1.mentionCount } : 0,
                        renaming: renamingCategory == category.id,
                        renameDraft: $renameDraft,
                        canManage: canManage && reordering,
                        onToggle: { collapsed = CollapsedCategories.toggle(category.id) },
                        onStartRename: {
                            renameDraft = category.name
                            renamingCategory = category.id
                        },
                        onRename: { rename(category, to: renameDraft) },
                        onDelete: { remove(category) }
                    )
                    if !folded {
                        ForEach(inside) { channel in channelRow(channel) }
                    }
                }
            }
        }
        .padding(.horizontal, 16)
    }

    /// Filing is a reorder: the whole order and the move travel together.
    private func file(_ channel: ChannelEntry, into categoryId: String?) {
        guard let index = channels.firstIndex(where: { $0.id == channel.id }) else { return }
        var next = channels
        next[index].categoryId = categoryId
        channels = next
        Task {
            do {
                try await container.repo.reorderChannels(
                    spaceId,
                    channelIds: next.map(\.id),
                    moves: [channel.id: categoryId]
                )
            } catch {
                reloadToken += 1
            }
        }
    }

    private func addCategory() {
        let name = newCategoryName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        newCategoryName = ""
        namingCategory = false
        Task {
            try? await container.repo.createCategory(spaceId, name: name)
            reloadToken += 1
        }
    }

    private func rename(_ category: ChannelCategory, to name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        renamingCategory = nil
        guard !trimmed.isEmpty, trimmed != category.name else { return }
        Task {
            try? await container.repo.renameCategory(spaceId, categoryId: category.id, name: trimmed)
            reloadToken += 1
        }
    }

    /// The channels inside survive this — the server sets them loose.
    private func remove(_ category: ChannelCategory) {
        Task {
            try? await container.repo.deleteCategory(spaceId, categoryId: category.id)
            reloadToken += 1
        }
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

                    /**
                     * Two rows, not one.
                     *
                     * All five controls — three posture chips plus Cancel and
                     * Create — used to share a single `HStack`. Three of those
                     * labels do not fit across a phone alongside two buttons, so
                     * SwiftUI did the only thing left to it and wrapped each one
                     * mid-word: "Ann/oun/cem/ents/only". Separating what the
                     * channel *is* from what you *do* about it gives both rows
                     * the width they need, and is the honest grouping anyway.
                     */
                    /*
                     * One quiet row where three rows of chips were.
                     *
                     * The posture chips were radio buttons pretending to be
                     * toggles — exactly one can hold, plus the implicit "just
                     * text" default — and the category chips grew by one with
                     * every category the space had. Each exclusive set is now
                     * a menu naming its current choice; only Private stays a
                     * chip, because it is the one genuine on/off. A category
                     * in menu form also cannot be mistaken for a kind of
                     * channel, which the chip row invited. Same treatment as
                     * Android.
                     */
                    HStack(spacing: 6) {
                        Menu {
                            Button { setKind() } label: {
                                Label("Text", systemImage: "number")
                            }
                            Button { setKind(announcement: true) } label: {
                                Label("Announcements", systemImage: "megaphone.fill")
                            }
                            // A board brings the announcement floor with it;
                            // a forum wants everyone posting and does not.
                            Button { setKind(board: true) } label: {
                                Label("Board", systemImage: "pin.fill")
                            }
                            Button { setKind(forum: true) } label: {
                                Label("Forum", systemImage: "list.bullet")
                            }
                        } label: {
                            menuChip(icon: kindIcon, label: kindLabel)
                        }

                        if !categories.isEmpty {
                            Menu {
                                // A checkmark on the current pick; plain text
                                // otherwise — an empty systemImage name is not
                                // "no icon", it is a broken one.
                                Button { newChannelCategoryId = nil } label: {
                                    if newChannelCategoryId == nil {
                                        Label("No category", systemImage: "checkmark")
                                    } else {
                                        Text("No category")
                                    }
                                }
                                ForEach(categories) { category in
                                    Button { newChannelCategoryId = category.id } label: {
                                        if newChannelCategoryId == category.id {
                                            Label(category.name, systemImage: "checkmark")
                                        } else {
                                            Text(category.name)
                                        }
                                    }
                                }
                            } label: {
                                menuChip(
                                    icon: nil,
                                    label: categories.first { $0.id == newChannelCategoryId }?.name ?? "No category"
                                )
                            }
                        }

                        /*
                         * Private is orthogonal to the kinds, and a board or a
                         * forum can perfectly well be private. The exception is
                         * announcement — the same lever pulled to a different
                         * floor — so the two cannot both be on.
                         */
                        PostureChip(icon: "lock", label: "Private", selected: newIsPrivate) {
                            newIsPrivate.toggle()
                            if newIsPrivate { newIsAnnouncement = false }
                        }

                        Spacer(minLength: 0)
                    }

                    if newIsPrivate {
                        Text("Only you and the space's moderators and admins will see this channel.")
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.textTertiary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    if let createError {
                        Text(createError)
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    HStack(spacing: 6) {
                        Spacer(minLength: 0)

                        Text("Cancel")
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(colors.textTertiary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .softTap {
                                creating = false
                                newTitle = ""
                                // `newIsAnnouncement` was left set here, so
                                // cancelling and reopening handed you a form
                                // that had quietly kept one of the three
                                // postures switched on.
                                newIsAnnouncement = false
                                newIsBoard = false
                                newIsForum = false
                                newIsPrivate = false
                                createError = nil
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

    private var kindLabel: String {
        if newIsBoard { return "Board" }
        if newIsForum { return "Forum" }
        if newIsAnnouncement { return "Announcements" }
        return "Text"
    }

    private var kindIcon: String {
        if newIsBoard { return "pin.fill" }
        if newIsForum { return "list.bullet" }
        if newIsAnnouncement { return "megaphone.fill" }
        return "number"
    }

    private func setKind(board: Bool = false, forum: Bool = false, announcement: Bool = false) {
        newIsBoard = board
        newIsForum = forum
        newIsAnnouncement = announcement
        // Announcement is the same lever as private at a different floor.
        if announcement { newIsPrivate = false }
    }

    /// A menu's face: the current choice with a disclosure chevron, dressed
    /// exactly like the chips beside it so the row reads as one family.
    private func menuChip(icon: String?, label: String) -> some View {
        HStack(spacing: 6) {
            if let icon {
                Image(systemName: icon)
                    .font(.system(size: 13))
                    .foregroundStyle(colors.accent)
            }
            Text(label)
                .font(YappyFont.labelMedium)
                .foregroundStyle(colors.textPrimary)
                .lineLimit(1)
                .fixedSize()
            Image(systemName: "chevron.down")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(colors.textTertiary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(colors.incoming, in: Capsule())
    }

    private func createChannel() {
        let name = newTitle.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, !busy else { return }
        busy = true
        createError = nil
        Task {
            do {
                _ = try await container.repo.createChannel(
                    spaceId,
                    title: name,
                    isAnnouncement: newIsAnnouncement,
                    isBoard: newIsBoard,
                    isForum: newIsForum,
                    isPrivate: newIsPrivate,
                    position: channels.count,
                    // Filed as it is made, so it never appears loose for one
                    // paint and then jumps.
                    categoryId: newChannelCategoryId
                )
            } catch {
                // The form stays open holding what was typed. Losing a name
                // and three toggles to a permission error is worse than the
                // error.
                busy = false
                createError = (error as? ApiError)?.message ?? "Could not create that channel"
                return
            }
            busy = false
            newTitle = ""
            newIsAnnouncement = false
            newIsBoard = false
            newIsForum = false
            newIsPrivate = false
            newChannelCategoryId = nil
            creating = false
            reloadToken += 1
        }
    }
}

// ── Category header ──────────────────────────────────────────────────────────

/**
 * A divider in the channel list.
 *
 * Quiet type and a chevron, with the channels under it drawn as ordinary
 * rows — it reads as a label over a group, not as a row you can open. The
 * only things it ever shows besides its name are the unread it is hiding
 * while folded, and the rename and delete controls, which appear only while
 * arranging.
 */
private struct CategoryHeader: View {
    @Environment(\.neu) private var colors

    let category: ChannelCategory
    let folded: Bool
    let hiddenUnread: Int
    let hiddenMentions: Int
    let renaming: Bool
    @Binding var renameDraft: String
    let canManage: Bool
    let onToggle: () -> Void
    let onStartRename: () -> Void
    let onRename: () -> Void
    let onDelete: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            if renaming {
                NeuTextField(text: $renameDraft, placeholder: category.name)
                Text("Save")
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(colors.accent)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .softTap(action: onRename)
            } else {
                HStack(spacing: 4) {
                    Image(systemName: folded ? "chevron.right" : "chevron.down")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(colors.textTertiary)
                    Text(category.name.uppercased())
                        .font(YappyFont.labelMedium)
                        .kerning(0.8)
                        .foregroundStyle(colors.textTertiary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
                .softTap(action: onToggle)
                .accessibilityLabel(folded ? "Expand \(category.name)" : "Collapse \(category.name)")

                // Rolled up while folded, so collapsing never swallows the
                // reason to look.
                if hiddenMentions > 0 {
                    // Yellow, like every mention marker: one colour, one meaning.
                    Text("@\(hiddenMentions > 99 ? "99+" : String(hiddenMentions))")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.onMention)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(colors.mention))
                } else if hiddenUnread > 0 {
                    badge(hiddenUnread > 99 ? "99+" : String(hiddenUnread))
                }

                if canManage {
                    Image(systemName: "pencil")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(colors.textTertiary)
                        .frame(width: 28, height: 28)
                        .contentShape(Circle())
                        .softTap(action: onStartRename)
                        .accessibilityLabel("Rename \(category.name)")
                    Image(systemName: "trash")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(colors.textTertiary)
                        .frame(width: 28, height: 28)
                        .contentShape(Circle())
                        .softTap(action: onDelete)
                        .accessibilityLabel("Delete \(category.name)")
                }
            }
        }
        .padding(.top, 6)
        .padding(.horizontal, 4)
    }

    private func badge(_ text: String) -> some View {
        Text(text)
            .font(YappyFont.labelSmall)
            .foregroundStyle(colors.accent)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(colors.accentSoft))
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
    /// For the "file this under" menu, only shown while rearranging.
    var categories: [ChannelCategory] = []
    var onFile: (String?) -> Void = { _ in }
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
                Image(systemName: channel.isBoard ? "pin.fill" : channel.isForum ? "list.bullet" : channel.isAnnouncement ? "megaphone.fill" : "number")
                    .font(.system(size: 17, weight: .medium))
                    // An unread channel takes the space's own accent — the same
                    // signal the conversation list uses, so it reads the same way.
                    .foregroundStyle(unread > 0 ? (accent ?? colors.accent) : colors.textTertiary)

                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(channel.title ?? "channel")
                            .font(unread > 0 ? YappyFont.titleSmallBold : YappyFont.titleSmall)
                            .foregroundStyle(colors.textPrimary)
                            .lineLimit(1)
                        /*
                         * A lock, because "why can I see this and Sam cannot" is
                         * a question the list should answer without being opened.
                         * After the name rather than replacing the kind glyph: a
                         * board, a forum and a voice room can all be private too,
                         * and their own glyph is the more useful of the two.
                         */
                        if channel.isPrivate {
                            Image(systemName: "lock.fill")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(colors.textTertiary)
                                .accessibilityLabel("Private channel")
                        }
                    }
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
                    if !categories.isEmpty {
                        /*
                         * Filing, in the mode where the list is already being
                         * rearranged. A menu rather than a drop target: dropping
                         * onto a divider on a phone means holding a row steady
                         * over a strip of text a few millimetres tall.
                         */
                        Menu {
                            Button("No category") { onFile(nil) }
                            ForEach(categories) { category in
                                Button(category.name) { onFile(category.id) }
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(colors.accent)
                                .frame(width: 30, height: 30)
                                .contentShape(Circle())
                        }
                        .accessibilityLabel("Move to category")
                    }
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
            // Brand yellow, not danger red: red on violet reads as an
            // error, and being named is not one. See NeuColors.mention.
            Text("@\(channel.mentionCount)")
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.onMention)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(colors.mention, in: Capsule())
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
                    Image(systemName: channel.isBoard ? "pin.fill" : channel.isForum ? "list.bullet" : channel.isAnnouncement ? "megaphone.fill" : "number")
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

                    Divider()
                        .overlay(colors.textTertiary.opacity(0.22))
                        .padding(.vertical, 12)
                    WebhookRows(conversationId: channel.id)
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

/// Incoming webhooks for one channel: a URL that posts into it.
///
/// The URL appears exactly once, at creation — the same discipline as bot
/// tokens, because a retrievable credential is a better target than the
/// systems it posts for. It is copied to the clipboard and shown until the
/// sheet closes; the list afterwards shows names only.
private struct WebhookRows: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let conversationId: String

    @State private var hooks: [Webhook] = []
    @State private var minted: Webhook?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Webhooks")
                .font(YappyFont.titleSmall)
                .foregroundStyle(colors.textPrimary)
            Text("A URL that posts into this channel — paste it into GitHub, Grafana, or a cron job.")
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)
                .padding(.bottom, 8)

            if let minted, let url = minted.url {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(minted.name) — copied to your clipboard. It will not be shown again.")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textPrimary)
                    Text(url)
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textSecondary)
                        .textSelection(.enabled)
                }
                .padding(10)
                .background(colors.accentSoft, in: RoundedRectangle(cornerRadius: Neu.cornerSmall))
                .padding(.bottom, 8)
            }

            ForEach(hooks) { hook in
                HStack {
                    Text(hook.name)
                        .font(YappyFont.bodyLarge)
                        .foregroundStyle(colors.textPrimary)
                    Spacer(minLength: 0)
                    Text("remove")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.danger)
                        .softTap { remove(hook) }
                }
                .padding(.vertical, 7)
            }

            Text(busy ? "Working…" : "New webhook")
                .font(YappyFont.labelLarge)
                .foregroundStyle(colors.accent)
                .padding(8)
                .contentShape(Rectangle())
                .softTap { create() }
        }
        .padding(.horizontal, 8)
        .task {
            hooks = (try? await container.repo.webhooks(conversationId).webhooks) ?? []
        }
    }

    private func create() {
        guard !busy else { return }
        busy = true
        Task {
            if let hook = try? await container.repo.createWebhook(conversationId, name: "webhook").webhook {
                minted = hook
                var listed = hook
                listed.url = nil
                hooks.insert(listed, at: 0)
                if let url = hook.url { UIPasteboard.general.string = url }
            }
            busy = false
        }
    }

    private func remove(_ hook: Webhook) {
        guard !busy else { return }
        busy = true
        Task {
            try? await container.repo.deleteWebhook(conversationId, webhookId: hook.id)
            hooks.removeAll { $0.id == hook.id }
            if minted?.id == hook.id { minted = nil }
            busy = false
        }
    }
}

/// What "let this role in" grants: see it, read it, speak in it.
private let channelViewBit: Int64 = 1 << 0
private let channelAccessBits: Int64 = (1 << 0) | (1 << 1) | (1 << 2)

/**
 * One of the three channel postures, at creation time.
 *
 * Was written out three times inline, fifteen near-identical lines each. The
 * `lineLimit`/`fixedSize` pair is the part that matters: without it a label too
 * wide for its row is broken across lines mid-word rather than the row being
 * allowed to overflow, which is how "Announcements only" became five stacked
 * fragments.
 */
private struct PostureChip: View {
    @Environment(\.neu) private var colors

    let icon: String
    let label: String
    let selected: Bool
    let onTap: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 13))
            Text(label)
                .font(YappyFont.labelMedium)
                .lineLimit(1)
                .fixedSize()
        }
        .foregroundStyle(selected ? colors.accent : colors.textTertiary)
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(selected ? colors.accentSoft : colors.incoming, in: Capsule())
        .softTap(action: onTap)
    }
}
