import AVFoundation
import SwiftUI

// ── Recording ────────────────────────────────────────────────────────────────

/// Records a voice note as AAC in an .m4a container.
///
/// AAC mono at 32 kbps, because a voice note is speech: a minute costs about a
/// quarter of a megabyte, which uploads fast on cellular and is transparent for
/// a voice. The server's accept list has `audio/mp4` at up to 50 MB, so the
/// format needs no server work at all.
@MainActor
final class VoiceRecorder: NSObject, ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var elapsed: TimeInterval = 0
    /// The microphone was refused. Shown once, where the mic button is.
    @Published var permissionDenied = false

    private var recorder: AVAudioRecorder?
    private var ticker: Task<Void, Never>?
    private var fileUrl: URL?

    func start() async {
        guard !isRecording else { return }

        let granted = await AVAudioApplication.requestRecordPermission()
        guard granted else {
            permissionDenied = true
            return
        }

        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true)
        } catch {
            return
        }

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 24_000,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32_000,
        ]

        guard let recorder = try? AVAudioRecorder(url: url, settings: settings) else { return }
        self.recorder = recorder
        fileUrl = url
        recorder.record()
        isRecording = true
        elapsed = 0

        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard let self, let recorder = self.recorder else { return }
                self.elapsed = recorder.currentTime
                // A cap keeps a pocket recording from becoming a 50 MB upload;
                // ten minutes of speech is a podcast, not a message.
                if recorder.currentTime >= 600 { _ = self.finish() }
            }
        }
    }

    /// Stop and hand back the file, or nil when there is nothing worth sending
    /// — recordings under half a second are always a slipped finger.
    func finish() -> (data: Data, durationMs: Int)? {
        guard let recorder, let fileUrl else { return nil }
        let duration = recorder.currentTime
        stop()

        defer { try? FileManager.default.removeItem(at: fileUrl) }
        guard duration >= 0.5, let data = try? Data(contentsOf: fileUrl) else { return nil }
        return (data, Int(duration * 1000))
    }

    func cancel() {
        if let fileUrl { try? FileManager.default.removeItem(at: fileUrl) }
        stop()
    }

    private func stop() {
        ticker?.cancel(); ticker = nil
        recorder?.stop()
        recorder = nil
        isRecording = false
        elapsed = 0
        // Hand the audio session back — leaving playAndRecord active routes all
        // other audio through the earpiece path and mutes ringers.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

// ── Playback ─────────────────────────────────────────────────────────────────

/// One shared player, because two voice notes talking over each other is never
/// what anyone wants — starting one stops the other, WhatsApp-style.
///
/// Fetch-then-play with `AVAudioPlayer`, not streaming with `AVPlayer`. Message
/// attachments are private and need the bearer token, and the only way to feed
/// `AVURLAsset` a header — `AVURLAssetHTTPHeaderFieldsKey` — is undocumented and
/// routinely dropped, so the request 401s and the item dies with no error while
/// the button sits on "pause" and nothing plays. That was the bug. A voice note
/// is a few hundred kilobytes; downloading it with an ordinary authorized
/// request and handing the bytes to `AVAudioPlayer` is both reliable and gives
/// `duration`/`currentTime` synchronously for the scrubber.
@MainActor
final class VoiceNotePlayer: NSObject, ObservableObject {
    static let shared = VoiceNotePlayer()

    /// Attachment id currently playing, or nil.
    @Published private(set) var playingId: String?
    /// Attachment id currently being fetched before it can play.
    @Published private(set) var loadingId: String?
    @Published private(set) var progress: Double = 0

    private var player: AVAudioPlayer?
    private var ticker: Task<Void, Never>?
    private var fetch: Task<Void, Never>?
    private var tokenProvider: () -> String? = { nil }
    private let session = URLSession(configuration: .default)

    private override init() {}

    func attach(tokenProvider: @escaping () -> String?) {
        self.tokenProvider = tokenProvider
    }

    func toggle(id: String, url: String) {
        if playingId == id || loadingId == id {
            stop()
            return
        }
        stop()

        guard let parsed = URL(string: url) else { return }
        loadingId = id

        fetch = Task { [weak self] in
            guard let self else { return }
            let data: Data?
            if parsed.isFileURL {
                // A note that is still uploading plays from its local copy.
                data = try? Data(contentsOf: parsed)
            } else {
                var request = URLRequest(url: parsed)
                if let host = parsed.host, AppConfig.apiHosts.contains(host), let token = tokenProvider() {
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                }
                data = try? await session.data(for: request).0
            }

            guard !Task.isCancelled, loadingId == id, let data else {
                if loadingId == id { loadingId = nil }
                return
            }
            play(id: id, data: data)
        }
    }

    private func play(id: String, data: Data) {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)

        guard let player = try? AVAudioPlayer(data: data) else {
            loadingId = nil
            return
        }
        player.delegate = self
        self.player = player
        loadingId = nil
        playingId = id
        progress = 0
        player.play()

        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard let self, let player = self.player, player.duration > 0 else { return }
                self.progress = min(player.currentTime / player.duration, 1)
            }
        }
    }

    func stop() {
        fetch?.cancel(); fetch = nil
        ticker?.cancel(); ticker = nil
        player?.stop()
        player = nil
        playingId = nil
        loadingId = nil
        progress = 0
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

extension VoiceNotePlayer: AVAudioPlayerDelegate {
    nonisolated func audioPlayerDidFinishPlaying(_: AVAudioPlayer, successfully _: Bool) {
        Task { @MainActor [weak self] in self?.stop() }
    }
}

// ── Bubble bodies ────────────────────────────────────────────────────────────

/// A voice note: play control, progress, duration.
struct VoiceNoteBody: View {
    @Environment(\.neu) private var colors
    @ObservedObject private var player = VoiceNotePlayer.shared

    let message: Message
    let isMine: Bool

    var body: some View {
        let attachment = message.attachments.first
        let playing = player.playingId == message.id
        let loading = player.loadingId == message.id
        let onColor = isMine ? colors.onOutgoing : colors.textPrimary

        HStack(spacing: 10) {
            Group {
                if loading {
                    ProgressView().tint(isMine ? colors.outgoing : colors.onAccent)
                } else {
                    Image(systemName: playing ? "pause.fill" : "play.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(isMine ? colors.outgoing : colors.onAccent)
                }
            }
            .frame(width: 36, height: 36)
            .background(onColor, in: Circle())
            .contentShape(Circle())
            .onTapGesture {
                guard let url = attachment?.url, !message.isPending else { return }
                player.toggle(id: message.id, url: url)
            }

            VStack(alignment: .leading, spacing: 5) {
                Waveform(
                    bars: bars,
                    progress: playing ? player.progress : 0,
                    color: onColor
                )
                .frame(height: 26)

                Text(durationLabel)
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(onColor.opacity(0.7))
            }

            if message.isPending {
                ProgressView().tint(onColor)
            }
        }
        .frame(width: 210)
        .padding(.vertical, 4)
    }

    /// Real amplitudes when the server sent them; otherwise a stable set of
    /// bars derived from the message id — the same note always draws the same
    /// shape, and it never reshuffles on a redraw.
    private var bars: [CGFloat] {
        if let waveform = message.attachments.first?.waveform, !waveform.isEmpty {
            let peak = CGFloat(waveform.max() ?? 1)
            return waveform.map { peak > 0 ? CGFloat($0) / peak : 0.2 }
        }
        var seed = UInt64(abs(message.id.hashValue) | 1)
        return (0 ..< 34).map { _ in
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return 0.25 + CGFloat(seed >> 40 & 0xFF) / 255 * 0.75
        }
    }

    private var durationLabel: String {
        let ms = message.attachments.first?.durationMs ?? 0
        let seconds = max(ms / 1000, 1)
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

/// The bar view. Bars up to the play head take the full colour; the rest are
/// dimmed, so the fill reads as progress the same way a scrubber would.
private struct Waveform: View {
    let bars: [CGFloat]
    let progress: Double
    let color: Color

    var body: some View {
        GeometryReader { geometry in
            let count = bars.count
            let spacing: CGFloat = 2
            let barWidth = max((geometry.size.width - spacing * CGFloat(count - 1)) / CGFloat(count), 1)
            let played = Int((progress * Double(count)).rounded())

            HStack(alignment: .center, spacing: spacing) {
                ForEach(bars.indices, id: \.self) { index in
                    Capsule()
                        .fill(color.opacity(index < played ? 1 : 0.3))
                        .frame(
                            width: barWidth,
                            height: max(geometry.size.height * bars[index], 3)
                        )
                }
            }
            .frame(height: geometry.size.height, alignment: .center)
        }
    }
}

/// A video: poster (or a quiet placeholder while there is none) with a play
/// badge; tapping opens the full-screen player.
struct VideoBody: View {
    @Environment(\.neu) private var colors

    let message: Message
    let isMine: Bool

    @State private var playerOpen = false
    @State private var poster: UIImage?

    var body: some View {
        let attachment = message.attachments.first
        let ratio: CGFloat = {
            if let width = attachment?.width, let height = attachment?.height, height > 0 {
                return min(max(CGFloat(width) / CGFloat(height), 0.6), 1.8)
            }
            return 1.33
        }()

        ZStack {
            // The poster rides in an overlay of a fixed frame for the same
            // reason as the media wall: whatever the file reports can never
            // become layout.
            Color.black.opacity(0.85)
                .frame(width: 240, height: 240 / ratio)
                .overlay {
                    if let serverPoster = attachment?.thumbnailUrl {
                        RemoteImage(url: serverPoster)
                    } else if let poster {
                        Image(uiImage: poster).resizable().aspectRatio(contentMode: .fill)
                    }
                }
                .clipShape(NeuShape(radius: Neu.cornerSmall))

            if message.isPending {
                ProgressView()
                    .tint(.white)
                    .frame(width: 44, height: 44)
                    .background(Color.black.opacity(0.45), in: Circle())
            } else {
                Image(systemName: "play.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(Color.black.opacity(0.45), in: Circle())
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard !message.isPending, message.attachments.first?.url != nil else { return }
            playerOpen = true
        }
        .fullScreenCover(isPresented: $playerOpen) {
            if let url = message.attachments.first?.url {
                VideoPlayerScreen(url: url, onDismiss: { playerOpen = false })
            }
        }
        .task(id: attachment?.url) {
            guard poster == nil, attachment?.thumbnailUrl == nil, let url = attachment?.url else { return }
            poster = await VideoPoster.first(url: url, token: ImageLoader.shared.currentToken())
        }
    }
}
