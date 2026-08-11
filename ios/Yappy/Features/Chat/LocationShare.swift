import CoreLocation
import MapKit
import SwiftUI

/// Choosing what to share.
///
/// Two things, and the second one is the reason this is a sheet rather than a
/// button: sending a pin is harmless and instant, while sharing live means
/// agreeing to be followed for a while, and those should not be one tap apart
/// with no chance to think.
///
/// The duration is the whole decision, so the options are the ones people
/// actually mean — "I am nearly there", "I am on my way", "we are out for the
/// day" — and every one of them is a length someone can hold in their head.
struct LocationShareSheet: View {
    @Environment(\.neu) private var colors
    @Environment(\.dismiss) private var dismiss
    @StateObject private var locator = Locator.shared

    /// nil duration = a pin, right now. Non-nil = live for that long.
    let onShare: (TimeInterval?) -> Void

    @State private var fix: CLLocation?
    @State private var working = false

    private static let durations: [(String, TimeInterval)] = [
        ("15 minutes", 900),
        ("1 hour", 3_600),
        ("8 hours", 28_800),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Share location")
                .font(YappyFont.titleSmall)
                .foregroundStyle(colors.text)

            if locator.denied {
                denied
            } else if !locator.authorised {
                asking
            } else {
                preview
                pin
                live
            }
        }
        .padding(22)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(colors.surface)
        .task {
            locator.requestAuthorisation()
            fix = await locator.current()
        }
    }

    // ── States ───────────────────────────────────────────────────────────────

    private var asking: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("yappy needs permission to use your location.")
                .font(YappyFont.body)
                .foregroundStyle(colors.textSecondary)
            NeuButton(action: { locator.requestAuthorisation() }) {
                Text("Allow location").font(YappyFont.labelMedium)
            }
        }
    }

    private var denied: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Location is turned off for yappy.")
                .font(YappyFont.body)
                .foregroundStyle(colors.textSecondary)
            Text("Turn it on in Settings › Privacy › Location Services.")
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)
        }
    }

    /// The map is here so nobody sends a pin without seeing what it is. A fix
    /// that has not arrived shows as a spinner rather than a wrong place.
    @ViewBuilder
    private var preview: some View {
        if let fix {
            Map(initialPosition: .region(MKCoordinateRegion(
                center: fix.coordinate,
                span: MKCoordinateSpan(latitudeDelta: 0.004, longitudeDelta: 0.004)
            ))) {
                Marker("You", coordinate: fix.coordinate)
                    .tint(colors.accent)
            }
            .frame(height: 170)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .allowsHitTesting(false)
        } else {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(colors.veil)
                .frame(height: 170)
                .overlay(ProgressView())
        }
    }

    private var pin: some View {
        NeuButton(action: { share(nil) }) {
            HStack(spacing: 10) {
                Image(systemName: "mappin.circle.fill")
                Text("Send this location").font(YappyFont.labelMedium)
            }
        }
        .disabled(fix == nil || working)
        .opacity(fix == nil ? 0.5 : 1)
    }

    private var live: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("OR SHARE LIVE")
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)
            Text("Everyone here sees you move until it ends. You can stop at any time.")
                .font(YappyFont.labelSmall)
                .foregroundStyle(colors.textTertiary)
                .fixedSize(horizontal: false, vertical: true)

            ForEach(Self.durations, id: \.0) { label, seconds in
                NeuButton(action: { share(seconds) }) {
                    HStack {
                        Image(systemName: "dot.radiowaves.left.and.right")
                        Text(label).font(YappyFont.labelMedium)
                        Spacer()
                    }
                }
                .disabled(fix == nil || working)
                .opacity(fix == nil ? 0.5 : 1)
            }
        }
    }

    private func share(_ duration: TimeInterval?) {
        guard fix != nil, !working else { return }
        working = true
        onShare(duration)
        dismiss()
    }
}

// ── The bubble ───────────────────────────────────────────────────────────────

/// A shared place, in the timeline.
///
/// A real map rather than a picture of one: MapKit costs nothing on iOS, needs
/// no key, and a static image would still have to be fetched from somebody's
/// tile server. The dot moves as pings arrive, so a live share is the same view
/// with different coordinates rather than a second kind of card.
struct LocationBubble: View {
    @Environment(\.neu) private var colors

    let payload: LocationPayload
    /// The current point, when this share is still moving. Nil means the map
    /// shows where it started, which is all a finished share has to say.
    let live: LiveLocation?
    let isMine: Bool
    let onStop: () -> Void
    let onOpen: () -> Void

    private var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(
            latitude: live?.latitude ?? payload.latitude,
            longitude: live?.longitude ?? payload.longitude
        )
    }

    /// A live share that has not ended and has not run out.
    private var isLive: Bool {
        guard let live, live.endedAt == nil else { return false }
        guard let until = YappyTime.parse(live.expiresAt) else { return false }
        return until > Date()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            map
            footer
        }
        .frame(width: 250)
        .background(colors.veil, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
    }

    private var map: some View {
        Map(position: .constant(.region(MKCoordinateRegion(
            center: coordinate,
            span: MKCoordinateSpan(latitudeDelta: 0.004, longitudeDelta: 0.004)
        )))) {
            Marker(payload.name ?? "Here", coordinate: coordinate)
                .tint(isLive ? colors.success : colors.accent)
        }
        .frame(height: 140)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        // The map is a picture here. Panning it inside a scrolling timeline
        // fights the list for every gesture, and the tap opens Maps anyway.
        .allowsHitTesting(false)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let name = payload.name, !name.isEmpty {
                Text(name)
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(colors.text)
                    .lineLimit(1)
            }

            if isLive, let live {
                HStack(spacing: 6) {
                    Circle()
                        .fill(colors.success)
                        .frame(width: 7, height: 7)
                    Text("Live until \(YappyTime.clockTime(live.expiresAt))")
                        .font(YappyFont.labelSmall)
                        .foregroundStyle(colors.success)
                }
                if isMine {
                    Button(action: onStop) {
                        Text("Stop sharing")
                            .font(YappyFont.labelSmall)
                            .foregroundStyle(colors.danger)
                    }
                    .buttonStyle(.plain)
                }
            } else if payload.liveUntil != nil {
                // A share that has finished. Saying so is what stops the last
                // known point from being read as where somebody is now.
                Text("Live location ended")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
            } else {
                Text("Location")
                    .font(YappyFont.labelSmall)
                    .foregroundStyle(colors.textTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}

/// Hand off to Maps. Nothing in the app is a better map than the one the phone
/// already has, and "open in Maps" is what people do with a pin anyway.
func openInMaps(_ payload: LocationPayload, current: LiveLocation?) {
    let coordinate = CLLocationCoordinate2D(
        latitude: current?.latitude ?? payload.latitude,
        longitude: current?.longitude ?? payload.longitude
    )
    let item = MKMapItem(placemark: MKPlacemark(coordinate: coordinate))
    item.name = payload.name ?? "Shared location"
    item.openInMaps()
}
