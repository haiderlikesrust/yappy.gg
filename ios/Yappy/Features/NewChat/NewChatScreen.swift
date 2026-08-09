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

    private var shown: [PublicUser] { query.isEmpty ? contacts : results }
    private var groupMode: Bool { selected.count >= 2 }

    private var selectedUsers: [PublicUser] {
        var seen = Set<String>()
        return (contacts + results)
            .filter { seen.insert($0.id).inserted }
            .filter { selected.contains($0.id) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                NeuIconButton(systemName: "chevron.left", label: "Back", size: 42, iconSize: 18, action: onBack)
                Text(groupMode ? "New group" : "New chat")
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

            if groupMode {
                NeuTextField(text: $groupTitle, placeholder: "Group name") {
                    Image(systemName: "person.2")
                        .font(.system(size: 16))
                        .foregroundStyle(colors.textTertiary)
                }
                .padding(.horizontal, 16)
                .padding(.top, 10)
            }

            list.padding(.top, 12)

            if groupMode {
                NeuButton(enabled: !busy, accent: true, action: createGroup) {
                    if busy {
                        NeuSpinner(tint: colors.onAccent)
                    } else {
                        Text("Create group with \(selected.count)")
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(colors.onAccent)
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
    }

    @ViewBuilder
    private var list: some View {
        if shown.isEmpty {
            Text(query.isEmpty ? "No contacts yet — search for someone" : "No one found")
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textTertiary)
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
                title: title, memberIds: Array(selected)
            ).conversation.id {
                onOpenChat(id)
            }
            busy = false
        }
    }
}
