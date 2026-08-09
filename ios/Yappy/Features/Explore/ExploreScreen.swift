import SwiftUI

/// Explore: public groups anyone can join.
///
/// This is what makes the "public" toggle in group settings mean something — a
/// flipped switch is only a promise until strangers can actually find the room.
struct ExploreScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let onBack: () -> Void
    let onOpenChat: (String) -> Void

    @State private var entries: [DiscoverEntry]?
    @State private var joining: String?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                NeuIconButton(systemName: "chevron.left", label: "Back", size: 42, iconSize: 18, action: onBack)
                Text("Explore")
                    .font(YappyFont.headlineSmall)
                    .foregroundStyle(colors.textPrimary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)

            content
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .task {
            entries = (try? await container.repo.discover().conversations) ?? []
        }
    }

    @ViewBuilder
    private var content: some View {
        if entries == nil {
            NeuSpinner().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if entries?.isEmpty == true {
            VStack(spacing: 6) {
                Text("Nothing public yet")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textSecondary)
                Text("Make one of your groups public and it will show up here.")
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(colors.textTertiary)
                    .multilineTextAlignment(.center)
            }
            .padding(40)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(entries ?? []) { entry in
                        row(entry)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 6)
                .padding(.bottom, 40)
            }
        }
    }

    private func row(_ entry: DiscoverEntry) -> some View {
        NeuSurface(radius: Neu.cornerMedium, contentPadding: 14) {
            HStack(spacing: 13) {
                Avatar(url: entry.avatarUrl, name: entry.title, id: entry.id, size: 50, shape: .place)

                VStack(alignment: .leading, spacing: 0) {
                    Text(entry.title ?? "Group")
                        .font(YappyFont.titleMedium)
                        .foregroundStyle(colors.textPrimary)
                        .lineLimit(1)

                    Text(subtitle(entry))
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)

                    if let description = entry.description, !description.isEmpty {
                        Text(description)
                            .font(YappyFont.bodyMedium)
                            .foregroundStyle(colors.textSecondary)
                            .lineLimit(2)
                            .padding(.top, 3)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                NeuButton(enabled: joining == nil, accent: true) {
                    guard joining == nil else { return }
                    joining = entry.id
                    Task {
                        if let id = try? await container.repo.joinPublic(entry.id).conversation.id {
                            onOpenChat(id)
                        }
                        joining = nil
                    }
                } content: {
                    Text(joining == entry.id ? "…" : "Join")
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(colors.onAccent)
                }
                .frame(width: 90)
            }
        }
    }

    private func subtitle(_ entry: DiscoverEntry) -> String {
        var text = "\(entry.memberCount) members"
        if let handle = entry.handle { text += " · @\(handle)" }
        return text
    }
}
