import SwiftUI

struct CallMiniPlayer: View {
    @Environment(\.neu) private var colors
    @ObservedObject var engine: CallEngine
    @ObservedObject private var system = CallSystem.shared
    let onOpen: (String) -> Void

    var body: some View {
        if Feature.calling, let id = system.activeCallId {
            HStack(spacing: 8) {
                Button { onOpen(id) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "waveform").font(.title3)
                            .foregroundStyle(colors.success)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(system.displayName).font(.subheadline.weight(.semibold)).lineLimit(1)
                            TimelineView(.periodic(from: .now, by: 1)) { context in
                                Text(status(at: context.date)).font(.caption).monospacedDigit()
                                    .foregroundStyle(colors.textSecondary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityHint("Return to the call")
                Button { system.setMuted(!system.muted) } label: {
                    Image(systemName: system.muted ? "mic.slash.fill" : "mic.fill")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(system.muted ? "Unmute" : "Mute")
                .disabled(!CallEngine.microphoneGranted)
                Button { system.hangUp(id) } label: {
                    Image(systemName: "phone.down.fill").foregroundStyle(.white)
                        .frame(width: 44, height: 44).background(colors.danger, in: Circle())
                }.accessibilityLabel("End call")
            }
            .foregroundStyle(colors.textPrimary).tint(colors.accent)
            .padding(10)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24))
            .overlay(RoundedRectangle(cornerRadius: 24).stroke(colors.accent.opacity(0.18)))
            .padding(.horizontal, 12).padding(.vertical, 8)
        }
    }

    private func status(at now: Date) -> String {
        switch engine.media.state {
        case .reconnecting: return "Reconnecting…"
        case .connected:
            if let since = system.connectedAt {
                return YappyTime.duration(max(0, Int(now.timeIntervalSince(since))))
                    + (system.muted ? " · Muted" : " · Tap to return")
            }
            return "In call · Tap to return"
        case .failed, .disconnected: return "Call disconnected"
        default: return system.activeCall?.state == "ringing" ? "Ringing…" : "Connecting…"
        }
    }
}
