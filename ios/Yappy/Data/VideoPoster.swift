import AVFoundation
import UIKit

/// First-frame posters for videos that have no server-side thumbnail.
///
/// The server generates thumbnails for images but not (yet) for video, so a
/// video note or video file arrives with `thumbnailUrl == nil` and would
/// otherwise show a black rectangle until it is played. This pulls frame zero
/// on the client — over the authed streaming asset for a remote URL, straight
/// off disk for a still-uploading local one — so the bubble shows the frame
/// immediately, the way every messenger does.
///
/// Cached in memory by URL: the same note scrolling in and out of view decodes
/// its poster once.
enum VideoPoster {
    private static let cache = NSCache<NSString, UIImage>()

    static func cached(_ url: String) -> UIImage? {
        cache.object(forKey: url as NSString)
    }

    static func first(url: String, token: String?) async -> UIImage? {
        if let hit = cached(url) { return hit }

        let asset: AVURLAsset?
        if let parsed = URL(string: url), parsed.isFileURL {
            asset = AVURLAsset(url: parsed)
        } else {
            asset = AuthedAsset.make(url: url, token: token)
        }
        guard let asset else { return nil }

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        // A little way in, not dead zero — the very first frame of a phone
        // recording is often a black or half-exposed frame.
        let time = CMTime(seconds: 0.1, preferredTimescale: 600)

        let image: UIImage? = await withCheckedContinuation { continuation in
            generator.generateCGImagesAsynchronously(forTimes: [NSValue(time: time)]) { _, cg, _, _, _ in
                continuation.resume(returning: cg.map { UIImage(cgImage: $0) })
            }
        }

        if let image { cache.setObject(image, forKey: url as NSString) }
        return image
    }
}
