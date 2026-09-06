import Foundation

enum SupportLinks {
    /// Only the case capability is carried onto the configured support site.
    static func url(appeal: Bool = false, source: String? = nil) -> URL {
        var components = URLComponents(string: AppConfig.webUrl + "/support/")!
        let version = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "unknown"
        let build = (Bundle.main.infoDictionary?["CFBundleVersion"] as? String) ?? "unknown"
        components.queryItems = [URLQueryItem(name: "client", value: "iOS · \(version) (\(build))")]
        if appeal {
            components.queryItems?.append(URLQueryItem(name: "topic", value: "appeal"))
            if let source, let fragment = URLComponents(string: source)?.percentEncodedFragment,
               let token = URLComponents(string: "https://yappy.gg/?" + fragment)?.queryItems?.first(where: { $0.name == "appeal" })?.value,
               !token.isEmpty, token.count <= 2000,
               token.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil {
                components.fragment = "appeal=" + token
            }
        }
        return components.url!
    }
}
