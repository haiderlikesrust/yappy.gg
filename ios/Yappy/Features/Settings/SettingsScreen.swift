import SwiftUI

struct SettingsScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let onBack: () -> Void

    @State private var devices: [DeviceEntry] = []
    /// Badged groups that have affiliated me — the only ones I may display.
    @State private var affiliations: [Conversation] = []
    @State private var avatarBusy = false
    @State private var showPreview = true
    @State private var readReceipts = true
    @State private var typingIndicators = true
    @State private var blockedOpen = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header

                profileCard.padding(.horizontal, 16)

                section("Appearance") { appearance }

                // Only rendered when a badged group has actually affiliated you,
                // so for almost everyone this section does not exist. An empty
                // "Affiliation" header would read as something withheld.
                if !affiliations.isEmpty {
                    section("Affiliation") { affiliationPicker }
                }

                section("Notifications") {
                    settingsGroup {
                        toggleRow(
                            "bell",
                            "Show message preview",
                            "Hide the text on your lock screen",
                            $showPreview
                        ) { next in
                            Task { try? await container.repo.updateNotificationFlag("showPreview", next) }
                        }
                    }
                }

                section("Privacy") {
                    settingsGroup {
                        toggleRow(
                            "eye",
                            "Read receipts",
                            "If off, you also stop seeing others'",
                            $readReceipts
                        ) { next in
                            Task { try? await container.repo.updatePrivacyFlag("readReceipts", next) }
                        }
                        NeuHairline()
                        toggleRow("lock", "Typing indicators", nil, $typingIndicators) { next in
                            Task { try? await container.repo.updatePrivacyFlag("typingIndicators", next) }
                        }
                        NeuHairline()
                        navRow("hand.raised", "Blocked accounts") { blockedOpen = true }
                    }
                }

                section("Active sessions") { sessions }

                signOutButton.padding(.horizontal, 16).padding(.top, 24)
            }
            .padding(.bottom, 40)
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $blockedOpen) {
            BlockedAccounts()
                .presentationDetents([.medium, .large])
                .presentationBackground(colors.surface)
        }
        .task { await load() }
    }

    private func load() async {
        if let user = try? await container.repo.me().user {
            container.setMe(user)
            if let value = user.notifications?["showPreview"]?.boolValue { showPreview = value }
            if let value = user.privacy?["readReceipts"]?.boolValue { readReceipts = value }
            if let value = user.privacy?["typingIndicators"]?.boolValue { typingIndicators = value }
        }
        devices = (try? await container.repo.devices().devices) ?? []
        // Both halves have to be true for a group to be offerable; the server
        // re-checks on write, so this is a filter and not the enforcement.
        affiliations = ((try? await container.repo.conversations().conversations) ?? [])
            .filter { $0.badge != nil && $0.selfState?.isAffiliate == true }
    }

    // ── Pieces ───────────────────────────────────────────────────────────────

    private var header: some View {
        HStack(spacing: 12) {
            NeuIconButton(systemName: "chevron.left", label: "Back", size: 42, iconSize: 18, action: onBack)
            Text("Settings")
                .font(YappyFont.headlineSmall)
                .foregroundStyle(colors.textPrimary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var profileCard: some View {
        NeuSurface(radius: Neu.cornerLarge, elevation: 8, contentPadding: 18) {
            HStack(spacing: 14) {
                EditableAvatar(
                    url: container.me?.avatarUrl,
                    name: container.me?.displayName,
                    id: container.me?.id ?? "me",
                    size: 62,
                    busy: avatarBusy,
                    enabled: container.me != nil
                ) { picked in
                    Task {
                        avatarBusy = true
                        if let uploaded = try? await container.uploader.upload(picked, purpose: "avatar"),
                           let updated = try? await container.repo.setMyAvatar(mediaId: uploaded.mediaId).user {
                            // Through the container: it evicts the old picture
                            // from the image cache and republishes to every
                            // screen drawing your face, so the home header
                            // changes at the same moment this card does.
                            container.setMe(updated)
                        }
                        avatarBusy = false
                    }
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(container.me?.displayName ?? "…")
                        .font(YappyFont.titleMedium)
                        .foregroundStyle(colors.textPrimary)
                    Text(container.me?.username.map { "@\($0)" } ?? "")
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.textTertiary)
                    if let bio = container.me?.bio, !bio.isEmpty {
                        Text(bio)
                            .font(YappyFont.bodyMedium)
                            .foregroundStyle(colors.textSecondary)
                            .padding(.top, 2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var appearance: some View {
        NeuSurface(radius: Neu.cornerMedium, contentPadding: 16) {
            VStack(alignment: .leading, spacing: 0) {
                Text("Theme")
                    .font(YappyFont.titleSmall)
                    .foregroundStyle(colors.textPrimary)
                    .padding(.bottom, 12)

                HStack(spacing: 8) {
                    ForEach(ThemePreference.allCases, id: \.self) { preference in
                        NeuChip(
                            label: preference.rawValue.capitalized,
                            selected: container.theme == preference
                        ) {
                            container.setTheme(preference)
                        }
                    }
                    Spacer(minLength: 0)
                }

                Text("The theme is stored on your account too, so a new device picks it up.")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
                    .padding(.top, 8)
            }
        }
    }

    private var affiliationPicker: some View {
        settingsGroup {
            Text("Show a group's logo next to your name. You can turn this off at any time, and so can they.")
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)
                .padding(.horizontal, 4)
                .padding(.vertical, 10)

            ForEach(affiliations) { group in
                NeuHairline()
                let selected = container.me?.affiliation?.id == group.id

                HStack(spacing: 12) {
                    Avatar(url: group.avatarUrl, name: group.title, id: group.id, size: 34, shape: .place)
                    Text(group.title ?? "Group")
                        .font(YappyFont.bodyLarge)
                        .foregroundStyle(colors.textPrimary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    BadgeMark(badge: group.badge, size: 15)
                    if selected {
                        Image(systemName: "checkmark")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(colors.accent)
                    }
                }
                .padding(.vertical, 12)
                .padding(.horizontal, 4)
                .contentShape(Rectangle())
                .softTap {
                    Task {
                        let next = selected ? nil : group.id
                        if let updated = try? await container.repo.setAffiliation(conversationId: next).user {
                            container.setMe(updated)
                        }
                    }
                }
            }
        }
    }

    private var sessions: some View {
        settingsGroup {
            if devices.isEmpty {
                Text("Loading…")
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(colors.textTertiary)
                    .padding(.vertical, 12)
            }

            ForEach(Array(devices.enumerated()), id: \.element.id) { index, device in
                if index > 0 { NeuHairline() }

                HStack(spacing: 14) {
                    Image(systemName: "laptopcomputer.and.iphone")
                        .font(.system(size: 17))
                        .foregroundStyle(colors.textSecondary)
                        .frame(width: 22)

                    VStack(alignment: .leading, spacing: 1) {
                        Text(device.name ?? device.platform.capitalized)
                            .font(YappyFont.bodyLarge)
                            .foregroundStyle(colors.textPrimary)
                        Text(device.isCurrent ? "This device" : (device.osVersion ?? device.platform))
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(device.isCurrent ? colors.success : colors.textTertiary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    if !device.isCurrent {
                        Text("Sign out")
                            .font(YappyFont.labelMedium)
                            .foregroundStyle(colors.danger)
                            .softTap {
                                Task {
                                    try? await container.repo.revokeDevice(device.id)
                                    devices.removeAll { $0.id == device.id }
                                }
                            }
                    }
                }
                .padding(.vertical, 12)
                .padding(.horizontal, 4)
            }
        }
    }

    private var signOutButton: some View {
        NeuSurface(radius: Neu.cornerMedium, contentPadding: 4, onTap: {
            Task { await container.signOut() }
        }) {
            HStack(spacing: 14) {
                Image(systemName: "rectangle.portrait.and.arrow.right")
                    .font(.system(size: 17))
                    .foregroundStyle(colors.danger)
                    .frame(width: 22)
                Text("Sign out")
                    .font(YappyFont.bodyLarge)
                    .foregroundStyle(colors.danger)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 10)
        }
    }

    // ── Layout helpers ───────────────────────────────────────────────────────

    @ViewBuilder
    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        SectionLabel(text: title)
            .padding(.horizontal, 22)
            .padding(.top, 24)
        content()
            .padding(.horizontal, 16)
    }

    // `@escaping` because `NeuSurface` stores its content closure rather than
    // calling it inline, and a stored closure outlives the call.
    private func settingsGroup<Content: View>(@ViewBuilder content: @escaping () -> Content) -> some View {
        NeuSurface(radius: Neu.cornerMedium, contentPadding: 12) {
            VStack(spacing: 0) { content() }
        }
    }

    private func toggleRow(
        _ symbol: String,
        _ title: String,
        _ subtitle: String?,
        _ value: Binding<Bool>,
        onChange: @escaping (Bool) -> Void
    ) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 17))
                .foregroundStyle(colors.textSecondary)
                .frame(width: 22)

            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(YappyFont.bodyLarge)
                    .foregroundStyle(colors.textPrimary)
                if let subtitle {
                    Text(subtitle)
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            NeuSwitch(isOn: value)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 4)
        .onChange(of: value.wrappedValue) { _, next in onChange(next) }
    }

    private func navRow(_ symbol: String, _ title: String, action: @escaping () -> Void) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 17))
                .foregroundStyle(colors.textSecondary)
                .frame(width: 22)
            Text(title)
                .font(YappyFont.bodyLarge)
                .foregroundStyle(colors.textPrimary)
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(colors.textTertiary)
        }
        .padding(.vertical, 13)
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
        .softTap(action: action)
    }
}

/// Blocked accounts, with the unblock the Android build left as a dead row.
private struct BlockedAccounts: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    @State private var blocked: [PublicUser]?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Blocked accounts")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textPrimary)
                    .padding(.bottom, 12)

                if blocked == nil {
                    NeuSpinner().frame(maxWidth: .infinity).padding(.vertical, 30)
                } else if blocked?.isEmpty == true {
                    Text("You haven't blocked anyone.")
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.textTertiary)
                        .padding(.vertical, 20)
                }

                ForEach(blocked ?? []) { user in
                    HStack(spacing: 12) {
                        Avatar(url: user.avatarUrl, name: user.label, id: user.id, size: 38)
                        Text(user.label)
                            .font(YappyFont.bodyLarge)
                            .foregroundStyle(colors.textPrimary)
                        Spacer(minLength: 0)
                        Text("Unblock")
                            .font(YappyFont.labelMedium)
                            .foregroundStyle(colors.accent)
                            .softTap {
                                Task {
                                    try? await container.repo.unblock(user.id)
                                    blocked?.removeAll { $0.id == user.id }
                                }
                            }
                    }
                    .padding(.vertical, 8)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 20)
            .padding(.bottom, 28)
        }
        .task {
            blocked = (try? await container.repo.blocks().users) ?? []
        }
    }
}
