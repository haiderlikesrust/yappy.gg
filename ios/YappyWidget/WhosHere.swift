import SwiftUI
import UIKit
import WidgetKit

// ── Data ─────────────────────────────────────────────────────────────────────

/**
 * What the widget needs out of the app's cached conversation list.
 *
 * Deliberately its own small `Decodable` rather than the app's `Conversation`,
 * which is one field short of a hundred and drags most of `Models.swift` behind
 * it. The server's JSON is the contract both read; taking four keys out of it
 * here costs nothing and keeps the widget target from compiling the entire
 * model layer to draw a list of names.
 */
private struct Snapshot: Decodable {
    let conversations: [Place]

    struct Place: Decodable, Identifiable {
        let id: String
        let type: String
        let title: String?
        let hereCount: Int
        let memberCount: Int

        private enum CodingKeys: String, CodingKey {
            case id, type, title, hereCount, memberCount
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = (try? c.decode(String.self, forKey: .id)) ?? ""
            type = (try? c.decode(String.self, forKey: .type)) ?? "group"
            title = try? c.decode(String.self, forKey: .title)
            // Tolerant on purpose: these are the two fields a server change is
            // most likely to touch, and a widget that renders "0 here" beats
            // one that fails to decode and shows the placeholder forever.
            hereCount = (try? c.decode(Int.self, forKey: .hereCount)) ?? 0
            memberCount = (try? c.decode(Int.self, forKey: .memberCount)) ?? 0
        }
    }
}

struct Place: Identifiable {
    let id: String
    let name: String
    let here: Int
    let members: Int
}

// ── Timeline ─────────────────────────────────────────────────────────────────

struct WhosHereEntry: TimelineEntry {
    let date: Date
    let places: [Place]
    /// Distinguishes "signed in, nothing to show" from "no snapshot at all",
    /// which want different words: one is an empty account, the other is a
    /// widget added before the app was ever opened.
    let hasSnapshot: Bool
}

struct WhosHereProvider: TimelineProvider {
    func placeholder(in _: Context) -> WhosHereEntry {
        WhosHereEntry(date: .now, places: Place.sample, hasSnapshot: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (WhosHereEntry) -> Void) {
        // The gallery preview gets invented data; a real instance never does.
        completion(context.isPreview ? placeholder(in: context) : load())
    }

    /**
     * Refreshed two ways, exactly as on Android: a half-hourly floor here, and
     * a live nudge from `ConversationsModel` every time the app loads the list.
     * The nudge is what makes the widget agree with the app whenever both are
     * looked at in the same minute; this timeline is what keeps it from going
     * stale on a phone nobody has opened.
     */
    func getTimeline(in _: Context, completion: @escaping (Timeline<WhosHereEntry>) -> Void) {
        completion(Timeline(entries: [load()], policy: .after(.now.addingTimeInterval(30 * 60))))
    }

    /**
     * Straight off the disk snapshot, and never over the network.
     *
     * The widget cannot reach the app's session — different process, different
     * sandbox — and giving it its own authenticated client would mean a second
     * copy of token refresh living in a process that runs for milliseconds at
     * unpredictable times. The app has already fetched this list; the shared
     * container is how the widget borrows it.
     */
    private func load() -> WhosHereEntry {
        guard let file = AppGroup.snapshots?.appendingPathComponent("conversations.json"),
              let data = try? Data(contentsOf: file),
              let snapshot = try? JSONDecoder().decode(Snapshot.self, from: data)
        else {
            return WhosHereEntry(date: .now, places: [], hasSnapshot: false)
        }

        let places = snapshot.conversations
            // A DM is not a place, and a space is a container of places rather
            // than one itself — neither has a here-count worth showing.
            .filter { $0.type == "group" || $0.type == "channel" }
            .sorted { $0.hereCount > $1.hereCount }
            .prefix(6)
            .map { Place(id: $0.id, name: $0.title ?? "Group", here: $0.hereCount, members: $0.memberCount) }

        return WhosHereEntry(date: .now, places: Array(places), hasSnapshot: true)
    }
}

// ── Widget ───────────────────────────────────────────────────────────────────

struct WhosHereWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "gg.yappy.app.whoshere", provider: WhosHereProvider()) { entry in
            WhosHereView(entry: entry)
                .containerBackground(WidgetPalette.surface, for: .widget)
        }
        .configurationDisplayName("Who's here")
        .description("Your places, and how many people are in them right now.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct WhosHereView: View {
    @Environment(\.widgetFamily) private var family

    let entry: WhosHereEntry

    /// One row is ~22pt plus the header; these are what fit without the last
    /// row being clipped in half, which reads as a bug rather than as more.
    private var limit: Int {
        switch family {
        case .systemSmall: return 3
        case .systemMedium: return 4
        default: return 6
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("who's here")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(WidgetPalette.accent)

            Spacer(minLength: 8)

            if entry.places.isEmpty {
                Text(entry.hasSnapshot ? "No places yet" : "Open yappy to get started")
                    .font(.system(size: 13))
                    .foregroundStyle(WidgetPalette.textDim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(entry.places.prefix(limit)) { place in
                        // Each row deep-links to its own chat. `Link` rather
                        // than `widgetURL` because the whole point of a list is
                        // that the rows go to different places; `widgetURL`
                        // would send every tap to the same one.
                        Link(destination: URL(string: "yappy://conversation/\(place.id)")!) {
                            PlaceRow(place: place, compact: family == .systemSmall)
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        // A tap that misses a row still opens the app rather than doing
        // nothing, which is what an empty widget needs anyway.
        .widgetURL(URL(string: "yappy://conversation/")!)
    }
}

private struct PlaceRow: View {
    let place: Place
    let compact: Bool

    var body: some View {
        HStack(spacing: 8) {
            Text(place.name)
                .font(.system(size: compact ? 13 : 14, weight: .medium))
                .foregroundStyle(WidgetPalette.text)
                .lineLimit(1)

            Spacer(minLength: 4)

            if place.here > 0 {
                HStack(spacing: 4) {
                    Circle()
                        .fill(WidgetPalette.here)
                        .frame(width: 6, height: 6)
                    Text(compact ? "\(place.here)" : "\(place.here) here")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(WidgetPalette.here)
                }
            } else {
                Text("quiet")
                    .font(.system(size: 12))
                    .foregroundStyle(WidgetPalette.textDim)
            }
        }
        .padding(.vertical, 5)
    }
}

// ── Palette ──────────────────────────────────────────────────────────────────

/**
 * The app's palette, restated.
 *
 * `NeuColors` lives in the app target and pulls the whole theme layer with it;
 * a widget draws five colours and none of the neumorphic treatment — the paired
 * shadows that language is built from are invisible at this size and cost a
 * saved layer to render. So the widget takes the tokens and leaves the
 * machinery.
 *
 * Values track `NeuColors.light` / `.dark`. Duplicating them is a real cost,
 * paid deliberately: the alternative is compiling `Neu.swift`,
 * `NeuColors.swift` and `Typography.swift` into a process whose entire job is a
 * list of names.
 *
 * Unlike Android's widget, which pins the dark palette, this follows the system
 * appearance — the app has a genuine light theme, and a violet-charcoal slab on
 * an otherwise light home screen reads as a widget that failed to load.
 */
private enum WidgetPalette {
    static let surface = adaptive(light: 0xEBE9F4, dark: 0x232030)
    static let text = adaptive(light: 0x2B2739, dark: 0xEFEDF6)
    static let textDim = adaptive(light: 0x8F8AA8, dark: 0x746E8E)
    static let accent = adaptive(light: 0x6C5CE7, dark: 0x8B7CFF)
    /// The one token that does not vary: "someone is in there right now" is the
    /// widget's whole message, and it should look identical in both themes.
    static let here = rgb(0x00CEC9)

    private static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? ui(dark) : ui(light) })
    }

    private static func rgb(_ hex: UInt32) -> Color { Color(ui(hex)) }

    private static func ui(_ hex: UInt32) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

extension Place {
    /// Gallery preview only. Real names, because a preview of "Group 1 / Group
    /// 2" tells nobody what the widget is for.
    static let sample: [Place] = [
        Place(id: "1", name: "NARF", here: 4, members: 12),
        Place(id: "2", name: "design", here: 2, members: 8),
        Place(id: "3", name: "weekend plans", here: 0, members: 5),
    ]
}
