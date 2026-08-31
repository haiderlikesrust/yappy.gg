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
    /// The container's engine, not our own. A lock-screen answer connects
    /// audio before this screen exists; building a second engine here would
    /// mean a second connection fighting the first over one microphone.
    @ObservedObject var engine: CallEngine
    @ObservedObject private var system = CallSystem.shared

    let callId: String
    let onLeave: () -> Void

    @State private var call: Call?
    @State private var videoOn = false
    @State private var speaker = true
    @State private var seconds = 0
    @State private var micGranted = CallEngine.microphoneGranted
    /// The success tap fires once, when audio first lands — not again on every
    /// reconnect wobble, which would turn a reassurance into a nag.
    @State private var announcedConnect = false

    private var participants: [CallParticipant] { call?.participants ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            Text(statusLine)
                .font(YappyFont.titleMedium)
                .foregroundStyle(colors.textSecondary)
                // Once the status line becomes a duration, the digits roll over
                // like a counter instead of blinking wholesale every second.
                .contentTransition(.numericText())
                .animation(.easeInOut(duration: 0.2), value: seconds)
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
        .onChange(of: engine.media.state) { _, state in
            if state == .connected, !announcedConnect {
                announcedConnect = true
                Haptics.success()
            }
        }
        .onDisappear { leave() }
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    private func join() async {
        if !micGranted {
            micGranted = await CallEngine.requestMicrophone()
            // Granted mid-call: start publishing without making them rejoin.
            if micGranted, engine.media.state == .connected {
                await engine.setMicEnabled(!system.muted)
            }
        }

        let fetched = try? await container.repo.call(callId).call
        // Every await in here is wrapped in `try?`, which swallows the
        // cancellation error too — so without this the screen could be gone,
        // the call already left, and we would then connect and publish the
        // microphone with no UI left to mute or hang up with.
        guard !Task.isCancelled else { return }

        call = fetched
        videoOn = fetched?.mode == "video"

        // Through CallKit, both directions. If a lock-screen answer already
        // connected this call, this returns immediately and the screen simply
        // adopts the live engine.
        let meId = container.session.userId
        let other = fetched?.participants.first { $0.user.id != meId }?.user.label
        await CallSystem.shared.connect(
            callId: callId,
            displayName: other ?? "yappy call",
            hasVideo: fetched?.mode == "video"
        )
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
                if fresh.state == "ended" {
                    // The socket may have been down when it ended; make sure
                    // the CallKit call dies with it.
                    CallSystem.shared.noteEnded(callId)
                    onLeave()
                }
            }
        }
    }

    private func leave() {
        // Through CallKit, so the system call ends with the screen. Idempotent:
        // if the hang-up button already ran, the call is unknown and this is a
        // no-op. Leaving a publishing mic alive after the screen is gone is
        // the worst bug a call app can have — CXEndCallAction closes the
        // engine before it tells the server.
        CallSystem.shared.hangUp(callId)
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
        // Joined the roster but the engine never left idle: the server minted
        // no media token, which means LIVEKIT_URL is missing over there.
        if system.activeCallId == callId, engine.media.state == .idle {
            return "No media token — check LIVEKIT_URL on the server"
        }
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
            BreathingAvatar(
                participant: participant,
                speaking: speaking,
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
            // The ring swells in on a spring and throws a soft green glow —
            // the tile lights up when its owner talks, which reads across the
            // room faster than the label under it can. Animating the width
            // from zero (rather than the colour from clear) is what makes it
            // grow instead of fade.
            NeuShape(radius: Neu.cornerLarge)
                .stroke(colors.success, lineWidth: speaking ? 3 : 0)
                .shadow(color: colors.success.opacity(0.45), radius: speaking ? 16 : 0)
        )
        .animation(.spring(response: 0.35, dampingFraction: 0.65), value: speaking)
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
                systemName: system.muted ? "mic.slash.fill" : "mic.fill",
                label: system.muted ? "Unmute" : "Mute",
                size: 58,
                iconSize: 24,
                active: system.muted,
                enabled: micGranted
            ) {
                // Through CallKit, so this button and the one on the system
                // call UI are the same switch rather than two that drift.
                Haptics.select()
                CallSystem.shared.setMuted(!system.muted)
            }
            Spacer()

            NeuIconButton(
                systemName: videoOn ? "video.fill" : "video.slash.fill",
                label: "Camera",
                size: 58,
                iconSize: 24,
                active: !videoOn
            ) {
                Haptics.select()
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
                Haptics.select()
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
                Haptics.thud()
                CallSystem.shared.hangUp(callId)
                onLeave()
            }
            Spacer()
        }
        .padding(.vertical, 16)
    }
}

/// The speaking participant's avatar breathes — a slow four-percent swell.
///
/// This is the screen's one ambient loop, and it is tied to live speech: the
/// engine says someone is talking, so something on screen is genuinely moving.
/// The moment the room goes quiet the loop is replaced with a short settle,
/// because a repeat-forever animation is never cancelled by flipping its flag
/// back — only by handing the property a new, finite animation.
private struct BreathingAvatar: View {
    let participant: CallParticipant
    let speaking: Bool
    let size: CGFloat

    @State private var breath = false

    var body: some View {
        Avatar(
            url: participant.user.avatarUrl,
            name: participant.user.label,
            id: participant.user.id,
            size: size
        )
        .scaleEffect(breath ? 1.04 : 1.0)
        // `initial: true` covers the tile that scrolls in mid-sentence: its
        // owner is already speaking, and `onChange` alone would wait for them
        // to stop and start again.
        .onChange(of: speaking, initial: true) { _, isSpeaking in
            if isSpeaking {
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                    breath = true
                }
            } else {
                withAnimation(.easeInOut(duration: 0.25)) {
                    breath = false
                }
            }
        }
    }
}
