import CryptoKit
import Foundation
import UIKit

/// The three-step upload, client side.
///
///   POST /media/uploads   → a pending row and a presigned PUT
///   PUT  <presigned url>  → bytes go straight to the bucket, never through us
///   POST /media/:id/confirm → the server HEADs the object and marks it ready
///
/// The bytes bypass the API entirely, which is the whole point: a 20 MB photo
/// routed through Node would hold a request open for the duration and pay for
/// the transfer twice.
///
/// Two details that are easy to get wrong and fail only at the bucket:
///  - the PUT's `Content-Type` must match the type that was signed, so it is set
///    from the same string we sent to the presign call, not re-sniffed;
///  - `Content-Length` is signed too, but URLSession derives it from the body,
///    so echoing the server's header back would duplicate it.
struct AttachmentUploader {
    let repo: YappyRepository
    let http: URLSession

    /// What the picker hands over. Bytes rather than a URL because
    /// `PhotosPickerItem` gives a transferable, not a file path, and copying it
    /// to a temp file first would only add a round trip through the disk.
    struct Picked {
        var data: Data
        var filename: String
        var mimeType: String
        var width: Int?
        var height: Int?
        /// Voice notes and videos; nil for stills.
        var durationMs: Int?
    }

    /// Result of a completed upload — the id is what a message references.
    struct Uploaded {
        let mediaId: String
        let media: Attachment
    }

    func upload(_ picked: Picked, purpose: String = "attachment") async throws -> Uploaded {
        let checksum = SHA256.hash(data: picked.data)
            .map { String(format: "%02x", $0) }
            .joined()

        let created = try await repo.createUpload(
            filename: picked.filename,
            mimeType: picked.mimeType,
            size: picked.data.count,
            purpose: purpose,
            width: picked.width,
            height: picked.height,
            durationMs: picked.durationMs,
            checksum: checksum
        )

        // The server recognised the checksum and reused the stored object.
        // Nothing to upload, nothing to confirm.
        guard let target = created.upload else {
            return Uploaded(mediaId: created.media.id, media: created.media)
        }

        guard let url = URL(string: target.url) else {
            throw ApiError(status: 0, code: "bad_upload_url", message: "The upload address was unusable.")
        }

        var request = URLRequest(url: url)
        request.httpMethod = target.method
        request.setValue(picked.mimeType, forHTTPHeaderField: "Content-Type")
        for (name, value) in target.headers {
            let key = name.lowercased()
            guard key != "content-length", key != "content-type" else { continue }
            request.setValue(value, forHTTPHeaderField: name)
        }

        let (body, response) = try await http.upload(for: request, from: picked.data)
        guard let http = response as? HTTPURLResponse, (200 ..< 300).contains(http.statusCode) else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let detail = String(data: body.prefix(200), encoding: .utf8) ?? ""
            throw ApiError(
                status: status,
                code: "upload_failed",
                message: "Upload failed (\(status)) \(detail)"
            )
        }

        let confirmed = try await repo.confirmUpload(mediaId: created.media.id)
        return Uploaded(mediaId: confirmed.media.id, media: confirmed.media)
    }

    /// Reads the pixel dimensions from the image header only.
    ///
    /// Decoding a 12 MP photo into a `UIImage` just to learn its size is how a
    /// picker gets jetsammed on an older phone, so this uses `CGImageSource`
    /// with the decode suppressed.
    static func dimensions(of data: Data) -> (width: Int, height: Int)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int
        else { return nil }
        return (width, height)
    }
}
