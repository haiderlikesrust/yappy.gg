import SwiftUI

/// Jump between channels without leaving the conversation.
///
/// Before this, moving from #general to #random meant: back out of the chat,
/// land on the space screen, tap the next channel — two gestures and a refetch
/// to do the thing people do most often inside a space.
///
/// The gesture is a **leftward** drag. Rightward is already swipe-to-reply on
/// every row, and the left screen edge is where iOS puts interactive back, so
/// the only free direction is this one. It opens from the trailing edge to
/// match: the panel arrives from where the finger is going.
@MainActor
final class ChannelSwitcherModel: ObservableObject {
    @Published var channels: [ChannelEntry] = []
    @Published var open = false

    private var loadedFor: String?

    /// Cheap and idempotent — the chat calls it on appear, and again whenever
    /// the space changes underneath.
    func load(_ container: AppContainer, spaceId: String) async {
        guard loadedFor != spaceId else { return }
        loadedFor = spaceId

        if let cached = DiskCache.decode(ChannelsEnvelope.self, key: "channels_\(spaceId)") {
            channels = cached.channels
        }
        if let fresh = try? await container.repo.channels(spaceId).channels {
            channels = fresh
        }
    }
}

struct ChannelSwitcherPanel: View {
    @Environment(\.neu) private var colors

    let channels: [ChannelEntry]
    let currentId: String
    let spaceTitle: String?
    let accent: Color?
    let onPick: (String) -> Void
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            // Tapping the dimmed remainder closes it, which is the gesture
            // people try first on any drawer.
            Color.black.opacity(0.18)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture(perform: onClose)

            panel
                .frame(width: 264)
                .transition(.move(edge: .trailing))
        }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(spaceTitle ?? "Channels")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textPrimary)
                    .lineLimit(1)
                Spacer(minLength: 0)
                NeuIconButton(
                    systemName: "xmark",
                    label: "Close",
                    size: 32,
                    iconSize: 13,
                    action: onClose
                )
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 10)

            ScrollView {
                VStack(spacing: 6) {
                    ForEach(channels) { channel in
                        row(channel)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 20)
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(colors.surface)
        .ignoresSafeArea(edges: .bottom)
    }

    private func row(_ channel: ChannelEntry) -> some View {
        let isCurrent = channel.id == currentId
        let tint = accent ?? colors.accent

        return HStack(spacing: 9) {
            Image(systemName: channel.isAnnouncement ? "megaphone" : "number")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(isCurrent ? tint : colors.textTertiary)
                .frame(width: 18)

            Text(channel.title ?? "channel")
                .font(isCurrent ? YappyFont.titleSmallBold : YappyFont.bodyLarge)
                .foregroundStyle(isCurrent ? colors.textPrimary : colors.textSecondary)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)

            if channel.isMuted {
                Image(systemName: "bell.slash")
                    .font(.system(size: 11))
                    .foregroundStyle(colors.textTertiary)
            } else if channel.mentionCount > 0 {
                Text("@\(channel.mentionCount)")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.onAccent)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(colors.danger, in: Capsule())
            } else if channel.unreadCount > 0 {
                Text("\(min(channel.unreadCount, 99))")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textSecondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(colors.incoming, in: Capsule())
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 10)
        .background(isCurrent ? tint.opacity(0.14) : Color.clear, in: NeuShape(radius: Neu.cornerSmall))
        .contentShape(Rectangle())
        .softTap { if !isCurrent { onPick(channel.id) } }
    }
}
