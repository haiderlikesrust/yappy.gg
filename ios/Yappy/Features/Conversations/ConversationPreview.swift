import SwiftUI

/// This view deliberately does not create a ChatModel: a peek must never
/// acknowledge messages, announce presence, or consume an encrypted envelope.
struct ConversationPreview: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.neu) private var colors
    let conversation: Conversation
    @State private var messages: [Message]?
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Avatar(url: conversation.displayAvatar, name: conversation.displayName,
                       id: conversation.avatarSeed, size: 46)
                VStack(alignment: .leading, spacing: 3) {
                    Text(conversation.displayName).font(.headline).lineLimit(2)
                    Label("Preview · stays unread", systemImage: "eye")
                        .font(.caption).foregroundStyle(colors.textSecondary)
                }
            }
            Divider()
            if conversation.isSpace {
                Text(conversation.description ?? "Open this place to browse its channels.")
                    .font(.body).foregroundStyle(colors.textSecondary).lineLimit(5)
                Label("\(conversation.memberCount) members", systemImage: "person.2")
                    .font(.caption).foregroundStyle(colors.textSecondary)
            } else if let messages {
                if messages.isEmpty {
                    Text("No messages yet").foregroundStyle(colors.textSecondary)
                }
                ForEach(messages) { message in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(message.sender?.label ?? "Message").font(.caption.weight(.semibold))
                            Spacer()
                            Text(YappyTime.relative(message.createdAt)).font(.caption2)
                        }
                        .foregroundStyle(colors.textSecondary)
                        Text(preview(message)).font(.subheadline).lineLimit(3)
                    }
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(colors.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 14))
                }
            } else if failed {
                Text("Couldn't load the preview. Open the chat to try again.")
                    .foregroundStyle(colors.textSecondary)
            } else {
                ProgressView().frame(maxWidth: .infinity).padding()
            }
        }
        .foregroundStyle(colors.textPrimary)
        .padding(20).frame(width: 320).background(colors.surface)
        .task(id: conversation.id) {
            guard !conversation.isSpace else { return }
            do {
                // Bypass history()'s latest-page disk cache. A four-message peek
                // must not overwrite the full page used when opening the chat.
                let result: HistoryEnvelope = try await container.repo.api.get(
                    "/conversations/\(conversation.id)/messages", query: ["limit": "4"]
                )
                guard !Task.isCancelled else { return }
                messages = result.messages.sorted { $0.seq < $1.seq }
            } catch {
                if !Task.isCancelled { failed = true }
            }
        }
    }

    private func preview(_ message: Message) -> String {
        if message.isDeleted { return "Message deleted" }
        if message.isEncrypted { return "Encrypted message" }
        if let content = message.content, !content.isEmpty { return content }
        if !message.attachments.isEmpty { return "Photo or attachment" }
        if message.stickerId != nil { return "Sticker" }
        if message.gif != nil { return "GIF" }
        if message.poll != nil { return "Poll" }
        if message.location != nil { return "Shared location" }
        return "Open chat to view this message"
    }
}
