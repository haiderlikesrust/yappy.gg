import SwiftUI

struct VoiceConnectedBar: View {
    @Environment(\.neu) private var colors
    @ObservedObject var voice: VoiceChannels
    @ObservedObject var engine: CallEngine
    let onOpen: (String) -> Void

    var body: some View {
        if let session = voice.session {
            HStack(spacing: 4) {
                Button { onOpen(session.spaceId) } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "waveform")
                        VStack(alignment: .leading, spacing: 2) {
                            Text(status).font(YappyFont.labelSmall)
                            Text(session.title).font(YappyFont.titleSmall).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Button { Task { await voice.toggleMute() } } label: {
                    Image(systemName: engine.media.micEnabled ? "mic.fill" : "mic.slash.fill")
                        .frame(width: 44, height: 44)
                }
                .disabled(engine.media.state != .connected)
                .accessibilityLabel(engine.media.micEnabled ? "Mute microphone" : "Unmute microphone")
                Button { engine.setSpeaker(!engine.speakerEnabled) } label: {
                    Image(systemName: engine.speakerEnabled ? "speaker.wave.2.fill" : "speaker.fill")
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel(engine.speakerEnabled ? "Turn speaker off" : "Turn speaker on")
                Button { voice.leave() } label: {
                    Image(systemName: "phone.down.fill").frame(width: 44, height: 44)
                        .foregroundStyle(colors.danger)
                }
                .accessibilityLabel("Leave voice channel")
            }
            .foregroundStyle(colors.accent)
            .padding(.leading, 16).padding(.trailing, 6).padding(.vertical, 6)
            .background(colors.surface)
            .overlay(alignment: .top) { NeuHairline() }
        }
    }

    private var status: String {
        switch engine.media.state {
        case .connected: return engine.media.micEnabled ? "In voice" : "In voice · mic off"
        case .reconnecting: return "Reconnecting…"
        default: return "Joining voice…"
        }
    }
}

struct VoiceChannelSeats: View {
    @Environment(\.neu) private var colors
    @ObservedObject var voice: VoiceChannels
    @ObservedObject var engine: CallEngine
    let channel: ChannelEntry
    let spaceId: String

    private var seated: Bool { voice.session?.channelId == channel.id }
    private var people: [VoiceOccupant] { voice.rosters[channel.id] ?? channel.voiceParticipants }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(people.isEmpty ? "Room is open" : "\(people.count) in voice")
                    .font(YappyFont.labelSmall).foregroundStyle(colors.textSecondary)
                Spacer()
                Button(seated ? "Leave" : "Join voice") {
                    if seated { voice.leave() }
                    else { voice.join(channelId: channel.id, spaceId: spaceId, title: channel.title ?? "Voice") }
                }
                .font(YappyFont.labelMedium).foregroundStyle(seated ? colors.danger : colors.accent)
                .frame(minHeight: 44)
            }
            if !people.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 14) {
                        ForEach(people) { person in
                            VStack(spacing: 4) {
                                Avatar(url: person.avatarUrl, name: person.label, id: person.id, size: 38)
                                    .overlay {
                                        Circle().stroke(seated && engine.media.speaking.contains(person.id)
                                                        ? colors.accent : .clear, lineWidth: 3)
                                    }
                                Text(person.label).lineLimit(1).font(YappyFont.labelSmall)
                                    .foregroundStyle(colors.textSecondary)
                            }
                            .frame(width: 60)
                            .accessibilityLabel(person.label + (person.isMuted == true ? ", muted" : ""))
                        }
                    }
                }
            }
        }
        .padding(.leading, 56).padding(.trailing, 14).padding(.bottom, 10)
    }
}
