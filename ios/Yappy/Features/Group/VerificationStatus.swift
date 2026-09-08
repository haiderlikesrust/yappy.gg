import SwiftUI

struct VerificationStatusEnvelope: Decodable {
    struct Request: Decodable {
        let status: String
        let createdAt: String?
        let updatedAt: String?
    }
    let request: Request?
    let badge: String?
}

extension YappyRepository {
    func verificationStatus(_ id: String) async throws -> VerificationStatusEnvelope {
        try await api.get("/conversations/\(id)/verification-request")
    }
}

struct VerificationStatusPanel: View {
    @EnvironmentObject private var container: AppContainer
    @Environment(\.neu) private var colors
    @Environment(\.scenePhase) private var phase
    let conversationId: String
    let wizardOpen: Bool
    let onRequest: () -> Void
    @State private var result: VerificationStatusEnvelope?
    @State private var loading = true
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if loading && result == nil {
                ProgressView("Checking verification…")
            } else if failed {
                Text("Couldn’t check the request status.").foregroundStyle(colors.textSecondary)
                Button("Try again") { Task { await load() } }
            } else if let badge = result?.badge {
                Label("This group is \(badge)", systemImage: "checkmark.seal.fill")
                    .foregroundStyle(colors.accent)
            } else if result?.request?.status == "open" || result?.request?.status == "pending" {
                Label("Verification pending", systemImage: "clock")
                    .foregroundStyle(colors.accent)
                Text("Your request is with the team. We’ll notify you when it’s reviewed.")
                    .foregroundStyle(colors.textSecondary)
            } else {
                if result?.request?.status == "declined" {
                    Text("Verification declined").foregroundStyle(colors.textPrimary)
                    Text("You can update your details and submit a new request.")
                        .foregroundStyle(colors.textSecondary)
                }
                Button(result?.request?.status == "declined" ? "Request again" : "Request verification",
                       action: onRequest)
                    .buttonStyle(.bordered)
            }
        }
        .font(YappyFont.bodyMedium)
        .task(id: wizardOpen) { if !wizardOpen { await load() } }
        .onChange(of: phase) { _, next in
            if next == .active, !wizardOpen { Task { await load() } }
        }
        .onReceive(container.gateway.events) { event in
            if event.type == "notification.create", event.data["targetId"]?.stringValue == conversationId {
                Task { await load() }
            }
        }
    }

    private func load() async {
        loading = true
        failed = false
        do { result = try await container.repo.verificationStatus(conversationId) }
        catch { if !Task.isCancelled { failed = true } }
        loading = false
    }
}
