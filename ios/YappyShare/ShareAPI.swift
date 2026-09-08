import Foundation

struct ShareError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private struct ShareErrorBody: Decodable {
    struct Detail: Decodable { var message: String? }
    var error: Detail?
}

struct SharePlace: Decodable, Identifiable, Hashable {
    let id: String
    var type: String?
    var title: String?
    var parentTitle: String?
    var canPost: Bool?
    var isVoice: Bool?
    var isForum: Bool?
    var label: String { parentTitle.map { "\($0) / \(title ?? "Channel")" } ?? title ?? "Group" }
    var isSpace: Bool { type == "space" }
    var acceptsShare: Bool { canPost != false && isVoice != true && isForum != true }
}

/// An extension-sized client using the same session and refresh lease as the app.
@MainActor
final class ShareAPI {
    private let id: UUID
    private let endpoints = Endpoints(apiUrls: AppConfig.apiUrls, gatewayUrls: [])
    private let http: URLSession

    init() throws {
        guard let record = try SharedSession.read(), record.accessToken != nil else {
            throw ShareError(message: "Open yappy and sign in, then try sharing again.")
        }
        id = record.id
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 300
        http = URLSession(configuration: config)
    }

    func request<T: Decodable>(_ path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> T {
        for attempt in 0..<2 {
            try Task.checkCancellation()
            guard let record = try SharedSession.read(), record.id == id, let token = record.accessToken else {
                throw ShareError(message: "Your sign-in changed. Close this sheet and try again.")
            }
            let base = endpoints.apiBase
            guard let url = URL(string: base + path) else { throw ShareError(message: "Invalid share address.") }
            var request = URLRequest(url: url)
            request.httpMethod = method
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            if method != "GET" {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body ?? [:])
            }
            let data: Data
            let response: URLResponse
            do { (data, response) = try await http.data(for: request) }
            catch let error as URLError where [.cannotFindHost, .cannotConnectToHost, .dnsLookupFailed].contains(error.code) && attempt == 0 {
                guard endpoints.failOver(from: base) != nil else { throw error }
                continue
            }
            guard try SharedSession.read()?.id == id else { throw ShareError(message: "Your sign-in changed. Try again from yappy.") }
            guard let status = (response as? HTTPURLResponse)?.statusCode else { throw ShareError(message: "No response. Try again.") }
            if status == 401 && attempt == 0 {
                do { try await SharedSession.refresh(id: id, failedAccess: token, base: base, http: http) }
                catch SharedSession.Failure.rejected { throw ShareError(message: "Open yappy and sign in again to share.") }
                catch { throw ShareError(message: "Couldn’t refresh your sign-in. Open yappy, then try again.") }
                continue
            }
            guard (200..<300).contains(status) else {
                let detail = try? JSONDecoder().decode(ShareErrorBody.self, from: data)
                throw ShareError(message: detail?.error?.message ?? "Couldn’t share (\(status)). Try again.")
            }
            return try JSONDecoder().decode(T.self, from: data)
        }
        throw ShareError(message: "Couldn’t reconnect. Open yappy, then try again.")
    }

    func upload(_ file: ShareFile) async throws -> String {
        struct Media: Decodable { let id: String }
        struct Target: Decodable { let url: String; let method: String; let headers: [String: String] }
        struct Upload: Decodable { let media: Media; let upload: Target? }
        let created: Upload = try await request("/media/uploads", method: "POST", body: [
            "filename": file.name, "mimeType": file.mime, "size": file.size, "purpose": "attachment",
        ])
        guard let target = created.upload else { return created.media.id }
        guard let url = URL(string: target.url), ["https", "http"].contains(url.scheme ?? "") else {
            throw ShareError(message: "The upload address was unusable.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = target.method
        request.setValue(file.mime, forHTTPHeaderField: "Content-Type")
        for (name, value) in target.headers where !["content-length", "content-type", "authorization"].contains(name.lowercased()) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        // Stream from disk; a video must not fill the extension's memory budget.
        let (_, response) = try await http.upload(for: request, fromFile: file.url)
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
            throw ShareError(message: "Couldn’t upload \(file.name). Try again.")
        }
        struct Confirmed: Decodable { let media: Media }
        let confirmed: Confirmed = try await self.request("/media/\(created.media.id)/confirm", method: "POST")
        return confirmed.media.id
    }
}
