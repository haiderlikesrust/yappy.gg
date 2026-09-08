import SwiftUI

struct PlaceActivityCard: View {
    @Environment(\.neu) private var colors
    @Environment(\.scenePhase) private var phase
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model = PlaceActivityModel()
    @State private var refresh: Task<Void, Never>?
    let conversationId: String
    let isSpace: Bool
    var people: [PublicUser] = []
    let onOpenConversation: (String) -> Void
    let onJoinVoice: (String, String) -> Void

    var body: some View {
        NeuSurface(radius: Neu.cornerMedium, contentPadding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Happening now").font(YappyFont.titleSmallBold)
                    Spacer()
                    Button { Task { await load() } } label: {
                        Image(systemName: "arrow.clockwise").frame(width: 36, height: 36)
                    }
                    .accessibilityLabel("Refresh activity")
                    .disabled(model.loading)
                }
                if let activity = model.activity {
                    ForEach(activity.inVoice) { room in
                        activityRow(room, voice: true)
                    }
                    ForEach(activity.reading) { room in
                        activityRow(room, voice: false)
                    }
                    if activity.reading.isEmpty && activity.inVoice.isEmpty {
                        Text("Quiet right now. There’s room for a conversation.")
                            .font(YappyFont.bodyMedium).foregroundStyle(colors.textSecondary)
                    }
                } else if model.loading {
                    ProgressView("Checking the place…")
                }
                if let error = model.error {
                    Text(error).font(YappyFont.labelSmall).foregroundStyle(colors.textSecondary)
                }
                if let checked = model.checkedAt {
                    TimelineView(.periodic(from: checked, by: 60)) { context in
                        if context.date.timeIntervalSince(checked) >= 60 {
                            Text("Updated \(checked, style: .relative) ago")
                                .font(YappyFont.labelSmall).foregroundStyle(colors.textTertiary)
                        }
                    }
                }
            }
        }
        .task(id: conversationId) {
            container.gateway.subscribe(conversationId)
            await load()
        }
        .onReceive(container.gateway.events) { event in
            guard model.affects(event, placeId: conversationId) else { return }
            // Coalesce bursts without delaying forever in an active space.
            guard refresh == nil else { return }
            refresh = Task {
                try? await Task.sleep(for: .milliseconds(400))
                if !Task.isCancelled { await load() }
                refresh = nil
            }
        }
        .onChange(of: phase) { _, next in
            if next == .active { Task { await load() } }
        }
        .onDisappear { refresh?.cancel(); refresh = nil }
    }

    private func load() async {
        guard let userId = container.session.userId else { return }
        await model.load(repo: container.repo, id: conversationId, isSpace: isSpace, userId: userId)
    }

    private func activityRow(_ room: PlaceActivityRoom, voice: Bool) -> some View {
        Button {
            if voice { onJoinVoice(room.conversationId, room.title) }
            else { onOpenConversation(room.conversationId) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: voice ? "waveform" : "text.bubble")
                    .foregroundStyle(colors.accent).frame(width: 24)
                VStack(alignment: .leading, spacing: 3) {
                    Text(voice ? "\(room.userIds.count) in \(room.title.isEmpty ? "voice" : room.title)"
                         : "\(names(room.userIds)) reading\(isSpace ? " in \(room.title.isEmpty ? "this place" : room.title)" : " here")")
                        .font(YappyFont.bodyMedium).foregroundStyle(colors.textPrimary)
                        .multilineTextAlignment(.leading)
                    if voice {
                        Text(names(room.userIds)).font(YappyFont.labelSmall).foregroundStyle(colors.textSecondary)
                    }
                }
                Spacer(minLength: 0)
                Text(voice ? "Join" : "Open").font(YappyFont.labelMedium).foregroundStyle(colors.accent)
            }
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }

    private func names(_ ids: [String]) -> String {
        let known = ids.compactMap { id in people.first { $0.id == id }?.label }
        guard !known.isEmpty else { return ids.count == 1 ? "1 person" : "\(ids.count) people" }
        let first = Array(known.prefix(2))
        let rest = ids.count - first.count
        return first.joined(separator: ", ") + (rest > 0 ? " + \(rest)" : "")
    }
}
