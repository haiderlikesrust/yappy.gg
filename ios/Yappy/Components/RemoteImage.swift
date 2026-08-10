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
        // A count limit alone is no limit at all: 400 full-resolution photos is
        // gigabytes of decoded bitmap, and the way that ends is a jetsam. Every
        // insert declares its pixel cost, and NSCache evicts to stay under this.
        cache.totalCostLimit = 128 * 1024 * 1024
    }

    func attach(tokenProvider: @escaping () -> String?) {
        self.tokenProvider = tokenProvider
    }

    /// The live access token, for the media surfaces (video, voice notes) that
    /// build AVFoundation assets instead of going through this loader.
    func currentToken() -> String? { tokenProvider() }

    func cached(_ url: String) -> UIImage? { cache.object(forKey: url as NSString) }

    /// Bytes of downloaded media currently on disk, for the Storage section.
    var diskUsage: Int { session.configuration.urlCache?.currentDiskUsage ?? 0 }

    /// Drop every cached image, in memory and on disk.
    ///
    /// Media only. Messages live in Postgres and in the snapshot cache, so this
    /// costs a re-download and nothing else — which is what the Settings copy
    /// promises, and the promise is the reason this is separate from
    /// `DiskCache.clear()`.
    func purge() {
        cache.removeAllObjects()
        session.configuration.urlCache?.removeAllCachedResponses()
    }

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

        // Built here, on the main actor, because the token provider reads
        // main-actor session state. The detached task below gets an immutable
        // request and nothing else of ours.
        guard let parsed = URL(string: url) else { return nil }
        var request = URLRequest(url: parsed)
        if let host = parsed.host, AppConfig.apiHosts.contains(host), let token = tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        /**
         * Detached on purpose, and it matters. A plain `Task {}` created inside
         * a `@MainActor` class inherits that isolation, which put `decode` — a
         * synchronous full-image decode — on the main thread. Every photo that
         * scrolled into view stole 50–150ms from the UI right as it was
         * animating, which is most of what "the app feels slow" was. The
         * network await never blocked anything; the decode after it did.
         */
        let fetch = request
        let task = Task.detached(priority: .userInitiated) { [session] () -> UIImage? in
            guard let (data, response) = try? await session.data(for: fetch) else { return nil }
            if let http = response as? HTTPURLResponse, !(200 ..< 300).contains(http.statusCode) {
                return nil
            }
            return ImageLoader.decode(data)
        }

        inFlight[url] = task
        let image = await task.value
        inFlight[url] = nil
        if let image { cache.setObject(image, forKey: url as NSString, cost: Self.cost(of: image)) }
        return image
    }

    /// Longest edge a decoded still is allowed. Bubbles and the viewer both
    /// render well under this; decoding a 4000-pixel original to show 320
    /// points is pure memory burn.
    private static let maxStillPixels: CGFloat = 1400
    /// Animated frames stay smaller — every frame is held in memory at once,
    /// so a 100-frame GIF at still resolution would be a quarter-gigabyte.
    private static let maxAnimatedPixels: CGFloat = 720

    /// Decoded bitmap size, which is what the cache is actually storing.
    nonisolated private static func cost(of image: UIImage) -> Int {
        let frames = image.images ?? [image]
        return frames.reduce(0) { total, frame in
            guard let cg = frame.cgImage else { return total }
            return total + cg.width * cg.height * 4
        }
    }

    /// Decode, downsampled at the source.
    ///
    /// `CGImageSourceCreateThumbnailAtIndex` scales *while* decoding, so the
    /// full-resolution bitmap never exists — neither the memory spike nor the
    /// decode time of the original is ever paid. `UIImage(data:)` remains only
    /// as the fallback for formats ImageIO does not recognise.
    ///
    /// Frame delays are read per frame rather than assumed uniform — a GIF with
    /// a long final frame is a common way to end a loop, and averaging it away
    /// makes the animation feel wrong.
    nonisolated static func decode(_ data: Data) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
            return UIImage(data: data)
        }
        let frameCount = CGImageSourceGetCount(source)

        let options: (CGFloat) -> CFDictionary = { maxPixels in
            [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                // Bakes the EXIF orientation into the bitmap, which is also why
                // the result needs no UIImage orientation bookkeeping.
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            ] as CFDictionary
        }

        guard frameCount > 1 else {
            guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options(maxStillPixels)) else {
                return UIImage(data: data)
            }
            return UIImage(cgImage: cgImage)
        }

        var frames: [UIImage] = []
        var totalDuration: Double = 0

        for index in 0 ..< frameCount {
            guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, index, options(maxAnimatedPixels)) else { continue }
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

    /// Never volunteer the file's pixel size to the layout.
    ///
    /// The default sizing consults the image view's intrinsic content size,
    /// which for a decoded GIF is its pixel dimensions — up to 720 points of
    /// "ideal" width. Where the proposal is concrete that mostly loses, but it
    /// does not always lose: a cell that let the intrinsic size through grew to
    /// the file's width, pushed its row past the screen edge, and the enclosing
    /// ScrollView centred the overwide content — every section on the page
    /// rendered shifted and full-bleed. Accept what is proposed; where nothing
    /// is, fall back to the intrinsic size capped at the screen's width.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UIImageView, context: Context) -> CGSize? {
        let intrinsic = uiView.intrinsicContentSize
        let cap = UIScreen.main.bounds.width
        let fallbackWidth = min(max(intrinsic.width, 1), cap)
        let fallbackHeight = intrinsic.width > 0 && intrinsic.height > 0
            ? fallbackWidth * intrinsic.height / intrinsic.width
            : fallbackWidth
        return CGSize(
            width: proposal.width ?? fallbackWidth,
            height: proposal.height ?? fallbackHeight
        )
    }
}
