import SwiftUI

/// Identity marks.
///
/// Two different claims, drawn differently on purpose:
///
///   badge       — the platform vouching for an account. A scalloped seal.
///   affiliation — a *group* vouching for a person. The group's own logo, in the
///                 squircle that means "place" everywhere else in the app.
///
/// Keeping them visually distinct matters more than it might seem: conflating
/// "yappy says this is really them" with "this org says they work here" is how
/// badge systems end up meaning nothing. The seal is ours to give; the squircle
/// is someone else's, and it looks borrowed.
///
/// Marks are drawn, not iconography from a set — at 14pt a stock symbol reads as
/// a smudge, and a seal built from circles stays legible down to 12pt.

enum BadgeKind {
    static let verified = "verified"
    static let partner = "partner"
    static let staff = "staff"
}

/// Human-readable, for profile screens and long-press explanations.
func badgeLabel(_ badge: String?) -> String? {
    switch badge {
    case BadgeKind.verified: return "Verified"
    case BadgeKind.partner: return "yappy partner"
    case BadgeKind.staff: return "yappy staff"
    default: return nil
    }
}

func badgeDescription(_ badge: String?) -> String? {
    switch badge {
    case BadgeKind.verified: return "yappy confirmed this account is who it says it is."
    case BadgeKind.partner: return "Part of the yappy partner programme."
    case BadgeKind.staff: return "Works on yappy."
    default: return nil
    }
}

/// The seal: a disc ringed by overlapping lobes.
///
/// Filling overlapping circles unions them for free, which is far less code than
/// solving for a scalloped outline and holds its shape at any size.
private struct Seal: Shape {
    var lobes: Int = 9

    func path(in rect: CGRect) -> Path {
        let radius = min(rect.width, rect.height) / 2
        let centre = CGPoint(x: rect.midX, y: rect.midY)
        let core = radius * 0.72
        let lobeRadius = radius * 0.30
        let ring = radius * 0.70

        var path = Path()
        path.addEllipse(in: CGRect(
            x: centre.x - core, y: centre.y - core,
            width: core * 2, height: core * 2
        ))
        for index in 0 ..< lobes {
            let angle: CGFloat = (2 * .pi * CGFloat(index) / CGFloat(lobes)) - .pi / 2
            let point = CGPoint(
                x: centre.x + cos(angle) * ring,
                y: centre.y + sin(angle) * ring
            )
            path.addEllipse(in: CGRect(
                x: point.x - lobeRadius, y: point.y - lobeRadius,
                width: lobeRadius * 2, height: lobeRadius * 2
            ))
        }
        return path
    }
}

private struct SealCheck: Shape {
    func path(in rect: CGRect) -> Path {
        let w = rect.width
        var path = Path()
        path.move(to: CGPoint(x: w * 0.31, y: w * 0.51))
        path.addLine(to: CGPoint(x: w * 0.44, y: w * 0.64))
        path.addLine(to: CGPoint(x: w * 0.70, y: w * 0.37))
        return path
    }
}

/// One badge. Renders nothing for an unknown or absent kind, so call sites can
/// pass a raw wire string without branching — and a badge kind added by a newer
/// server simply does not appear on an older build, rather than crashing it.
struct BadgeMark: View {
    @Environment(\.neu) private var colors
    let badge: String?
    var size: CGFloat = 15

    var body: some View {
        if badgeLabel(badge) != nil {
            let glyph = colors.isDark ? Color(hex: 0x14121F) : Color.white

            ZStack {
                Seal()
                    // Partner gets the gradient because it is the rarer, "earned"
                    // mark; a flat fill would make it read as a second verified.
                    .fill(sealGradient)
                if badge != BadgeKind.staff {
                    SealCheck()
                        .stroke(glyph, style: StrokeStyle(lineWidth: size * 0.11, lineCap: .round, lineJoin: .round))
                } else {
                    // Staff carries the wordmark initial instead of a check — the
                    // mark says "this is us", not "this is verified", and the two
                    // should not be distinguishable by colour alone.
                    Text("y")
                        .font(YappyFont.grotesk(size * 0.62, weight: 700))
                        .foregroundStyle(glyph)
                }
            }
            .frame(width: size, height: size)
            .accessibilityLabel(badgeLabel(badge) ?? "")
        }
    }

    private var sealGradient: LinearGradient {
        switch badge {
        case BadgeKind.partner:
            return LinearGradient(
                colors: [colors.accent, Color(hex: 0xFF6BD6)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
        case BadgeKind.staff:
            return LinearGradient(colors: [colors.warning, colors.warning], startPoint: .top, endPoint: .bottom)
        default:
            return LinearGradient(colors: [colors.accent, colors.accent], startPoint: .top, endPoint: .bottom)
        }
    }
}

/// The affiliated group's logo. A squircle, because in this app a squircle is
/// always a place — the shape is doing the explaining.
struct AffiliateMark: View {
    let affiliation: Affiliation?
    var size: CGFloat = 15

    var body: some View {
        if let affiliation {
            Avatar(
                url: affiliation.avatarUrl,
                name: affiliation.title,
                id: affiliation.id,
                size: size,
                shape: .place
            )
        }
    }
}

/// "BOT", next to a name.
///
/// Knowing a message came from software is not a nicety — it is the difference
/// between advice and an advertisement. It lived only on the chat bubble, so a
/// bot was indistinguishable from a person everywhere else: in the chat list,
/// in a member list, on its own profile. Anywhere a name is drawn, this is part
/// of the name.
struct BotTag: View {
    @Environment(\.neu) private var colors
    var size: CGFloat = 15

    var body: some View {
        Text("BOT")
            // Tracks the marks it sits beside rather than a fixed point size,
            // so it does not tower over a 13pt badge or vanish beside a 20pt one.
            .font(.system(size: max(8, size * 0.62), weight: .bold))
            .foregroundStyle(colors.onAccent)
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(colors.accent, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
            .fixedSize()
    }
}

/// Everything that goes after a name, in a fixed order: affiliation first (whose
/// it is), then the badge (what they are), then BOT (what it is). Emits nothing
/// at all when there is nothing to show, so it can be dropped into any row
/// without disturbing layout.
struct IdentityMarks: View {
    let user: PublicUser
    var size: CGFloat = 15
    /// The chat bubble draws its own, beside the sender name it already builds.
    var showsBot = true

    var body: some View {
        if user.badge != nil || user.affiliation != nil || (showsBot && user.isBot) {
            HStack(spacing: 3) {
                AffiliateMark(affiliation: user.affiliation, size: size)
                BadgeMark(badge: user.badge, size: size)
                if showsBot && user.isBot { BotTag(size: size) }
            }
        }
    }
}
