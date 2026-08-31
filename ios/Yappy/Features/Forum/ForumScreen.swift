import SwiftUI

/**
 * A forum channel: the top level is a list of posts, not a timeline.
 *
 * The machinery underneath is the app's existing threads — a post is a root
 * message with a title, and opening one opens its thread. So this screen is a
 * list and a composer; ThreadScreen does the actual conversation.
 */
struct ForumScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let conversationId: String
    let title: String?
    let mayPost: Bool
    let onBack: () -> Void
    let onOpenPost: (String) -> Void

    @State private var posts: [ForumPost] = []
    @State private var cursor: String?
    @State private var loaded = false
    /// Distinct from "loaded and there is nothing here". See the render below.
    @State private var loadFailed = false
    @State private var composing = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                NeuIconButton(systemName: "chevron.left", label: "Back", action: onBack)
                Text(title ?? "forum")
                    .font(YappyFont.headlineSmall)
                    .foregroundStyle(colors.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if mayPost {
                    Button {
                        composing = true
                    } label: {
                        Label("New post", systemImage: "plus")
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(colors.accent)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            Divider().overlay(colors.hairline)

            /**
             * Three empty-ish states, not one.
             *
             * This used to be `loaded && posts.isEmpty` for the empty case and
             * the list for everything else, which got both ends wrong. Before
             * the first response it rendered an *empty ScrollView* — a blank
             * white screen where every other screen in the app shows a spinner
             * — and after a failed one it said "Nothing here yet. Start the
             * first post." on a forum that may well be full, because `loaded`
             * is set in the `catch` too.
             *
             * ConversationsScreen already states the rule this breaks: an empty
             * list is only true if a fetch said so, and a dead network gets an
             * honest error rather than an empty account.
             */
            if !loaded {
                ScrollView {
                    SkeletonRows(count: 7, avatarSize: 34).padding(.top, 4)
                }
                .scrollDisabled(true)
            } else if posts.isEmpty, loadFailed {
                VStack(spacing: 10) {
                    Spacer()
                    Text("Couldn't load this forum")
                        .font(YappyFont.titleMedium)
                        .foregroundStyle(colors.textSecondary)
                    Text("Retry")
                        .font(YappyFont.titleSmallBold)
                        .foregroundStyle(colors.accent)
                        .padding(.horizontal, 26)
                        .padding(.vertical, 12)
                        .neu(Capsule(), colors, state: .raised, elevation: 6)
                        .softTap { Task { await load() } }
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            } else if posts.isEmpty {
                VStack {
                    Spacer()
                    Text(mayPost ? "Nothing here yet. Start the first post." : "Nothing here yet.")
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.textTertiary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                    Spacer()
                }
            } else {
                ScrollView {
                    // Cards rather than a hairline-divided sheet: the gaps do
                    // the separating the Dividers used to, and each post gets
                    // a surface of its own instead of a slice of the screen.
                    LazyVStack(spacing: 8) {
                        ForEach(posts) { post in
                            Button { onOpenPost(post.id) } label: { row(post) }
                                .buttonStyle(.plain)
                        }
                        if cursor != nil {
                            // Same flat treatment as the cards above it, so
                            // pagination reads as one more row of the list
                            // rather than a control floating under it.
                            Button { Task { await load(after: cursor) } } label: {
                                Text("Older posts")
                                    .font(YappyFont.labelMedium)
                                    .foregroundStyle(colors.textSecondary)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 12)
                                    .background(colors.incoming, in: Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                }
                .refreshable {
                    await load()
                    Haptics.success()
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .neuBackdrop(colors)
        .navigationBarBackButtonHidden(true)
        // Reply counts and ordering both move while a post is open, so the
        // list is refetched on every appearance rather than cached.
        .task(id: conversationId) { await load() }
        .sheet(isPresented: $composing) {
            NewPostSheet(conversationId: conversationId) {
                composing = false
                Task { await load() }
            }
        }
    }

    private func row(_ post: ForumPost) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Avatar(
                url: post.author?.avatarUrl,
                name: post.author?.displayName ?? post.author?.username,
                id: post.author?.id ?? post.id,
                size: 34
            )
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    if post.pinned {
                        Image(systemName: "pin.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(colors.accent)
                    }
                    Text(post.title ?? "Untitled")
                        .font(YappyFont.titleSmall)
                        .foregroundStyle(colors.textPrimary)
                        .lineLimit(1)
                }
                if !post.excerpt.isEmpty {
                    Text(post.excerpt)
                        .font(YappyFont.bodySmall)
                        .foregroundStyle(colors.textSecondary)
                        .lineLimit(1)
                }
                Text(meta(post))
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
            }
            Spacer(minLength: 0)
            // The reply count as a mark, not a clause: a number in a capsule
            // is countable at a glance where "14 replies" buried mid-sentence
            // is not. A post with nothing to count shows nothing at all.
            if post.replyCount > 0 {
                HStack(spacing: 4) {
                    Image(systemName: "bubble.left")
                        .font(.system(size: 10, weight: .semibold))
                    Text("\(post.replyCount)")
                        .font(YappyFont.labelSmall)
                }
                .foregroundStyle(colors.accent)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(colors.accentSoft, in: Capsule())
            }
        }
        .padding(14)
        .contentShape(NeuShape(radius: Neu.cornerSmall))
        // Flat like a bubble, because a post row is content, not chrome — the
        // one exception the palette carves out of the shadow grammar. Pinned
        // gets a whisper of accentSoft folded into the fill itself: colour as
        // light under the card, so a pin reads before the glyph is found.
        .neu(
            NeuShape(radius: Neu.cornerSmall), colors, state: .flat,
            fill: post.pinned
                ? colors.incoming.mix(with: colors.accentSoft, by: 0.12)
                : colors.incoming
        )
    }

    /// Just "who · age" — the reply count lives in the badge now, and a meta
    /// line that repeats it would be the row saying everything twice.
    private func meta(_ post: ForumPost) -> String {
        let who = post.author?.displayName ?? post.author?.username ?? "someone"
        let when = age(post.lastActivityAt)
        return when.isEmpty ? who : "\(who) · \(when)"
    }

    private func load(after: String? = nil) async {
        do {
            let page = try await container.repo.forumPosts(conversationId, cursor: after)
            posts = after == nil ? page.posts : posts + page.posts
            cursor = page.nextCursor
            loadFailed = false
        } catch {
            // A failed refresh leaves what is already on screen alone — and
            // only claims failure when there is nothing else to show, so a
            // dropped refresh over a list that is already up is invisible.
            loadFailed = posts.isEmpty
        }
        loaded = true
    }
}

private struct NewPostSheet: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss

    let conversationId: String
    let onPosted: () -> Void

    @State private var title = ""
    @State private var body_ = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                TextField("What is this about?", text: $title)
                    .textFieldStyle(.roundedBorder)
                TextEditor(text: $body_)
                    .frame(minHeight: 120)
                    .overlay(alignment: .topLeading) {
                        if body_.isEmpty {
                            Text("Say more…")
                                .foregroundStyle(colors.textTertiary)
                                .padding(.top, 8)
                                .padding(.leading, 5)
                                .allowsHitTesting(false)
                        }
                    }
                Text("The title is how people will find this later — it is the whole row in the list.")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
                if let error {
                    Text(error).font(YappyFont.labelSmall).foregroundStyle(colors.danger)
                }
                Spacer()
            }
            .padding(16)
            .neuBackdrop(colors)
            .navigationTitle("New post")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Posting…" : "Post") { Task { await post() } }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
            }
        }
    }

    private func post() async {
        busy = true
        error = nil
        do {
            let trimmed = body_.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try await container.repo.createForumPost(
                conversationId,
                title: title.trimmingCharacters(in: .whitespaces),
                body: trimmed.isEmpty ? nil : trimmed
            )
            onPosted()
            dismiss()
        } catch {
            self.error = "Could not post."
            busy = false
        }
    }
}

/// "3m", "5h", "2d" — a forum row wants an age, not a clock reading.
private func age(_ iso: String?) -> String {
    guard let then = YappyTime.parse(iso) else { return "" }
    let secs = max(0, Date().timeIntervalSince(then))
    switch secs {
    case ..<60: return "just now"
    case ..<3600: return "\(Int(secs / 60))m"
    case ..<86_400: return "\(Int(secs / 3600))h"
    default: return "\(Int(secs / 86_400))d"
    }
}
