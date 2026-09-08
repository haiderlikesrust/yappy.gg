import SwiftUI

/// Explore: public places, ranked by warmth.
///
/// A place-first directory has one question to answer better than "how big is
/// it": *is anyone there right now?* Seven people with three present beats two
/// hundred and nobody home, so the page leads with who is around — the live
/// calls, the here-counts — and lets size be a detail.
///
/// Every group is drawn as a card wearing its own flair: the gradient and emoji
/// its owner picked in settings, or a tint derived from its id when they never
/// did. A directory of identical grey rows says "database"; a wall of covers
/// says "places".
struct ExploreScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let onBack: () -> Void
    let onOpenChat: (String) -> Void
    /// The empty state's door. Optional with a default so the existing call
    /// site keeps compiling; the button only appears once the route passes it.
    var onStartGroup: (() -> Void)? = nil

    var isTabRoot = false
    @State private var preview: DiscoverEntry?
    @State private var joinedId: String?
    @State private var joinError: String?

    @State private var entries: [DiscoverEntry]?
    @State private var joining: String?
    @State private var failed = false
    @State private var query = ""
    @State private var interest = ""
    @State private var language = ""
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Picker("Interest", selection: $interest) { Text("Any interest").tag(""); ForEach(["gaming", "music", "design", "movies", "technology", "art"], id: \.self) { Text($0.capitalized).tag($0) } }
                Picker("Language", selection: $language) { ForEach(communityLanguages, id: \.0) { value, label in Text(label).tag(value) } }
            }.padding(.horizontal, 16)
            if !interest.isEmpty { Text("Groups matching your interest in \(interest)").font(.caption).foregroundStyle(colors.textSecondary) }
            content
        }
        .navigationTitle("Explore")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .searchable(text: $query, prompt: "Search public groups")
        .toolbar {
            ToolbarItem(placement: .principal) { ScreenHeading(title: "Explore", subtitle: "Find your people") }
            if let onStartGroup {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Start a group", systemImage: "plus", action: onStartGroup)
                }
            }
        }
        .sheet(item: $preview, onDismiss: {
            if let id = joinedId { joinedId = nil; onOpenChat(id) }
        }) { entry in
            PublicPlacePreview(entry: entry, joining: joining == entry.id, error: joinError,
                               onJoin: { join(entry) }, onClose: { preview = nil })
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
                .presentationContentInteraction(.resizes)
                .presentationBackground(colors.surface)
        }
        .task(id: "\(interest):\(language)") { await load() }
        // Browse loads once; a query re-asks the server, debounced so a fast
        // typist costs one request, not one per letter.
        .onChange(of: query) { _, _ in
            searchTask?.cancel()
            searchTask = Task {
                if !activeQuery.isEmpty {
                    try? await Task.sleep(for: .milliseconds(350))
                }
                guard !Task.isCancelled else { return }
                await load()
            }
        }
    }

    /// What actually goes to the server: a single character matches half the
    /// directory and flashes the page on every first keystroke, so search only
    /// begins at two.
    private var activeQuery: String {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count >= 2 ? trimmed : ""
    }

    /// "Nothing public yet" is a claim about the world, so a failed fetch may
    /// not make it — entries stays nil and the screen says what actually
    /// happened instead.
    private func load() async {
        failed = false
        let asked = activeQuery
        let askedInterest = interest, askedLanguage = language
        if let found = try? await container.repo.discover(matching: asked, tag: askedInterest, language: askedLanguage).conversations {
            // A slow browse response must not overwrite a newer search's page.
            guard !Task.isCancelled, asked == activeQuery, askedInterest == interest, askedLanguage == language else { return }
            entries = found
        } else if entries == nil {
            failed = true
        }
    }

    private func join(_ entry: DiscoverEntry) {
        guard joining == nil else { return }
        joining = entry.id
        joinError = nil
        Task {
            do {
                let id = try await container.repo.joinPublic(entry.id).conversation.id
                if preview != nil {
                    joinedId = id
                    preview = nil
                } else {
                    onOpenChat(id)
                }
            } catch {
                joinError = "Couldn't join this group. Please try again."
            }
            joining = nil
        }
    }

    @ViewBuilder
    private var content: some View {
        if failed, entries == nil {
            VStack(spacing: 10) {
                Text("Couldn't load Explore")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textSecondary)
                Text("Retry")
                    .font(YappyFont.titleSmallBold)
                    .foregroundStyle(colors.accent)
                    .padding(.horizontal, 26)
                    .padding(.vertical, 12)
                    .neu(Capsule(), colors, state: .raised, elevation: 6)
                    .softTap { Task { await load() } }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if entries == nil {
            ScrollView {
                SkeletonRows(count: 7).padding(.top, 6)
            }
            .scrollDisabled(true)
        } else if entries?.isEmpty == true {
            emptyState
        } else {
            directory
        }
    }

    /// Sectioned by what matters, in order: the vouched-for, the warm, the
    /// fresh, then everything else. A group appears once, in the strongest
    /// section it qualifies for.
    private var directory: some View {
        let loaded = entries ?? []
        let verified = loaded.filter { $0.badge != nil }
        let rest1 = loaded.filter { $0.badge == nil }
        let buzzing = rest1.filter { $0.hereCount > 0 || $0.live }
        let rest2 = rest1.filter { !($0.hereCount > 0 || $0.live) }
        let fresh = rest2.filter { Self.isNew($0.createdAt) }
        let others = rest2.filter { !Self.isNew($0.createdAt) }
        let moreLabel = (verified.isEmpty && buzzing.isEmpty && fresh.isEmpty) ? nil : "More places"

        return ScrollView {
            LazyVStack(spacing: 10) {
                section("Verified", verified)
                section("Buzzing now", buzzing)
                section("New places", fresh)
                section(moreLabel, others)
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .padding(.bottom, 40)
        }
        .refreshable {
            await load()
            Haptics.success()
        }
    }

    @ViewBuilder
    private func section(_ label: String?, _ items: [DiscoverEntry]) -> some View {
        if !items.isEmpty {
            if let label {
                SectionLabel(text: label)
                    .padding(.top, 8)
            }
            ForEach(items) { entry in
                PlaceCard(entry: entry) {
                    joinError = nil
                    preview = entry
                }
                // `SectionLabel` carries six points of its own. Without this
                // every card hung six points left of the heading naming it.
                .padding(.horizontal, 6)
            }
        }
    }

    /// Empty, with a door. Advice without a way to act on it is the old
    /// version's mistake — "make a group public" with nowhere to tap.
    private var emptyState: some View {
        let searching = !activeQuery.isEmpty
        return VStack(spacing: 0) {
            ZStack {
                PlaceShape()
                    .fill(
                        LinearGradient(
                            colors: [Color(hex: 0x8B7CFF).opacity(0.4), Color(hex: 0x00CEC9).opacity(0.25)],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 64, height: 64)
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 24, weight: .medium))
                    .foregroundStyle(colors.textSecondary)
            }
            .padding(.bottom, 16)

            Text(searching ? "Nothing matches" : "No public places yet")
                .font(YappyFont.titleMedium)
                .foregroundStyle(colors.textPrimary)
                .padding(.bottom, 6)

            Text(
                searching
                    ? "Try another name — or start the group you were looking for."
                    : "Public groups show up here for anyone to walk into. Yours could be first: make a group, then flip it to public in its settings."
            )
            .font(YappyFont.bodyMedium)
            .foregroundStyle(colors.textTertiary)
            .multilineTextAlignment(.center)

            if let onStartGroup {
                NeuButton(accent: true, action: onStartGroup) {
                    Text("Start a group")
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(colors.onAccent)
                }
                .fixedSize()
                .padding(.top, 20)
            }
        }
        .padding(.horizontal, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Under two weeks old — young enough that joining still means shaping it.
    private static func isNew(_ createdAt: String?) -> Bool {
        guard let created = YappyTime.parse(createdAt) else { return false }
        return created > Date().addingTimeInterval(-14 * 24 * 3600)
    }
}

/// Discover with the directory's text filter. Lives beside the screen rather
/// than in the repository so Explore's search shipped without touching shared
/// files; fold into `discover()` when the repository is next open. An empty
/// query is the browse page, exactly as the server reads it.
private extension YappyRepository {
    func discover(matching query: String, tag: String = "", language: String = "") async throws -> DiscoverEnvelope {
        try await api.get("/conversations/discover", query: [
            "limit": "50",
            "q": query.isEmpty ? nil : query,
            "tag": tag.isEmpty ? nil : tag,
            "language": language.isEmpty ? nil : language,
        ])
    }
}

/// One public group, drawn as a cover.
///
/// The band at the top wears the group's own flair gradient — the identity its
/// owner chose in settings — falling back to the deterministic id-colour every
/// avatar already uses, so no two groups without flair look the same either.
private struct PlaceCard: View {
    @Environment(\.neu) private var colors

    let entry: DiscoverEntry
    let onPreview: () -> Void

    var body: some View {
        NeuSurface(radius: Neu.cornerMedium, contentPadding: 0, onTap: onPreview) {
            VStack(spacing: 0) {
                band
                HStack(alignment: .top, spacing: 0) {
                    // The squircle sits in a sliver of surface so it reads as
                    // resting *on* the band, the profile page's banner trick.
                    //
                    // It only reads that way if it actually overlaps one. Bottom
                    // alignment parked it entirely under the band, leaving a hard
                    // seam across the card and a slab of flat colour above it;
                    // the negative inset lifts it onto the band and gives the
                    // borrowed height back, so the card does not grow to suit.
                    ZStack {
                        PlaceShape()
                            .fill(colors.surface)
                            .frame(width: 58, height: 58)
                        Avatar(url: entry.avatarUrl, name: entry.title, id: entry.id, size: 52, shape: .place)
                    }
                    .padding(.top, -26)

                    VStack(alignment: .leading, spacing: 0) {
                        HStack(spacing: 5) {
                            Text(entry.title ?? "Group")
                                .font(YappyFont.titleMedium)
                                .foregroundStyle(colors.textPrimary)
                                .lineLimit(1)
                            BadgeMark(badge: entry.badge, size: 15)
                        }
                        Text(subtitle)
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(entry.hereCount > 0 ? colors.success : colors.textTertiary)
                        if !entry.tags.isEmpty {
                            Text(entry.tags.joined(separator: " · ")).font(.caption).foregroundStyle(colors.accent)
                        }
                        if let reason = entry.recommendation {
                            Text(reason).font(.caption).foregroundStyle(colors.textSecondary)
                        }
                        if let description = entry.description, !description.isEmpty {
                            Text(description)
                                .font(YappyFont.bodyMedium)
                                .foregroundStyle(colors.textSecondary)
                                .lineLimit(2)
                                .padding(.top, 3)
                        }
                    }
                    .padding(.leading, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)

                    Image(systemName: "chevron.right")
                        .font(.body.weight(.semibold)).foregroundStyle(colors.accent)
                        .frame(minWidth: 32, minHeight: 32).padding(.leading, 8)
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .padding(.bottom, 14)
            }
            // The band's flair does not stop at the band: the same gradient
            // runs under the whole card as a wash, so the cover reads as
            // light spilling into the room rather than a sticker on top.
            .background(
                LinearGradient(colors: stops, startPoint: .topLeading, endPoint: .bottomTrailing)
                    .opacity(0.10)
            )
            .clipShape(NeuShape(radius: Neu.cornerMedium))
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Preview this group before joining")
    }

    /// The cover band. Short on purpose: it is a banner, not a poster, and
    /// four of these should fit a screen.
    private var band: some View {
        ZStack {
            LinearGradient(colors: stops, startPoint: .topLeading, endPoint: .bottomTrailing)

            if let emoji = entry.appearance?.emoji {
                // A watermark, not a badge: oversized, faded, and pushed past
                // the corner so the band's clip crops it mid-glyph.
                Text(emoji)
                    .font(.system(size: 54))
                    .opacity(0.25)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .offset(x: 10, y: 10)
            }

            if entry.live {
                HStack(spacing: 5) {
                    Circle()
                        .fill(Color(hex: 0xFF5252))
                        .frame(width: 6, height: 6)
                    Text("LIVE")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(.black.opacity(0.65), in: Capsule())
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(10)
            }
        }
        .frame(height: 54)
        .clipShape(NeuCorners(topLeading: Neu.cornerMedium, topTrailing: Neu.cornerMedium))
    }

    /// Explicit gradient only — an accent is not a gradient, and faking one
    /// would make every flaired group look the same. No flair falls back to the
    /// id-colour, faded across the band.
    private var stops: [Color] {
        if let declared = entry.appearance?.gradient {
            let parsed = declared.compactMap { Color(hexString: $0) }
            if parsed.count >= 2 { return parsed }
        }
        let base = colorForId(entry.id)
        return [base.opacity(0.85), base.opacity(0.3)]
    }

    private var subtitle: String {
        var text = ""
        if entry.hereCount > 0 { text += "\(entry.hereCount) here now · " }
        text += "\(entry.memberCount) \(entry.memberCount == 1 ? "member" : "members")"
        if let handle = entry.handle { text += " · @\(handle)" }
        return text
    }
}
