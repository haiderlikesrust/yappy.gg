import XCTest
@testable import yappy

@MainActor
final class Release26Tests: XCTestCase {
    func testFiltersKeepPlacesPeopleAndUnreadDistinct() throws {
        let json = #"{"conversations":[{"id":"dm","type":"dm","self":{"unreadCount":2}},{"id":"group","type":"group"},{"id":"space","type":"space","self":{"mentionCount":1}}]}"#
        let rows = try JSONDecoder().decode(ConversationsEnvelope.self, from: Data(json.utf8)).conversations
        XCTAssertEqual(rows.filter(ConversationsModel.HomeFilter.places.admits).map(\.id), ["group", "space"])
        XCTAssertEqual(rows.filter(ConversationsModel.HomeFilter.people.admits).map(\.id), ["dm"])
        XCTAssertEqual(rows.filter(ConversationsModel.HomeFilter.unread.admits).map(\.id), ["dm", "space"])
    }

    func testVoiceRosterDecodesWithoutBreakingOlderChannelPayloads() throws {
        let old = try JSONDecoder().decode(ChannelEntry.self, from: Data(#"{"id":"text"}"#.utf8))
        XCTAssertFalse(old.isVoice)
        XCTAssertTrue(old.voiceParticipants.isEmpty)
        let room = try JSONDecoder().decode(ChannelEntry.self, from: Data(#"{"id":"room","isVoice":true,"voiceParticipants":[{"id":"u","displayName":"Sam","isMuted":true}]}"#.utf8))
        XCTAssertEqual(room.voiceParticipants.first?.label, "Sam")
        XCTAssertEqual(room.voiceParticipants.first?.isMuted, true)
    }

    func testNoticePushDoesNotDisappearBehindMessageSuppression() {
        let notice: [AnyHashable: Any] = ["kind": "group_verified", "conversationId": "g", "notificationId": "n"]
        XCTAssertFalse(PushService.isMessagePush(notice))
        XCTAssertEqual(PushService.destination(notice), .notifications)
        XCTAssertFalse(PushService.isMessagePush(["type": "notification", "conversationId": "g"]))
        XCTAssertEqual(PushService.destination(["type": "notification", "conversationId": "g"]), .notifications)
        let message: [AnyHashable: Any] = ["conversationId": "g", "messageId": "m"]
        XCTAssertTrue(PushService.isMessagePush(message))
        XCTAssertEqual(PushService.destination(message), .conversation("g"))
    }

    func testSpaceShortcutOpensSpaceAndRejectsUnknownWebHost() {
        XCTAssertEqual(DeepLink(url: URL(string: "yappy://home")!), .home)
        XCTAssertEqual(DeepLink(url: URL(string: "yappy://space/s")!), .space("s"))
        XCTAssertNil(DeepLink(url: URL(string: "https://example.com/join/code")!))
        XCTAssertNil(DeepLink(url: URL(string: "yappy://conversation/")!))
    }

    func testLateJoinCannotRestoreASeatAfterLeave() async {
        let api = DeferredVoiceAPI()
        let joined = expectation(description: "join reached API")
        api.onJoin = { joined.fulfill() }
        let engine = CallEngine()
        let voice = VoiceChannels(repo: api, engine: engine, callBusy: { false }, microphonePermission: { false })
        voice.join(channelId: "a", spaceId: "s", title: "A")
        await fulfillment(of: [joined], timeout: 2)
        voice.leave()
        api.completeJoin()
        await voice.waitUntilSettled()
        XCTAssertNil(voice.session)
        XCTAssertEqual(engine.media.state, .disconnected)
        XCTAssertTrue(api.left.contains("a"))
    }

    func testCallArrivingDuringJoinReleasesTheSeat() async {
        let api = DeferredVoiceAPI()
        let joined = expectation(description: "join reached API")
        api.onJoin = { joined.fulfill() }
        var busy = false
        let voice = VoiceChannels(repo: api, engine: CallEngine(), callBusy: { busy }, microphonePermission: { false })
        voice.join(channelId: "a", spaceId: "s", title: "A")
        await fulfillment(of: [joined], timeout: 2)
        busy = true
        api.completeJoin()
        await voice.waitUntilSettled()
        await voice.waitUntilSettled()
        XCTAssertNil(voice.session)
        XCTAssertTrue(api.left.contains("a"))
    }

    func testBusyCallPreventsVoiceJoin() async {
        let api = DeferredVoiceAPI()
        let voice = VoiceChannels(repo: api, engine: CallEngine(), callBusy: { true }, microphonePermission: { false })
        voice.join(channelId: "a", spaceId: "s", title: "A")
        await voice.waitUntilSettled()
        XCTAssertNil(voice.session)
        XCTAssertNotNil(voice.error)
        XCTAssertEqual(api.joinCount, 0)
    }

    func testFailedMicrophoneChangeKeepsActualState() async {
        let transport = TestTransport()
        let engine = CallEngine { transport }
        await engine.connect(url: "wss://example.com", token: "test", publishAudio: false, activateSession: false)
        transport.failMicrophone = true
        await engine.setMicEnabled(true)
        XCTAssertFalse(engine.media.micEnabled)
        XCTAssertNotNil(engine.media.error)
        engine.close(deactivateSession: false)
    }

    func testLateVoiceCleanupDoesNotUseTheNextAccount() async {
        let api = DeferredVoiceAPI()
        let joined = expectation(description: "join reached API")
        api.onJoin = { joined.fulfill() }
        var account = UUID()
        let voice = VoiceChannels(repo: api, engine: CallEngine(), callBusy: { false },
                                  microphonePermission: { false }, accountGeneration: { account })
        voice.join(channelId: "a", spaceId: "s", title: "A")
        await fulfillment(of: [joined], timeout: 2)
        account = UUID()
        voice.reset()
        api.completeJoin()
        await voice.waitUntilSettled()
        XCTAssertNil(voice.session)
        XCTAssertTrue(api.left.isEmpty)
    }

    func testSwitchWaitsForOldSeatCleanup() async {
        let api = DeferredVoiceAPI()
        let first = expectation(description: "first join")
        let second = expectation(description: "second join")
        api.onJoin = {
            if api.joinCount == 1 { first.fulfill() }
            else { second.fulfill() }
        }
        let voice = VoiceChannels(repo: api, engine: CallEngine { TestTransport() },
                                  callBusy: { false }, microphonePermission: { false })
        voice.join(channelId: "a", spaceId: "s", title: "A")
        await fulfillment(of: [first], timeout: 2)
        voice.join(channelId: "b", spaceId: "s", title: "B")
        api.completeJoin()
        await fulfillment(of: [second], timeout: 2)
        XCTAssertTrue(api.left.contains("a"))
        api.completeJoin()
        await voice.waitUntilSettled()
        XCTAssertEqual(voice.session?.channelId, "b")
        voice.leave()
        await voice.waitUntilSettled()
    }
}

@MainActor
private final class DeferredVoiceAPI: VoiceChannelAPI {
    var onJoin: (() -> Void)?
    var joinCount = 0
    var left: [String] = []
    private var continuation: CheckedContinuation<VoiceJoinEnvelope, Never>?

    func joinVoice(_ id: String) async throws -> VoiceJoinEnvelope {
        joinCount += 1
        return await withCheckedContinuation {
            continuation = $0
            onJoin?()
        }
    }
    func leaveVoice(_ id: String) async throws { left.append(id) }
    func completeJoin() {
        continuation?.resume(returning: VoiceJoinEnvelope(token: "test", url: "wss://example.com", participants: []))
        continuation = nil
    }
}

private final class TestTransport: CallMediaTransport {
    var onStateChange: ((MediaState) -> Void)?
    var onSpeakersChange: ((Set<String>) -> Void)?
    var onParticipantCountChange: ((Int) -> Void)?
    var failMicrophone = false
    func connect(url: String, token: String, publishAudio: Bool) async throws {}
    func disconnect() async {}
    func setMicrophoneEnabled(_ enabled: Bool) async throws {
        if failMicrophone { throw URLError(.cannotConnectToHost) }
    }
}
