import SwiftUI

/// Group flair rendering.
///
/// A group's flair is its owner's one visual sentence about the place, so it has
/// to be *visible* (the whole point is the conversation list) without breaking
/// the design system. The rule: flair may add colour and motion *around* an
/// element — the ring, a glow, a tinted title — but never restyles the element
/// itself. That is what keeps a flaired row and a plain row siblings instead of
/// strangers.
extension ConversationAppearance {
    /// The two ring stops: explicit gradient, else accent doubled, else nil.
    var ringColors: [Color]? {
        if let gradient {
            let parsed = gradient.compactMap { Color(hexString: $0) }
            if parsed.count >= 2 { return parsed }
        }
        guard let solid = Color(hexString: accent) else { return nil }
        return [solid, solid.opacity(0.55)]
    }

    /// Colour a flaired title should take: the accent, else the first gradient
    /// stop.
    var titleColor: Color? {
        Color(hexString: accent) ?? gradient?.first.flatMap { Color(hexString: $0) }
    }

    /// A gradient an outgoing bubble or a send button can wear. Nil unless the
    /// group actually declared two stops — one colour is not a gradient, and
    /// faking the second makes every flaired group look the same.
    var bubbleGradient: LinearGradient? {
        guard let gradient else { return nil }
        let parsed = gradient.compactMap { Color(hexString: $0) }
        guard parsed.count >= 2 else { return nil }
        return LinearGradient(colors: parsed, startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

/// An `Avatar` wrapped in its group's flair: a gradient ring, optionally glowing
/// or shimmering. Falls back to a plain avatar when there is nothing to show, so
/// call sites do not need to branch.
struct FlairAvatar: View {
    let appearance: ConversationAppearance?
    let url: String?
    let name: String?
    let id: String
    var size: CGFloat = 48
    var presence: String?
    var shape: AvatarShape = .person

    @State private var angle: Double = 0

    var body: some View {
        if let ring = appearance?.ringColors {
            flaired(ring)
        } else {
            Avatar(url: url, name: name, id: id, size: size, presence: presence, shape: shape)
        }
    }

    @ViewBuilder
    private func flaired(_ ring: [Color]) -> some View {
        let stroke: CGFloat = 2.5
        let gap: CGFloat = 2.5
        let inner = size - (stroke + gap) * 2
        let glow = appearance?.effect == "glow"
        let shimmer = appearance?.effect == "shimmer"

        ZStack {
            if glow {
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [ring[0].opacity(0.40), .clear],
                            center: .center,
                            startRadius: 0,
                            endRadius: size * 0.675
                        )
                    )
                    .frame(width: size * 1.35, height: size * 1.35)
            }

            // The ring follows the avatar's silhouette — a circle for a person, a
            // squircle for a place — and is drawn *inside* the declared size so
            // flaired and plain rows keep identical layout metrics.
            ringShape
                .stroke(
                    AngularGradient(colors: ring + [ring[0]], center: .center),
                    lineWidth: stroke
                )
                .frame(width: size - stroke, height: size - stroke)
                .rotationEffect(.degrees(angle))

            Avatar(url: url, name: name, id: id, size: inner, presence: presence, shape: shape)
        }
        .frame(width: size, height: size)
        .onAppear {
            // Shimmer rotates the gradient around the ring; a static ring is
            // angle 0 and never starts a timer.
            guard shimmer else { return }
            withAnimation(.linear(duration: 2.6).repeatForever(autoreverses: false)) {
                angle = 360
            }
        }
    }

    private var ringShape: AnyShape {
        switch shape {
        case .person: return AnyShape(Circle())
        case .place: return AnyShape(PlaceShape())
        }
    }
}

/// Paints whatever the view draws — text, a mark — with a gradient.
///
/// `foregroundStyle` takes a `ShapeStyle` directly on iOS 17, so unlike the
/// Compose original this needs no offscreen layer and no blend mode.
extension View {
    func gradientFill(_ gradient: LinearGradient) -> some View {
        overlay(gradient).mask(self)
    }
}

/// The brand gradient: the accent running to teal. Used only where the app is
/// talking about itself — the sign-in mark and the home lockup.
func brandGradient(_ colors: NeuColors) -> LinearGradient {
    LinearGradient(
        colors: [colors.accent, Color(hex: 0x00CEC9)],
        startPoint: .leading,
        endPoint: .trailing
    )
}
