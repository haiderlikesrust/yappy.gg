import SwiftUI

/// What happened while you were away, at the top of the chat.
///
/// Deliberately not a summary of what was *said*. A generated paragraph about a
/// conversation is a guess that nobody in it can check, and being subtly wrong
/// about what your friends said is worse than saying nothing. Everything here
/// is a fact: how many, who, and what they posted.
///
/// It answers one question — is there anything in here for me — and then gets
/// out of the way, which is why it can be dismissed.
struct CatchUpCard: View {
    let catchUp: CatchUp
    let onDismiss: () -> Void
    let onOpenMessage: (String) -> Void

    @Environment(\.neu) private var colors

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            if !catchUp.participants.isEmpty {
                people
            }

            if !catchUp.media.isEmpty {
                pictures
            }

            if !catchUp.mentions.isEmpty {
                mentions
            }
        }
        .padding(14)
        .background(colors.dark.opacity(0.08), in: NeuShape(radius: Neu.cornerMedium))
        .padding(.horizontal, 14)
        .padding(.vertical, 4)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text("While you were away")
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(colors.textPrimary)
                Text(summary)
                    .font(YappyFont.bodySmall)
                    .foregroundStyle(colors.textTertiary)
            }
            Spacer(minLength: 0)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(colors.textTertiary)
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
    }

    /// "14 messages from 3 people". `capped` means the count is a floor, so it
    /// is shown as "500+" rather than as a number that is quietly wrong.
    private var summary: String {
        var text = "\(catchUp.newMessages)\(catchUp.capped ? "+" : "")"
        text += catchUp.newMessages == 1 ? " message" : " messages"
        if !catchUp.participants.isEmpty {
            let count = catchUp.participants.count
            text += " from \(count) \(count == 1 ? "person" : "people")"
        }
        return text
    }

    /// Who was talking, loudest first — the server already ordered them.
    private var people: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 14) {
                ForEach(catchUp.participants) { entry in
                    VStack(spacing: 4) {
                        Avatar(
                            url: entry.user.avatarUrl,
                            name: entry.user.label,
                            id: entry.user.id,
                            size: 34
                        )
                        Text("\(entry.count)")
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.textTertiary)
                    }
                }
            }
        }
    }

    /// Pictures, because "did I miss anything" usually means "did anybody post
    /// anything I want to see".
    private var pictures: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(catchUp.media) { picture in
                    RemoteImage(url: picture.thumbnailUrl ?? picture.url)
                        .frame(width: 58, height: 58)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
            }
        }
    }

    /// Mentions last and loudest: of everything here, being named is the one
    /// thing somebody actually has to act on.
    private var mentions: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(catchUp.mentions.prefix(3))) { mention in
                Button {
                    onOpenMessage(mention.id)
                } label: {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(colors.accent)
                            .frame(width: 4, height: 4)
                        Text("\(mention.sender?.label ?? "Someone") mentioned you")
                            .font(YappyFont.labelMedium)
                            .foregroundStyle(colors.accent)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 9)
                    .padding(.vertical, 7)
                    .background(
                        colors.accent.opacity(0.10),
                        in: RoundedRectangle(cornerRadius: 9, style: .continuous)
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }
}
