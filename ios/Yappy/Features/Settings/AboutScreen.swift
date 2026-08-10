import SwiftUI

/// About: what this build is, what the server is, and whether they agree.
///
/// Exists mostly for support. "What version are you on?" is the first question
/// of every bug report, and an answer someone can read off the screen and copy
/// is worth more than one they have to find in the App Store.
struct AboutScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer

    let onBack: () -> Void

    @State private var info: VersionInfo?
    /// Distinguishes "still loading" from "asked and could not reach it".
    @State private var versionChecked = false
    /// Nil while loading, empty when the server has nothing to show.
    @State private var notes: [ReleaseNote]?
    @State private var showNotes = false
    @State private var copied = false

    private var appVersion: String { Bundle.main.appVersion }
    private var appBuild: String { Bundle.main.appBuild }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                logo
                status
                details
                links
            }
            .padding(.bottom, 40)
        }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showNotes) {
            WhatsNewSheet(notes: notes ?? [])
                .presentationDetents([.large])
                .presentationBackground(Color(.clear))
                .background(ThemedSheetBackground())
        }
        .task {
            // Both are optional extras: About must still render every local
            // fact when the network is down, which is often exactly when
            // someone is reading it.
            info = try? await container.repo.version()
            versionChecked = true
            notes = (try? await container.repo.changelog())?.notes ?? []
        }
    }

    // ── Pieces ───────────────────────────────────────────────────────────────

    private var header: some View {
        HStack(spacing: 12) {
            NeuIconButton(systemName: "chevron.left", label: "Back", size: 42, iconSize: 18, action: onBack)
            Text("About")
                .font(YappyFont.headlineSmall)
                .foregroundStyle(colors.textPrimary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var logo: some View {
        VStack(spacing: 10) {
            LogoMark(height: 44)
            Text("yappy")
                .font(YappyFont.headlineMedium)
                .foregroundStyle(colors.textPrimary)
            Text("Version \(appVersion) (\(appBuild))")
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textTertiary)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 12)
        .padding(.bottom, 22)
    }

    /// One line that answers "am I on the latest?" without making anyone
    /// compare two version strings themselves.
    private var status: some View {
        NeuSurface(radius: Neu.cornerMedium, contentPadding: 14) {
            HStack(spacing: 12) {
                Image(systemName: statusSymbol)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(statusTint)
                    .frame(width: 24)

                VStack(alignment: .leading, spacing: 2) {
                    Text(statusTitle)
                        .font(YappyFont.bodyLarge)
                        .foregroundStyle(colors.textPrimary)
                    if let detail = statusDetail {
                        Text(detail)
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.textTertiary)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, 16)
    }

    private var statusSymbol: String {
        guard let info else { return versionChecked ? "wifi.slash" : "arrow.triangle.2.circlepath" }
        if info.updateRequired { return "exclamationmark.triangle.fill" }
        return info.updateAvailable ? "arrow.down.circle.fill" : "checkmark.circle.fill"
    }

    private var statusTint: Color {
        guard let info else { return colors.textTertiary }
        if info.updateRequired { return colors.danger }
        return info.updateAvailable ? colors.accent : colors.success
    }

    private var statusTitle: String {
        guard let info else {
            return versionChecked ? "Couldn't check for updates" : "Checking for updates…"
        }
        if info.updateRequired { return "This version is no longer supported" }
        return info.updateAvailable ? "An update is available" : "You're on the latest version"
    }

    private var statusDetail: String? {
        guard let info else {
            return versionChecked ? "The version above is what is installed on this device." : nil
        }
        if info.updateRequired { return "Update from TestFlight or the App Store to keep using yappy." }
        if info.updateAvailable, let latest = info.latest { return "Version \(latest) is out now." }
        return nil
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "Build")
                .padding(.leading, 22)
                .padding(.top, 24)

            NeuSurface(radius: Neu.cornerMedium, contentPadding: 12) {
                VStack(spacing: 0) {
                    detailRow("App", "\(appVersion) (\(appBuild))")
                    NeuHairline()
                    detailRow("Server", info?.api ?? (versionChecked ? "unreachable" : "…"))
                    NeuHairline()
                    detailRow("iOS", UIDevice.current.systemVersion)

                    NeuHairline()
                    // Support asks for all of it at once; typing it out from a
                    // screenshot is how transcription errors get into tickets.
                    HStack(spacing: 14) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 15))
                            .foregroundStyle(copied ? colors.success : colors.textSecondary)
                            .frame(width: 22)
                        Text(copied ? "Copied" : "Copy build details")
                            .font(YappyFont.bodyLarge)
                            .foregroundStyle(colors.textPrimary)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 13)
                    .padding(.horizontal, 4)
                    .contentShape(Rectangle())
                    .softTap {
                        UIPasteboard.general.string = """
                            yappy \(appVersion) (\(appBuild))
                            server \(info?.api ?? "unknown")
                            iOS \(UIDevice.current.systemVersion)
                            """
                        copied = true
                    }
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private var links: some View {
        VStack(alignment: .leading, spacing: 0) {
            SectionLabel(text: "More")
                .padding(.leading, 22)
                .padding(.top, 24)

            NeuSurface(radius: Neu.cornerMedium, contentPadding: 12) {
                VStack(spacing: 0) {
                    // Always here, whether or not the launch sheet ever fired —
                    // an announcement people can only see once is one most
                    // people never see.
                    linkRow("sparkles", "What's New", enabled: !(notes ?? []).isEmpty) {
                        showNotes = true
                    }
                    NeuHairline()
                    linkRow("book", "Docs") { open("https://docs.yappy.gg") }
                    NeuHairline()
                    linkRow("hand.raised", "Privacy policy") { open("https://yappy.gg/privacy") }
                    NeuHairline()
                    linkRow("doc.text", "Terms") { open("https://yappy.gg/terms") }
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private func detailRow(_ label: String, _ value: String) -> some View {
        HStack(spacing: 14) {
            Text(label)
                .font(YappyFont.bodyLarge)
                .foregroundStyle(colors.textPrimary)
            Spacer(minLength: 0)
            Text(value)
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textTertiary)
                .monospacedDigit()
        }
        .padding(.vertical, 13)
        .padding(.horizontal, 4)
    }

    private func linkRow(
        _ symbol: String,
        _ title: String,
        enabled: Bool = true,
        action: @escaping () -> Void
    ) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 17))
                .foregroundStyle(colors.textSecondary)
                .frame(width: 22)
            Text(title)
                .font(YappyFont.bodyLarge)
                .foregroundStyle(colors.textPrimary)
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(colors.textTertiary)
        }
        .padding(.vertical, 13)
        .padding(.horizontal, 4)
        .contentShape(Rectangle())
        .softTap(enabled: enabled, action: action)
    }

    private func open(_ url: String) {
        if let link = URL(string: url) { UIApplication.shared.open(link) }
    }
}
