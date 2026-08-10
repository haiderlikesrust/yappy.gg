import PhotosUI
import SwiftUI

/// Who may do a thing to you. Mirrors the server's `PRIVACY_AUDIENCES`.
private let audiences: [(String, String)] = [
    ("everyone", "Everyone"),
    ("contacts", "Contacts"),
    ("nobody", "Nobody"),
]

/// Per-conversation-kind notification levels, as the server names them.
private let levels: [(String, String)] = [
    ("all", "All"),
    ("mentions", "Mentions"),
    ("none", "None"),
]

struct SettingsScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer
    @EnvironmentObject private var lock: AppLockGate

    let onBack: () -> Void
    var onOpenAbout: () -> Void = {}

    @State private var devices: [DeviceEntry] = []
    /// Badged groups that have affiliated me — the only ones I may display.
    @State private var affiliations: [Conversation] = []
    @State private var avatarBusy = false
    @State private var bannerBusy = false
    @State private var bannerSelection: PhotosPickerItem?
    @State private var showPreview = true
    @State private var announcements = true
    @State private var soundOn = true
    @State private var inAppOn = true
    @State private var inAppSoundOn = true
    @State private var readReceipts = true
    @State private var typingIndicators = true
    @State private var ambientPresence = true
    @State private var blockedOpen = false

    // Status — the free-text line beside your name.
    @State private var customStatus = ""
    @State private var customStatusSave: Task<Void, Never>?

    // Notifications
    @State private var reactionsOn = true
    @State private var callsOn = true
    @State private var dmLevel = "all"
    @State private var groupLevel = "mentions"
    @State private var quietOn = false
    @State private var quietStart = "23:00"
    @State private var quietEnd = "08:00"

    // Privacy
    @State private var whoCanDm = "everyone"
    @State private var whoCanAdd = "everyone"
    @State private var whoCanSeeLastSeen = "everyone"

    // Appearance and storage
    @State private var fontScale = 1.0
    @State private var cacheBytes: Int64 = 0
    @State private var cacheCleared = false

    // Account
    @State private var usernameOpen = false
    @State private var deleteOpen = false
    @State private var fontScaleSave: Task<Void, Never>?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header

                profileCard.padding(.horizontal, 16)

                section("Status") { statusField }

                section("Appearance") { appearance }

                // Only rendered when a badged group has actually affiliated you,
                // so for almost everyone this section does not exist. An empty
                // "Affiliation" header would read as something withheld.
                if !affiliations.isEmpty {
                    section("Affiliation") { affiliationPicker }
                }

                section("Notifications") {
                    settingsGroup {
                        // Off means the notification still appears — it just
                        // arrives without a sound. Said in the subtitle because
                        // "Sound: off" is otherwise easy to read as "silence
                        // notifications", which is a different and much more
                        // alarming promise.
                        toggleRow(
                            "speaker.wave.2",
                            "Sound",
                            "Off still shows the notification, just silently",
                            $soundOn
                        ) { next in
                            Task {
                                try? await container.repo.updateNotificationValue(
                                    "sound", next ? "default" : "none"
                                )
                            }
                        }
                        toggleRow(
                            "bell",
                            "Show message preview",
                            "Hide the text on your lock screen",
                            $showPreview
                        ) { next in
                            Task { try? await container.repo.updateNotificationFlag("showPreview", next) }
                        }
                        // The banner that slides in while you are elsewhere in
                        // the app. Distinct from push: these arrive over the
                        // socket and exist even with notifications denied.
                        toggleRow(
                            "bubble.left",
                            "In-app banners",
                            "A banner for messages while you are in the app",
                            $inAppOn
                        ) { next in
                            Task { try? await container.repo.updateNotificationFlag("inApp", next) }
                        }
                        toggleRow(
                            "speaker.wave.1",
                            "In-app sound",
                            "Play a sound with those banners",
                            $inAppSoundOn
                        ) { next in
                            Task { try? await container.repo.updateNotificationFlag("inAppSound", next) }
                        }
                        // The off switch also rides on the messages themselves,
                        // which is where people actually decide they are done
                        // with them. This is the way back on — without it, one
                        // tap in a DM would be permanent.
                        toggleRow(
                            "megaphone",
                            "Tips from yapper",
                            "Welcome notes and bot housekeeping. Security alerts always arrive",
                            $announcements
                        ) { next in
                            Task { try? await container.repo.updateNotificationFlag("announcements", next) }
                        }
                        toggleRow("heart", "Reactions", "When someone reacts to your message", $reactionsOn) { next in
                            Task { try? await container.repo.updateNotificationFlag("reactions", next) }
                        }
                        toggleRow("phone", "Calls", nil, $callsOn) { next in
                            Task { try? await container.repo.updateNotificationFlag("calls", next) }
                        }
                    }

                    settingsGroup {
                        // The per-kind default. A conversation that has been
                        // muted individually still wins over this.
                        pickerRow("What to notify me about in direct messages", levels, $dmLevel) { next in
                            Task { try? await container.repo.updateNotificationValue("dm", next) }
                        }
                        NeuHairline()
                        pickerRow("…and in groups", levels, $groupLevel) { next in
                            Task { try? await container.repo.updateNotificationValue("groups", next) }
                        }
                    }
                    .padding(.top, 10)

                    quietHours.padding(.top, 10)
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
                        toggleRow(
                            "person.2",
                            "Show me in \"here now\"",
                            "Others see you're in a chat while you have it open",
                            $ambientPresence
                        ) { next in
                            Task { try? await container.repo.updatePrivacyFlag("ambientPresence", next) }
                        }
                        NeuHairline()
                        navRow("hand.raised", "Blocked accounts") { blockedOpen = true }
                    }

                    settingsGroup {
                        pickerRow("Who can message me", audiences, $whoCanDm) { next in
                            Task { try? await container.repo.updatePrivacy("whoCanDm", next) }
                        }
                        NeuHairline()
                        pickerRow("Who can add me to groups", audiences, $whoCanAdd) { next in
                            Task { try? await container.repo.updatePrivacy("whoCanAddToGroups", next) }
                        }
                        NeuHairline()
                        pickerRow("Who can see when I was last online", audiences, $whoCanSeeLastSeen) { next in
                            Task { try? await container.repo.updatePrivacy("whoCanSeeLastSeen", next) }
                        }
                    }
                    .padding(.top, 10)

                    if AppLockGate.available {
                        settingsGroup {
                            toggleRow(
                                "faceid",
                                "App lock",
                                "Ask for Face ID when yappy opens. It hides the app, not your data",
                                Binding(get: { lock.enabled }, set: { lock.setEnabled($0) })
                            ) { _ in }
                        }
                        .padding(.top, 10)
                    }
                }

                section("Storage") { storage }

                section("Active sessions") { sessions }

                section("Account") {
                    settingsGroup {
                        navRow("at", "Change username") { usernameOpen = true }
                        NeuHairline()
                        navRow("info.circle", "About", action: onOpenAbout)
                    }
                }

                signOutButton.padding(.horizontal, 16).padding(.top, 24)
                deleteAccountButton.padding(.horizontal, 16).padding(.top, 10)
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
        .sheet(isPresented: $usernameOpen) {
            ChangeUsernameSheet(current: container.me?.username ?? "")
                .presentationDetents([.medium])
                .presentationBackground(colors.surface)
        }
        .sheet(isPresented: $deleteOpen) {
            DeleteAccountSheet()
                .presentationDetents([.medium, .large])
                .presentationBackground(colors.surface)
        }
        .task { await load() }
        .onDisappear { fontScaleSave?.cancel() }
    }

    private func load() async {
        // Seed from the profile already in memory *before* any await, so the
        // toggles open on their real values. Reading them only after the `me()`
        // round trip is what made a disabled toggle show enabled for a second
        // and then flip — the classic default-then-load flash.
        if let cached = container.me { applyPreferences(from: cached) }
        cacheBytes = Int64(ImageLoader.shared.diskUsage)

        if let user = try? await container.repo.me().user {
            container.setMe(user)
            applyPreferences(from: user)
        }
        devices = (try? await container.repo.devices().devices) ?? []
        // Both halves have to be true for a group to be offerable; the server
        // re-checks on write, so this is a filter and not the enforcement.
        affiliations = ((try? await container.repo.conversations().conversations) ?? [])
            .filter { $0.badge != nil && $0.selfState?.isAffiliate == true }
    }

    /// Mirror a profile's notification and privacy settings onto the toggles.
    /// Defaults match the server's: absent means on, except `sound`, where
    /// anything but the silent sentinel counts as a sound.
    private func applyPreferences(from user: FullUser) {
        let notifications = user.notifications
        let privacy = user.privacy

        if let value = notifications?["showPreview"]?.boolValue { showPreview = value }
        soundOn = (notifications?["sound"]?.stringValue ?? "default") != "none"
        announcements = notifications?["announcements"]?.boolValue ?? true
        inAppOn = notifications?["inApp"]?.boolValue ?? true
        inAppSoundOn = notifications?["inAppSound"]?.boolValue ?? true
        reactionsOn = notifications?["reactions"]?.boolValue ?? true
        callsOn = notifications?["calls"]?.boolValue ?? true
        dmLevel = notifications?["dm"]?.stringValue ?? "all"
        groupLevel = notifications?["groups"]?.stringValue ?? "mentions"

        // Absent or null quiet hours means off; the times keep their defaults
        // so switching it on offers a sane window rather than midnight-midnight.
        if let quiet = notifications?["quietHours"], !quiet.isNull {
            quietOn = quiet["enabled"]?.boolValue ?? false
            quietStart = quiet["start"]?.stringValue ?? quietStart
            quietEnd = quiet["end"]?.stringValue ?? quietEnd
        } else {
            quietOn = false
        }

        if let value = privacy?["readReceipts"]?.boolValue { readReceipts = value }
        if let value = privacy?["typingIndicators"]?.boolValue { typingIndicators = value }
        // Absent means on: accounts created before the setting existed have no
        // key for it, and the server reads a missing value the same way.
        ambientPresence = privacy?["ambientPresence"]?.boolValue ?? true
        customStatus = user.presence.customStatus ?? ""
        whoCanDm = privacy?["whoCanDm"]?.stringValue ?? "everyone"
        whoCanAdd = privacy?["whoCanAddToGroups"]?.stringValue ?? "everyone"
        whoCanSeeLastSeen = privacy?["whoCanSeeLastSeen"]?.stringValue ?? "everyone"

        fontScale = user.appearance?.fontScale ?? 1.0
    }

    /// Persist the slider once it settles.
    ///
    /// `Slider` reports every intermediate value, and a PATCH per tick would
    /// be dozens of writes for one drag — and they can land out of order, so
    /// the last one to arrive is not necessarily the value on screen.
    private func scheduleFontScaleSave() {
        fontScaleSave?.cancel()
        let target = fontScale
        fontScaleSave = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            _ = try? await container.repo.setFontScale(target)
        }
    }

    private func saveQuietHours() {
        guard quietOn else { return }
        Task {
            try? await container.repo.setQuietHours(start: quietStart, end: quietEnd, enabled: true)
        }
    }

    // ── Time helpers ─────────────────────────────────────────────────────────

    /// `HH:mm` is what the server stores, and it is timezone-free by design —
    /// the zone travels beside it.
    private static func time(from raw: String) -> Date {
        let parts = raw.split(separator: ":").compactMap { Int($0) }
        var components = DateComponents()
        components.hour = parts.first ?? 23
        components.minute = parts.count > 1 ? parts[1] : 0
        return Calendar.current.date(from: components) ?? Date()
    }

    private static func string(from date: Date) -> String {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }

    private static func readableSize(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
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
            VStack(spacing: 14) {
                bannerEditor

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
    }

    /// The profile banner, editable in place. Tap to pick; long-press for
    /// remove. The preview is the exact crop ProfileScreen draws, so what you
    /// see here is what visitors get.
    private var bannerEditor: some View {
        ZStack(alignment: .bottomTrailing) {
            Group {
                if let url = container.me?.bannerUrl {
                    RemoteImage(url: url) { Rectangle().fill(colors.accentSoft) }
                } else {
                    Rectangle()
                        .fill(colors.accentSoft)
                        .overlay(
                            HStack(spacing: 6) {
                                Image(systemName: "photo")
                                    .font(.system(size: 13))
                                Text("Add a banner")
                                    .font(YappyFont.labelMedium)
                            }
                            .foregroundStyle(colors.textTertiary)
                        )
                }
            }
            .frame(height: 84)
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: Neu.cornerSmall, style: .continuous))
            .overlay {
                if bannerBusy {
                    colors.surface.opacity(0.6)
                        .overlay(NeuSpinner())
                        .clipShape(RoundedRectangle(cornerRadius: Neu.cornerSmall, style: .continuous))
                }
            }

            if !bannerBusy {
                Circle()
                    .fill(colors.accent)
                    .frame(width: 26, height: 26)
                    .overlay(
                        Image(systemName: "camera.fill")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(colors.onAccent)
                    )
                    .padding(6)
            }
        }
        .overlay {
            // Same trick as EditableAvatar: an invisible picker on top makes
            // the whole strip one tap target.
            if !bannerBusy, container.me != nil {
                PhotosPicker(selection: $bannerSelection, matching: .images, photoLibrary: .shared()) {
                    Color.clear.contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .contextMenu {
            if container.me?.bannerUrl != nil {
                Button("Remove banner", role: .destructive) {
                    Task {
                        bannerBusy = true
                        if let updated = try? await container.repo.setMyBanner(mediaId: nil).user {
                            container.setMe(updated)
                        }
                        bannerBusy = false
                    }
                }
            }
        }
        .onChange(of: bannerSelection) { _, item in
            guard let item else { return }
            Task {
                bannerBusy = true
                if let picked = await item.picked(),
                   let uploaded = try? await container.uploader.upload(picked, purpose: "banner"),
                   let updated = try? await container.repo.setMyBanner(mediaId: uploaded.mediaId).user {
                    container.setMe(updated)
                }
                bannerSelection = nil
                bannerBusy = false
            }
        }
    }

    /// The free-text line beside your name.
    ///
    /// Saved on a debounce rather than behind a Save button, matching every
    /// other control on this screen — and cleared by emptying the field, which
    /// is what people try first.
    private var statusField: some View {
        settingsGroup {
            HStack(spacing: 14) {
                Image(systemName: "face.smiling")
                    .font(.system(size: 17))
                    .foregroundStyle(colors.textTertiary)
                    .frame(width: 22)

                NeuTextField(
                    text: Binding(
                        get: { customStatus },
                        set: { next in
                            customStatus = String(next.prefix(128))
                            customStatusSave?.cancel()
                            customStatusSave = Task {
                                try? await Task.sleep(for: .milliseconds(700))
                                guard !Task.isCancelled else { return }
                                // Presence itself is unchanged; only the text is
                                // being written. "offline" would be a lie coming
                                // from someone actively typing into this field.
                                let current = container.me?.presence.status ?? "online"
                                try? await container.repo.setPresence(
                                    current == "offline" ? "online" : current,
                                    customStatus: customStatus
                                )
                            }
                        }
                    ),
                    placeholder: "What are you up to?"
                ) {
                    EmptyView()
                } trailing: {
                    EmptyView()
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
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

                NeuHairline().padding(.vertical, 14)

                HStack {
                    Text("Message text size")
                        .font(YappyFont.titleSmall)
                        .foregroundStyle(colors.textPrimary)
                    Spacer(minLength: 0)
                    Text("\(Int(fontScale * 100))%")
                        .font(YappyFont.labelMedium)
                        .foregroundStyle(colors.textTertiary)
                        .monospacedDigit()
                }

                // The sample is the point: a percentage means nothing until you
                // can see what it does to a line of chat.
                Text("The quick brown fox jumps over the lazy dog")
                    .font(.system(size: 16 * fontScale))
                    .foregroundStyle(colors.textSecondary)
                    .lineLimit(2)
                    .padding(.top, 8)

                HStack(spacing: 10) {
                    Text("A").font(.system(size: 13)).foregroundStyle(colors.textTertiary)
                    // Server range is 0.8–1.6; the step keeps it to values that
                    // land on a whole percentage.
                    Slider(value: $fontScale, in: 0.8...1.6, step: 0.05)
                        .tint(colors.accent)
                    Text("A").font(.system(size: 21)).foregroundStyle(colors.textTertiary)
                }
                .padding(.top, 6)
                // Only on release: dragging the slider would otherwise PATCH
                // the account on every tick.
                .onChange(of: fontScale) { _, _ in scheduleFontScaleSave() }
            }
        }
    }

    private var quietHours: some View {
        settingsGroup {
            toggleRow(
                "moon",
                "Quiet hours",
                "Notifications still arrive, they just wait until morning",
                $quietOn
            ) { next in
                Task {
                    if next {
                        try? await container.repo.setQuietHours(
                            start: quietStart, end: quietEnd, enabled: true
                        )
                    } else {
                        try? await container.repo.clearQuietHours()
                    }
                }
            }

            if quietOn {
                NeuHairline()
                HStack(spacing: 10) {
                    timeField("From", $quietStart)
                    timeField("Until", $quietEnd)
                }
                .padding(.vertical, 10)
                .padding(.horizontal, 4)

                // A window that ends before it starts is a normal thing to
                // want — it is what "overnight" means — so it is stated rather
                // than rejected.
                if quietStart > quietEnd {
                    Text("Overnight, through to \(quietEnd) the next day.")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                        .padding(.horizontal, 4)
                        .padding(.bottom, 8)
                }
            }
        }
    }

    private func timeField(_ label: String, _ value: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)

            DatePicker(
                label,
                selection: Binding(
                    get: { Self.time(from: value.wrappedValue) },
                    set: { value.wrappedValue = Self.string(from: $0); saveQuietHours() }
                ),
                displayedComponents: .hourAndMinute
            )
            .labelsHidden()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var storage: some View {
        settingsGroup {
            HStack(spacing: 14) {
                Image(systemName: cacheCleared ? "checkmark" : "trash")
                    .font(.system(size: 17))
                    .foregroundStyle(cacheCleared ? colors.success : colors.textSecondary)
                    .frame(width: 22)

                VStack(alignment: .leading, spacing: 1) {
                    Text(cacheCleared ? "Cache cleared" : "Clear cache")
                        .font(YappyFont.bodyLarge)
                        .foregroundStyle(colors.textPrimary)
                    // Says what is *not* lost, because "clear" next to a chat
                    // app reads as "delete my messages" to most people.
                    Text(cacheCleared
                        ? "Media will download again when you open it"
                        : "\(Self.readableSize(cacheBytes)) of downloaded media. Your messages stay.")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.vertical, 10)
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
            .softTap(enabled: !cacheCleared) {
                ImageLoader.shared.purge()
                cacheBytes = 0
                cacheCleared = true
            }
        }
    }

    private var deleteAccountButton: some View {
        NeuSurface(radius: Neu.cornerMedium, contentPadding: 4, onTap: { deleteOpen = true }) {
            HStack(spacing: 14) {
                Image(systemName: "trash")
                    .font(.system(size: 17))
                    .foregroundStyle(colors.danger)
                    .frame(width: 22)
                Text("Delete account")
                    .font(YappyFont.bodyLarge)
                    .foregroundStyle(colors.danger)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 10)
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

    /// A label with a row of chips under it.
    ///
    /// Chips rather than a `Menu`: three short options fit, and a menu hides
    /// the current answer behind a tap on a screen whose whole job is showing
    /// people what their settings currently are.
    private func pickerRow(
        _ title: String,
        _ options: [(String, String)],
        _ value: Binding<String>,
        onChange: @escaping (String) -> Void
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(title)
                .font(YappyFont.titleSmall)
                .foregroundStyle(colors.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 8) {
                ForEach(options, id: \.0) { key, label in
                    NeuChip(label: label, selected: value.wrappedValue == key) {
                        guard value.wrappedValue != key else { return }
                        value.wrappedValue = key
                        onChange(key)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.vertical, 11)
        .padding(.horizontal, 4)
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

// ── Account ──────────────────────────────────────────────────────────────────

/// Rename.
///
/// The server keeps the old handle in `username_history`, so links and mentions
/// that used it still resolve — that is worth saying out loud, because "will my
/// old @ break?" is the reason most people never touch this.
private struct ChangeUsernameSheet: View {
    @Environment(\.neu) private var colors
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var container: AppContainer

    let current: String

    @State private var draft = ""
    @State private var state: CheckState = .idle
    @State private var busy = false
    @State private var error: String?
    @State private var check: Task<Void, Never>?

    private enum CheckState: Equatable {
        case idle, checking, free, taken
    }

    private var trimmed: String {
        draft.trimmingCharacters(in: .whitespaces).lowercased()
    }

    private var canSave: Bool {
        !busy && state == .free && trimmed != current.lowercased() && trimmed.count >= 3
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Change username")
                .font(YappyFont.titleMedium)
                .foregroundStyle(colors.textPrimary)

            Text("Your old @\(current) keeps working for mentions and links that already point at it. You can change this about once a day.")
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 6)

            NeuTextField(
                text: $draft,
                placeholder: current,
                autocapitalization: .never
            ) {
                Text("@").font(YappyFont.bodyLarge).foregroundStyle(colors.textTertiary)
            } trailing: {
                statusMark
            }
            .padding(.top, 16)
            .onChange(of: draft) { _, _ in scheduleCheck() }

            if let error {
                Text(error)
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.danger)
                    .padding(.top, 8)
            } else if state == .taken {
                Text("That one is taken.")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.danger)
                    .padding(.top, 8)
            }

            NeuButton(enabled: canSave, accent: true, action: save) {
                Text(busy ? "Saving…" : "Save")
                    .font(YappyFont.labelLarge)
                    .foregroundStyle(colors.onAccent)
            }
            .padding(.top, 18)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.top, 22)
        .onDisappear { check?.cancel() }
    }

    @ViewBuilder
    private var statusMark: some View {
        switch state {
        case .checking: NeuSpinner().frame(width: 16, height: 16)
        case .free: Image(systemName: "checkmark").foregroundStyle(colors.success)
        case .taken: Image(systemName: "xmark").foregroundStyle(colors.danger)
        case .idle: EmptyView()
        }
    }

    /// Debounced, because the availability endpoint is rate-limited per second
    /// and a keystroke-per-request burns that budget on prefixes nobody typed
    /// on purpose.
    private func scheduleCheck() {
        error = nil
        check?.cancel()
        let candidate = trimmed

        guard candidate.count >= 3, candidate != current.lowercased() else {
            state = .idle
            return
        }

        state = .checking
        check = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            let free = (try? await container.repo.usernameAvailable(candidate)) ?? false
            guard !Task.isCancelled, candidate == trimmed else { return }
            state = free ? .free : .taken
        }
    }

    private func save() {
        guard canSave else { return }
        busy = true
        error = nil

        Task {
            do {
                container.setMe(try await container.repo.changeUsername(trimmed).user)
                dismiss()
            } catch let failure as ApiError {
                // The rate limit is the one people actually hit, and "429" is
                // not an explanation.
                error = failure.isRateLimited
                    ? "You have changed it too recently. Try again tomorrow."
                    : failure.message
            } catch {
                self.error = "That did not work. Try again."
            }
            busy = false
        }
    }
}

/// Deleting the account.
///
/// In the app because the App Store requires it of anything that can create an
/// account, and behind a typed confirmation because it is the one destructive
/// action here that a mis-tap should not be able to reach.
private struct DeleteAccountSheet: View {
    @Environment(\.neu) private var colors
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var container: AppContainer

    @State private var confirmation = ""
    @State private var busy = false
    @State private var error: String?

    private var armed: Bool {
        confirmation.trimmingCharacters(in: .whitespaces).lowercased() == "delete"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Delete account")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.danger)

                Text("""
                    Your profile, username and picture are removed right away, and everything else is erased for good after 30 days.

                    Signing back in during those 30 days cancels it. After that it cannot be undone.
                    """)
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)

                Text("Type DELETE to confirm")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
                    .padding(.top, 20)
                    .padding(.bottom, 6)

                NeuTextField(text: $confirmation, placeholder: "DELETE", autocapitalization: .characters)

                if let error {
                    Text(error)
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.danger)
                        .padding(.top, 8)
                }

                NeuButton(enabled: armed && !busy, action: destroy) {
                    Text(busy ? "Deleting…" : "Delete my account")
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(colors.danger)
                }
                .padding(.top, 18)

                NeuButton(enabled: !busy) { dismiss() } content: {
                    Text("Keep my account")
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(colors.textSecondary)
                }
                .padding(.top, 10)
            }
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 30)
        }
    }

    private func destroy() {
        guard armed, !busy else { return }
        busy = true
        error = nil

        Task {
            do {
                _ = try await container.repo.deleteAccount()
                // Sign out locally too: the tokens are dead server-side, and
                // leaving the app on a signed-in screen it can no longer load
                // is a worse ending than the sign-in screen.
                await container.signOut()
            } catch {
                self.error = "That did not work. Try again."
                busy = false
            }
        }
    }
}
