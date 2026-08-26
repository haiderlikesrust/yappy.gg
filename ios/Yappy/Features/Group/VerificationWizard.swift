import SwiftUI

/// Asking for the badge, one question at a time.
///
/// The X-signup shape on purpose: a single large question, one field, Next —
/// each answer earns the next screen, sliding in from the right. Three fields
/// on one form would be *faster*, and that is exactly what it should not be:
/// a verification request read by a human deserves a moment's thought per
/// answer, and the pacing is the prompt.
///
/// Steps: what the group is (required) → where else it lives (optional) → why
/// verified (optional) → review → sent. Back walks the same path in reverse.
///
/// Kept in step with android/.../ui/group/VerificationWizard.kt.
struct VerificationWizard: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let conversationId: String
    let groupName: String
    let onDismiss: () -> Void

    @State private var step = 0
    /// Which way the next screen enters: forward slides in from the right,
    /// back from the left — the animation says which way you moved.
    @State private var forward = true

    @State private var purpose = ""
    @State private var link = ""
    @State private var note = ""
    @State private var sending = false
    @State private var error: String?
    @State private var sent = false

    /// question, question, question, review — "sent" is its own state.
    private let steps = 4

    var body: some View {
        VStack(spacing: 0) {
            topBar

            if sent {
                SentScreen(groupName: groupName, onDone: onDismiss)
            } else {
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)

                nextButton
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(colors.surface.ignoresSafeArea())
    }

    // ── Chrome ───────────────────────────────────────────────────────────────

    private var topBar: some View {
        HStack {
            NeuIconButton(systemName: "chevron.left", label: "Back", size: 42, iconSize: 18, action: goBack)
            Spacer()
            // Progress dots: where you are, out of how much. Hidden on the
            // sent screen — there is nothing left to progress through.
            if !sent {
                HStack(spacing: 6) {
                    ForEach(0 ..< steps, id: \.self) { index in
                        let active = index == step
                        Circle()
                            .fill(active ? colors.accent : colors.surfaceRecessed)
                            .frame(width: active ? 8 : 6, height: active ? 8 : 6)
                    }
                }
            }
            Spacer()
            // Balances the back button so the dots sit centred.
            Color.clear.frame(width: 42, height: 42)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func goBack() {
        if sent || step == 0 {
            onDismiss()
            return
        }
        forward = false
        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { step -= 1 }
    }

    // ── Steps ────────────────────────────────────────────────────────────────

    private var content: some View {
        Group {
            switch step {
            case 0:
                question(
                    title: "What is \(groupName) about?",
                    hint: "A couple of sentences. This is what staff read first.",
                    text: $purpose,
                    placeholder: "We're the group for…",
                    multiline: true
                )
            case 1:
                question(
                    title: "Where else does it live?",
                    hint: "A link that shows the group is real — a site, a Discord, an Instagram. Optional.",
                    text: $link,
                    placeholder: "https://…",
                    multiline: false
                )
            case 2:
                question(
                    title: "Why should it be verified?",
                    hint: "Your pitch, if you have one. Optional.",
                    text: $note,
                    placeholder: "Because…",
                    multiline: true
                )
            default:
                review
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 26)
        .id(step)
        .transition(.asymmetric(
            insertion: .move(edge: forward ? .trailing : .leading).combined(with: .opacity),
            removal: .move(edge: forward ? .leading : .trailing).combined(with: .opacity)
        ))
    }

    private func question(
        title: String,
        hint: String,
        text: Binding<String>,
        placeholder: String,
        multiline: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(YappyFont.headlineMedium)
                .headlineTracking()
                .foregroundStyle(colors.textPrimary)
            Text(hint)
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textTertiary)
                .padding(.top, 8)
            NeuTextField(
                text: text,
                placeholder: placeholder,
                multiline: multiline,
                lineLimit: 6,
                autocapitalization: multiline ? .sentences : .never
            )
            .padding(.top, 22)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var review: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Ready to send")
                .font(YappyFont.headlineMedium)
                .headlineTracking()
                .foregroundStyle(colors.textPrimary)
            Text("Staff read this and decide. You will see the badge on \(groupName) if it goes through.")
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textTertiary)
                .padding(.top, 8)

            reviewRow("About", purpose)
                .padding(.top, 22)
            if !link.trimmingCharacters(in: .whitespaces).isEmpty {
                reviewRow("Link", link)
            }
            if !note.trimmingCharacters(in: .whitespaces).isEmpty {
                reviewRow("Why", note)
            }

            if let error {
                Text(error)
                    .font(YappyFont.bodyMedium)
                    .foregroundStyle(colors.danger)
                    .padding(.top, 14)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func reviewRow(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label.uppercased())
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)
            Text(value)
                .font(YappyFont.bodyLarge)
                .foregroundStyle(colors.textPrimary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 14)
    }

    // ── The one primary action ───────────────────────────────────────────────

    private var purposeOk: Bool {
        purpose.trimmingCharacters(in: .whitespacesAndNewlines).count >= 12
    }

    private var linkOk: Bool {
        let trimmed = link.trimmingCharacters(in: .whitespaces)
        return trimmed.isEmpty || trimmed.hasPrefix("http")
    }

    private var canAdvance: Bool {
        switch step {
        case 0: return purposeOk
        case 1: return linkOk
        default: return true
        }
    }

    /// The label is the state machine: Next, Next, Next, Send.
    private var nextButton: some View {
        NeuButton(enabled: canAdvance && !sending, accent: true) {
            error = nil
            if step < 3 {
                forward = true
                withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { step += 1 }
            } else if !sending {
                submit()
            }
        } content: {
            Text(sending ? "Sending…" : (step < 3 ? "Next" : "Send it"))
                .font(YappyFont.labelLarge)
                .foregroundStyle(colors.onAccent)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 18)
    }

    private func submit() {
        sending = true
        Task {
            do {
                let trimmedLink = link.trimmingCharacters(in: .whitespaces)
                let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
                try await container.repo.requestVerification(
                    conversationId,
                    purpose: purpose.trimmingCharacters(in: .whitespacesAndNewlines),
                    link: trimmedLink.isEmpty ? nil : trimmedLink,
                    note: trimmedNote.isEmpty ? nil : trimmedNote
                )
                withAnimation { sent = true }
            } catch let failure as ApiError {
                error = failure.message
            } catch {
                self.error = "Something went wrong. Try again."
            }
            sending = false
        }
    }
}

/// The full stop: a check that springs in, and nothing else asked of anyone.
private struct SentScreen: View {
    @Environment(\.neu) private var colors

    let groupName: String
    let onDone: () -> Void

    @State private var shown = false

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 0)

            Image(systemName: "checkmark")
                .font(.system(size: 34, weight: .bold))
                .foregroundStyle(colors.onAccent)
                .frame(width: 84, height: 84)
                .neu(Circle(), colors, state: .raised, elevation: 5, fill: colors.accent)
                .scaleEffect(shown ? 1 : 0.4)

            Text("Sent")
                .font(YappyFont.headlineMedium)
                .headlineTracking()
                .foregroundStyle(colors.textPrimary)
                .padding(.top, 24)

            Text("Staff will look at \(groupName). If it is verified, the badge simply appears — nothing else to do.")
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textTertiary)
                .multilineTextAlignment(.center)
                .padding(.top, 8)

            NeuButton(accent: true, action: onDone) {
                Text("Done")
                    .font(YappyFont.labelLarge)
                    .foregroundStyle(colors.onAccent)
            }
            .padding(.top, 28)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 32)
        .onAppear {
            withAnimation(.spring(response: 0.5, dampingFraction: 0.5)) { shown = true }
        }
    }
}
