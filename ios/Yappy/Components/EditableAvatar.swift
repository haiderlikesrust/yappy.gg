import PhotosUI
import SwiftUI

/// An avatar you can change.
///
/// The camera pip sits *on* the picture rather than beside it as a separate
/// "Edit photo" row: on every phone app in existence, tapping your own face is
/// how you change it, and a row nobody looks for is a feature nobody finds.
///
/// Shape is passed through rather than assumed, so this works for a person
/// (circle) and a group (squircle) without a second component — the app's shape
/// language stays intact in the one place people are most likely to notice it.
struct EditableAvatar: View {
    @Environment(\.neu) private var colors

    let url: String?
    let name: String?
    let id: String
    var size: CGFloat = 96
    var shape: AvatarShape = .person
    var busy: Bool = false
    var enabled: Bool = true
    let onPicked: (AttachmentUploader.Picked) -> Void

    @State private var selection: PhotosPickerItem?

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            ZStack {
                Avatar(url: url, name: name, id: id, size: size, shape: shape)

                // The spinner covers the picture rather than replacing it, so the
                // old image stays visible until the new one is actually live.
                if busy {
                    colors.surface.opacity(0.6)
                        .frame(width: size, height: size)
                        .overlay(NeuSpinner())
                        .clipShape(clipShape)
                }
            }

            if enabled, !busy {
                Circle()
                    .fill(colors.accent)
                    .frame(width: size * 0.30, height: size * 0.30)
                    .overlay(
                        Image(systemName: "camera.fill")
                            .font(.system(size: size * 0.13, weight: .semibold))
                            .foregroundStyle(colors.onAccent)
                    )
            }
        }
        .frame(width: size, height: size, alignment: .bottomTrailing)
        .overlay {
            // The picker sits on top as an invisible target rather than wrapping
            // the avatar, so the pip and the picture are one tap area.
            if enabled, !busy {
                PhotosPicker(selection: $selection, matching: .images, photoLibrary: .shared()) {
                    Color.clear.contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .onChange(of: selection) { _, item in
            guard let item else { return }
            Task {
                if let picked = await item.picked() { onPicked(picked) }
                selection = nil
            }
        }
    }

    private var clipShape: AnyShape {
        switch shape {
        case .person: return AnyShape(Circle())
        case .place: return AnyShape(PlaceShape())
        }
    }
}

extension PhotosPickerItem {
    /// Turns a picker item into the bytes the uploader needs.
    ///
    /// The dimensions come from the image header, not a decode: the presign call
    /// wants width and height, and decoding a 12 MP photo to learn them is how a
    /// picker gets the app jetsammed on an older phone.
    func picked() async -> AttachmentUploader.Picked? {
        guard let data = try? await loadTransferable(type: Data.self) else { return nil }

        let type = supportedContentTypes.first
        let mime = type?.preferredMIMEType ?? "image/jpeg"
        let ext = type?.preferredFilenameExtension ?? "jpg"
        let size = AttachmentUploader.dimensions(of: data)

        return AttachmentUploader.Picked(
            data: data,
            filename: "\(UUID().uuidString).\(ext)",
            mimeType: mime,
            width: size?.width,
            height: size?.height
        )
    }
}
