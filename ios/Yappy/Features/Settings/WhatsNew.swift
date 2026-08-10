import SwiftUI

/// Release notes.
///
/// The hard part of a What's New screen is not drawing it, it is deciding when
/// *not* to show it. `WhatsNewGate` owns that decision and nothing else does —
/// see the rules on `check()`.

extension Bundle {
    /// `1.1.0`. The marketing version, which is what people recognise.
    var appVersion: String {
        (infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0"
    }

    /// The build number, shown next to the version for support.
    var appBuild: String {
        (infoDictionary?["CFBundleVersion"] as? String) ?? "0"
    }
}

/// Decides whether the sheet is owed, and remembers that it was paid.
@MainActor
final class WhatsNewGate: ObservableObject {
    /// Non-nil when there is something to show and the moment is right.
    @Published var pending: [ReleaseNote] = []

    private let store: SessionStore
    private let repo: YappyRepository
    private var checked = false

    init(store: SessionStore, repo: YappyRepository) {
        self.store = store
        self.repo = repo
    }

    /// Rules, in order:
    ///
    /// 1. Once per launch, never on a timer.
    /// 2. A fresh install records where it came in and shows nothing — nothing
    ///    is "new" to someone who has never seen the old version.
    /// 3. Only notes newer than the last one shown, which the server decides.
    /// 4. Marked seen the moment it is dismissed, so a crash mid-read means it
    ///    comes back rather than being lost.
    ///
    /// Rule 2 is the subtle one, and 1.1.0 got it wrong. "No marker" does not
    /// mean "new here": it is also what every upgrader looks like on the first
    /// run of the build that *introduced* the marker. Treating those as fresh
    /// installs swallowed the 1.1.0 notes for everyone who already had yappy —
    /// exactly the audience they were written for. A session that already
    /// existed when the process started is the tell, so an upgrader with no
    /// marker is caught up rather than silenced.
    func check() async {
        guard !checked else { return }
        checked = true

        let seen = store.seenRelease
        guard let feed = try? await repo.changelog(since: seen) else { return }

        if seen == nil, !store.hadSessionAtLaunch {
            // Genuinely new here. Record where they came in, show nothing.
            if let latest = feed.latestId { store.setSeenRelease(latest) }
            return
        }

        // An upgrader with no marker gets the newest note only. The whole back
        // catalogue would be a wall of text about releases they lived through.
        pending = seen == nil ? Array(feed.notes.prefix(1)) : feed.notes
    }

    /// Called on dismiss, and by the Settings entry, which must not re-arm it.
    func markSeen() {
        if let newest = pending.first?.id { store.setSeenRelease(newest) }
        pending = []
    }
}

// ── The sheet ────────────────────────────────────────────────────────────────

struct WhatsNewSheet: View {
    @Environment(\.neu) private var colors
    @Environment(\.dismiss) private var dismiss

    let notes: [ReleaseNote]
    var onClose: (() -> Void)?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(notes.enumerated()), id: \.element.id) { index, note in
                    if index > 0 {
                        NeuHairline()
                            .padding(.horizontal, 20)
                            .padding(.vertical, 26)
                    }
                    noteBody(note, isFirst: index == 0)
                }

                NeuButton(accent: true) {
                    onClose?()
                    dismiss()
                } content: {
                    Text("Got it")
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(colors.onAccent)
                }
                .padding(.horizontal, 20)
                .padding(.top, 30)
            }
            .padding(.bottom, 40)
        }
        .background(colors.surface)
    }

    @ViewBuilder
    private func noteBody(_ note: ReleaseNote, isFirst: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if isFirst { hero(note) }

            VStack(alignment: .leading, spacing: 4) {
                Text(note.title)
                    .font(YappyFont.headlineMedium)
                    .foregroundStyle(colors.textPrimary)

                Text(subtitle(note))
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(colors.textTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, isFirst ? 20 : 0)

            if let intro = note.intro, !intro.isEmpty {
                Text(intro)
                    .font(YappyFont.bodyLarge)
                    .foregroundStyle(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 20)
                    .padding(.top, 12)
            }

            ForEach(Array(note.sections.enumerated()), id: \.offset) { _, section in
                sectionView(section)
            }
        }
    }

    /// The bundled banner unless the release ships its own.
    ///
    /// Bundled rather than fetched by default: this sheet is the first thing
    /// someone sees after updating, sometimes before the network settles, and a
    /// grey rectangle at the top of it is a bad first impression.
    @ViewBuilder
    private func hero(_ note: ReleaseNote) -> some View {
        Group {
            if let url = note.heroUrl, !url.isEmpty {
                RemoteImage(url: url, contentMode: .fill) {
                    Image("WhatsNewHero").resizable().aspectRatio(contentMode: .fill)
                }
            } else {
                Image("WhatsNewHero").resizable().aspectRatio(contentMode: .fill)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 168)
        .clipped()
        .clipShape(NeuShape(radius: Neu.cornerLarge))
        .padding(.horizontal, 16)
        .padding(.top, 16)
    }

    private func sectionView(_ section: ReleaseNoteSection) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                if let icon = section.icon, UIImage(systemName: icon) != nil {
                    Image(systemName: icon)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(colors.accent)
                }
                Text(section.heading.uppercased())
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.accent)
                    .tracking(0.6)
                Rectangle()
                    .fill(colors.accent.opacity(0.25))
                    .frame(height: 1)
            }
            .padding(.horizontal, 20)
            .padding(.top, 26)

            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(section.items.enumerated()), id: \.offset) { _, item in
                    itemView(item)
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
        }
    }

    private func itemView(_ item: ReleaseNoteItem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(colors.textTertiary.opacity(0.5))
                .frame(width: 5, height: 5)
                .padding(.top, 7)

            // One Text so the bold lead-in and the sentence wrap as a paragraph
            // rather than as two stacked blocks.
            (
                Text(item.title).font(YappyFont.titleSmallBold).foregroundStyle(colors.textPrimary)
                    + Text("  ")
                    + Text(item.body).font(YappyFont.bodyMedium).foregroundStyle(colors.textSecondary)
            )
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .contentShape(Rectangle())
        .softTap(enabled: item.url != nil) {
            if let url = item.url, let link = URL(string: url) { UIApplication.shared.open(link) }
        }
    }

    /// "Version 1.1.0 · 10 August 2026", degrading to whichever half parses.
    private func subtitle(_ note: ReleaseNote) -> String {
        var parts: [String] = []
        if !note.version.isEmpty { parts.append("Version \(note.version)") }
        if let pretty = Self.prettyDate(note.date) { parts.append(pretty) }
        return parts.joined(separator: " · ")
    }

    private static let inbound: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .iso8601)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(secondsFromGMT: 0)
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static func prettyDate(_ raw: String) -> String? {
        guard let date = inbound.date(from: raw) else { return nil }
        return date.formatted(.dateTime.day().month(.wide).year())
    }
}
