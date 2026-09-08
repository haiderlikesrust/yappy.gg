import Foundation
import UniformTypeIdentifiers

struct ShareFile: Identifiable {
    let id = UUID()
    let url: URL
    let name: String
    let mime: String
    let size: Int
}

struct SharePayload {
    var text = ""
    var files: [ShareFile] = []

    static func load(_ items: [NSExtensionItem], into directory: URL) async throws -> SharePayload {
        var result = SharePayload()
        var texts: [String] = []
        let providers = items.flatMap { $0.attachments ?? [] }
        guard providers.count <= 10 else { throw ShareError(message: "Share up to 10 items at a time.") }
        for item in items {
            if let text = item.attributedContentText?.string, !text.isEmpty { texts.append(text) }
        }
        for provider in providers {
            try Task.checkCancellation()
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                let item = try await value(provider, type: UTType.fileURL.identifier)
                guard let url = item as? URL else { throw ShareError(message: "Couldn’t read the shared file.") }
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                result.files.append(try copy(url, name: provider.suggestedName, into: directory))
            } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                let item = try await value(provider, type: UTType.url.identifier)
                if let url = item as? URL, ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                    texts.append(url.absoluteString)
                } else { throw ShareError(message: "This link type can’t be shared. Try a web link or file.") }
            } else if let type = provider.registeredTypeIdentifiers.first(where: {
                guard let type = UTType($0) else { return false }
                return type.conforms(to: .image) || type.conforms(to: .movie) || type.conforms(to: .audio)
            }) {
                result.files.append(try await file(provider, type: type, directory: directory))
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                let item = try await value(provider, type: UTType.plainText.identifier)
                if let text = item as? String { texts.append(text) }
                else if let text = item as? NSAttributedString { texts.append(text.string) }
                else { throw ShareError(message: "Couldn’t read the shared text.") }
            } else if let type = provider.registeredTypeIdentifiers.first(where: { UTType($0)?.conforms(to: .data) == true }) {
                result.files.append(try await file(provider, type: type, directory: directory))
            } else { throw ShareError(message: "This item can’t be shared. Try saving it to Files first.") }
        }
        var seen = Set<String>()
        result.text = texts.filter { seen.insert($0).inserted }.joined(separator: "\n")
        guard !result.text.isEmpty || !result.files.isEmpty else { throw ShareError(message: "There’s nothing to share.") }
        return result
    }

    private static func value(_ provider: NSItemProvider, type: String) async throws -> NSSecureCoding {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { value, error in
                if let error { continuation.resume(throwing: error) }
                else if let value { continuation.resume(returning: value) }
                else { continuation.resume(throwing: ShareError(message: "The source app didn’t provide this item.")) }
            }
        }
    }

    private static func file(_ provider: NSItemProvider, type: String, directory: URL) async throws -> ShareFile {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                if let error { continuation.resume(throwing: error); return }
                guard let url else { continuation.resume(throwing: ShareError(message: "Couldn’t load this file.")); return }
                // The provider removes its temporary file after this callback.
                do { continuation.resume(returning: try copy(url, name: provider.suggestedName, into: directory, typeHint: UTType(type))) }
                catch { continuation.resume(throwing: error) }
            }
        }
    }

    private static func copy(_ source: URL, name: String?, into directory: URL, typeHint: UTType? = nil) throws -> ShareFile {
        let resource = try source.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey, .contentTypeKey])
        guard resource.isRegularFile == true, let size = resource.fileSize, size > 0 else {
            throw ShareError(message: "Choose a non-empty file, photo, or video.")
        }
        var mime = typeHint?.preferredMIMEType ?? resource.contentType?.preferredMIMEType
            ?? UTType(filenameExtension: source.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        let limits = ["image/jpeg": 25_000_000, "image/png": 25_000_000, "image/webp": 25_000_000,
                      "image/gif": 50_000_000, "image/heic": 40_000_000,
                      "video/mp4": 500_000_000, "video/quicktime": 500_000_000, "video/webm": 500_000_000,
                      "audio/mpeg": 50_000_000, "audio/mp4": 50_000_000, "audio/aac": 50_000_000,
                      "audio/ogg": 50_000_000, "audio/opus": 25_000_000, "audio/webm": 25_000_000,
                      "application/pdf": 100_000_000, "application/zip": 200_000_000,
                      "text/plain": 10_000_000, "application/octet-stream": 200_000_000]
        if limits[mime] == nil { mime = "application/octet-stream" }
        guard size <= (limits[mime] ?? 0) else { throw ShareError(message: "\(source.lastPathComponent) is too large to share.") }
        let destination = directory.appendingPathComponent(UUID().uuidString).appendingPathExtension(source.pathExtension)
        try FileManager.default.copyItem(at: source, to: destination)
        var filename = name.map { URL(fileURLWithPath: $0).lastPathComponent } ?? source.lastPathComponent
        if URL(fileURLWithPath: filename).pathExtension.isEmpty, !source.pathExtension.isEmpty { filename += "." + source.pathExtension }
        return ShareFile(url: destination, name: String(filename.prefix(255)), mime: mime, size: size)
    }
}
