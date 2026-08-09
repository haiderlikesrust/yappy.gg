import SwiftUI

/// Call screen.
///
/// Two halves meet here. The backend owns *who may be in this call* —
/// permission, ringing, the roster, the record that lands in the thread — and
/// `CallEngine` owns the device: the audio session, the route, and the mic.
/// The controls move real state: mute stops publishing, hang-up tears the room
/// down, and the tiles ring when someone talks.
///
/// Microphone permission is asked for but not required: denied, you still join
/// and can hear everyone. Refusing to connect someone who declined a permission
/// would be punishing them for the wrong thing.
struct CallScreen: View {
    @Environment(\.neu) private var colors
    @EnvironmentObject private var container: AppContainer
    @StateObject private var engine = CallEngine { LiveKitTransport() }

    let callId: String
    let onLeave: () -> Void

    @State private var call: Call?
    @State private var muted = false
    @State private var videoOn = false
    @State private var speaker = true
    @State private var seconds = 0
    @State private var micGranted = CallEngine.microphoneGranted
    @State private var mediaOffered = true

    private var participants: [CallParticipant] { call?.participants ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            Text(statusLine)
                .font(YappyFont.titleMedium)
                .foregroundStyle(colors.textSecondary)
                .frame(maxWidth: .infinity)

            Text(modeLine)
                .font(YappyFont.labelMedium)
                .foregroundStyle(engine.media.state == .connected ? colors.success : colors.textTertiary)
                .frame(maxWidth: .infinity)
                .padding(.top, 6)

            tiles.padding(.top, 24)

            // Only ever shown when something is actually wrong: a media failure
            // the user can act on, or a build the server refused a token to.
            if let problem = mediaProblem {
                Text(problem)
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.warning)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, 12)
            }

            controls
        }
        .padding(20)
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .task { await join() }
        // A second `.task` rather than an unstructured `Task` started inside
        // `join()`. An unstructured task does not inherit its parent's
        // cancellation and nothing else held a reference to it once the screen
        // was gone, so leaving a call before it finished connecting left a
        // one-second loop polling the call for the life of the process — and
        // when that call eventually ended, its `onLeave()` popped whatever
        // screen the user happened to be on.
        .task { await pollRoster() }
        .onDisappear { leave() }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    private func join() async {
        if !micGranted {
            micGranted = await CallEngine.requestMicrophone()
            // Granted mid-call: start publishing without making them rejoin.
            if micGranted, engine.media.state == .connected {
                await engine.setMicEnabled(!muted)
            }
        }

        let joined = try? await container.repo.joinCall(callId, video: false)
        // Every await in here is wrapped in `try?`, which swallows the
        // cancellation error too — so without this the screen could be gone,
        // `leave()` could already have closed the room, and we would then
        // connect and publish the microphone with no UI left to mute or hang up
        // with. Exactly the case the comment on `leave()` calls the worst bug a
        // call app can have.
        guard !Task.isCancelled else { return }

        call = joined?.call
        videoOn = joined?.call.mode == "video"

        if let token = joined?.token, let url = joined?.url {
            await engine.connect(
                url: CallEngine.resolveUrl(url),
                token: token,
                publishAudio: micGranted
            )
        } else {
            mediaOffered = false
        }
    }

    /// Poll the roster. The gateway pushes participant updates too; this is the
    /// backstop for the case where the socket is down but the call is not.
    private func pollRoster() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            seconds += 1
            guard seconds % 5 == 0 else { continue }
            if let fresh = try? await container.repo.call(callId).call {
                guard !Task.isCancelled else { return }
                call = fresh
                if fresh.state == "ended" { onLeave() }
            }
        }
    }

    private func leave() {
        // Tear the room down synchronously — leaving a publishing mic alive
        // after the screen is gone is the worst bug a call app can have.
        engine.close()
        // Fire-and-forget: the view is going away and its own task would be
        // cancelled with it.
        let repo = container.repo
        Task.detached { try? await repo.leaveCall(callId) }
    }

    // ── Pieces ───────────────────────────────────────────────────────────────

    private var statusLine: String {
        if call == nil { return "Connecting…" }
        if engine.media.state == .connecting { return "Connecting audio…" }
        if engine.media.state == .reconnecting { return "Reconnecting…" }
        if call?.state == "ringing" { return "Ringing…" }
        return YappyTime.duration(seconds)
    }

    private var modeLine: String {
        var text = call?.mode == "video" ? "Video call" : "Voice call"
        if engine.media.state == .connected { text += " · audio live" }
        if !micGranted { text += " · listening only" }
        return text
    }

    private var mediaProblem: String? {
        if !mediaOffered { return "No media token — check LIVEKIT_URL on the server" }
        if engine.media.state == .failed { return engine.media.error ?? "Audio failed to connect" }
        return nil
    }

    private var tiles: some View {
        let columns = participants.count <= 2
            ? [GridItem(.flexible())]
            : [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

        return ScrollView {
            LazyVGrid(columns: columns, spacing: 14) {
                ForEach(participants) { participant in
                    tile(participant)
                }
            }
        }
        .frame(maxHeight: .infinity)
    }

    private func tile(_ participant: CallParticipant) -> some View {
        // The engine reports speakers by identity, which the backend mints as
        // our user id — so this maps straight across.
        let speaking = engine.media.speaking.contains(participant.user.id)
        let joined = participant.state == "joined"

        return VStack(spacing: 0) {
            Avatar(
                url: participant.user.avatarUrl,
                name: participant.user.label,
                id: participant.user.id,
                size: participants.count <= 2 ? 96 : 62
            )
            .padding(.bottom, 10)

            Text(participant.user.label)
                .font(YappyFont.titleSmall)
                .foregroundStyle(colors.textPrimary)

            Text(stateLabel(participant, speaking: speaking))
                .font(YappyFont.labelSmall)
                .foregroundStyle(speaking ? colors.success : colors.textTertiary)
        }
        .frame(maxWidth: .infinity)
        .frame(height: participants.count <= 2 ? 260 : 170)
        .padding(12)
        // Someone still ringing is recessed; once they join the tile lifts.
        // Depth carries the state without a label.
        .neu(
            NeuShape(radius: Neu.cornerLarge),
            colors,
            state: joined ? .raised : .pressed,
            elevation: joined ? 8 : 5
        )
        .overlay(
            NeuShape(radius: Neu.cornerLarge)
                .stroke(speaking ? colors.success : .clear, lineWidth: 2)
        )
        .animation(.easeInOut(duration: 0.15), value: speaking)
    }

    private func stateLabel(_ participant: CallParticipant, speaking: Bool) -> String {
        if speaking { return "Speaking" }
        switch participant.state {
        case "joined": return participant.isMuted ? "Muted" : "In call"
        case "ringing", "invited": return "Ringing…"
        case "declined": return "Declined"
        case "missed": return "No answer"
        default: return participant.state
        }
    }

    private var controls: some View {
        HStack {
            Spacer()
            NeuIconButton(
                systemName: muted ? "mic.slash.fill" : "mic.fill",
                label: muted ? "Unmute" : "Mute",
                size: 58,
                iconSize: 24,
                active: muted,
                enabled: micGranted
            ) {
                muted.toggle()
                Task {
                    // Stop the track first, then tell the roster. In the other
                    // order a slow request leaves you hot-mic'd.
                    await engine.setMicEnabled(!muted)
                    _ = try? await container.repo.setCallState(callId, muted: muted)
                }
            }
            Spacer()

            NeuIconButton(
                systemName: videoOn ? "video.fill" : "video.slash.fill",
                label: "Camera",
                size: 58,
                iconSize: 24,
                active: !videoOn
            ) {
                videoOn.toggle()
                Task { try? await container.repo.setCallState(callId, video: videoOn) }
            }
            Spacer()

            NeuIconButton(
                systemName: speaker ? "speaker.wave.2.fill" : "speaker.fill",
                label: "Speaker",
                size: 58,
                iconSize: 24,
                active: !speaker
            ) {
                speaker.toggle()
                engine.setSpeaker(speaker)
            }
            Spacer()

            NeuIconButton(
                systemName: "phone.down.fill",
                label: "End call",
                size: 66,
                iconSize: 26,
                tint: colors.onAccent,
                accent: true
            ) {
                engine.close()
                Task {
                    try? await container.repo.leaveCall(callId)
                    onLeave()
                }
            }
            Spacer()
        }
        .padding(.vertical, 16)
    }
}
