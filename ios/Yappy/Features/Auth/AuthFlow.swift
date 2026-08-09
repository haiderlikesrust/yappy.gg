import SwiftUI

/// Sign in to an existing account, or make a new one.
enum AuthMode {
    case signIn
    case register
}

@MainActor
final class AuthModel: ObservableObject {
    /// Matches the server's rule; duplicated so the UI can say so early.
    static let minPassword = 8

    @Published var mode: AuthMode = .signIn
    @Published var email = ""
    @Published var password = ""
    @Published var username = ""
    @Published var displayName = ""
    @Published var usernameAvailable: Bool?
    @Published var showPassword = false
    @Published var loading = false
    @Published var error: String?
    @Published var done = false

    private var container: AppContainer?
    private var usernameCheck: Task<Void, Never>?

    func bind(_ container: AppContainer) { self.container = container }

    var emailLooksValid: Bool {
        guard let at = email.lastIndex(of: "@") else { return false }
        return email[email.index(after: at)...].contains(".")
    }

    /// Whether the button should be live.
    ///
    /// Registration additionally waits on the username check having come back
    /// negative-free. `nil` (still checking, or too short to check) does not
    /// block — the server is the authority and rejects a taken name anyway.
    var canSubmit: Bool {
        !loading && emailLooksValid && password.count >= Self.minPassword
            && (mode == .signIn || (username.count >= 3 && usernameAvailable != false))
    }

    func setMode(_ next: AuthMode) {
        mode = next
        error = nil
        usernameAvailable = nil
    }

    func setEmail(_ value: String) {
        // Trimmed and lowered here as well as on the server: a keyboard that
        // capitalises the first letter would otherwise make the address the
        // person typed look different from the one they registered.
        email = String(value.trimmingCharacters(in: .whitespaces).lowercased().prefix(254))
        error = nil
    }

    func setPassword(_ value: String) {
        password = String(value.prefix(200))
        error = nil
    }

    func setDisplayName(_ value: String) {
        displayName = String(value.prefix(64))
    }

    func setUsername(_ value: String) {
        let cleaned = String(
            value.lowercased()
                .filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "." }
                .prefix(32)
        )
        username = cleaned
        usernameAvailable = nil
        error = nil

        // Debounced: firing a request per keystroke would both hammer the
        // endpoint and race its own responses out of order.
        usernameCheck?.cancel()
        guard cleaned.count >= 3, let container else { return }
        usernameCheck = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            let available = try? await container.repo.usernameAvailable(cleaned).available
            guard !Task.isCancelled, username == cleaned else { return }
            usernameAvailable = available
        }
    }

    func submit() {
        guard canSubmit, let container else { return }
        loading = true
        error = nil

        Task {
            do {
                let tokens: AuthTokens
                if mode == .register {
                    let trimmed = displayName.trimmingCharacters(in: .whitespaces)
                    tokens = try await container.repo.register(
                        email: email,
                        password: password,
                        username: username,
                        displayName: trimmed.isEmpty ? username : trimmed
                    )
                } else {
                    tokens = try await container.repo.login(email: email, password: password)
                }

                container.session.saveTokens(access: tokens.accessToken, refresh: tokens.refreshToken)
                if let user = tokens.user {
                    container.session.saveIdentity(userId: user.id, deviceId: tokens.deviceId)
                }

                // The password is held only as long as the request needs it.
                // Leaving it in state means it survives in a process dump and in
                // any state snapshot the framework takes.
                loading = false
                password = ""
                done = true
            } catch let failure as ApiError {
                loading = false
                error = friendly(failure)
                if failure.code == "already_exists", mode == .register {
                    usernameAvailable = false
                }
            } catch {
                loading = false
                self.error = "Something went wrong. Try again."
            }
        }
    }

    /// Server error codes → copy a person can act on. The raw messages are
    /// accurate but written for developers.
    ///
    /// "Email or password is incorrect" is passed through deliberately vague:
    /// saying which one was wrong tells anyone who asks whether an address has
    /// an account here.
    private func friendly(_ error: ApiError) -> String {
        switch error.code {
        case "rate_limited":
            return "Too many attempts. Try again in \(error.retryAfter ?? 60)s."
        case "validation_failed":
            return error.message.isEmpty ? "Check the details and try again." : error.message
        case "network_error":
            return "Can't reach yappy. Check your connection."
        default:
            return error.message
        }
    }
}

/// Sign in, or make an account.
///
/// One screen with two modes rather than a wizard. The previous flow was three
/// steps because an SMS code forces a round trip in the middle; email and
/// password do not, and registration only adds two fields, so making someone
/// page through screens for it would be ceremony.
struct AuthFlow: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model = AuthModel()

    let onAuthenticated: () -> Void

    private var registering: Bool { model.mode == .register }

    var body: some View {
        // The form is vertically centred while it fits and scrolls once it does
        // not — which is what happens the moment the keyboard opens in register
        // mode. A plain ScrollView cannot centre, because its content height is
        // whatever the content is; the minHeight is what gives it room to.
        GeometryReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    // The mark itself, gradient-filled on the sheet — no tile
                    // behind it. The launcher icon already showed its yellow a
                    // second ago; repeating it here as a badge just puts a
                    // sticker on the page, and the same treatment is what the
                    // home header uses, so the two screens read as one product.
                    LogoMarkGradient(height: 52)
                        .padding(.bottom, 28)

                    Text(registering ? "Make an account" : "Welcome back")
                    .font(YappyFont.displaySmall)
                    .displayTracking()
                    .foregroundStyle(colors.textPrimary)

                Text(registering
                    ? "Pick a username your friends will recognise."
                    : "Sign in with your email and password.")
                    .font(YappyFont.bodyLarge)
                    .foregroundStyle(colors.textSecondary)
                    .padding(.top, 8)

                fields.padding(.top, 28)

                if let error = model.error {
                    Text(error)
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.danger)
                        .padding(.top, 10)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }

                NeuButton(enabled: model.canSubmit, accent: true, action: model.submit) {
                    if model.loading {
                        NeuSpinner(tint: colors.onAccent)
                    } else {
                        Text(registering ? "Create account" : "Sign in")
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(colors.onAccent)
                    }
                }
                .padding(.top, 20)

                    switcher.padding(.top, 18)
                    agreement.padding(.top, 18)
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 24)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
                .frame(minHeight: proxy.size.height, alignment: .center)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .animation(.easeInOut(duration: 0.2), value: registering)
        .animation(.easeInOut(duration: 0.2), value: model.error)
        .onAppear { model.bind(container) }
        .onChange(of: model.done) { _, done in
            if done { onAuthenticated() }
        }
    }

    @ViewBuilder
    private var fields: some View {
        VStack(spacing: 12) {
            NeuTextField(
                text: Binding(get: { model.email }, set: model.setEmail),
                placeholder: "you@example.com",
                keyboard: .emailAddress,
                autocapitalization: .never,
                submitLabel: .next
            ) {
                Image(systemName: "envelope")
                    .font(.system(size: 17))
                    .foregroundStyle(colors.textTertiary)
            }

            NeuTextField(
                text: Binding(get: { model.password }, set: model.setPassword),
                placeholder: registering ? "At least 8 characters" : "Password",
                secure: !model.showPassword,
                submitLabel: registering ? .next : .go,
                onSubmit: model.submit,
                leading: {
                    Image(systemName: "lock")
                        .font(.system(size: 17))
                        .foregroundStyle(colors.textTertiary)
                },
                trailing: {
                    Image(systemName: model.showPassword ? "eye.slash" : "eye")
                        .font(.system(size: 17))
                        .foregroundStyle(colors.textTertiary)
                        .softTap { model.showPassword.toggle() }
                        .accessibilityLabel(model.showPassword ? "Hide password" : "Show password")
                }
            )

            // Only the extra fields animate. The email and password rows stay
            // put when the mode changes, so switching does not feel like a
            // different screen.
            if registering {
                NeuTextField(
                    text: Binding(get: { model.username }, set: model.setUsername),
                    placeholder: "username",
                    autocapitalization: .never,
                    submitLabel: .next,
                    leading: {
                        Image(systemName: "at")
                            .font(.system(size: 17))
                            .foregroundStyle(colors.textTertiary)
                    },
                    trailing: {
                        // Only ever a confirmation. "Taken" is said in words
                        // below, because a red mark alone leaves people guessing
                        // what is wrong.
                        if model.usernameAvailable == true {
                            Image(systemName: "checkmark")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(colors.success)
                        }
                    }
                )

                if model.usernameAvailable == false {
                    Text("That username is taken.")
                        .font(YappyFont.labelMedium)
                        .foregroundStyle(colors.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                NeuTextField(
                    text: Binding(get: { model.displayName }, set: model.setDisplayName),
                    placeholder: "Display name (optional)",
                    submitLabel: .go,
                    onSubmit: model.submit
                )
            }
        }
    }

    private var switcher: some View {
        HStack(spacing: 6) {
            Text(registering ? "Already have an account?" : "New here?")
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textSecondary)
            Text(registering ? "Sign in" : "Make one")
                .font(YappyFont.labelLarge)
                .foregroundStyle(colors.accent)
                .softTap { model.setMode(registering ? .signIn : .register) }
        }
        .frame(maxWidth: .infinity)
    }

    /// The links are real — a "By continuing you agree to…" line that points
    /// nowhere is worse than none, because it claims consent to a document the
    /// person cannot read.
    private var agreement: some View {
        let terms = "\(AppConfig.webUrl)/terms/"
        let privacy = "\(AppConfig.webUrl)/privacy/"

        var text = AttributedString("By continuing you agree to the ")
        var termsLink = AttributedString("Terms")
        termsLink.link = URL(string: terms)
        termsLink.foregroundColor = colors.accent
        let middle = AttributedString(" and ")
        var privacyLink = AttributedString("Privacy Policy")
        privacyLink.link = URL(string: privacy)
        privacyLink.foregroundColor = colors.accent

        text.append(termsLink)
        text.append(middle)
        text.append(privacyLink)
        text.append(AttributedString("."))

        return Text(text)
            .font(YappyFont.labelSmall)
            .foregroundStyle(colors.textTertiary)
    }
}
