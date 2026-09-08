import XCTest
@testable import yappy

@MainActor
final class InboxActivityTests: XCTestCase {
    func testStatusBubbleRejectsBlankTextAndKeepsWholeEmojiWithinAPILimit() {
        XCTAssertNil(StatusText.visible(" \n\t"))
        XCTAssertEqual(StatusText.visible("  Here for a bit  "), "Here for a bit")
        let family = "👨‍👩‍👧‍👦"
        let limited = StatusText.limited(String(repeating: family, count: 20))
        XCTAssertLessThanOrEqual(limited.utf16.count, 128)
        XCTAssertTrue(limited.allSatisfy { String($0) == family })
        XCTAssertEqual(StatusText.limited(String(repeating: "a", count: 129)).count, 128)
    }

    private func inbox() -> NotificationInboxModel {
        NotificationInboxModel(defaults: UserDefaults(suiteName: "InboxTests." + UUID().uuidString)!)
    }

    func testPagingAcknowledgesLoadedNoticeIdsAndUsesEachSourceCursor() async throws {
        let api = InboxAPIStub()
        api.noticePages = [
            #"{"notifications":[{"id":"n1","kind":"group_verified"}],"nextCursor":"notice-page-2","supportsSelectiveRead":true}"#,
            #"{"notifications":[{"id":"n2","kind":"role_granted"}],"nextCursor":null,"supportsSelectiveRead":true}"#,
        ]
        api.mentionPages = [
            #"{"mentions":[{"isBroadcast":false,"unread":true,"conversation":{"id":"g","type":"group"},"message":{"id":"m1"}}],"nextCursor":"mention-page-2"}"#,
            #"{"mentions":[],"nextCursor":null}"#,
        ]
        let model = inbox()
        await model.load(api, userId: "me")
        XCTAssertEqual(api.readBatches, [["n1"]])
        XCTAssertTrue(model.hasMore)
        await model.load(api, userId: "me")
        XCTAssertEqual(api.noticeCursors, [nil, "notice-page-2"])
        XCTAssertEqual(api.mentionCursors, [nil, "mention-page-2"])
        XCTAssertEqual(api.readBatches, [["n1"], ["n2"]])
        XCTAssertEqual(Set(model.entries.map(\.id)), ["notice:n1", "notice:n2", "mention:m1"])
        XCTAssertFalse(model.hasMore)
    }

    func testOlderServerNeverReceivesPotentialReadAllRequest() async {
        let api = InboxAPIStub()
        api.noticePages = [#"{"notifications":[{"id":"n","kind":"future_kind"}]}"#]
        let model = inbox()
        await model.load(api, userId: "me")
        XCTAssertTrue(api.readBatches.isEmpty)
        XCTAssertEqual(model.entries.count, 1)
    }

    func testFailedSourceRetriesWithoutThrowingAwaySuccessfulRows() async {
        let api = InboxAPIStub()
        api.noticePages = [#"{"notifications":[{"id":"n","kind":"role_granted"}]}"#]
        api.failMentions = true
        let model = inbox()
        await model.load(api, userId: "me")
        XCTAssertNotNil(model.error)
        XCTAssertEqual(model.entries.map(\.id), ["notice:n"])
        api.failMentions = false
        await model.load(api, userId: "me")
        XCTAssertNil(model.error)
        XCTAssertEqual(api.noticeCursors.count, 1)
        XCTAssertEqual(model.entries.map(\.id), ["notice:n"])
    }

    func testFailedAcknowledgementCanRetryEvenAtEndOfBothFeeds() async {
        let api = InboxAPIStub()
        api.noticePages = [#"{"notifications":[{"id":"n","kind":"role_granted"}],"supportsSelectiveRead":true}"#]
        api.failRead = true
        let model = inbox()
        await model.load(api, userId: "me")
        XCTAssertNotNil(model.error)
        api.failRead = false
        await model.load(api, userId: "me")
        XCTAssertNil(model.error)
        XCTAssertEqual(api.readBatches, [["n"], ["n"]])
    }

    func testFailedDismissKeepsRowAndSuccessfulDismissRemovesIt() async throws {
        let api = InboxAPIStub()
        api.noticePages = [#"{"notifications":[{"id":"n","kind":"role_granted"}]}"#]
        let model = inbox()
        await model.load(api, userId: "me")
        let entry = try XCTUnwrap(model.entries.first)
        api.failDismiss = true
        await model.dismiss(entry, api: api)
        XCTAssertEqual(model.entries.count, 1)
        api.failDismiss = false
        await model.dismiss(entry, api: api)
        XCTAssertTrue(model.entries.isEmpty)
    }

    func testFailedRefreshAtEndRetriesTheFirstPage() async {
        let api = InboxAPIStub()
        let model = inbox()
        await model.load(api, userId: "me")
        api.failMentions = true
        await model.load(api, userId: "me", refresh: true)
        XCTAssertNotNil(model.error)
        api.failMentions = false
        await model.load(api, userId: "me")
        XCTAssertEqual(api.mentionCursors.count, 3)
        XCTAssertNil(api.mentionCursors.last!)
        XCTAssertNil(model.error)
    }

    func testActivityHidesSelfAndInaccessibleRooms() throws {
        let source = #"{"reading":[{"conversationId":"public","title":"general","userIds":["me","ada","ada"]},{"conversationId":"private","title":"hidden","userIds":["bob"]}],"inVoice":[{"conversationId":"voice","title":"hangout","userIds":["me"]}]}"#
        let activity = try JSONDecoder().decode(PlaceActivity.self, from: Data(source.utf8))
            .visible(to: "me", conversations: ["public", "voice"])
        XCTAssertEqual(activity.reading.count, 1)
        XCTAssertEqual(activity.reading.first?.userIds, ["ada"])
        XCTAssertTrue(activity.inVoice.isEmpty)
    }

    func testBroadcastDemotionKeepsAllMessagesAndDirectMentions() throws {
        let broadcast: JSONValue = .object(["entities": .array([.object(["type": .string("mention_all")])])])
        let off: JSONValue = .object(["broadcastMentions": .bool(false)])
        XCTAssertTrue(BroadcastMentionPolicy.suppresses(broadcast, for: "me", preferences: off, level: "mentions"))
        XCTAssertFalse(BroadcastMentionPolicy.suppresses(broadcast, for: "me", preferences: off, level: "all"))
        XCTAssertFalse(BroadcastMentionPolicy.suppresses(broadcast, for: "me", preferences: .object([:]), level: "mentions"))
        let direct: JSONValue = .object(["entities": .array([
            .object(["type": .string("mention_role")]),
            .object(["type": .string("mention"), "userId": .string("me")]),
        ])])
        XCTAssertFalse(BroadcastMentionPolicy.suppresses(direct, for: "me", preferences: off, level: "mentions"))
    }
}

private final class InboxAPIStub: NotificationInboxAPI {
    var noticePages: [String] = []
    var mentionPages: [String] = []
    var noticeCursors: [String?] = []
    var mentionCursors: [String?] = []
    var readBatches: [[String]] = []
    var failMentions = false
    var failRead = false
    var failDismiss = false

    func notifications(cursor: String?, limit: Int) async throws -> NotificationsEnvelope {
        noticeCursors.append(cursor)
        return try decode(noticePages.isEmpty ? #"{"notifications":[]}"# : noticePages.removeFirst())
    }
    func mentions(before: String?, limit: Int) async throws -> MentionsEnvelope {
        mentionCursors.append(before)
        if failMentions { throw URLError(.notConnectedToInternet) }
        return try decode(mentionPages.isEmpty ? #"{"mentions":[],"nextCursor":null}"# : mentionPages.removeFirst())
    }
    func readNotifications(ids: [String]) async throws -> Ok {
        readBatches.append(ids)
        if failRead { throw URLError(.notConnectedToInternet) }
        return try decode(#"{"ok":true}"#)
    }
    func dismissNotification(_ id: String) async throws -> Ok {
        if failDismiss { throw URLError(.notConnectedToInternet) }
        return try decode(#"{"ok":true}"#)
    }
    private func decode<T: Decodable>(_ json: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(json.utf8)) }
}
