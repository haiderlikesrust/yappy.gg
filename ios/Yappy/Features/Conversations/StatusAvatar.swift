import SwiftUI

struct MyStatusAvatar: View {
    @Environment(\.neu) private var colors
    @Environment(\.scenePhase) private var phase
    @EnvironmentObject private var container: AppContainer
    @ScaledMetric(relativeTo: .caption) private var bubbleHeight: CGFloat = 78
    @State private var editing = false

    var body: some View {
        Button { editing = true } label: {
            VStack(spacing: 4) {
                StatusBubble(text: StatusText.visible(container.me?.presence.customStatus) ?? "＋ Set status",
                             placeholder: StatusText.visible(container.me?.presence.customStatus) == nil)
                    .frame(height: bubbleHeight, alignment: .bottom)
                Avatar(url: container.me?.avatarUrl, name: container.me?.displayName,
                       id: container.me?.id ?? "me", size: 54)
                Text("You").font(YappyFont.labelSmall).foregroundStyle(colors.textSecondary)
            }
            .frame(width: 104)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Your status: \(StatusText.visible(container.me?.presence.customStatus) ?? "not set"). Edit status.")
        .disabled(container.me == nil)
        .sheet(isPresented: $editing) {
            StatusEditorSheet().presentationDetents([.medium, .large])
        }
        .task {
            // The profile endpoint removes expired statuses. Only this visible
            // strip refreshes them; no background polling or status disk cache.
            while !Task.isCancelled {
                if phase == .active { await container.loadMe() }
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }
    }
}

struct FriendStatusAvatar: View {
    @Environment(\.neu) private var colors
    @Environment(\.scenePhase) private var phase
    @EnvironmentObject private var container: AppContainer
    @ScaledMetric(relativeTo: .caption) private var bubbleHeight: CGFloat = 78
    @State private var status: String?
    @State private var revision = 0
    let entry: OnlineEntry
    let onOpenChat: () -> Void
    let onOpenProfile: () -> Void

    var body: some View {
        VStack(spacing: 4) {
            Group {
                if let status {
                    Button(action: onOpenProfile) { StatusBubble(text: status) }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(entry.user.label): \(status). Open profile.")
                } else { Color.clear.accessibilityHidden(true) }
            }
            .frame(height: bubbleHeight, alignment: .bottom)
            Button(action: onOpenChat) {
                VStack(spacing: 4) {
                    Avatar(url: entry.user.avatarUrl, name: entry.user.label, id: entry.user.id,
                           size: 54, presence: entry.status)
                    Text(entry.user.displayName?.split(separator: " ").first.map(String.init) ?? entry.user.label)
                        .font(YappyFont.labelSmall).foregroundStyle(colors.textSecondary).lineLimit(1)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Message \(entry.user.label)")
        }
        .frame(width: 104)
        .task(id: entry.id) {
            while !Task.isCancelled {
                if phase == .active { await load() }
                do { try await Task.sleep(for: .seconds(60)) } catch { return }
            }
        }
        .onReceive(container.gateway.events) { event in
            guard ["presence.update", "user.update", "block.update"].contains(event.type),
                  (event.data["userId"]?.stringValue ?? event.data["id"]?.stringValue) == entry.id else { return }
            // Never trust a raw broadcast to bypass profile privacy/expiry.
            status = nil
            Task { await load() }
        }
    }

    private func load() async {
        revision += 1
        let request = revision
        let generation = container.session.generation
        let user = try? await container.repo.user(entry.id).user
        guard !Task.isCancelled, generation == container.session.generation, request == revision else { return }
        status = StatusText.visible(user?.presence.customStatus)
    }
}
