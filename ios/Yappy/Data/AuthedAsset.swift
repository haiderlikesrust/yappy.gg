import AVFoundation
import Foundation

/// An `AVURLAsset` that can stream a bearer-protected URL.
///
/// `AVURLAssetHTTPHeaderFieldsKey` is the only documented way to attach a header
/// to an asset, and iOS ignores it often enough that it cannot be relied on —
/// the request goes out unauthenticated, 401s, and the player shows a black
/// frame with no error. This routes the asset through a custom scheme so a
/// resource-loader delegate handles every range request itself, with the token
/// attached, which is the supported way to stream private media.
///
/// Kept only for large media (video files) that cannot simply be downloaded
/// first; short clips (voice notes, video notes) fetch-then-play instead, which
/// is simpler and needs none of this.
enum AuthedAsset {
    /// Build an asset for a possibly-private URL. A public or local URL gets a
    /// plain asset; an API-hosted one gets the loader.
    static func make(url: String, token: String?) -> AVURLAsset? {
        guard let parsed = URL(string: url) else { return nil }
        guard let host = parsed.host, AppConfig.apiHosts.contains(host), let token else {
            return AVURLAsset(url: parsed)
        }
        guard var components = URLComponents(url: parsed, resolvingAgainstBaseURL: false) else {
            return AVURLAsset(url: parsed)
        }
        components.scheme = Self.scheme
        guard let tagged = components.url else { return AVURLAsset(url: parsed) }

        let asset = AVURLAsset(url: tagged)
        let loader = Loader(realURL: parsed, token: token)
        // The delegate must outlive the call; the asset holds only a weak
        // reference, so it is parked on the asset via an associated object.
        objc_setAssociatedObject(asset, &Self.loaderKey, loader, .OBJC_ASSOCIATION_RETAIN)
        asset.resourceLoader.setDelegate(loader, queue: DispatchQueue(label: "gg.yappy.assetloader"))
        return asset
    }

    private static let scheme = "yappy-authed"
    private nonisolated(unsafe) static var loaderKey = 0

    private final class Loader: NSObject, AVAssetResourceLoaderDelegate {
        private let realURL: URL
        private let token: String
        private let session = URLSession(configuration: .default)

        init(realURL: URL, token: String) {
            self.realURL = realURL
            self.token = token
        }

        func resourceLoader(
            _: AVAssetResourceLoader,
            shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
        ) -> Bool {
            var request = URLRequest(url: realURL)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

            // Honour the byte range AVFoundation asked for — seeking and
            // progressive playback both depend on it.
            if let dataRequest = loadingRequest.dataRequest {
                let start = dataRequest.requestedOffset
                let length = dataRequest.requestedLength
                if !(dataRequest.requestsAllDataToEndOfResource && start == 0) {
                    let end = start + Int64(length) - 1
                    request.setValue("bytes=\(start)-\(end)", forHTTPHeaderField: "Range")
                }
            }

            session.dataTask(with: request) { data, response, error in
                if let error {
                    loadingRequest.finishLoading(with: error)
                    return
                }
                if let http = response as? HTTPURLResponse,
                   let info = loadingRequest.contentInformationRequest {
                    info.contentType = http.mimeType ?? "video/mp4"
                    info.isByteRangeAccessSupported =
                        http.statusCode == 206 || http.value(forHTTPHeaderField: "Accept-Ranges") == "bytes"
                    if let total = Self.totalLength(from: http) {
                        info.contentLength = total
                    }
                }
                if let data { loadingRequest.dataRequest?.respond(with: data) }
                loadingRequest.finishLoading()
            }.resume()

            return true
        }

        /// Total resource size from either Content-Range (on a 206) or
        /// Content-Length (on a 200).
        private static func totalLength(from http: HTTPURLResponse) -> Int64? {
            if let range = http.value(forHTTPHeaderField: "Content-Range"),
               let total = range.split(separator: "/").last, let value = Int64(total) {
                return value
            }
            if http.statusCode == 200, http.expectedContentLength > 0 {
                return http.expectedContentLength
            }
            return nil
        }
    }
}
