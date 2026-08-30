import Combine
import SwiftUI

struct ProfileScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let userId: String
    let onBack: () -> Void
    let onOpenChat: (String) -> Void
    /// The conversation this was opened from, if any.
    ///
    /// With one, the card also shows their roles there. Without one — from
    /// Settings, a search result, a follower list — it stays the profile it
    /// has always been.
    var inConversation: String?

    @State private var user: FullUser?
    /// Their roles in the group this was opened from.
    ///
    /// Failing silently is right: not being a member is an ordinary answer —
    /// they may have left since, or this may be a DM, which has no roles to
    /// speak of. The section simply does not appear.
    @State private var groupRoles: [RoleEntry] = []
    @State private var loadFailed = false
    @State private var busy = false
    @State private var blocked = false
    @State private var reported = false

    /// Held separately from `user` so a press can move it immediately and put
    /// it back if the request fails, without rebuilding the whole profile.
    @State private var relationship: Relationship?
    @State private var followBusy = false
    @State private var listener: AnyCancellable?

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                HStack {
                    NeuIconButton(systemName: "chevron.left", label: "Back", size: 42, iconSize: 18, action: onBack)
                    Spacer(minLength: 0)
                    if let user { overflowMenu(user) }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)

                if let user {
                    identity(user)
                } else if loadFailed {
                    // A spinner that never resolves reads as a hang; say what
                    // happened and offer the way back.
                    VStack(spacing: 10) {
                        Text("Couldn't load this profile")
                            .font(YappyFont.titleMedium)
                            .foregroundStyle(colors.textSecondary)
                        Text("Retry")
                            .font(YappyFont.titleSmallBold)
                            .foregroundStyle(colors.accent)
                            .padding(.horizontal, 26)
                            .padding(.vertical, 12)
                            .neu(Capsule(), colors, state: .raised, elevation: 6)
                            .softTap { Task { await loadUser() } }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 300)
                } else {
                    NeuSpinner().frame(height: 300)
                }
            }
            .padding(.bottom, 40)
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .task { await loadUser() }
        .onAppear(perform: observe)
        .onDisappear { listener?.cancel() }
    }

    private func loadUser() async {
        loadFailed = false
        if let fetched = try? await container.repo.user(userId).user {
            user = fetched
            relationship = fetched.relationship
        } else if user == nil {
            loadFailed = true
        }

        // A separate request, and a silent failure — see `groupRoles`.
        if let conversationId = inConversation,
           let member = try? await container.repo.member(conversationId, userId: userId).member {
            groupRoles = member.roles
        }
    }

    /// React to them following you back while you are stood on their profile.
    ///
    /// `relationship.update` is delivered to the person on the receiving end of
    /// the follow, so this fires when *they* act, never when you do — your own
    /// presses are settled by the response to the request. Without it, the
    /// button would go on saying "Following" after the pair had completed, and
    /// the caption would go on saying you cannot add them to a group when you
    /// now can.
    private func observe() {
        listener = container.gateway.events.sink { event in
            switch event.type {
            case "relationship.update":
                guard event.data["userId"]?.stringValue == userId else { return }
                // Refetched rather than patched from the payload. The event
                // carries the follow edge but not `canAddToGroups`, which also
                // depends on their privacy setting — patching would leave the
                // caption contradicting the button until something else
                // refreshed it. There is no tap latency to hide here either:
                // nobody pressed anything on this device, so a round trip
                // costs nothing that is felt.
                Task {
                    if let fresh = try? await container.repo.user(userId).user.relationship {
                        relationship = fresh
                    }
                }

            // They edited their profile while you were stood on it. The whole
            // card refetches: the event carries the public shape, this screen
            // shows the full one (bio, banner, mutuals).
            case "user.update":
                guard event.data["id"]?.stringValue == userId else { return }
                Task {
                    if let fresh = try? await container.repo.user(userId).user {
                        user = fresh
                        relationship = fresh.relationship
                    }
                }

            // A block made from another of your devices. Mirrored here so the
            // button is not offering a DM the server would refuse.
            case "block.update":
                guard event.data["userId"]?.stringValue == userId else { return }
                blocked = event.data["blocked"]?.boolValue ?? blocked

            default:
                break
            }
        }
    }

    @ViewBuilder
    private func identity(_ user: FullUser) -> some View {
        VStack(spacing: 0) {
            /**
             * Always a banner, whether or not there is a picture for it.
             *
             * It used to be drawn only when `bannerUrl` was set, and every other
             * profile — which is nearly all of them — got an avatar floating in
             * empty space with no top to the page. The header was conditional
             * on content when it should have been part of the layout.
             *
             * The fallback is the person's own deterministic colour, fading into
             * the page. It costs nothing, it is different for everybody, and a
             * profile with no banner now reads as designed rather than as one
             * that failed to load.
             */
            /**
             * The banner rides in an *overlay* of an empty, correctly-sized
             * box, so whatever the image reports can never become layout.
             *
             * `RemoteImage` fills by default, and a fill deliberately reports a
             * size larger than the proposal on one axis — for a wide banner
             * that is the width. As a ZStack *child* it was handing that width
             * upwards: measured, a 3:1 banner made this view 448pt on a 402pt
             * screen and the whole profile 496pt, so every sibling — the back
             * button, the Follow button, the block/report card — was centred in
             * a canvas wider than the phone and clipped on both edges. A clip
             * cannot fix that; clipping is paint, and this is measurement.
             *
             * As an overlay the box is sized first and the image is fitted into
             * it afterwards, which is the same trick a video poster in
             * `MessageBubble` already uses for exactly this reason.
             */
            Color.clear
                .frame(height: 148)
                .frame(maxWidth: .infinity)
                .overlay {
                    ZStack(alignment: .bottom) {
                        // Chosen flair beats the derived colour; both fade into
                        // the page the same way, so a flaired profile and a
                        // plain one share a shape.
                        let tint = colorForId(user.id)
                        let stops = flairStops(user.flair?.gradient)
                        LinearGradient(
                            colors: [
                                (stops?.0 ?? tint).opacity(0.85),
                                (stops?.1 ?? tint).opacity(0.22),
                            ],
                            startPoint: .top,
                            endPoint: .bottom
                        )

                        if let banner = user.bannerUrl {
                            RemoteImage(url: banner) { Color.clear }
                        }

                        // Into the page rather than stopping at a hard line —
                        // the soft edge is what makes a colour block read as a
                        // banner instead of a rectangle somebody forgot to fill.
                        LinearGradient(
                            colors: [.clear, colors.surface],
                            startPoint: .center,
                            endPoint: .bottom
                        )
                    }
                }
            /**
             * Rounded across the top, square across the bottom.
             *
             * The banner does not touch the top of the screen — the back button
             * sits above it — so a hard corner up there read as an unfinished
             * block in an app where nothing else has one. The bottom stays
             * square on purpose: the fade already dissolves that edge, and a
             * radius under a gradient is a radius nobody can see.
             *
             * Full width rather than an inset card. A card with margins would
             * read as *a card that happens to be at the top*; this should read
             * as the top of the page.
             */
            .clipShape(
                UnevenRoundedRectangle(
                    topLeadingRadius: Neu.cornerLarge,
                    bottomLeadingRadius: 0,
                    bottomTrailingRadius: 0,
                    topTrailingRadius: Neu.cornerLarge,
                    style: .continuous
                )
            )

            // Half over the banner's lower edge, ringed in the page colour so
            // it reads as sitting on the banner rather than cut out of it.
            Avatar(url: user.avatarUrl, name: user.displayName, id: user.id, size: 112)
                .overlay(Circle().stroke(colors.surface, lineWidth: 5))
                .padding(.top, -52)
                .padding(.bottom, 16)

            HStack(spacing: 8) {
                Text(user.displayName ?? "Someone")
                    .font(YappyFont.headlineMedium)
                    .headlineTracking()
                    .foregroundStyle(colors.textPrimary)
                BadgeMarks(badges: heldBadges(user), size: 20, max: 4)
                // A bot's own profile is exactly where "is this a person?"
                // gets asked, and it was the one place not answering.
                if user.isBot { BotTag(size: 20) }
            }

            // Pronouns ride the username line: identity facts, one glance.
            let identityLine = [
                user.username.map { "@\($0)" },
                user.pronouns.flatMap { $0.isEmpty ? nil : $0 },
            ].compactMap { $0 }
            if !identityLine.isEmpty {
                Text(identityLine.joined(separator: " · "))
                    .font(YappyFont.bodyLarge)
                    .foregroundStyle(colors.textTertiary)
            }

            /**
             * Presence sits with the name now, not below the bio.
             *
             * And it is drawn only when there is something to say. The dot and
             * the label were an unconditional pair, but `presenceLabel` returns
             * an empty string whenever privacy withholds both the status and
             * the last-seen time — which left a single coloured dot floating
             * under the handle, labelling nothing. It read as a rendering bug
             * because it was one.
             */
            let presence = presenceLabel(user)
            if !presence.isEmpty {
                HStack(spacing: 6) {
                    PresenceDot(status: user.presence.status, size: 10)
                    Text(presence)
                        .font(YappyFont.labelMedium)
                        .foregroundStyle(colors.textTertiary)
                }
                .padding(.top, 8)
            }

            actions(user)

            details(user)
        }
        .padding(24)
    }

    // ── The read-once half ───────────────────────────────────────────────────

    /**
     * Everything below the actions, in cards.
     *
     * The profile used to render this as a centred column of capsules — a badge
     * pill, an affiliation pill, a status pill, a mutual-groups pill, each on
     * its own line with its own top padding. Four different pill shapes stacked
     * vertically is not a hierarchy, it is a list pretending not to be one, and
     * it left the page both taller and emptier than it needed to be.
     *
     * Cards instead, which is the language the rest of the app already speaks —
     * Settings is built from them. Left-aligned, because these are things to
     * read rather than an identity to present, and centred prose is slower to
     * read at every line break.
     */
    @ViewBuilder
    private func details(_ user: FullUser) -> some View {
        let marks = heldBadges(user).compactMap { badge -> (String, String)? in
            badgeDescription(badge).map { (badge, $0) }
        }
        let status = user.presence.customStatus.flatMap { $0.isEmpty ? nil : $0 }
        let bio = user.bio.flatMap { $0.isEmpty ? nil : $0 }
        let joined = YappyTime.monthYear(user.createdAt)
        let mutual = user.mutualGroups.flatMap { $0.count > 0 ? $0 : nil }

        VStack(spacing: 22) {
            if status != nil || bio != nil || joined != nil {
                card("About") {
                    // Above the bio, because a status is what someone is doing
                    // *now* and a bio is who they are.
                    if let status {
                        row(icon: "quote.bubble", text: status)
                    }
                    if let bio {
                        Text(bio)
                            .font(YappyFont.bodyLarge)
                            .foregroundStyle(colors.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    // Decoded on `FullUser` since the field shipped and never
                    // once drawn. It is the cheapest signal a profile has for
                    // "is this account new", which is the question behind most
                    // of the others.
                    if let joined {
                        row(icon: "calendar", text: "Joined \(joined)")
                    }
                }
            }

            if !marks.isEmpty || user.affiliation != nil {
                // The profile is the one place with room to say what a mark
                // means, so it does — in words, not a second glyph.
                card("Marks") {
                    ForEach(marks, id: \.0) { badge, description in
                        HStack(spacing: 9) {
                            BadgeMark(badge: badge, size: 15)
                            Text(description)
                                .font(YappyFont.labelMedium)
                                .foregroundStyle(colors.textSecondary)
                            Spacer(minLength: 0)
                        }
                    }
                    if let affiliation = user.affiliation {
                        HStack(spacing: 9) {
                            AffiliateMark(affiliation: affiliation, size: 15)
                            Text("Affiliated with \(affiliation.title ?? "a group")")
                                .font(YappyFont.labelMedium)
                                .foregroundStyle(colors.textSecondary)
                            Spacer(minLength: 0)
                        }
                    }
                }
            }

            /*
             * What they are in the room you came from.
             *
             * Wrapped rather than truncated: somebody with five roles has
             * five roles, and a profile is where you go to find that out.
             */
            if !groupRoles.isEmpty {
                FlowLayout(spacing: 6) {
                    ForEach(groupRoles) { role in
                        let tint = role.color.flatMap { Color(hexString: $0) } ?? colors.textSecondary
                        HStack(spacing: 6) {
                            Circle().fill(tint).frame(width: 7, height: 7)
                            Text(role.name)
                                .font(YappyFont.labelMedium)
                                .foregroundStyle(tint)
                        }
                        .padding(.horizontal, 11)
                        .padding(.vertical, 5)
                        .background(colors.veil, in: Capsule())
                    }
                }
                .padding(.horizontal, 24)
                .padding(.top, 14)
            }

            // The rooms you share — the social proof a group-first app has
            // instead of follower counts. Every group named here is one the
            // viewer is in themselves, so nothing is disclosed that their own
            // home screen does not already show.
            if let mutual {
                card("In common") {
                    row(icon: "person.3.fill", text: mutualLabel(mutual))
                }
            }
        }
        .padding(.top, 30)
    }

    /// `content` is called here rather than handed onwards: `NeuSurface` stores
    /// its content, so passing the non-escaping parameter into it would mean
    /// escaping a closure that promised not to. Building the view first and
    /// capturing *that* is the same result with none of the lifetime question.
    private func card(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        let body = content()
        return VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: title)
            NeuSurface(radius: Neu.cornerLarge, contentPadding: 16) {
                VStack(alignment: .leading, spacing: 12) {
                    body
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private func row(icon: String, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(colors.textTertiary)
                .frame(width: 15)
            Text(text)
                .font(YappyFont.labelMedium)
                .foregroundStyle(colors.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    // ── Following ────────────────────────────────────────────────────────────

    /// The four states a follow can be in, and what each one is for.
    ///
    /// Following is not a feed subscription here — there is no feed. It is the
    /// only way to become someone's *contact*, and being contacts is what the
    /// privacy defaults require before you can add each other to a group or
    /// call. So the button says what it does and the caption says what it is
    /// worth; "Following" on its own means nothing to anyone who has not read
    /// the privacy settings.
    /**
     * Actions, directly under the identity.
     *
     * They used to come last, after every chip and the bio — so the two things
     * a visitor actually came to do sat below the fold on any profile with
     * something written on it. Metadata is what you read once; the buttons are
     * what you came for.
     *
     * One row, not two. Follow and Message were separate lines, and with
     * calling switched off that left Message as a single circular icon centred
     * on a line of its own — an orphan with no sibling to be a row with. Side
     * by side, Follow takes the space it needs and Message stays the fixed
     * satellite it always was.
     *
     * A bot has no follow, so Message becomes the full-width primary instead of
     * a lone circle. Same rule, other direction.
     */
    @ViewBuilder
    private func actions(_ user: FullUser) -> some View {
        let rel = user.isBot ? nil : relationship

        VStack(spacing: 10) {
            HStack(spacing: 12) {
                if let rel {
                    followButton(rel)
                    messageButton(user, wide: false)
                } else {
                    messageButton(user, wide: true)
                }
                // Note for whoever turns calling back on: this never had an
                // action. It looked like a button and did nothing.
                if Feature.calling {
                    NeuIconButton(systemName: "phone.fill", label: "Call", size: 56, iconSize: 22) {}
                }
            }

            if let rel {
                Text(followCaption(rel))
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(rel.isMutual ? colors.accent : colors.textTertiary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, 22)
    }

    @ViewBuilder
    private func messageButton(_ user: FullUser, wide: Bool) -> some View {
        let open = {
            busy = true
            Task {
                if let id = try? await container.repo.createDm(userId: user.id).conversation.id {
                    onOpenChat(id)
                }
                busy = false
            }
        }

        if wide {
            NeuButton(enabled: !busy, radius: Neu.cornerMedium, accent: true, action: open) {
                Image(systemName: "bubble.left.fill")
                    .font(.system(size: 16, weight: .semibold))
                Text("Message")
                    .font(YappyFont.labelLarge)
            }
            .foregroundStyle(colors.onAccent)
        } else {
            NeuIconButton(
                systemName: "bubble.left.fill",
                label: "Message",
                size: 56,
                iconSize: 22,
                enabled: !busy,
                action: open
            )
        }
    }

    @ViewBuilder
    private func followButton(_ rel: Relationship) -> some View {
        NeuButton(
            enabled: !followBusy,
            radius: Neu.cornerMedium,
            // Accent only when there is something to gain by pressing. A
            // filled button that undoes a thing reads as the thing.
            accent: !rel.following,
            action: toggleFollow
        ) {
            if followBusy {
                NeuSpinner(tint: rel.following ? colors.textPrimary : colors.onAccent)
            } else {
                Image(systemName: followSymbol(rel))
                    .font(.system(size: 16, weight: .semibold))
                Text(followLabel(rel))
                    .font(YappyFont.labelLarge)
            }
        }
        .foregroundStyle(rel.following ? colors.textPrimary : colors.onAccent)
    }

    private func followSymbol(_ rel: Relationship) -> String {
        if rel.isMutual { return "person.2.fill" }
        if rel.following { return "checkmark" }
        return "person.badge.plus"
    }

    private func followLabel(_ rel: Relationship) -> String {
        if rel.isMutual { return "Contacts" }
        if rel.following { return "Following" }
        // Naming the asymmetry is the nudge: they have already done their half.
        if rel.followedBy { return "Follow back" }
        return "Follow"
    }

    private func followCaption(_ rel: Relationship) -> String {
        // The truthful answer, from the server, rather than "mutual therefore
        // yes" — they may have opened group adds to everyone, or closed them
        // to nobody, and both make the obvious inference wrong.
        if rel.canAddToGroups {
            return rel.isMutual
                ? "You are contacts. You can add each other to groups and call each other."
                : "You can add them to groups."
        }
        if rel.following { return "They will need to follow you back before you can add them to a group." }
        if rel.followedBy { return "They follow you. Follow back to become contacts." }
        return "Follow each other to become contacts, so you can add them to groups."
    }

    /// Optimistic, with the server's answer as the settlement.
    ///
    /// The press moves the button now because the round trip is long enough to
    /// feel like a dropped tap, and `isMutual` is then taken from the response
    /// rather than assumed — following someone who already followed you
    /// completes a pair, and only the server knows whether it did.
    private func toggleFollow() {
        guard let rel = relationship, !followBusy else { return }
        let previous = rel
        followBusy = true

        var optimistic = rel
        optimistic.following.toggle()
        // False either way for now: unfollowing definitely breaks the pair, and
        // following only *might* complete one. The response says which.
        optimistic.isMutual = false
        relationship = optimistic

        Task {
            do {
                let result = previous.following
                    ? try await container.repo.unfollow(userId)
                    : try await container.repo.follow(userId)

                var settled = optimistic
                settled.following = result.following
                settled.isMutual = result.isMutual
                relationship = settled

                // One refetch for canAddToGroups, which depends on their
                // privacy setting and so cannot be derived from the follow
                // result alone. The button is already correct by this point;
                // this only settles the caption.
                if let fresh = try? await container.repo.user(userId).user.relationship {
                    relationship = fresh
                }
            } catch {
                relationship = previous
            }
            followBusy = false
        }
    }

    /// "N groups in common · title 🍿, title" — the count first, then whatever
    /// the preview can name.
    private func mutualLabel(_ mutual: MutualGroups) -> String {
        var text = mutual.count == 1 ? "1 group in common" : "\(mutual.count) groups in common"
        let names = mutual.preview.compactMap { ref -> String? in
            guard let title = ref.title else { return nil }
            return [title, ref.emoji].compactMap { $0 }.joined(separator: " ")
        }
        if !names.isEmpty {
            text += " · " + names.joined(separator: ", ")
        }
        return text
    }

    private func presenceLabel(_ user: FullUser) -> String {
        if user.presence.status == "online" { return "Online" }
        if let lastSeen = user.presence.lastSeenAt {
            return "Last seen \(YappyTime.relative(lastSeen))"
        }
        // The backend suppresses both status and last-seen together when privacy
        // forbids it, so there is nothing to show rather than a misleading
        // "Offline".
        return ""
    }

    /// Your own profile is reachable — from Settings, and from your own name in
    /// a chat — and it must not offer to block and report you.
    private var isSelf: Bool {
        container.me?.id == userId
    }

    /// Block and Report live in the top-right overflow now — a standard place,
    /// reachable without scrolling past the whole profile.
    private func overflowMenu(_ user: FullUser) -> some View {
        Menu {
            ShareLink(item: shareText(user)) {
                Label("Share profile", systemImage: "square.and.arrow.up")
            }

            if !isSelf {
                let blockRole: ButtonRole? = blocked ? nil : .destructive
                Button(role: blockRole) {
                    Task {
                        do {
                            if blocked {
                                try await container.repo.unblock(userId)
                            } else {
                                try await container.repo.block(userId)
                            }
                            blocked.toggle()
                        } catch {}
                    }
                } label: {
                    Label(
                        blocked ? "Unblock" : "Block",
                        systemImage: blocked ? "hand.raised.slash" : "hand.raised"
                    )
                }

                Button(role: .destructive) {
                    guard !reported else { return }
                    reported = true
                    Task {
                        try? await container.repo.report(
                            targetType: "user", targetId: userId, reason: "spam", detail: nil
                        )
                    }
                } label: {
                    Label(reported ? "Reported" : "Report", systemImage: "flag")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(colors.textSecondary)
                .frame(width: 42, height: 42)
                .neu(Circle(), colors, state: .raised, elevation: 6)
                .contentShape(Circle())
        }
        .accessibilityLabel("More")
    }

    private func shareText(_ user: FullUser) -> String {
        var text = ""
        if let username = user.username { text += "@\(username) " }
        text += "on yappy — yappy://user/\(user.id)"
        return text
    }
}
