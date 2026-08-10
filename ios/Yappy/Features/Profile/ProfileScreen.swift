import Combine
import SwiftUI

struct ProfileScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let userId: String
    let onBack: () -> Void
    let onOpenChat: (String) -> Void

    @State private var user: FullUser?
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
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)

                if let user {
                    identity(user)
                    actions.padding(.top, 8)
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
            // The banner is theirs to fill; the avatar sits half over its
            // bottom edge, ringed in the surface colour so it reads against
            // whatever picture is behind it. No banner, no ring — a floating
            // outline around a plain avatar would just be noise.
            if let banner = user.bannerUrl {
                RemoteImage(url: banner) {
                    Rectangle().fill(colors.accentSoft)
                }
                .frame(height: 148)
                .frame(maxWidth: .infinity)
                .clipShape(RoundedRectangle(cornerRadius: Neu.cornerMedium, style: .continuous))

                Avatar(url: user.avatarUrl, name: user.displayName, id: user.id, size: 112)
                    .overlay(Circle().stroke(colors.surface, lineWidth: 5))
                    .padding(.top, -52)
                    .padding(.bottom, 16)
            } else {
                Avatar(url: user.avatarUrl, name: user.displayName, id: user.id, size: 112)
                    .padding(.bottom, 16)
            }

            HStack(spacing: 8) {
                Text(user.displayName ?? "Someone")
                    .font(YappyFont.headlineMedium)
                    .headlineTracking()
                    .foregroundStyle(colors.textPrimary)
                BadgeMark(badge: user.badge, size: 20)
            }

            if let username = user.username {
                Text("@\(username)")
                    .font(YappyFont.bodyLarge)
                    .foregroundStyle(colors.textTertiary)
            }

            // The profile is the one place with room to say what a mark means,
            // so it does — in words, not a second glyph.
            if let description = badgeDescription(user.badge) {
                HStack(spacing: 7) {
                    BadgeMark(badge: user.badge, size: 14)
                    Text(description)
                        .font(YappyFont.labelMedium)
                        .foregroundStyle(colors.accent)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(colors.accentSoft, in: Capsule())
                .padding(.top, 10)
            }

            if let affiliation = user.affiliation {
                HStack(spacing: 8) {
                    AffiliateMark(affiliation: affiliation, size: 18)
                    Text("Affiliated with \(affiliation.title ?? "a group")")
                        .font(YappyFont.labelMedium)
                        .foregroundStyle(colors.textSecondary)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(colors.accentSoft.opacity(0.6), in: Capsule())
                .padding(.top, 10)
            }

            HStack(spacing: 6) {
                PresenceDot(status: user.presence.status, size: 10)
                Text(presenceLabel(user))
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(colors.textTertiary)
            }
            .padding(.top, 8)

            // Above the bio, because a status is what someone is doing *now* and
            // a bio is who they are. The server withholds it along with the rest
            // of the presence block when privacy forbids it, so nil here means
            // "not for you" or "not set" — either way nothing shows.
            if let status = user.presence.customStatus, !status.isEmpty {
                Text(status)
                    .font(YappyFont.labelLarge)
                    .foregroundStyle(colors.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(colors.dark.opacity(0.08), in: Capsule())
                    .padding(.top, 10)
            }

            if let bio = user.bio, !bio.isEmpty {
                Text(bio)
                    .font(YappyFont.bodyLarge)
                    .foregroundStyle(colors.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.top, 14)
            }

            HStack(spacing: 14) {
                NeuIconButton(
                    systemName: "bubble.left.fill",
                    label: "Message",
                    size: 56,
                    iconSize: 22,
                    accent: true,
                    enabled: !busy
                ) {
                    busy = true
                    Task {
                        if let id = try? await container.repo.createDm(userId: user.id).conversation.id {
                            onOpenChat(id)
                        }
                        busy = false
                    }
                }
                NeuIconButton(systemName: "phone.fill", label: "Call", size: 56, iconSize: 22) {}
            }
            .padding(.top, 24)

            // Bots have no social graph — following one would do nothing, and
            // offering it invites the question of why it did nothing.
            if !user.isBot, let relationship {
                followControl(relationship).padding(.top, 20)
            }
        }
        .padding(24)
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
    @ViewBuilder
    private func followControl(_ rel: Relationship) -> some View {
        VStack(spacing: 10) {
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

            Text(followCaption(rel))
                .font(YappyFont.labelMedium)
                .foregroundStyle(rel.isMutual ? colors.accent : colors.textTertiary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
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

    private var actions: some View {
        NeuSurface(radius: Neu.cornerMedium, contentPadding: 6) {
            VStack(spacing: 0) {
                actionRow(
                    blocked ? "hand.raised.slash" : "hand.raised",
                    blocked ? "Unblock" : "Block",
                    danger: !blocked
                ) {
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
                }

                actionRow("flag", reported ? "Reported" : "Report", danger: !reported) {
                    guard !reported else { return }
                    reported = true
                    Task {
                        try? await container.repo.report(
                            targetType: "user", targetId: userId, reason: "spam", detail: nil
                        )
                    }
                }
            }
        }
        .padding(.horizontal, 16)
    }

    private func actionRow(
        _ symbol: String,
        _ label: String,
        danger: Bool,
        action: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 17))
                .foregroundStyle(danger ? colors.danger : colors.textSecondary)
                .frame(width: 22)
            Text(label)
                .font(YappyFont.bodyLarge)
                .foregroundStyle(danger ? colors.danger : colors.textPrimary)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 10)
        .contentShape(Rectangle())
        .softTap(action: action)
    }
}
