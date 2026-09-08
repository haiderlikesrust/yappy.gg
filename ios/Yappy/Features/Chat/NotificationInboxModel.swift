import Combine
import Foundation

protocol NotificationInboxAPI {
    func notifications(cursor: String?, limit: Int) async throws -> NotificationsEnvelope
    func mentions(before: String?, limit: Int) async throws -> MentionsEnvelope
    func readNotifications(ids: [String]) async throws -> Ok
    func dismissNotification(_ id: String) async throws -> Ok
}

extension YappyRepository: NotificationInboxAPI {}

enum InboxEntry: Identifiable {
    case mention(MentionEntry)
    case notice(NotificationEntry)

    var id: String {
        switch self {
        case .mention(let entry): return "mention:\(entry.message?.id ?? entry.conversation.id)"
        case .notice(let entry): return "notice:\(entry.id)"
        }
    }

    var createdAt: Date {
        switch self {
        case .mention(let entry): return YappyTime.parse(entry.message?.createdAt) ?? .distantPast
        case .notice(let entry): return YappyTime.parse(entry.createdAt) ?? .distantPast
        }
    }

    var dismissLabel: String {
        if case .mention = self { return "Hide on this device" }
        return "Dismiss"
    }
}

@MainActor
final class NotificationInboxModel: ObservableObject {
    @Published private(set) var entries: [InboxEntry] = []
    @Published private(set) var loading = false
    @Published private(set) var loaded = false
    @Published private(set) var error: String?
    @Published private(set) var dismissing: Set<String> = []
    private var notices: [NotificationEntry] = []
    private var mentions: [MentionEntry] = []
    private var noticeCursor: String?
    private var mentionCursor: String?
    private var noticesStarted = false
    private var mentionsStarted = false
    private var noticeFailure: (cursor: String?, replace: Bool)?
    private var mentionFailure: (cursor: String?, replace: Bool)?
    private var pendingRead = Set<String>()
    private var hidden = Set<String>()
    private var userId: String?
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    var hasMore: Bool {
        !noticesStarted || !mentionsStarted || noticeCursor != nil || mentionCursor != nil
    }
    func load(_ api: NotificationInboxAPI, userId: String, refresh: Bool = false,
              isCurrent: () -> Bool = { true }) async {
        guard !loading else { return }
        if self.userId != userId {
            self.userId = userId
            hidden = Set(defaults.stringArray(forKey: "hiddenMentions.\(userId)") ?? [])
            notices = []; mentions = []; pendingRead = []
            noticeCursor = nil; mentionCursor = nil
            noticesStarted = false; mentionsStarted = false
            noticeFailure = nil; mentionFailure = nil
            entries = []; loaded = false
        }
        loading = true
        error = nil
        defer { loading = false }
        let fetchNotices = refresh || !noticesStarted || noticeCursor != nil || noticeFailure != nil
        let fetchMentions = refresh || !mentionsStarted || mentionCursor != nil || mentionFailure != nil
        let oldNoticeCursor = refresh ? nil : (noticeFailure != nil ? noticeFailure?.cursor : noticeCursor)
        let oldMentionCursor = refresh ? nil : (mentionFailure != nil ? mentionFailure?.cursor : mentionCursor)
        // Explicit tasks also avoid the SwiftUI/async-let cancellation teardown
        // issue already handled by the space screen's parallel loading path.
        let noticeTask = Task { () -> NotificationsEnvelope? in
            guard fetchNotices else { return nil }
            return try? await api.notifications(cursor: oldNoticeCursor, limit: 40)
        }
        let mentionTask = Task { () -> MentionsEnvelope? in
            guard fetchMentions else { return nil }
            return try? await api.mentions(before: oldMentionCursor, limit: 40)
        }
        let (noticeResult, mentionResult) = await withTaskCancellationHandler {
            let notices = await noticeTask.value
            let mentions = await mentionTask.value
            return (notices, mentions)
        } onCancel: {
            noticeTask.cancel()
            mentionTask.cancel()
        }
        guard !Task.isCancelled, isCurrent() else { return }
        var failed: [String] = []
        if let page = noticeResult {
            if refresh || noticeFailure?.replace == true { notices = [] }
            var ids = Set(notices.map(\.id))
            notices += page.notifications.filter { ids.insert($0.id).inserted }
            noticeCursor = page.nextCursor == oldNoticeCursor ? nil : page.nextCursor
            noticesStarted = true
            noticeFailure = nil
            if page.supportsSelectiveRead {
                pendingRead.formUnion(page.notifications.filter { $0.readAt == nil }.map(\.id))
            }
        } else if fetchNotices {
            noticeFailure = (oldNoticeCursor, refresh || noticeFailure?.replace == true)
            failed.append("updates")
        }
        if let page = mentionResult {
            if refresh || mentionFailure?.replace == true { mentions = [] }
            var ids = Set(mentions.map { InboxEntry.mention($0).id })
            mentions += page.mentions.filter { ids.insert(InboxEntry.mention($0).id).inserted }
            mentionCursor = page.nextCursor == oldMentionCursor ? nil : page.nextCursor
            mentionsStarted = true
            mentionFailure = nil
        } else if fetchMentions {
            mentionFailure = (oldMentionCursor, refresh || mentionFailure?.replace == true)
            failed.append("mentions")
        }
        loaded = true
        rebuild()
        // The service allows at most 100 ids per acknowledgement. Never send
        // an empty/omitted list: older deployments interpret that as read-all.
        while !pendingRead.isEmpty {
            guard !Task.isCancelled, isCurrent() else { return }
            let batch = Array(pendingRead.prefix(100))
            do {
                _ = try await api.readNotifications(ids: batch)
                pendingRead.subtract(batch)
            } catch {
                failed.append("read status")
                break
            }
            if Task.isCancelled { return }
        }
        if !failed.isEmpty { error = "Couldn’t update \(failed.joined(separator: " and ")). Pull to refresh or retry." }
    }

    func dismiss(_ entry: InboxEntry, api: NotificationInboxAPI) async {
        guard !loading, dismissing.insert(entry.id).inserted else { return }
        defer { dismissing.remove(entry.id) }
        switch entry {
        case .notice(let notice):
            do {
                _ = try await api.dismissNotification(notice.id)
                notices.removeAll { $0.id == notice.id }
                pendingRead.remove(notice.id)
            } catch {
                self.error = "Couldn’t dismiss this update. Try again."
                return
            }
        case .mention:
            hidden.insert(entry.id)
            if let userId { defaults.set(Array(hidden), forKey: "hiddenMentions.\(userId)") }
        }
        rebuild()
    }

    private func rebuild() {
        entries = (notices.map(InboxEntry.notice) + mentions.map(InboxEntry.mention))
            .filter { !hidden.contains($0.id) }
            .sorted { $0.createdAt == $1.createdAt ? $0.id > $1.id : $0.createdAt > $1.createdAt }
    }
}
