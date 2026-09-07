import SwiftUI

struct WelcomeHint: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.neu) private var colors
    let conversationId: String
    let onOpen: () -> Void
    @State private var welcome: CommunityWelcome?
    @State private var error: String?
    var body: some View {
        Group {
            if let welcome, !welcome.seen, welcome.profile.welcome?.isEmpty == false || welcome.profile.rules?.isEmpty == false {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Welcome! Here’s a good place to start.").font(.subheadline.bold())
                    HStack { Button("Read welcome & rules", action: onOpen); Spacer(); Button("Got it") { Task { do { try await container.repo.changeCommunity("POST", "/groups/\(conversationId)/welcome/read"); self.welcome = nil } catch { self.error = error.localizedDescription } } } }
                    if let error { Text(error).font(.caption).foregroundStyle(colors.danger) }
                }.padding(12).background(colors.accentSoft, in: RoundedRectangle(cornerRadius: 16)).padding(.horizontal, 16)
            }
        }.task(id: conversationId) { welcome = nil; let response: CommunityWelcome? = try? await container.repo.community("/groups/\(conversationId)/welcome"); if !Task.isCancelled { welcome = response } }
    }
}
