import SwiftUI

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
func colorForId(_ id: String) -> Color {
    var hash: UInt64 = 5381
    for byte in id.utf8 {
        hash = (hash &* 33) &+ UInt64(byte)
    }
    return fallbackColors[Int(hash % UInt64(fallbackColors.count))]
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
        colorForId(id)
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
