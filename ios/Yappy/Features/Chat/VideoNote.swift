import AVFoundation
import SwiftUI

// ── Capture ──────────────────────────────────────────────────────────────────

/// Records a video note: front camera, small frame, capped length.
///
/// VGA on purpose — a video note is a face in a circle, and 640 pixels is
/// already more than the 220-point bubble will ever show. It also keeps a
/// full-length note around a few megabytes, which matters more than fidelity
/// on the cellular link most of these are sent over.
@MainActor
final class VideoNoteCapture: NSObject, ObservableObject {
    @Published private(set) var isRecording = false
    @Published private(set) var elapsed: TimeInterval = 0
    @Published var permissionDenied = false
    /// Set when the recording lands on disk, ready to send.
    @Published private(set) var finished: (url: URL, durationMs: Int)?
    /// No front camera — the simulator, mainly.
    @Published private(set) var unavailable = false

    let session = AVCaptureSession()
    private let output = AVCaptureMovieFileOutput()
    private var ticker: Task<Void, Never>?
    /// Cancelled mid-recording: the delegate callback should discard the file.
    private var discardOnFinish = false

    func start() async {
        let camera = await AVCaptureDevice.requestAccess(for: .video)
        let mic = await AVCaptureDevice.requestAccess(for: .audio)
        guard camera, mic else {
            permissionDenied = true
            return
        }

        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
              let videoInput = try? AVCaptureDeviceInput(device: device),
              let micDevice = AVCaptureDevice.default(for: .audio),
              let micInput = try? AVCaptureDeviceInput(device: micDevice)
        else {
            unavailable = true
            return
        }

        session.beginConfiguration()
        session.sessionPreset = .vga640x480
        if session.canAddInput(videoInput) { session.addInput(videoInput) }
        if session.canAddInput(micInput) { session.addInput(micInput) }
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()

        // Blocking; never on the main thread.
        let session = session
        await Task.detached { session.startRunning() }.value

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("video-note-\(UUID().uuidString).mov")
        output.startRecording(to: url, recordingDelegate: self)
        isRecording = true

        ticker?.cancel()
        ticker = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(200))
                guard let self, self.isRecording else { return }
                self.elapsed = self.output.recordedDuration.seconds
                // A minute, like everyone else's video notes — past that it is
                // a video, and the library picker exists for those.
                if self.elapsed >= 60 { self.stop() }
            }
        }
    }

    func stop() {
        guard isRecording else { return }
        isRecording = false
        ticker?.cancel(); ticker = nil
        output.stopRecording()
    }

    func cancel() {
        discardOnFinish = true
        if isRecording {
            stop()
        } else {
            tearDown()
        }
    }

    func tearDown() {
        ticker?.cancel(); ticker = nil
        let session = session
        Task.detached { if session.isRunning { session.stopRunning() } }
    }
}

extension VideoNoteCapture: AVCaptureFileOutputRecordingDelegate {
    nonisolated func fileOutput(
        _ output: AVCaptureFileOutput,
        didFinishRecordingTo outputFileURL: URL,
        from _: [AVCaptureConnection],
        error: Error?
    ) {
        let duration = output.recordedDuration.seconds
        Task { @MainActor [weak self] in
            guard let self else { return }
            tearDown()
            if discardOnFinish || error != nil || duration < 0.5 {
                try? FileManager.default.removeItem(at: outputFileURL)
                return
            }
            finished = (outputFileURL, Int(duration * 1000))
        }
    }
}

/// The camera feed, masked to the circle it will be displayed in.
private struct CapturePreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context _: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_: PreviewView, context _: Context) {}

    final class PreviewView: UIView {
        override static var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}

// ── Recorder screen ──────────────────────────────────────────────────────────

/// Full-screen video-note recording: a live circle, a timer, cancel and send.
///
/// Recording starts the moment the screen appears — the person pressed and
/// held a camera button to get here; a second "start" button would be
/// ceremony.
struct VideoNoteRecorderScreen: View {
    @Environment(\.neu) private var colors

    let onSend: (URL, Int) -> Void
    let onDismiss: () -> Void

    @StateObject private var capture = VideoNoteCapture()

    /// The capture class stops itself at a minute; the ring below draws
    /// against the same number so it completes exactly as recording ends.
    private let limit: TimeInterval = 60

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 28) {
                Spacer()

                ZStack {
                    CapturePreview(session: capture.session)
                        .frame(width: 280, height: 280)
                        .clipShape(Circle())

                    if capture.unavailable || capture.permissionDenied {
                        Circle()
                            .fill(Color.white.opacity(0.08))
                            .frame(width: 280, height: 280)
                        Text(capture.permissionDenied
                            ? "Allow camera and microphone access in Settings"
                            : "No camera on this device")
                            .font(YappyFont.bodyMedium)
                            .foregroundStyle(.white.opacity(0.8))
                            .multilineTextAlignment(.center)
                            .frame(width: 200)
                    }
                }
                // The minute, spent visibly: the ring fills clockwise from
                // twelve as the recording runs, so "how much is left" is read
                // off the circle itself instead of arithmetic on the timer.
                .overlay {
                    Circle()
                        .trim(from: 0, to: capture.elapsed / limit)
                        .stroke(
                            brandGradient(colors),
                            style: StrokeStyle(lineWidth: 4, lineCap: .round)
                        )
                        .rotationEffect(.degrees(-90))
                        // A hair outside the feed, so the gap reads as a
                        // deliberate ring and not a border eating the video.
                        .padding(-8)
                        .opacity(capture.isRecording ? 1 : 0)
                        .animation(.linear(duration: 0.2), value: capture.elapsed)
                }

                HStack(spacing: 8) {
                    if capture.isRecording {
                        Circle().fill(Color.red).frame(width: 8, height: 8)
                    }
                    Text(timerLabel)
                        .font(YappyFont.titleMedium)
                        .monospacedDigit()
                        .foregroundStyle(.white)
                }

                Spacer()

                HStack(spacing: 60) {
                    Button {
                        capture.cancel()
                        onDismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 56, height: 56)
                            .background(.white.opacity(0.15), in: Circle())
                    }

                    Button {
                        capture.stop()
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 22, weight: .bold))
                            .foregroundStyle(.black)
                            .frame(width: 68, height: 68)
                            .background(.white, in: Circle())
                    }
                    .disabled(!capture.isRecording)
                    .opacity(capture.isRecording ? 1 : 0.4)
                }
                .padding(.bottom, 48)
            }
        }
        .statusBarHidden()
        .task { await capture.start() }
        .onChange(of: capture.finished?.url) { _, _ in
            guard let finished = capture.finished else { return }
            onSend(finished.url, finished.durationMs)
            onDismiss()
        }
        .onDisappear { capture.cancel() }
    }

    private var timerLabel: String {
        let seconds = Int(capture.elapsed)
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

// ── Bubble body ──────────────────────────────────────────────────────────────

/// A video note in the timeline: a circle that plays in place when tapped.
struct VideoNoteBody: View {
    @Environment(\.neu) private var colors

    let message: Message
    let isMine: Bool

    @StateObject private var player = InlinePlayer()
    /// Client-generated first frame, since video has no server thumbnail.
    @State private var poster: UIImage?

    var body: some View {
        ZStack {
            Circle()
                .fill(Color.black.opacity(0.85))
                .frame(width: 200, height: 200)
                .overlay {
                    if !player.isActive {
                        if let serverPoster = message.attachments.first?.thumbnailUrl {
                            RemoteImage(url: serverPoster)
                        } else if let poster {
                            Image(uiImage: poster)
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                        }
                    }
                }
                .overlay {
                    if player.isActive {
                        InlineVideoView(player: player.player)
                    }
                }
                .clipShape(Circle())

            if message.isPending || player.isLoading {
                ProgressView()
                    .tint(.white)
                    .frame(width: 44, height: 44)
                    .background(Color.black.opacity(0.45), in: Circle())
            } else if !player.isPlaying {
                Image(systemName: "play.fill")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(Color.black.opacity(0.45), in: Circle())
            }
        }
        .frame(width: 200, height: 200)
        .contentShape(Circle())
        .onTapGesture {
            guard !message.isPending, let url = message.attachments.first?.url else { return }
            player.toggle(url: url)
        }
        .task(id: message.attachments.first?.url) {
            guard poster == nil, message.attachments.first?.thumbnailUrl == nil,
                  let url = message.attachments.first?.url else { return }
            poster = await VideoPoster.first(url: url, token: ImageLoader.shared.currentToken())
        }
        .onDisappear { player.stop() }
    }
}

/// Playback for one circle. Deliberately per-bubble rather than shared: a video
/// note that scrolls away stops itself via `onDisappear`, and two playing at
/// once is prevented by the audio session takeover.
@MainActor
final class InlinePlayer: ObservableObject {
    @Published private(set) var isPlaying = false
    @Published private(set) var isLoading = false
    @Published private(set) var isActive = false

    let player = AVPlayer()
    private var endObserver: NSObjectProtocol?
    private var fetch: Task<Void, Never>?
    private var localFile: URL?
    private let session = URLSession(configuration: .default)

    func toggle(url: String) {
        if isLoading { return }
        if isPlaying {
            player.pause()
            isPlaying = false
            return
        }
        // Already loaded once — just resume.
        if isActive {
            try? AVAudioSession.sharedInstance().setCategory(.playback)
            player.play()
            isPlaying = true
            return
        }

        guard let parsed = URL(string: url) else { return }
        isLoading = true

        // Download-then-play, not streaming.
        //
        // Feeding AVURLAsset a bearer token needs AVURLAssetHTTPHeaderFieldsKey,
        // which iOS routinely ignores — the request 401s and the circle sits
        // black and silent, which is exactly how a received video note arrived.
        // A note is a few megabytes at most, so fetch it with an ordinary
        // authorized request and play the local file.
        fetch = Task { [weak self] in
            guard let self else { return }
            let data: Data?
            if parsed.isFileURL {
                data = try? Data(contentsOf: parsed)
            } else {
                var request = URLRequest(url: parsed)
                if let host = parsed.host, AppConfig.apiHosts.contains(host),
                   let token = ImageLoader.shared.currentToken() {
                    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                }
                data = try? await session.data(for: request).0
            }

            guard !Task.isCancelled, let data else {
                isLoading = false
                return
            }

            let temp = FileManager.default.temporaryDirectory
                .appendingPathComponent("vn-\(UUID().uuidString).mov")
            guard (try? data.write(to: temp)) != nil else { isLoading = false; return }
            localFile = temp
            startPlayback(from: temp)
        }
    }

    private func startPlayback(from fileUrl: URL) {
        let item = AVPlayerItem(url: fileUrl)
        player.replaceCurrentItem(with: item)
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.player.seek(to: .zero)
                self?.isPlaying = false
            }
        }
        try? AVAudioSession.sharedInstance().setCategory(.playback)
        isActive = true
        isLoading = false
        isPlaying = true
        player.play()
    }

    func stop() {
        fetch?.cancel(); fetch = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        if let localFile { try? FileManager.default.removeItem(at: localFile); self.localFile = nil }
        isPlaying = false
        isLoading = false
        isActive = false
    }
}

private struct InlineVideoView: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context _: Context) -> PlayerView {
        let view = PlayerView()
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_: PlayerView, context _: Context) {}

    final class PlayerView: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}
