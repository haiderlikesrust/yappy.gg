import SwiftUI

/// A rich card.
///
/// Flat, like every other piece of *content* in this app — the accent bar down
/// the left edge does the work a shadow would do elsewhere, and it is the one
/// place an author-chosen colour is allowed to land.
///
/// Deliberately not tappable as a whole: a card whose every pixel is a link is
/// how people get phished. Only the title opens the URL.
struct EmbedCard: View {
    @Environment(\.neu) private var colors
    @Environment(\.openURL) private var openURL

    let embed: Embed

    var body: some View {
        let accent = Color(hexString: embed.color) ?? colors.accent

        HStack(alignment: .top, spacing: 0) {
            // The bar matches the content's height because the row sizes to its
            // tallest child and the bar is told to fill.
            Rectangle()
                .fill(accent)
                .frame(width: 4)

            VStack(alignment: .leading, spacing: 0) {
                if let author = embed.author {
                    authorLine(author).padding(.bottom, 4)
                }

                if embed.author == nil, let provider = embed.provider {
                    Text(provider)
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.textTertiary)
                        .padding(.bottom, 3)
                }

                if let title = embed.title {
                    Text(title)
                        .font(YappyFont.titleSmallBold)
                        .foregroundStyle(embed.url != nil ? accent : colors.textPrimary)
                        .lineLimit(2)
                        .padding(.bottom, 4)
                        .softTap(enabled: embed.url != nil) {
                            if let url = embed.url.flatMap(URL.init(string:)) { openURL(url) }
                        }
                }

                if let description = embed.description {
                    Text(description)
                        .font(YappyFont.bodyMedium)
                        .foregroundStyle(colors.textSecondary)
                        .lineLimit(8)
                }

                if !embed.fields.isEmpty {
                    fieldGrid.padding(.top, 8)
                }

                if let image = embed.image {
                    RemoteImage(url: image.url)
                        .frame(height: 150)
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .padding(.top, 8)
                }

                if let footer = embed.footer {
                    footerLine(footer).padding(.top, 8)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .frame(maxWidth: 300, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background(colors.incoming, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func authorLine(_ author: EmbedAuthor) -> some View {
        HStack(spacing: 6) {
            if let icon = author.iconUrl {
                RemoteImage(url: icon)
                    .frame(width: 18, height: 18)
                    .clipShape(Circle())
            }
            Text(author.name)
                .font(YappyFont.labelMedium)
                .foregroundStyle(colors.textSecondary)
                .lineLimit(1)
        }
    }

    private func footerLine(_ footer: EmbedFooter) -> some View {
        HStack(spacing: 5) {
            if let icon = footer.iconUrl {
                RemoteImage(url: icon)
                    .frame(width: 14, height: 14)
                    .clipShape(Circle())
            }
            Text(footer.text)
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)
                .lineLimit(1)
        }
    }

    /// Inline fields sit two-up; block fields take the full width.
    ///
    /// Chunked rather than a grid, because a grid would reflow them into
    /// column order and authors write fields expecting reading order.
    private var fieldGrid: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(alignment: .top, spacing: 12) {
                    ForEach(row) { field in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(field.name)
                                .font(YappyFont.body(11, weight: .semibold))
                                .foregroundStyle(colors.textPrimary)
                            Text(field.value)
                                .font(YappyFont.bodyMedium)
                                .foregroundStyle(colors.textSecondary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if row.count == 1, row[0].inline {
                        Color.clear.frame(maxWidth: .infinity)
                    }
                }
            }
        }
    }

    private var rows: [[EmbedField]] {
        var result: [[EmbedField]] = []
        var run: [EmbedField] = []

        for field in embed.fields {
            if field.inline {
                run.append(field)
                if run.count == 2 {
                    result.append(run)
                    run = []
                }
            } else {
                if !run.isEmpty {
                    result.append(run)
                    run = []
                }
                result.append([field])
            }
        }
        if !run.isEmpty { result.append(run) }
        return result
    }
}

/// Buttons a bot attached to its message.
///
/// Flat, like embeds and unlike the app's chrome: this is content, and giving it
/// the raised treatment used for real controls would blur the line between "the
/// app is offering this" and "someone in the conversation is". The colour
/// carries the affordance instead.
///
/// A press is optimistic in appearance only — the row shows a spinner and stops
/// accepting input until the server answers, because the outcome (approving a
/// sign-in) is not something to guess at and then correct.
struct ComponentRows: View {
    @Environment(\.neu) private var colors

    let rows: [MessageComponentRow]
    let myUserId: String?
    let pressing: String?
    let onPress: (MessageButton) -> Void

    var body: some View {
        VStack(spacing: 6) {
            ForEach(rows) { row in
                HStack(spacing: 6) {
                    ForEach(row.components) { button in
                        cell(button)
                    }
                }
            }
        }
        .frame(maxWidth: 300)
    }

    private func cell(_ button: MessageButton) -> some View {
        // A button addressed to someone else is shown, not hidden: seeing that a
        // prompt exists but is not yours is clearer than a card whose buttons
        // vanished.
        let forSomeoneElse = button.onlyUserId != nil && button.onlyUserId != myUserId
        let inert = button.disabled || forSomeoneElse
        let busy = pressing == button.customId
        let enabled = !inert && pressing == nil

        let fill: Color = {
            if inert { return colors.dark.opacity(0.07) }
            switch button.style {
            case "success": return Color(hex: 0x3DD68C)
            case "danger": return Color(hex: 0xFF6369)
            case "primary": return colors.accent
            default: return colors.dark.opacity(0.10)
            }
        }()

        let label: Color = {
            if inert { return colors.textTertiary }
            return button.style == "secondary" ? colors.textPrimary : .white
        }()

        return ZStack {
            if busy {
                ProgressView().tint(label).controlSize(.small)
            } else {
                // Two lines, then ellipsis. A bot chooses its own labels and
                // cannot know how wide two-up buttons are on a given phone;
                // silently clipping mid-word turns "Only people I follow" into
                // "Only people I", which reads as a different answer.
                Text(button.label)
                    .font(YappyFont.labelLarge)
                    .foregroundStyle(label)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .softTap(enabled: enabled) { onPress(button) }
    }
}
