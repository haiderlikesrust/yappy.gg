import ImageIO
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The image pipeline.
///
/// `AsyncImage` cannot do the two things this app needs:
///
///  1. **Authorised media.** Message attachments are private — the API serves
///     them only to members of the conversation they were posted in, so image
///     requests to our own host need the access token. Sent *only* to our host:
///     attaching it to a Tenor URL would leak the session to a third party.
///  2. **Animated GIFs.** Half the point of the GIF picker is that they move,
///     and `Image` renders only the first frame.
@MainActor
final class ImageLoader {
    static let shared = ImageLoader()

    private let cache = NSCache<NSString, UIImage>()
    private let session: URLSession
    private var tokenProvider: () -> String? = { nil }
    private var inFlight: [String: Task<UIImage?, Never>] = [:]

    private init() {
        let configuration = URLSessionConfiguration.default
        // A generous on-disk cache: avatars and stickers are requested on nearly
        // every screen and almost never change.
        configuration.urlCache = URLCache(
            memoryCapacity: 32 * 1024 * 1024,
            diskCapacity: 256 * 1024 * 1024
        )
        configuration.requestCachePolicy = .returnCacheDataElseLoad
        session = URLSession(configuration: configuration)
        cache.countLimit = 400
    }

    func attach(tokenProvider: @escaping () -> String?) {
        self.tokenProvider = tokenProvider
    }

    func cached(_ url: String) -> UIImage? { cache.object(forKey: url as NSString) }

    /// Forget a URL's bytes, in memory and on disk.
    ///
    /// Needed because the API may reuse a URL for replaced media — a new avatar
    /// at the same address. Without this the old picture survives every cache
    /// lookup and only a reinstall clears it.
    func invalidate(_ url: String) {
        cache.removeObject(forKey: url as NSString)
        guard let parsed = URL(string: url) else { return }
        session.configuration.urlCache?.removeCachedResponse(for: URLRequest(url: parsed))
    }

    func load(_ url: String) async -> UIImage? {
        if let hit = cached(url) { return hit }

        // Two bubbles showing the same sticker should cause one request, not two.
        if let existing = inFlight[url] { return await existing.value }

        let task = Task<UIImage?, Never> { [session, tokenProvider] in
            guard let parsed = URL(string: url) else { return nil }

            var request = URLRequest(url: parsed)
            if let host = parsed.host, AppConfig.apiHosts.contains(host), let token = tokenProvider() {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }

            guard let (data, response) = try? await session.data(for: request) else { return nil }
            if let http = response as? HTTPURLResponse, !(200 ..< 300).contains(http.statusCode) {
                return nil
            }
            return Self.decode(data)
        }

        inFlight[url] = task
        let image = await task.value
        inFlight[url] = nil
        if let image { cache.setObject(image, forKey: url as NSString) }
        return image
    }

    /// Decodes on a background queue, animating when the payload has more than
    /// one frame.
    ///
    /// Frame delays are read per frame rather than assumed uniform — a GIF with
    /// a long final frame is a common way to end a loop, and averaging it away
    /// makes the animation feel wrong.
    nonisolated static func decode(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            return UIImage(data: data)
        }
        let frameCount = CGImageSourceGetCount(source)
        guard frameCount > 1 else { return UIImage(data: data) }

        var frames: [UIImage] = []
        var totalDuration: Double = 0

        for index in 0 ..< frameCount {
            guard let cgImage = CGImageSourceCreateImageAtIndex(source, index, nil) else { continue }
            frames.append(UIImage(cgImage: cgImage))

            let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
            let gif = properties?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
            let webp = properties?[kCGImagePropertyWebPDictionary] as? [CFString: Any]
            let container = gif ?? webp

            let unclamped = container?[kCGImagePropertyGIFUnclampedDelayTime] as? Double
            let clamped = container?[kCGImagePropertyGIFDelayTime] as? Double
            // Browsers floor anything under 20ms at 100ms; matching that keeps a
            // "0 delay" GIF from running at display refresh rate and burning
            // battery.
            var delay = unclamped ?? clamped ?? 0.1
            if delay < 0.02 { delay = 0.1 }
            totalDuration += delay
        }

        guard !frames.isEmpty else { return UIImage(data: data) }
        return UIImage.animatedImage(with: frames, duration: totalDuration)
    }
}

/// An image from the network, with a placeholder while it loads.
///
/// `contentMode` rather than SwiftUI's `.resizable().scaledToFill()` at the call
/// site, because a fill has to be clipped to its frame and forgetting the clip
/// is how one wide photo pushes a whole message list sideways.
struct RemoteImage<Placeholder: View>: View {
    let url: String?
    var contentMode: ContentMode = .fill
    @ViewBuilder var placeholder: () -> Placeholder

    @State private var image: UIImage?
    @State private var loadedUrl: String?

    var body: some View {
        Group {
            if let image {
                if image.images == nil {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: contentMode)
                } else {
                    // Animated frames need a UIImageView; SwiftUI's Image shows
                    // only `image.images.first`.
                    AnimatedImage(image: image, contentMode: contentMode)
                }
            } else {
                placeholder()
            }
        }
        .task(id: url) { await load() }
    }

    private func load() async {
        guard let url, !url.isEmpty else {
            image = nil
            return
        }
        guard loadedUrl != url else { return }

        // A cache hit renders on the first frame, so a scrolling list of avatars
        // does not flash a placeholder on every cell that comes back into view.
        if let hit = ImageLoader.shared.cached(url) {
            image = hit
            loadedUrl = url
            return
        }

        image = nil
        let loaded = await ImageLoader.shared.load(url)
        guard !Task.isCancelled else { return }
        image = loaded
        loadedUrl = url
    }
}

extension RemoteImage where Placeholder == Color {
    init(url: String?, contentMode: ContentMode = .fill) {
        self.init(url: url, contentMode: contentMode) { Color.clear }
    }
}

private struct AnimatedImage: UIViewRepresentable {
    let image: UIImage
    let contentMode: ContentMode

    func makeUIView(context: Context) -> UIImageView {
        let view = UIImageView()
        view.clipsToBounds = true
        view.contentMode = contentMode == .fill ? .scaleAspectFill : .scaleAspectFit
        // Without these the view refuses to shrink below the intrinsic size of a
        // large GIF and blows out the layout it sits in.
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        view.setContentHuggingPriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.defaultLow, for: .vertical)
        return view
    }

    func updateUIView(_ view: UIImageView, context: Context) {
        view.image = image
        view.contentMode = contentMode == .fill ? .scaleAspectFill : .scaleAspectFit
    }
}
