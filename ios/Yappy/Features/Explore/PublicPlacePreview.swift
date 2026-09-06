import SwiftUI

/// Uses public directory metadata only; opening this sheet never joins a group.
struct PublicPlacePreview: View {
    @Environment(\.neu) private var colors
    let entry: DiscoverEntry
    let joining: Bool
    let error: String?
    let onJoin: () -> Void
    let onClose: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("Group preview").font(.subheadline.weight(.medium))
                        .foregroundStyle(colors.textSecondary)
                    Spacer()
                    Button("Close", systemImage: "xmark", action: onClose)
                        .labelStyle(.iconOnly).frame(width: 44, height: 44).disabled(joining)
                }
                HStack(spacing: 16) {
                    Avatar(url: entry.avatarUrl, name: entry.title, id: entry.id, size: 72, shape: .place)
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text(entry.title ?? "Group").font(.title2.bold()).fixedSize(horizontal: false, vertical: true)
                            BadgeMark(badge: entry.badge, size: 20)
                        }
                        Label("\(entry.memberCount) members", systemImage: "person.2")
                            .font(.subheadline).foregroundStyle(colors.textSecondary)
                        if let handle = entry.handle {
                            Text("@\(handle)").font(.caption).foregroundStyle(colors.textSecondary)
                        }
                    }
                }
                if entry.hereCount > 0 {
                    Label("\(entry.hereCount) here now", systemImage: "circle.fill")
                        .font(.caption.weight(.medium)).foregroundStyle(colors.success)
                }
                Text(entry.description?.isEmpty == false ? entry.description! : "A public place to meet and chat.")
                    .font(.body).foregroundStyle(colors.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let error {
                    Label(error, systemImage: "exclamationmark.circle")
                        .font(.subheadline).foregroundStyle(colors.danger)
                        .accessibilityAddTraits(.updatesFrequently)
                }
                Button(action: onJoin) {
                    HStack {
                        Spacer()
                        if joining { ProgressView().tint(colors.onAccent) }
                        Text(joining ? "Joining…" : "Join group").font(.headline)
                        Spacer()
                    }.padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent).tint(colors.accent)
                .foregroundStyle(colors.onAccent).disabled(joining)
                Text("Join to take part in the conversation.")
                    .font(.caption).foregroundStyle(colors.textTertiary)
            }
            .padding(.horizontal, 24).padding(.bottom, 24)
        }
        .foregroundStyle(colors.textPrimary)
        .interactiveDismissDisabled(joining)
    }
}
