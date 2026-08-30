import CryptoKit
import Intents
import UniformTypeIdentifiers
import UserNotifications

/**
 * Communication notifications.
 *
 * Android reached this by going data-only and drawing `MessagingStyle` itself
 * — the note in `apps/worker/src/jobs/push.ts` explains why: a plain
 * notification block means the OS draws a title and two lines and that is the
 * ceiling, no avatars, no history. iOS has the same ceiling and a different
 * door out of it. Rather than hand the app a silent push and let it draw,
 * `UNNotificationContent.updating(from:)` takes an `INSendMessageIntent` and
 * restyles the notification into the same treatment Messages gets: the
 * sender's name as the title, their face beside it, the conversation grouped
 * by person rather than by app.
 *
 * What that buys beyond looks — and this is the part worth the extension:
 *
 *   · the notification is attributed to a **person**, so it can break through
 *     Focus when that person is on the allow-list, and it shows on the lock
 *     screen the way a message from a human does;
 *   · donating the interaction puts the conversation in the share sheet's
 *     suggestions and in Siri;
 *   · the sender's avatar appears without the app ever having launched.
 *
 * **The entitlement is not currently held.** `com.apple.developer.usernotifications.communication`
 * has to be enabled on the App ID in the Developer portal, and it is one of the
 * few capabilities `xcodebuild -allowProvisioningUpdates` cannot register on
 * its own — so a device build fails to sign with it declared. It is therefore
 * out of the entitlements files for now, `updating(from:)` throws, and the
 * restyling silently does not happen.
 *
 * What still works without it, and why this extension is not dead weight:
 *
 *   · the avatar is attached to the notification as an image, so a message
 *     arrives with the sender's face on it — not the full person treatment,
 *     but not the bare app icon either;
 *   · the intent is still donated, which is what reaches Siri and the share
 *     sheet's suggestions.
 *
 * Re-adding the entitlement once the portal has the capability turns the full
 * treatment back on with no code change — `updating(from:)` is already called
 * and already falls back.
 *
 * Everything degrades to exactly today's behaviour on every failure path. The
 * avatar fetch can fail or time out, the payload can be from an older API, the
 * restyle can throw — each falls through to the unmodified content iOS would
 * have shown anyway. There is no state in which this extension makes a
 * notification worse than not having it.
 */
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?
    private var work: Task<Void, Never>?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        handler = contentHandler
        let mutable = request.content.mutableCopy() as? UNMutableNotificationContent
        bestAttempt = mutable

        guard let mutable else {
            contentHandler(request.content)
            return
        }

        let info = request.content.userInfo

        // Only messages get the person treatment. A reaction or an account
        // notice has no sender to attribute it to in this sense, and dressing
        // one up as a message from a human is a lie the Focus allow-list would
        // then act on.
        guard info["type"] as? String == "message",
              let senderId = info["senderId"] as? String,
              let senderName = info["senderName"] as? String,
              let conversationId = info["conversationId"] as? String
        else {
            contentHandler(mutable)
            return
        }

        let isGroup = (info["isGroup"] as? String) == "1"
        let groupName = info["conversationTitle"] as? String
        let avatarUrl = info["senderAvatarUrl"] as? String

        /**
         * The unfused message text.
         *
         * `body` arrives as "Haider: hey" in a group, because that is what a
         * notification without a sender attached has to say. Once the intent
         * carries the sender, the same string renders under their name and
         * their face — "Haider · Haider: hey". The server sends the raw
         * preview alongside for exactly this, and the fallback keeps older API
         * builds rendering the fused form rather than nothing.
         */
        let body = (info["messagePreview"] as? String) ?? mutable.body

        work = Task { [weak self] in
            let data = await Self.avatarData(from: avatarUrl)
            guard !Task.isCancelled else { return }

            let image = data.flatMap { INImage(imageData: $0) }

            // The half that works with no entitlement: the face as an
            // attachment. iOS *moves* the file it is given, so this is written
            // fresh each time rather than handed the cached copy — attaching
            // the cache entry would delete it on first use.
            if let data, let attached = Self.attachment(for: data, url: avatarUrl) {
                mutable.attachments = [attached]
            }

            let intent = Self.intent(
                senderId: senderId,
                senderName: senderName,
                image: image,
                body: body,
                conversationId: conversationId,
                isGroup: isGroup,
                groupName: groupName
            )

            // Donating is what reaches Siri and the share sheet; it is
            // deliberately separate from the restyle below, which is what
            // reaches the notification itself. Either can work without the
            // other.
            let interaction = INInteraction(intent: intent, response: nil)
            interaction.direction = .incoming
            interaction.donate(completion: nil)

            // Throws without the entitlement, and on a malformed intent. The
            // un-styled notification is the correct thing to show then — it is
            // what shipped before this extension existed.
            let final = (try? mutable.updating(from: intent)) ?? mutable
            self?.deliver(final)
        }
    }

    /**
     * iOS is about to give up on us.
     *
     * Whatever has been assembled so far ships — an un-styled notification is
     * worth far more than a dropped one, and this is the path a slow avatar
     * fetch on a bad connection actually takes.
     */
    override func serviceExtensionTimeWillExpire() {
        work?.cancel()
        if let bestAttempt { deliver(bestAttempt) }
    }

    /// Guards against both paths firing: `contentHandler` must be called
    /// exactly once, and the expiry callback races the fetch by design.
    private func deliver(_ content: UNNotificationContent) {
        guard let handler else { return }
        self.handler = nil
        handler(content)
    }

    // ── Intent ───────────────────────────────────────────────────────────────

    private static func intent(
        senderId: String,
        senderName: String,
        image: INImage?,
        body: String,
        conversationId: String,
        isGroup: Bool,
        groupName: String?
    ) -> INSendMessageIntent {
        /**
         * `customIdentifier` is the sender's user id, and that choice is what
         * makes the grouping work: iOS threads notifications by the person's
         * identity, so a stable id means every message from one person lands in
         * one stack. Keying on the display name instead would split the stack
         * the moment somebody renamed themselves.
         *
         * `personHandle` carries the same id rather than a phone number or
         * email — the honest answer for an account-based messenger, and the
         * `.unknown` type is what tells the system not to try to resolve it
         * against Contacts.
         */
        let sender = INPerson(
            personHandle: INPersonHandle(value: senderId, type: .unknown),
            nameComponents: nil,
            displayName: senderName,
            image: image,
            contactIdentifier: nil,
            customIdentifier: senderId
        )

        let intent = INSendMessageIntent(
            recipients: nil,
            outgoingMessageType: .outgoingMessageText,
            content: body,
            // Present only for a group, and it is what makes the notification
            // read "Haider · NARF" rather than dropping the room entirely —
            // the one piece of context a DM does not need and a group cannot
            // do without.
            speakableGroupName: isGroup ? INSpeakableString(spokenPhrase: groupName ?? "Group") : nil,
            // Ties the notification to the conversation the app already knows
            // by this id, which is what lets a reply from the notification land
            // in the right place.
            conversationIdentifier: conversationId,
            serviceName: nil,
            sender: sender,
            attachments: nil
        )

        return intent
    }

    // ── Avatar ───────────────────────────────────────────────────────────────

    /**
     * The sender's face.
     *
     * Fetched straight over HTTP with no credentials, which is only correct
     * because avatars live in the *public* bucket — `mediaUrl` in
     * `apps/api/src/lib/serialize.ts` serves them from S3 directly, while
     * message attachments go through an authorised route on the API. A private
     * URL here would need the access token, and an extension cannot see the
     * app's keychain; that this one does not is the reason this method is
     * fifteen lines instead of a keychain-sharing entitlement.
     *
     * Cached in the shared container because the alternative is re-downloading
     * the same face for every message in a burst, on a cellular connection,
     * inside a process with a hard time budget.
     */
    private static func avatarData(from url: String?) async -> Data? {
        guard let url, let parsed = URL(string: url) else { return nil }

        if let cached = cachedAvatar(for: parsed) { return cached }

        var request = URLRequest(url: parsed)
        // Well inside the ~30s the extension gets: a face is a nice-to-have and
        // a late notification is not, so this gives up early and ships without.
        request.timeoutInterval = 8

        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              !data.isEmpty
        else { return nil }

        cacheAvatar(data, for: parsed)
        return data
    }

    /**
     * The sender's face as a notification attachment.
     *
     * Needs no entitlement at all, which is the point: it is what survives when
     * the communication treatment cannot be applied. iOS renders it as the
     * thumbnail on the trailing edge of the notification.
     *
     * The file extension is load-bearing — `UNNotificationAttachment` decides
     * what it has been given from the path, and an image with the wrong suffix
     * is rejected rather than guessed at. Taken from the source URL when it has
     * one, since S3 keys carry a real extension, and `jpg` when it does not.
     */
    private static func attachment(for data: Data, url: String?) -> UNNotificationAttachment? {
        let suffix = URL(string: url ?? "")?.pathExtension
        let ext = (suffix?.isEmpty == false ? suffix! : "jpg").lowercased()

        // A directory per attachment: iOS takes ownership of the file and moves
        // it out, and a shared name would collide between two notifications
        // arriving in the same second.
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        guard (try? FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true
        )) != nil else { return nil }

        let file = directory.appendingPathComponent("avatar." + ext)
        guard (try? data.write(to: file)) != nil else { return nil }
        return try? UNNotificationAttachment(identifier: "avatar", url: file, options: nil)
    }

    private static func avatarCacheDirectory() -> URL? {
        guard let container = AppGroup.container else { return nil }
        let directory = container.appendingPathComponent("notification-avatars", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    /**
     * Named by a digest of the URL rather than the URL itself: the last path
     * component of an S3 key is not unique across buckets, and the full URL is
     * not a legal filename.
     *
     * SHA-256 rather than `hashValue`, which is seeded per process and would
     * therefore name the same avatar differently on every launch — a cache
     * that never once hits and grows a new file for each notification, which
     * is strictly worse than having no cache at all.
     */
    private static func avatarFile(for url: URL) -> URL? {
        guard let directory = avatarCacheDirectory() else { return nil }
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8))
        return directory.appendingPathComponent(digest.map { String(format: "%02x", $0) }.joined())
    }

    private static func cachedAvatar(for url: URL) -> Data? {
        guard let file = avatarFile(for: url) else { return nil }
        return try? Data(contentsOf: file)
    }

    private static func cacheAvatar(_ data: Data, for url: URL) {
        guard let file = avatarFile(for: url) else { return }
        try? data.write(to: file, options: .atomic)
        sweep()
    }

    /**
     * Keeps the avatar cache bounded.
     *
     * Content-addressed names never collide, which is the point of them and
     * also why nothing here is ever overwritten: change your avatar and the old
     * file stays behind forever. Bounded rather than expired — a face has no
     * natural staleness, it is just one of the last N people who messaged you.
     *
     * Only ever runs on a cache miss, so this is a directory listing on the
     * rare path and nothing at all on the common one.
     */
    private static func sweep(limit: Int = 64) {
        guard let directory = avatarCacheDirectory() else { return }
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey]
        ), files.count > limit else { return }

        let oldestFirst = files.sorted {
            let a = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            let b = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return a < b
        }
        for file in oldestFirst.prefix(files.count - limit) {
            try? fm.removeItem(at: file)
        }
    }
}
