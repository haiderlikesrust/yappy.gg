import SwiftUI
import UIKit

/// Avatars are flat, clipped shapes — they are content, not chrome, and a screen
/// that is mostly a list of them cannot afford a shadow treatment on every one.
///
/// The fallback is a deterministic colour derived from the user id, so the same
/// person is always the same colour on every device without the server having to
/// store one.
private let fallbackColors: [Color] = [
    Color(hex: 0x6C5CE7), Color(hex: 0x00B894), Color(hex: 0xE17055), Color(hex: 0x0984E3),
    Color(hex: 0xD63031), Color(hex: 0x6D4C41), Color(hex: 0x00838F), Color(hex: 0x8E24AA),
]

/// A stable hash of the id.
///
/// Not `String.hashValue`: Swift seeds that per process, so the same person
/// would be a different colour on every launch — and the whole point is that
/// they are not.
private func stableHash(_ id: String) -> UInt64 {
    var hash: UInt64 = 5381
    for byte in id.utf8 {
        hash = (hash &* 33) &+ UInt64(byte)
    }
    return hash
}

func colorForId(_ id: String) -> Color {
    fallbackColors[Int(stableHash(id) % UInt64(fallbackColors.count))]
}

/// The id's colour and a deterministic partner for it, for the places that need
/// a real two-stop gradient — the bannerless profile header and its flair ring.
///
/// The partner comes from the hash's higher bits, which the first pick never
/// consumed, and the `+ 1` keeps it off the first entry — so every id gets a
/// genuine pair rather than a gradient that collapses back into one colour.
func colorPairForId(_ id: String) -> (Color, Color) {
    let hash = stableHash(id)
    let count = fallbackColors.count
    let first = Int(hash % UInt64(count))
    let second = (first + 1 + Int((hash / UInt64(count)) % UInt64(count - 1))) % count
    return (fallbackColors[first], fallbackColors[second])
}

/// The colour at 72% — the same factor PixelPet shades a body with (and Android
/// multiplies in), mirrored here so an imageless avatar falls off to the same
/// depth as everything else derived from its colour.
private func shaded(_ color: Color) -> Color {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    _ = UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
    return Color(.sRGB, red: Double(r) * 0.72, green: Double(g) * 0.72, blue: Double(b) * 0.72, opacity: 1)
}

func initialsOf(_ name: String?) -> String {
    let trimmed = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "?" }

    let parts = trimmed
        .split(whereSeparator: { $0 == " " || $0 == "_" || $0 == "." })
        .filter { !$0.isEmpty }

    if parts.count >= 2, let first = parts[0].first, let second = parts[1].first {
        return "\(first)\(second)".uppercased()
    }
    return String(trimmed.prefix(2)).uppercased()
}

/// Circles are people; pass `.place` for groups.
enum AvatarShape {
    case person
    case place
}

struct Avatar: View {
    let url: String?
    let name: String?
    let id: String
    var size: CGFloat = 48
    var presence: String?
    var shape: AvatarShape = .person

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            silhouette
                .frame(width: size, height: size)

            if let presence, presence != "offline" {
                PresenceDot(status: presence, size: min(max(size / 3.6, 10), 16))
            }
        }
        .frame(width: size, height: size, alignment: .bottomTrailing)
    }

    @ViewBuilder
    private var silhouette: some View {
        let clip = clipShape

        if let url, !url.isEmpty {
            RemoteImage(url: url) {
                initialsTile
            }
            .frame(width: size, height: size)
            .clipShape(clip)
        } else {
            initialsTile.clipShape(clip)
        }
    }

    private var initialsTile: some View {
        // A vertical fall-off rather than a flat fill: colour is light here,
        // and a lit disc darkens as it turns away from the lamp. Subtle on
        // purpose — at the 14pt badge sizes this must read as one colour that
        // happens to be alive, not as two.
        let base = colorForId(id)
        return LinearGradient(colors: [base, shaded(base)], startPoint: .top, endPoint: .bottom)
            .frame(width: size, height: size)
            .overlay(
                Text(initialsOf(name))
                    .font(YappyFont.grotesk(size / 2.6, weight: 600))
                    .foregroundStyle(.white)
            )
    }

    private var clipShape: AnyShape {
        switch shape {
        case .person: return AnyShape(Circle())
        case .place: return AnyShape(PlaceShape())
        }
    }
}

/// Overlapping faces for a group row, fanned along the diagonal so each face
/// stays identifiable.
struct AvatarStack: View {
    struct Person: Identifiable {
        let id: String
        let name: String?
        let url: String?
    }

    let people: [Person]
    var size: CGFloat = 48

    var body: some View {
        let shown = Array(people.prefix(3))
        let small = size * 0.62
        let step = (size - small) / CGFloat(max(shown.count - 1, 1))

        ZStack {
            ForEach(Array(shown.enumerated()), id: \.element.id) { index, person in
                Avatar(url: person.url, name: person.name, id: person.id, size: small)
                    .offset(
                        x: step * CGFloat(index) - step,
                        y: step * CGFloat(index) - step
                    )
            }
        }
        .frame(width: size, height: size)
    }
}
