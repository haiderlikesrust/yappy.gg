import AuthenticationServices
import SwiftUI

/// Sign in to an existing account, make a new one, or get back into one.
enum AuthMode {
    case signIn
    case register
    case forgot
}

/// Ask for the code, then use it. Two steps on one screen: sending somebody
/// to their inbox and back should not cost them their place in the flow.
enum ForgotStep {
    case ask
    case reset
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
    @Published var forgotStep: ForgotStep = .ask
    @Published var code = ""

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
        if loading { return false }
        // Step one needs an address and nothing else; step two needs the code
        // and a password that would be accepted on the way in.
        if mode == .forgot { return forgotStep == .ask ? emailLooksValid : code.count == 6 && password.count >= Self.minPassword }
        guard emailLooksValid, password.count >= Self.minPassword else { return false }
        return mode == .signIn || (username.count >= 3 && usernameAvailable != false)
    }

    func setMode(_ next: AuthMode) {
        mode = next
        error = nil
        usernameAvailable = nil
        forgotStep = .ask
        code = ""
        // The password field is shared, and a half-typed one belonging to the
        // previous mode is only ever confusing.
        password = ""
    }

    func setCode(_ value: String) {
        code = String(value.filter(\.isNumber).prefix(6))
        error = nil
    }

    func backToAsk() {
        forgotStep = .ask
        code = ""
        error = nil
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

    /// Finish an Apple sign-in: the button already produced the identity
    /// token; the server decides returning-account versus brand-new. Same
    /// completion path as submit(), because the response is the same shape.
    func socialSignIn(provider: String, idToken: String, fullName: String?) {
        guard let container else { return }
        loading = true
        error = nil

        Task {
            do {
                let tokens = try await container.repo.socialSignIn(
                    provider: provider,
                    idToken: idToken,
                    fullName: fullName
                )
                container.session.saveTokens(access: tokens.accessToken, refresh: tokens.refreshToken)
                if let user = tokens.user {
                    container.session.saveIdentity(userId: user.id, deviceId: tokens.deviceId)
                }
                loading = false
                password = ""
                done = true
            } catch let failure as ApiError {
                loading = false
                error = friendly(failure)
            } catch {
                loading = false
                self.error = "Something went wrong. Try again."
            }
        }
    }

    /// The system sheet failed outside our control (or was dismissed).
    func socialFailed(_ message: String?) {
        loading = false
        error = message
    }

    /// Ask for a code, then move to the second step regardless of what the
    /// server found. It answers identically for an address with no account, so
    /// pretending to know better here would leak exactly what it protects.
    func requestReset() {
        guard !loading, emailLooksValid, let container else { return }
        loading = true
        error = nil
        Task {
            do {
                try await container.repo.forgotPassword(email: email)
                loading = false
                forgotStep = .reset
            } catch let failure as ApiError {
                // A rate limit is the one refusal worth stopping for: it is the
                // difference between "try again" and "wait".
                loading = false
                error = friendly(failure)
            } catch {
                loading = false
                self.error = "Something went wrong. Try again."
            }
        }
    }

    /// Set the new password with the code, and land signed in.
    func submitReset() {
        guard canSubmit, let container else { return }
        loading = true
        error = nil
        Task {
            do {
                let tokens = try await container.repo.resetPassword(
                    email: email,
                    code: code,
                    password: password
                )
                container.session.saveTokens(access: tokens.accessToken, refresh: tokens.refreshToken)
                if let user = tokens.user {
                    container.session.saveIdentity(userId: user.id, deviceId: tokens.deviceId)
                }
                loading = false
                password = ""
                code = ""
                done = true
            } catch let failure as ApiError {
                loading = false
                error = friendly(failure)
            } catch {
                loading = false
                self.error = "Something went wrong. Try again."
            }
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
    @Environment(\.colorScheme) private var scheme
    @EnvironmentObject private var container: AppContainer
    @StateObject private var model = AuthModel()

    let onAuthenticated: () -> Void

    private var registering: Bool { model.mode == .register }
    private var forgetting: Bool { model.mode == .forgot }
    private var entering: Bool { forgetting && model.forgotStep == .reset }

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

                    // Keyed on its own text so a mode switch pushes the old
                    // headline out instead of morphing letters in place —
                    // the words change meaning, not spelling.
                    Text(headline)
                    .font(YappyFont.displaySmall)
                    .displayTracking()
                    .foregroundStyle(colors.textPrimary)
                    .id(headline)
                    .transition(.push(from: .bottom).combined(with: .opacity))

                Text(subheadline)
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

                NeuButton(enabled: model.canSubmit, accent: true, action: primaryAction) {
                    if model.loading {
                        NeuSpinner(tint: colors.onAccent)
                    } else {
                        Text(primaryLabel)
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(colors.onAccent)
                            .id(primaryLabel)
                            .transition(.push(from: .bottom).combined(with: .opacity))
                    }
                }

                if entering {
                    Text("The code lasts 15 minutes. Setting a new password signs out every other device.")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                        .padding(.top, 10)
                }

                // ── Apple ────────────────────────────────────────────────────
                // The native button; the server verifies the identity token
                // against Apple's JWKS. Needs the Sign in with Apple
                // capability on the App ID — enabled in Xcode, not here.
                if !forgetting {
                HStack(spacing: 10) {
                    Rectangle()
                        .fill(colors.textTertiary.opacity(0.25))
                        .frame(height: 1)
                    Text("or")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                    Rectangle()
                        .fill(colors.textTertiary.opacity(0.25))
                        .frame(height: 1)
                }
                .padding(.top, 14)

                SignInWithAppleButton(.continue) { request in
                    // Name arrives only on the very first authorization;
                    // email may be a private-relay address, which is fine.
                    request.requestedScopes = [.fullName, .email]
                } onCompletion: { result in
                    switch result {
                    case .success(let authorization):
                        guard
                            let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                            let tokenData = credential.identityToken,
                            let idToken = String(data: tokenData, encoding: .utf8)
                        else {
                            model.socialFailed("Apple didn't hand back a sign-in. Try again.")
                            return
                        }
                        let name = [
                            credential.fullName?.givenName,
                            credential.fullName?.familyName,
                        ].compactMap { $0 }.joined(separator: " ")
                        model.socialSignIn(
                            provider: "apple",
                            idToken: idToken,
                            fullName: name.isEmpty ? nil : name
                        )
                    case .failure(let failure):
                        // ASAuthorizationError.canceled is the person closing
                        // the sheet — not an error worth showing.
                        if (failure as? ASAuthorizationError)?.code != .canceled {
                            model.socialFailed("Apple sign-in didn't complete. Try again.")
                        }
                    }
                }
                .signInWithAppleButtonStyle(scheme == .dark ? .white : .black)
                .frame(height: 50)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .padding(.top, 14)
                }

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
        // One extra pool of accent light behind the mark, on top of the
        // standard backdrop. Sign-in is the only screen with no content of
        // its own to warm the page, so the sheet does it. Static on
        // purpose: nothing here is live, so nothing breathes.
        .background {
            RadialGradient(
                colors: [colors.accent.opacity(0.10), .clear],
                center: .init(x: 0.28, y: 0.30),
                startRadius: 0,
                endRadius: 360
            )
            .ignoresSafeArea()
        }
        .neuBackdrop(colors)
        .animation(.easeInOut(duration: 0.2), value: registering)
        .animation(.easeInOut(duration: 0.2), value: model.error)
        // The headline changes with every mode and step switch, so it is the
        // one value that drives all the push transitions above.
        .animation(.easeInOut(duration: 0.2), value: headline)
        .onAppear { model.bind(container) }
        .onChange(of: model.done) { _, done in
            if done {
                Haptics.success()
                onAuthenticated()
            }
        }
    }

    /// Taller than the app's default field.
    ///
    /// Two or three of these *are* the sign-in page, with nothing else
    /// competing for the space. At the default height they read as a list of
    /// rows rather than as the thing you came here to fill in, and they are the
    /// first surface anyone touches.
    private let fieldPadding: CGFloat = 16

    @ViewBuilder
    private var fields: some View {
        VStack(spacing: 12) {
            NeuTextField(
                text: Binding(get: { model.email }, set: model.setEmail),
                placeholder: "you@example.com",
                verticalPadding: fieldPadding,
                keyboard: .emailAddress,
                autocapitalization: .never,
                submitLabel: .next
            ) {
                Image(systemName: "envelope")
                    .font(.system(size: 17))
                    .foregroundStyle(colors.textTertiary)
            }

            if entering {
                NeuTextField(
                    text: Binding(get: { model.code }, set: model.setCode),
                    placeholder: "Six-digit code",
                    verticalPadding: fieldPadding,
                    keyboard: .numberPad,
                    submitLabel: .next
                ) {
                    Image(systemName: "envelope.badge")
                        .font(.system(size: 17))
                        .foregroundStyle(colors.textTertiary)
                }
            }

            // The password field is the new password while resetting, and is out
            // of the way entirely on the step that only wants an address.
            if !forgetting || entering {
            NeuTextField(
                text: Binding(get: { model.password }, set: model.setPassword),
                placeholder: (registering || entering) ? "At least 8 characters" : "Password",
                secure: !model.showPassword,
                verticalPadding: fieldPadding,
                submitLabel: registering ? .next : .go,
                onSubmit: primaryAction,
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
            }

            // Only the extra fields animate. The email and password rows stay
            // put when the mode changes, so switching does not feel like a
            // different screen.
            if registering {
                NeuTextField(
                    text: Binding(get: { model.username }, set: model.setUsername),
                    placeholder: "username",
                    verticalPadding: fieldPadding,
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
                    verticalPadding: fieldPadding,
                    submitLabel: .go,
                    onSubmit: model.submit
                )
            }
        }
    }

    private var headline: String {
        if entering { return "Check your email" }
        if forgetting { return "Forgot your password" }
        return registering ? "Make an account" : "Welcome back"
    }

    private var subheadline: String {
        if entering { return "Enter the six-digit code sent to \(model.email), and pick a new password." }
        if forgetting { return "We will send a code to your email." }
        return registering
            ? "Pick a username your friends will recognise."
            : "Sign in with your email and password."
    }

    private var primaryLabel: String {
        if entering { return "Set new password" }
        if forgetting { return "Send the code" }
        return registering ? "Create account" : "Sign in"
    }

    private func primaryAction() {
        if entering { model.submitReset() } else if forgetting { model.requestReset() } else { model.submit() }
    }

    @ViewBuilder
    private var switcher: some View {
        if forgetting {
            Text(entering ? "Use a different address" : "Back to sign in")
                .font(YappyFont.labelLarge)
                .foregroundStyle(colors.accent)
                .frame(maxWidth: .infinity)
                .softTap { entering ? model.backToAsk() : model.setMode(.signIn) }
        } else {
            VStack(spacing: 14) {
                HStack(spacing: 6) {
                    Text(registering ? "Already have an account?" : "New here?")
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.textSecondary)
                    Text(registering ? "Sign in" : "Make one")
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(colors.accent)
                        .softTap { model.setMode(registering ? .signIn : .register) }
                }

                // Only offered on the way in: somebody halfway through making an
                // account has no password to have forgotten.
                if !registering {
                    Text("Forgot your password?")
                        .font(YappyFont.labelLarge)
                        .foregroundStyle(colors.textSecondary)
                        .softTap { model.setMode(.forgot) }
                }
            }
            .frame(maxWidth: .infinity)
        }
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
