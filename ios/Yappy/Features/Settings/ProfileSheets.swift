import CoreImage.CIFilterBuiltins
import SwiftUI

/// Flair presets. A fixed palette rather than a colour wheel: every option here
/// is one the design language already speaks, so any choice looks like yappy —
/// and a bounded set makes the row a single glance instead of a project.
let flairPresets: [[String]] = [
    ["#8B7CFF", "#00CEC9"],
    ["#FF9F43", "#FF6B81"],
    ["#00CEC9", "#6BCB77"],
    ["#FCCE09", "#FF9F43"],
    ["#FF6B81", "#8B7CFF"],
    ["#4FC3F7", "#8B7CFF"],
]

/// The two stops as colours, or nil when absent/garbled.
func flairStops(_ gradient: [String]?) -> (Color, Color)? {
    guard let stops = gradient?.compactMap({ Color(hexString: $0) }), stops.count >= 2 else { return nil }
    return (stops[0], stops[1])
}

/// Edit the things a profile says: name, pronouns, bio, flair.
///
/// The preview at the top is not a decoration — it renders from the *staged*
/// values through the same layout the profile header uses, so what it shows is
/// what saving produces. The same promise the banner editor makes.
struct EditProfileSheet: View {
    @Environment(\.neu) private var colors
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var container: AppContainer

    let me: FullUser

    @State private var name: String
    @State private var pronouns: String
    @State private var bio: String
    @State private var flair: [String]?
    @State private var busy = false

    init(me: FullUser) {
        self.me = me
        _name = State(initialValue: me.displayName ?? "")
        _pronouns = State(initialValue: me.pronouns ?? "")
        _bio = State(initialValue: me.bio ?? "")
        _flair = State(initialValue: me.flair?.gradient)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Edit profile")
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textPrimary)

                preview.padding(.top, 14)

                SectionLabel(text: "Display name").padding(.top, 18)
                NeuTextField(
                    text: Binding(
                        get: { name },
                        set: { name = String($0.prefix(50)) }
                    ),
                    placeholder: "Your name"
                )

                SectionLabel(text: "Pronouns").padding(.top, 14)
                NeuTextField(
                    text: Binding(
                        get: { pronouns },
                        set: { pronouns = String($0.prefix(32)) }
                    ),
                    placeholder: "e.g. they/them"
                )

                SectionLabel(text: "Bio").padding(.top, 14)
                NeuTextField(
                    text: Binding(
                        get: { bio },
                        set: { bio = String($0.prefix(280)) }
                    ),
                    placeholder: "A line about you",
                    multiline: true
                )

                SectionLabel(text: "Flair").padding(.top, 14)
                flairRow

                NeuButton(enabled: !busy, accent: true, action: save) {
                    if busy {
                        NeuSpinner(tint: colors.onAccent)
                    } else {
                        Text("Save")
                            .font(YappyFont.labelLarge)
                            .foregroundStyle(colors.onAccent)
                    }
                }
                .padding(.top, 22)
            }
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 28)
        }
    }

    /// The staged values through the header's own layout: chosen flair beats
    /// the derived colour, both fading the same way the profile banner does.
    private var preview: some View {
        let stops = flairStops(flair)
        let fallback = colorForId(me.id)

        return HStack(spacing: 12) {
            Avatar(url: me.avatarUrl, name: name.isEmpty ? me.displayName : name, id: me.id, size: 46)
                .overlay(Circle().stroke(colors.surface, lineWidth: 3))

            VStack(alignment: .leading, spacing: 2) {
                Text(name.isEmpty ? "Your name" : name)
                    .font(YappyFont.titleMedium)
                    .foregroundStyle(colors.textPrimary)
                Text(
                    [
                        me.username.map { "@\($0)" },
                        pronouns.isEmpty ? nil : pronouns,
                    ]
                    .compactMap { $0 }
                    .joined(separator: " · ")
                )
                .font(YappyFont.labelMedium)
                .foregroundStyle(colors.textSecondary)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .background(
            LinearGradient(
                colors: [
                    (stops?.0 ?? fallback).opacity(0.85),
                    (stops?.1 ?? fallback).opacity(0.25),
                ],
                startPoint: .top,
                endPoint: .bottom
            ),
            in: RoundedRectangle(cornerRadius: Neu.cornerMedium, style: .continuous)
        )
    }

    private var flairRow: some View {
        HStack(spacing: 10) {
            // "None" returns to the derived per-id colour.
            Circle()
                .fill(colors.veil)
                .frame(width: 40, height: 40)
                .overlay(
                    Circle().stroke(
                        flair == nil ? colors.accent : colors.textTertiary.opacity(0.3),
                        lineWidth: flair == nil ? 2 : 1
                    )
                )
                .overlay(
                    Image(systemName: "nosign")
                        .font(.system(size: 15))
                        .foregroundStyle(colors.textTertiary)
                )
                .softTap { flair = nil }

            ForEach(flairPresets, id: \.self) { preset in
                if let pair = flairStops(preset) {
                    let selected = flair == preset
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [pair.0, pair.1],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: 40, height: 40)
                        .overlay {
                            if selected {
                                Circle().stroke(colors.textPrimary, lineWidth: 2)
                                Image(systemName: "checkmark")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(.white)
                            }
                        }
                        .softTap { flair = preset }
                }
            }
            Spacer(minLength: 0)
        }
    }

    private func save() {
        guard !busy else { return }
        busy = true
        Task {
            do {
                let trimmedName = name.trimmingCharacters(in: .whitespaces)
                let trimmedBio = bio.trimmingCharacters(in: .whitespaces)
                let trimmedPronouns = pronouns.trimmingCharacters(in: .whitespaces)
                _ = try await container.repo.updateProfile(
                    displayName: trimmedName.isEmpty ? nil : trimmedName,
                    bio: trimmedBio.isEmpty ? nil : trimmedBio,
                    pronouns: trimmedPronouns.isEmpty ? nil : trimmedPronouns
                )
                // Through the container, so every screen drawing you — the home
                // header, the settings card — changes at the same moment.
                container.setMe(try await container.repo.setMyFlair(gradient: flair).user)
                dismiss()
            } catch {}
            busy = false
        }
    }
}

/// Your profile as a QR code, for the person standing next to you.
///
/// The code carries `yappy://user/<id>` — the system camera reads it and hands
/// the app a deep link straight to the profile, where Follow lives. No web
/// round-trip, nothing to type.
struct ShareProfileSheet: View {
    @Environment(\.neu) private var colors

    let me: FullUser

    @State private var qr: UIImage?

    private var link: String { "yappy://user/\(me.id)" }

    private var shareText: String {
        var text = "I'm "
        if let username = me.username { text += "@\(username) " }
        text += "on yappy — \(link)"
        return text
    }

    var body: some View {
        VStack(spacing: 0) {
            Text("Share profile")
                .font(YappyFont.titleMedium)
                .foregroundStyle(colors.textPrimary)

            Text("Point a camera at this to open your profile in yappy.")
                .font(YappyFont.bodyMedium)
                .foregroundStyle(colors.textTertiary)
                .multilineTextAlignment(.center)
                .padding(.top, 4)

            if let qr {
                Image(uiImage: qr)
                    // Nearest-neighbour: a QR is squares, and smoothing the
                    // upscale blurs the modules a camera has to separate.
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 240, height: 240)
                    .padding(14)
                    // Always white behind a QR: scanners want contrast, not
                    // theming.
                    .background(
                        Color.white,
                        in: RoundedRectangle(cornerRadius: Neu.cornerMedium, style: .continuous)
                    )
                    .padding(.top, 18)
                    .accessibilityLabel("Profile QR code")
            }

            if let username = me.username {
                Text("@\(username)")
                    .font(YappyFont.titleSmall)
                    .foregroundStyle(colors.textSecondary)
                    .padding(.top, 12)
            }

            ShareLink(item: shareText) {
                Text("Share link")
                    .font(YappyFont.labelLarge)
                    .foregroundStyle(colors.onAccent)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .neu(
                        NeuShape(radius: Neu.cornerMedium),
                        colors,
                        state: .raised,
                        elevation: 7,
                        fill: colors.accent
                    )
            }
            .buttonStyle(.plain)
            .padding(.top, 18)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.top, 22)
        .padding(.bottom, 28)
        .onAppear { qr = Self.qrImage(link) }
    }

    /// Render the QR crisply: the generator emits a tiny image, so it is scaled
    /// up by an integer factor before rasterising. Quiet zone comes from the
    /// padded white card.
    private static func qrImage(_ content: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(content.utf8)
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
        guard let rendered = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: rendered)
    }
}
