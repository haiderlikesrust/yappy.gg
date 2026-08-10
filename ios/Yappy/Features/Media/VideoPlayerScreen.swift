import AVKit
import SwiftUI

/// Full-screen video playback.
///
/// The player is created here rather than in the view body so the asset can
/// carry the bearer token — message attachments are private, and `VideoPlayer`
/// given a bare URL would just show a black frame over a 401.
struct VideoPlayerScreen: View {
    let url: String
    let onDismiss: () -> Void

    @State private var player: AVPlayer?

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()

            if let player {
                VideoPlayer(player: player)
                    .ignoresSafeArea()
            }

            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 38, height: 38)
                    .background(.black.opacity(0.5), in: Circle())
            }
            .padding(.leading, 16)
            .padding(.top, 8)
        }
        .statusBarHidden()
        .onAppear {
            guard let parsed = URL(string: url) else { return }
            var options: [String: Any] = [:]
            if let host = parsed.host, AppConfig.apiHosts.contains(host),
               let token = ImageLoader.shared.currentToken() {
                options["AVURLAssetHTTPHeaderFieldsKey"] = ["Authorization": "Bearer \(token)"]
            }
            let created = AVPlayer(playerItem: AVPlayerItem(asset: AVURLAsset(url: parsed, options: options)))
            player = created
            try? AVAudioSession.sharedInstance().setCategory(.playback)
            created.play()
        }
        .onDisappear {
            player?.pause()
            player = nil
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }
}
