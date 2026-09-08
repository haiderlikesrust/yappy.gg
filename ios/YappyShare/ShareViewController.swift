import SwiftUI
import UIKit
import LocalAuthentication

@MainActor
final class ShareViewController: UIViewController {
    private var model: ShareModel?

    override func viewDidLoad() {
        super.viewDidLoad()
        guard let context = extensionContext else { return }
        let model = ShareModel(context: context)
        self.model = model
        let host = UIHostingController(rootView: ShareSheet(model: model))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        host.didMove(toParent: self)
    }
}

@MainActor
final class ShareModel: ObservableObject {
    @Published var text = ""
    @Published var query = ""
    @Published private(set) var files: [ShareFile] = []
    @Published private(set) var places: [SharePlace] = []
    @Published private(set) var space: SharePlace?
    @Published private(set) var selected: SharePlace?
    @Published private(set) var busy = false
    @Published private(set) var ready = false
    @Published private(set) var sendAttempted = false
    @Published private(set) var progress = ""
    @Published private(set) var error: String?
    @Published private(set) var nextCursor: String?
    private let context: NSExtensionContext
    private let directory = FileManager.default.temporaryDirectory.appendingPathComponent("yappy-share-" + UUID().uuidString)
    private var api: ShareAPI?
    private var rootPlaces: [SharePlace] = []
    private var rootCursor: String?
    private var uploaded: [UUID: String] = [:]
    private let nonce = UUID().uuidString

    init(context: NSExtensionContext) { self.context = context }
    deinit { try? FileManager.default.removeItem(at: directory) }

    var filtered: [SharePlace] {
        places.filter { query.isEmpty || $0.label.localizedCaseInsensitiveContains(query) }
    }
    var valid: Bool {
        ready && selected != nil && !busy && text.utf16.count <= 8_000
            && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty)
    }

    func prepare() async {
        guard !busy, !ready else { return }
        busy = true; error = nil; progress = "Preparing…"
        defer { busy = false }
        do {
            if SharedSession.appLockEnabled {
                let auth = LAContext()
                _ = try await auth.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock yappy to share with a place.")
            }
            let api = try ShareAPI()
            self.api = api
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                     attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            let payload = try await SharePayload.load(context.inputItems.compactMap { $0 as? NSExtensionItem }, into: directory)
            files = payload.files; text = payload.text
            try await loadRoots(api, cursor: nil)
            ready = true
        } catch { self.error = error.localizedDescription }
    }

    private func loadRoots(_ api: ShareAPI, cursor: String?) async throws {
        struct Page: Decodable { let conversations: [SharePlace]; let nextCursor: String? }
        var components = URLComponents()
        components.queryItems = [URLQueryItem(name: "limit", value: "50")]
        if let cursor { components.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        let page: Page = try await api.request("/conversations?" + (components.percentEncodedQuery ?? ""))
        let eligible = page.conversations.filter { ["group", "space", "channel"].contains($0.type ?? "") && $0.acceptsShare }
        if cursor == nil { rootPlaces = [] }
        var ids = Set(rootPlaces.map(\.id))
        rootPlaces += eligible.filter { ids.insert($0.id).inserted }
        rootCursor = page.nextCursor == cursor ? nil : page.nextCursor
        places = rootPlaces; nextCursor = rootCursor
    }

    func more() async {
        guard !busy, let api, let cursor = nextCursor else { return }
        busy = true; error = nil; progress = "Loading places…"
        defer { busy = false }
        do { try await loadRoots(api, cursor: cursor) }
        catch { self.error = error.localizedDescription }
    }

    func choose(_ place: SharePlace) async {
        guard !busy, !sendAttempted, let api else { return }
        if !place.isSpace { selected = place; return }
        busy = true; error = nil; progress = "Loading channels…"
        defer { busy = false }
        do {
            struct Page: Decodable { let channels: [SharePlace] }
            let page: Page = try await api.request("/conversations/\(place.id)/channels")
            places = page.channels.filter(\.acceptsShare)
            space = place; nextCursor = nil; query = ""
        } catch { self.error = error.localizedDescription }
    }

    func backToPlaces() {
        space = nil; places = rootPlaces; nextCursor = rootCursor; query = ""
    }

    func send() async {
        guard valid, let selected, let api else { return }
        busy = true; error = nil; progress = "Sending…"
        defer { busy = false }
        do {
            // Permission may have changed after the recent-place list was fetched.
            struct Envelope: Decodable { let conversation: SharePlace }
            let latest: Envelope = try await api.request("/conversations/\(selected.id)")
            guard latest.conversation.acceptsShare, !latest.conversation.isSpace else {
                throw ShareError(message: "You can’t post to this place right now. Choose another place.")
            }
            for (index, file) in files.enumerated() where uploaded[file.id] == nil {
                progress = "Uploading \(index + 1) of \(files.count)…"
                uploaded[file.id] = try await api.upload(file)
            }
            try Task.checkCancellation()
            let ids = files.compactMap { uploaded[$0.id] }
            var body: [String: Any] = ["nonce": nonce, "type": ids.isEmpty ? "text" : (files.allSatisfy { $0.mime.hasPrefix("image/") } ? "image" : "file")]
            if !text.isEmpty { body["content"] = text }
            if !ids.isEmpty { body["attachmentIds"] = ids }
            // Freeze the draft before the request can reach the server. A retry
            // reuses both content and nonce if its response was lost in transit.
            sendAttempted = true; progress = "Sending to \(selected.label)…"
            struct Sent: Decodable { struct Message: Decodable { let id: String }; let message: Message }
            let _: Sent = try await api.request("/conversations/\(selected.id)/messages", method: "POST", body: body)
            context.completeRequest(returningItems: [], completionHandler: nil)
        } catch {
            self.error = error.localizedDescription
            if sendAttempted { self.error = "\(error.localizedDescription) Retry to confirm this same message without sending a duplicate." }
        }
    }

    func cancel() {
        guard !busy else { return }
        context.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }
}

private struct ShareSheet: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        NavigationStack {
            Form {
                if model.ready {
                    Section("Share") {
                        TextEditor(text: $model.text)
                            .frame(minHeight: 80, maxHeight: 140)
                            .accessibilityLabel("Message or caption")
                            .disabled(model.busy || model.sendAttempted)
                        if model.text.utf16.count > 8_000 { Text("Keep your message under 8,000 characters.").foregroundStyle(.red) }
                        ForEach(model.files) { file in
                            Label("\(file.name) · \(ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file))",
                                  systemImage: file.mime.hasPrefix("image/") ? "photo" : "doc")
                                .font(.footnote).lineLimit(2)
                        }
                    }
                    Section(model.space?.label ?? "Recent places") {
                        if model.space != nil {
                            Button("Back to places", systemImage: "chevron.left") { model.backToPlaces() }
                        }
                        TextField("Find a place", text: $model.query)
                        ForEach(model.filtered) { place in
                            Button { Task { await model.choose(place) } } label: {
                                HStack {
                                    Label(place.label, systemImage: place.isSpace ? "square.grid.2x2" : "bubble.left.and.bubble.right")
                                    Spacer()
                                    if place.isSpace { Image(systemName: "chevron.right") }
                                    else if model.selected?.id == place.id { Image(systemName: "checkmark.circle.fill") }
                                }
                            }
                        }
                        if model.filtered.isEmpty { Text("No places here. Load more or open yappy to join a group.").foregroundStyle(.secondary) }
                        if model.nextCursor != nil { Button("Load more places") { Task { await model.more() } } }
                    }
                    .disabled(model.busy || model.sendAttempted)
                }
                if model.busy { ProgressView(model.progress) }
                if let error = model.error {
                    Section {
                        Text(error).foregroundStyle(.secondary)
                        if !model.ready { Button("Try again") { Task { await model.prepare() } }.disabled(model.busy) }
                    }
                }
            }
            .navigationTitle("Share to yappy")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: model.cancel).disabled(model.busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.sendAttempted ? "Retry" : "Send") { Task { await model.send() } }.disabled(!model.valid)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if let place = model.selected {
                    Text("To: \(place.label)").font(.subheadline).padding(12)
                        .frame(maxWidth: .infinity).background(.regularMaterial)
                }
            }
        }
        .tint(.purple)
        .interactiveDismissDisabled(model.busy)
        .task { await model.prepare() }
    }
}
