import SwiftUI

/// New conversation.
///
/// One screen for both DMs and groups: tapping a person starts a DM, and
/// selecting several switches the primary action to "create group". Splitting
/// these into two entry points makes people back out and start over when they
/// change their mind halfway.
struct NewChatScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let onBack: () -> Void
    let onOpenChat: (String) -> Void

    @State private var query = ""
    @State private var contacts: [PublicUser] = []
    @State private var results: [PublicUser] = []
    @State private var selected: Set<String> = []
    @State private var groupTitle = ""
    @State private var busy = false
    @State private var searchTask: Task<Void, Never>?
    /// Non-nil makes the new group a campfire.
    @State private var campfireSeconds: Int?

    /**
     * Group mode, asked for rather than stumbled into.
     *
     * It used to be `selected.count >= 2` and nothing else — so the only way to
     * discover that this app makes groups was to guess that picking a second
     * person would transform the screen. In a product whose whole argument is
     * that a group is a place, the path to making one was the one thing with no
     * button.
     *
     * Kept as an *addition* to the derived rule, not a replacement: selecting
     * two people still switches over on its own, because that path works and
     * people who know it will keep using it.
     */
    @State private var explicitGroupMode = false

    /// A code somebody was given rather than a link they could tap.
    ///
    /// The join page has always told people to "open the app and enter" their
    /// code, and until now there was nowhere in the app to enter it. That is
    /// the last step of the chain: an invite is shared, somebody without yappy
    /// installs it, and the link that brought them is long gone by the time
    /// they open the app.
    @State private var inviteEntryOpen = false
    @State private var inviteText = ""
    @State private var inviteCode: String?

    /// Campfire durations. Capped at a week deliberately — past that nobody
    /// holds the end date in their head and it stops being a campfire.
    private let campfireChoices: [(label: String, seconds: Int)] = [
        ("1 hour", 3_600),
        ("6 hours", 21_600),
        ("12 hours", 43_200),
        ("1 day", 86_400),
        ("3 days", 259_200),
        ("1 week", 604_800),
    ]

    private var shown: [PublicUser] { query.isEmpty ? contacts : results }
    private var groupMode: Bool { explicitGroupMode || selected.count >= 2 }
    /// The server takes it from two upwards; below that the button says what is
    /// missing instead of failing when pressed.
    private var canCreateGroup: Bool { selected.count >= 2 }

    private var selectedUsers: [PublicUser] {
        var seen = Set<String>()
        return (contacts + results)
            .filter { seen.insert($0.id).inserted }
            .filter { selected.contains($0.id) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                // Backing out of group mode before backing out of the screen:
                // somebody who has picked three people and changed their mind
                // wants the selection gone, not the page.
                NeuIconButton(
                    systemName: groupMode ? "xmark" : "chevron.left",
                    label: groupMode ? "Cancel group" : "Back",
                    size: 42,
                    iconSize: 18,
                    action: handleBack
                )
                Text(groupMode ? (campfireSeconds == nil ? "New group" : "Campfire") : "New chat")
                    .font(YappyFont.headlineSmall)
                    .foregroundStyle(colors.textPrimary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            NeuTextField(
                text: $query,
                placeholder: "Search by name or @username",
                radius: Neu.cornerPill,
                autocapitalization: .never
            ) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 16))
                    .foregroundStyle(colors.textTertiary)
            }
            .padding(.horizontal, 16)

            // Only when they are not already picking people. Somebody mid-way
            // through choosing who to message is not looking for this.
            if !groupMode, selected.isEmpty, query.isEmpty {
                starters
                    .padding(.horizontal, 16)
                    .padding(.top, 14)
            }

            if groupMode {
                NeuTextField(text: $groupTitle, placeholder: "Group name") {
                    Image(systemName: "person.2")
                        .font(.system(size: 16))
                        .foregroundStyle(colors.textTertiary)
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)

                campfirePicker
            }

            list.padding(.top, 12)

            if groupMode {
                // Shown from the moment group mode starts, disabled until it
                // can succeed, and saying which. A button that appears only
                // once the requirement is met never teaches the requirement.
                NeuButton(
                    enabled: !busy && canCreateGroup,
                    // Same rule as the invite button: no accent fill until the
                    // press would do something, so the label stays readable.
                    accent: canCreateGroup,
                    action: createGroup
                ) {
                    if busy {
                        NeuSpinner(tint: colors.onAccent)
                    } else {
                        Text(createGroupLabel)
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(canCreateGroup ? colors.onAccent : colors.textTertiary)
                    }
                }
                .padding(16)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: groupMode)
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .task {
            contacts = (try? await container.repo.contacts().users) ?? []
        }
        .onChange(of: query) { _, value in search(value) }
        // The same sheet a tapped invite link opens, so a pasted code and a
        // followed link end in exactly the same place.
        .sheet(item: Binding(
            get: { inviteCode.map(PastedInviteCode.init) },
            set: { inviteCode = $0?.value }
        )) { pasted in
            InviteSheet(
                code: pasted.value,
                onJoined: { conversationId, _ in
                    inviteCode = nil
                    onOpenChat(conversationId)
                },
                onDismiss: { inviteCode = nil }
            )
        }
    }

    @ViewBuilder
    private var list: some View {
        if shown.isEmpty {
            // One grey sentence in the middle of an empty page was the whole
            // empty state, on the screen a new account lands on first.
            VStack(spacing: 10) {
                Image(systemName: query.isEmpty ? "person.2" : "magnifyingglass")
                    .font(.system(size: 30, weight: .light))
                    .foregroundStyle(colors.textTertiary.opacity(0.7))
                Text(query.isEmpty ? "No contacts yet" : "No one found")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textSecondary)
                Text(query.isEmpty
                    ? "Search for someone by name or @username, or join a group with an invite code."
                    : "Check the spelling, or try their @username.")
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(colors.textTertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 44)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(shown) { user in
                        row(user)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 4)
            }
            .scrollDismissesKeyboard(.interactively)
        }
    }

    /**
     * A person who cannot be put in a group.
     *
     * `nil` means the endpoint did not say, which is not the same as "no" — an
     * older server, or a list that never carried the field, must not turn the
     * whole picker grey.
     */
    private func addable(_ user: PublicUser) -> Bool { user.canAddToGroups ?? true }

    private func row(_ user: PublicUser) -> some View {
        let isSelected = selected.contains(user.id)
        let canAdd = addable(user)

        return NeuSurface(
            radius: Neu.cornerMedium,
            state: isSelected ? .pressed : .raised,
            elevation: isSelected ? 3 : 5,
            contentPadding: 12,
            onTap: {
                if selected.isEmpty {
                    // Single tap with nothing selected is the fast path:
                    // straight into a DM. Still offered to someone who cannot
                    // be added to a group — `whoCanDm` is a separate setting,
                    // and the usual answer to it is everyone.
                    openDm(with: user)
                } else {
                    toggle(user)
                }
            },
            onLongPress: { toggle(user) }
        ) {
            HStack(spacing: 12) {
                Avatar(url: user.avatarUrl, name: user.label, id: user.id, size: 44)
                    .opacity(canAdd ? 1 : 0.45)

                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(user.label)
                            .font(YappyFont.titleSmall)
                            .foregroundStyle(canAdd ? colors.textPrimary : colors.textTertiary)
                        IdentityMarks(user: user, size: 13)
                    }
                    if canAdd {
                        if let username = user.username {
                            Text("@\(username)")
                                .font(YappyFont.labelSmall)
                                .foregroundStyle(colors.textTertiary)
                        }
                    } else {
                        // The handle gives way to the reason. Someone greyed out
                        // with no explanation reads as a broken app; the same row
                        // with "only their contacts can add them" reads as a
                        // setting, and points at what would change it.
                        Text("Only their contacts can add them to groups")
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.textTertiary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(colors.onAccent)
                        .frame(width: 24, height: 24)
                        .neu(Circle(), colors, state: .raised, elevation: 2, fill: colors.accent)
                } else if !canAdd {
                    Image(systemName: "person.crop.circle.badge.xmark")
                        .font(.system(size: 15))
                        .foregroundStyle(colors.textTertiary)
                        .frame(width: 24, height: 24)
                }
            }
        }
    }

    /// Selection is where the refusal lives, not the tap.
    ///
    /// The alternative — letting them be selected and failing at creation — is
    /// what this whole path used to do: the server drops anyone whose privacy
    /// refuses the add, and the group appears with only you in it. Refusing the
    /// selection moves that from a silent failure after the fact to a visible
    /// state before it.
    private func toggle(_ user: PublicUser) {
        guard addable(user) else { return }
        if selected.contains(user.id) {
            selected.remove(user.id)
        } else {
            selected.insert(user.id)
        }
    }

    private func search(_ value: String) {
        searchTask?.cancel()
        guard !value.isEmpty else {
            results = []
            return
        }
        searchTask = Task {
            // Debounced; the endpoint is rate limited.
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            let found = (try? await container.repo.searchUsers(value).users) ?? []
            guard !Task.isCancelled, query == value else { return }
            results = found
        }
    }

    /**
     * Campfire: a group with an end date.
     *
     * Offered at creation and nowhere else on purpose. Turning an ongoing group
     * into one that deletes itself is a decision nobody else in it agreed to,
     * and the whole appeal of a campfire is that everyone walked in knowing.
     *
     * Was a horizontal `ScrollView` of six chips, edge to edge. On a 402pt
     * screen that put "3 days" half off the bezel with no padding and no fade —
     * which does not read as *there is more, scroll* so much as *this is
     * broken*. Six fixed choices never needed a scroller; three columns hold
     * them in two rows with nothing clipped and nothing to discover.
     *
     * The switch is new too. The durations used to be permanently on screen for
     * every group, so a plain group was always being asked a question it had
     * not raised, and the Campfire entry on the previous screen had nothing to
     * distinguish it from New group. Off by default, on when asked for.
     */
    private var campfirePicker: some View {
        let on = campfireSeconds != nil

        return VStack(alignment: .leading, spacing: 0) {
            NeuChip(
                label: "Campfire",
                selected: on,
                leadingEmoji: "🔥",
                action: { campfireSeconds = on ? nil : 86_400 }
            )

            if on {
                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3),
                    spacing: 8
                ) {
                    ForEach(campfireChoices, id: \.seconds) { choice in
                        NeuChip(
                            label: choice.label,
                            selected: campfireSeconds == choice.seconds,
                            // Never back to nil from here: the switch above owns
                            // whether this is a campfire at all, and tapping the
                            // duration you already picked should not silently
                            // turn the whole thing off.
                            action: { campfireSeconds = choice.seconds }
                        )
                    }
                }
                .padding(.top, 10)

                Text("This group and everything in it is deleted when the time is up.")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
                    .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.top, 12)
    }

    private func openDm(with user: PublicUser) {
        busy = true
        Task {
            if let id = try? await container.repo.createDm(userId: user.id).conversation.id {
                onOpenChat(id)
            }
            busy = false
        }
    }

    private func createGroup() {
        busy = true
        Task {
            let fallback = String(selectedUsers.map(\.label).joined(separator: ", ").prefix(60))
            let title = groupTitle.isEmpty ? fallback : groupTitle
            if let id = try? await container.repo.createGroup(
                title: title, memberIds: Array(selected), campfireSeconds: campfireSeconds
            ).conversation.id {
                onOpenChat(id)
            }
            busy = false
        }
    }

    /**
     * The three things this screen can do that are not "tap a person".
     *
     * All of them already existed and none of them had a button. Group and
     * campfire were reachable only by selecting two contacts and noticing the
     * screen change underneath you; the invite code was a bare `Text` in accent
     * colour, the one plain hyperlink in an app built entirely from surfaces.
     *
     * Shown only while idle — no query, nothing selected — because somebody
     * halfway through picking people is not shopping for a different action.
     */
    @ViewBuilder
    private var starters: some View {
        if inviteEntryOpen {
            inviteEntry
        } else {
            VStack(alignment: .leading, spacing: 0) {
                SectionLabel(text: "Start something")
                NeuSurface(radius: Neu.cornerLarge, contentPadding: 0) {
                    VStack(spacing: 0) {
                        StarterRow(
                            icon: "person.2.fill",
                            title: "New group",
                            detail: "A place for a few people"
                        ) {
                            Haptics.tap()
                            explicitGroupMode = true
                        }
                        .neuDivider(colors)

                        StarterRow(
                            icon: "flame.fill",
                            title: "Campfire",
                            detail: "A group that deletes itself"
                        ) {
                            Haptics.tap()
                            explicitGroupMode = true
                            // Pre-armed at a day, so the picker below opens
                            // already showing what a campfire *is* rather than
                            // as six unexplained chips.
                            campfireSeconds = 86_400
                        }
                        .neuDivider(colors)

                        StarterRow(
                            icon: "link",
                            title: "Join with a code",
                            detail: "Somebody sent you an invite"
                        ) {
                            Haptics.tap()
                            inviteEntryOpen = true
                        }
                    }
                }
            }
        }
    }

    private var createGroupLabel: String {
        switch selected.count {
        case 0: return "Pick who is coming"
        case 1: return "Pick one more"
        default: return "Create group with \(selected.count)"
        }
    }

    /// Group mode is a state to leave, not a screen to pop.
    private func handleBack() {
        guard groupMode else {
            onBack()
            return
        }
        explicitGroupMode = false
        selected.removeAll()
        campfireSeconds = nil
        groupTitle = ""
    }

    /// "Have an invite code?"
    ///
    /// Accepts whatever somebody actually has to hand. People paste the whole
    /// link far more often than they type the ten characters out of the middle
    /// of it, and rejecting the link would be pedantry — the code is in it.
    @ViewBuilder
    private var inviteEntry: some View {
        if inviteEntryOpen {
            VStack(spacing: 8) {
                NeuTextField(
                    text: $inviteText,
                    placeholder: "Paste the link or the code",
                    radius: Neu.cornerPill,
                    autocapitalization: .never
                ) {
                    Image(systemName: "link")
                        .font(.system(size: 16))
                        .foregroundStyle(colors.textTertiary)
                }

                /**
                 * Not accent-filled while it cannot be pressed.
                 *
                 * `NeuButton` dims a disabled button with `opacity(0.45)`, which
                 * on an accent fill takes the white label down with it — a pale
                 * violet slab with barely-legible text on it. Dropping to the
                 * ordinary raised surface says "not yet" in the language the
                 * rest of the app already uses, and keeps the label readable.
                 *
                 * The inner `frame` and `padding` are gone because `NeuButton`
                 * already applies both; doubled up they made this button half
                 * again as tall as every other one on the screen.
                 */
                let ready = parsedInviteCode != nil
                NeuButton(
                    enabled: ready,
                    accent: ready,
                    action: { inviteCode = parsedInviteCode }
                ) {
                    Text("Look it up")
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(ready ? colors.onAccent : colors.textTertiary)
                }
            }
        }
    }

    /// The code out of anything somebody might paste.
    ///
    /// `yappy.gg/join/abc123`, `https://yappy.gg/join/abc123?x=1`,
    /// `yappy://join/abc123`, or the bare `abc123`. Nil when there is nothing
    /// code-shaped in it, which keeps the button disabled rather than sending
    /// a lookup for whatever happened to be on the clipboard.
    private var parsedInviteCode: String? {
        let trimmed = inviteText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        var candidate = trimmed
        if let marker = trimmed.range(of: "join/", options: .backwards) {
            candidate = String(trimmed[marker.upperBound...])
        }
        candidate = String(candidate.prefix(while: { $0 != "?" && $0 != "#" }))
        candidate = candidate.trimmingCharacters(in: CharacterSet(charactersIn: "/ "))

        let ok = (6...32).contains(candidate.count)
            && candidate.allSatisfy { $0.isLetter || $0.isNumber }
        return ok ? candidate : nil
    }
}

/// A code, made `Identifiable` so `.sheet(item:)` can carry it. RootView has
/// its own private copy for the deep-link path; both are three lines.
private struct PastedInviteCode: Identifiable {
    let value: String
    var id: String { value }

    init(_ value: String) { self.value = value }
}

/// One of the starter actions: an icon in a tinted well, a name, a line saying
/// what it is for, and a chevron promising it goes somewhere.
private struct StarterRow: View {
    @Environment(\.neu) private var colors

    let icon: String
    let title: String
    let detail: String
    let action: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(colors.accent)
                .frame(width: 34, height: 34)
                .background(colors.accentSoft, in: Circle())

            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(YappyFont.titleSmall)
                    .foregroundStyle(colors.textPrimary)
                Text(detail)
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
            }

            Spacer(minLength: 0)

            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(colors.textTertiary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .softTap(action: action)
    }
}
