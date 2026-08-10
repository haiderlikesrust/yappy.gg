import Combine
import SwiftUI

/// A thread: one root message and its replies, oldest first.
///
/// Threads keep a side conversation from flooding the main timeline — the
/// backend already maintained the counts and the reply index; this screen is the
/// missing half.
struct ThreadScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let conversationId: String
    let rootId: String
    let onBack: () -> Void

    @State private var root: Message?
    @State private var replies: [Message] = []
    @State private var loadFailed = false
    @State private var draft = ""
    @State private var meId: String?
    @State private var listener: AnyCancellable?

    var body: some View {
        VStack(spacing: 0) {
            header

            if root == nil, loadFailed {
                VStack(spacing: 10) {
                    Text("Couldn't load this thread")
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
            } else if root == nil {
                NeuSpinner().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if let root {
                            MessageBubble(message: root, isMine: root.senderId == meId)
                                .padding(.bottom, 6)
                        }
                        ForEach(replies) { reply in
                            MessageBubble(
                                message: reply,
                                isMine: reply.senderId == meId,
                                showAvatar: reply.senderId != meId
                            )
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                }
                // Deliberately not anchored to the bottom. A thread is read
                // from its root down, which is where Android starts it, and a
                // bottom anchor is the same trap as in the main timeline: it
                // fixes where content *starts* and does not survive the
                // keyboard shrinking the viewport underneath it, leaving the
                // lazy stack scrolled past its own content and drawing blank.
                .scrollDismissesKeyboard(.interactively)
            }

            composer
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .task { await load() }
        .onAppear { observe() }
        .onDisappear { listener?.cancel() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            NeuIconButton(systemName: "chevron.left", label: "Back", size: 42, iconSize: 18, action: onBack)
            VStack(alignment: .leading, spacing: 0) {
                Text("Thread")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textPrimary)
                Text("\(replies.count) \(replies.count == 1 ? "reply" : "replies")")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 8) {
            NeuTextField(
                text: $draft,
                placeholder: "Reply in thread",
                radius: Neu.cornerLarge,
                multiline: true,
                lineLimit: 4
            )
            NeuIconButton(
                systemName: "arrow.up",
                label: "Send reply",
                size: 44,
                iconSize: 20,
                accent: canSend,
                enabled: canSend,
                action: send
            )
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func load() async {
        meId = container.session.userId
        loadFailed = false
        if let fetched = try? await container.repo.message(conversationId, messageId: rootId).message {
            root = fetched
        } else if root == nil {
            loadFailed = true
        }
        replies = (try? await container.repo.thread(conversationId, rootId: rootId).messages) ?? replies
    }

    /// Live replies ride the same conversation subscription as the main chat.
    private func observe() {
        listener = container.gateway.events.sink { event in
            guard event.type == "message.create",
                  event.data["threadRootId"]?.stringValue == rootId,
                  let data = try? JSONEncoder().encode(event.data),
                  let incoming = try? JSONDecoder().decode(Message.self, from: data),
                  !replies.contains(where: { $0.id == incoming.id })
            else { return }
            replies.append(incoming)
        }
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""

        Task {
            guard let sent = try? await container.repo.sendText(
                conversationId, text: text, threadRootId: rootId
            ) else { return }
            if !replies.contains(where: { $0.id == sent.message.id }) {
                replies.append(sent.message)
            }
        }
    }
}
