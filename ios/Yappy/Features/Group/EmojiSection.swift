import PhotosUI
import SwiftUI

/**
 * A group's own emoji: everyone browses, MANAGE_STICKERS curates.
 *
 * The phones could already *use* these — a `:party_parrot:` typed here renders
 * as a picture — but there was no way to make one without opening the web app,
 * which is a strange thing to require of a feature whose whole point is that a
 * group has a voice of its own.
 *
 * Name first, picture second. The server insists on both, and picking the
 * image first means an upload that has already happened by the time somebody
 * changes their mind about the name.
 */
struct EmojiSection: View {
    @Environment(\.neu) private var colors

    let container: AppContainer
    let conversationId: String
    let canManage: Bool

    @State private var emojis: [CustomEmoji] = []
    @State private var name = ""
    @State private var selection: PhotosPickerItem?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        Group {
            if !emojis.isEmpty || canManage {
                VStack(alignment: .leading, spacing: 0) {
                    SectionLabel(text: "Emoji")
                        .padding(.leading, 24)
                        .padding(.top, 18)
                        .padding(.bottom, 8)

                    if !emojis.isEmpty {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 10) {
                                ForEach(emojis) { emoji in
                                    tile(emoji)
                                }
                            }
                            .padding(.horizontal, 20)
                        }
                        .padding(.bottom, 10)
                    }

                    if canManage {
                        if let error {
                            Text(error)
                                .font(YappyFont.bodyMedium)
                                .foregroundStyle(colors.danger)
                                .padding(.horizontal, 20)
                                .padding(.vertical, 4)
                        }
                        adder
                        Text("Up to 50 per group, 512 KB each.")
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.textTertiary)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 6)
                    }
                }
            }
        }
        .task(id: conversationId) { await reload() }
        .onChange(of: selection) { _, picked in
            guard let picked else { return }
            Task { await add(picked) }
        }
    }

    private func tile(_ emoji: CustomEmoji) -> some View {
        VStack(spacing: 3) {
            ZStack(alignment: .topTrailing) {
                RemoteImage(url: emoji.url)
                    .frame(width: 44, height: 44)
                if canManage {
                    Image(systemName: "xmark")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(colors.textSecondary)
                        .frame(width: 18, height: 18)
                        .background(Circle().fill(colors.veil))
                        .contentShape(Circle())
                        .softTap { Task { await remove(emoji) } }
                        .accessibilityLabel("Remove :\(emoji.name):")
                }
            }
            Text(":\(emoji.name):")
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)
                .lineLimit(1)
                .frame(width: 60)
        }
    }

    private var adder: some View {
        HStack(spacing: 8) {
            NeuTextField(text: $name, placeholder: "name (a–z, 0–9, _)", autocapitalization: .never)
            PhotosPicker(selection: $selection, matching: .images, photoLibrary: .shared()) {
                HStack(spacing: 5) {
                    Image(systemName: "plus")
                        .font(.system(size: 14, weight: .semibold))
                    Text(busy ? "Adding…" : "Picture")
                        .font(YappyFont.labelLarge)
                }
                .foregroundStyle(name.isEmpty ? colors.textTertiary : colors.accent)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || busy)
        }
        .padding(.horizontal, 20)
    }

    private func reload() async {
        emojis = (try? await container.repo.customEmojis(conversationId).emojis) ?? []
    }

    private func add(_ picked: PhotosPickerItem) async {
        let wanted = name.trimmingCharacters(in: .whitespaces).lowercased()
        selection = nil
        guard !wanted.isEmpty else { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            guard let bytes = await picked.picked() else { return }
            let uploaded = try await container.uploader.upload(bytes, purpose: "emoji")
            try await container.repo.createCustomEmoji(
                conversationId, name: wanted, mediaId: uploaded.mediaId
            )
            name = ""
            await reload()
        } catch {
            // Surfaced rather than swallowed: the name rules are strict
            // (lowercase, 2–32, no spaces) and a silent no-op teaches nobody
            // what went wrong.
            self.error = (error as? ApiError)?.message ?? "Could not add that emoji"
        }
    }

    private func remove(_ emoji: CustomEmoji) async {
        try? await container.repo.deleteCustomEmoji(conversationId, emojiId: emoji.id)
        await reload()
    }
}
