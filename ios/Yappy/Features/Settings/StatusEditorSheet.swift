import SwiftUI

struct StatusEditorSheet: View {
    @Environment(\.neu) private var colors
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var container: AppContainer
    @State private var draft = ""
    @State private var duration = 24
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    VStack(spacing: 3) {
                        StatusBubble(text: StatusText.visible(draft) ?? "What are you up to?", placeholder: StatusText.visible(draft) == nil)
                            .frame(width: 170)
                        Avatar(url: container.me?.avatarUrl, name: container.me?.displayName,
                               id: container.me?.id ?? "me", size: 64)
                    }
                    TextField("What are you up to?", text: $draft, axis: .vertical)
                        .lineLimit(2...4)
                        .padding(14)
                        .background(colors.veil, in: RoundedRectangle(cornerRadius: 16))
                        .accessibilityLabel("Your status")
                        .onChange(of: draft) { _, text in draft = StatusText.limited(text) }
                        .disabled(saving)
                    HStack {
                        Text("Visible to people allowed to see your status.")
                        Spacer()
                        Text("\(draft.utf16.count)/128").monospacedDigit()
                    }
                    .font(YappyFont.labelSmall).foregroundStyle(colors.textTertiary)
                    Picker("Clear after", selection: $duration) {
                        Text("1 hour").tag(1)
                        Text("24 hours").tag(24)
                        Text("Until I clear it").tag(0)
                    }
                    .pickerStyle(.menu)
                    .disabled(saving)
                    if StatusText.visible(container.me?.presence.customStatus) != nil {
                        Button("Clear status", role: .destructive) { save(clear: true) }.disabled(saving)
                    }
                    if let error { Text(error).font(YappyFont.bodyMedium).foregroundStyle(colors.textSecondary) }
                    if saving { ProgressView("Saving…") }
                }
                .padding(20)
            }
            .neuBackdrop(colors)
            .navigationTitle("Your status")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(clear: false) }.disabled(saving || StatusText.visible(draft) == nil)
                }
            }
        }
        .onAppear { draft = container.me?.presence.customStatus ?? "" }
        .interactiveDismissDisabled(saving)
    }

    private func save(clear: Bool) {
        guard !saving else { return }
        let generation = container.session.generation
        let value = clear ? "" : (StatusText.visible(draft) ?? "")
        let expiry = !clear && duration > 0
            ? ISO8601DateFormatter().string(from: Date().addingTimeInterval(Double(duration) * 3600)) : nil
        saving = true; error = nil
        Task {
            defer { saving = false }
            do {
                let current = container.me?.presence.status ?? "online"
                _ = try await container.repo.setPresence(current == "offline" ? "online" : current,
                                                          customStatus: value, expiresAt: expiry)
                guard container.session.generation == generation else { return }
                container.setCustomStatus(StatusText.visible(value))
                dismiss()
            } catch { self.error = "Couldn’t save your status. Try again when you’re connected." }
        }
    }
}

struct StatusSettingsRow: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer
    @State private var editing = false

    var body: some View {
        Button { editing = true } label: {
            HStack(spacing: 12) {
                Image(systemName: "bubble.left").foregroundStyle(colors.accent)
                VStack(alignment: .leading, spacing: 4) {
                    Text(StatusText.visible(container.me?.presence.customStatus) ?? "What are you up to?")
                        .font(YappyFont.bodyMedium).foregroundStyle(colors.textPrimary)
                    Text("Edit your status bubble").font(YappyFont.labelSmall).foregroundStyle(colors.textTertiary)
                }
                Spacer()
                Image(systemName: "chevron.right").foregroundStyle(colors.textTertiary)
            }
            .padding(14)
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $editing) {
            StatusEditorSheet().presentationDetents([.medium, .large])
        }
    }
}
