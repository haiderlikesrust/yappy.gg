import AVFoundation
import ImageIO
import PhotosUI
import SwiftUI
import UIKit

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
    /// Stills are re-encoded to a downscaled JPEG before upload, which is what
    /// every major chat app does, for three reasons that all bit here:
    ///
    ///  1. **Size.** A camera photo is 3–8 MB and 4000 pixels wide; the bubble
    ///     it lands in is 300 points. Sending ~2000px at JPEG 0.8 cuts the
    ///     upload — and the recipient's download — by an order of magnitude,
    ///     which is most of the difference between "sending…" and "sent".
    ///  2. **HEIC.** iPhones shoot HEIC, and nothing else in the system can
    ///     decode it: the worker's thumbnailer (no HEVC in its libvips) and
    ///     older Android both choke. JPEG is the one format every consumer of
    ///     this byte stream understands.
    ///  3. **Metadata.** Re-encoding through a bitmap drops EXIF wholesale —
    ///     including GPS, which has no business travelling with a chat photo.
    ///
    /// GIFs are exempt: recompressing one kills the animation, and they are
    /// already screen-sized.
    func picked() async -> AttachmentUploader.Picked? {
        guard let data = try? await loadTransferable(type: Data.self) else { return nil }

        let type = supportedContentTypes.first
        let mime = type?.preferredMIMEType ?? "image/jpeg"

        // A video from the library goes up as-is — recompressing one on the
        // phone is minutes of battery for a marginal saving. Dimensions and
        // duration come from the container's metadata via a temp file, since
        // AVFoundation reads assets, not byte buffers.
        if type?.conforms(to: .movie) == true || mime.hasPrefix("video/") {
            let ext = type?.preferredFilenameExtension ?? "mp4"
            let temp = FileManager.default.temporaryDirectory
                .appendingPathComponent("picked-\(UUID().uuidString).\(ext)")
            try? data.write(to: temp, options: .atomic)
            defer { try? FileManager.default.removeItem(at: temp) }

            let asset = AVURLAsset(url: temp)
            let durationMs = (try? await asset.load(.duration)).map { Int($0.seconds * 1000) }
            var width: Int?
            var height: Int?
            if let track = try? await asset.loadTracks(withMediaType: .video).first,
               let size = try? await track.load(.naturalSize),
               let transform = try? await track.load(.preferredTransform) {
                let rotated = size.applying(transform)
                width = Int(abs(rotated.width))
                height = Int(abs(rotated.height))
            }

            return AttachmentUploader.Picked(
                data: data,
                filename: "\(UUID().uuidString).\(ext)",
                mimeType: mime.hasPrefix("video/") ? mime : "video/quicktime",
                width: width,
                height: height,
                durationMs: durationMs
            )
        }

        if mime != "image/gif", let reencoded = Self.reencodeForUpload(data) {
            return AttachmentUploader.Picked(
                data: reencoded.data,
                filename: "\(UUID().uuidString).jpg",
                mimeType: "image/jpeg",
                width: reencoded.width,
                height: reencoded.height
            )
        }

        // The original bytes, for GIFs and for anything the re-encode could
        // not read. Dimensions from the header, not a decode: the presign call
        // wants width and height, and decoding a 12 MP photo to learn them is
        // how a picker gets the app jetsammed on an older phone.
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

    /// Decode downsampled — the full-resolution bitmap never exists — and
    /// re-encode as JPEG. Runs off the main actor; the picker calls this from
    /// a plain task and a two-megapixel encode is work worth keeping off the
    /// UI thread.
    private static func reencodeForUpload(_ data: Data) -> (data: Data, width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            // Bake the orientation in. EXIF is about to be dropped, and a
            // sideways photo with no orientation tag stays sideways for ever.
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2048,
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        guard let jpeg = UIImage(cgImage: cgImage).jpegData(compressionQuality: 0.82) else { return nil }
        return (jpeg, cgImage.width, cgImage.height)
    }
}
