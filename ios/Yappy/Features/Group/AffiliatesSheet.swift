import SwiftUI

struct AffiliatesEnvelope: Decodable { let affiliates: [MemberEntry] }

extension YappyRepository {
    func affiliates(_ conversationId: String) async throws -> AffiliatesEnvelope {
        try await api.get("/conversations/\(conversationId)/affiliates")
    }
}

struct AffiliatesSheet: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    let onOpenProfile: (String) -> Void
    @State private var members: [MemberEntry] = []
    @State private var loading = true
    @State private var failed = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("People this group has vouched for.")
                        .font(YappyFont.bodyMedium).foregroundStyle(colors.textSecondary)
                    if loading {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if failed {
                        Text("Couldn’t load affiliates.").foregroundStyle(colors.textSecondary)
                        Button("Try again") { Task { await load() } }
                    } else if members.isEmpty {
                        Text("No affiliates yet.").foregroundStyle(colors.textSecondary)
                    } else {
                        ForEach(members) { member in
                            Button { onOpenProfile(member.user.id) } label: {
                                HStack(spacing: 12) {
                                    Avatar(url: member.user.avatarUrl, name: member.user.label,
                                           id: member.user.id, size: 44)
                                    Text(member.user.label).font(YappyFont.titleSmall)
                                        .foregroundStyle(colors.textPrimary)
                                    IdentityMarks(user: member.user)
                                    Spacer()
                                    Image(systemName: "chevron.right").foregroundStyle(colors.textTertiary)
                                }
                                .contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                    }
                }.padding(20)
            }
            .neuBackdrop(colors)
            .navigationTitle("Affiliates").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func load() async {
        loading = true
        failed = false
        do { members = try await container.repo.affiliates(conversationId).affiliates }
        catch { failed = true }
        loading = false
    }
}
