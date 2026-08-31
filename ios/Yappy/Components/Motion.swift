import SwiftUI
import UIKit

// ── Zoom transitions ─────────────────────────────────────────────────────────

/**
 * The shared namespace every zoom transition in the signed-in stack draws on.
 *
 * A matched transition needs both halves to name the same namespace, and the
 * two halves live in different files — the row is in `ConversationsScreen`, the
 * screen it becomes is in `RootView`'s destination builder. Passing a
 * `Namespace.ID` down through every initialiser between them would mean
 * threading one argument through a dozen views that have no other interest in
 * it, so it rides the environment instead.
 *
 * Optional, and every call site tolerates `nil`: a view rendered outside the
 * signed-in stack — a preview, a sheet that hosts a row on its own — still
 * draws, it simply pushes without the zoom.
 */
private struct ZoomNamespaceKey: EnvironmentKey {
    static let defaultValue: Namespace.ID? = nil
}

extension EnvironmentValues {
    var zoomNamespace: Namespace.ID? {
        get { self[ZoomNamespaceKey.self] }
        set { self[ZoomNamespaceKey.self] = newValue }
    }
}

extension View {
    /**
     * Marks this view as the thing a pushed screen grows out of.
     *
     * The id is a `Route`, which is the same value that drives the navigation
     * itself — so the transition cannot disagree with the destination about
     * which chat is being opened. Anything else would be a second identity to
     * keep in sync with the first.
     */
    func zoomSource(_ route: Route) -> some View {
        modifier(ZoomSource(route: route))
    }

    /// The other half: the pushed screen, growing out of `route`'s source.
    func zoomDestination(_ route: Route) -> some View {
        modifier(ZoomDestination(route: route))
    }
}

private struct ZoomSource: ViewModifier {
    @Environment(\.zoomNamespace) private var namespace
    let route: Route

    func body(content: Content) -> some View {
        if let namespace {
            content.matchedTransitionSource(id: route, in: namespace)
        } else {
            content
        }
    }
}

private struct ZoomDestination: ViewModifier {
    @Environment(\.zoomNamespace) private var namespace
    let route: Route

    func body(content: Content) -> some View {
        if let namespace {
            content.navigationTransition(.zoom(sourceID: route, in: namespace))
        } else {
            content
        }
    }
}

// ── Media viewer zoom ────────────────────────────────────────────────────────

/**
 * The media viewer's own namespace, kept apart from `zoomNamespace` above on
 * purpose: that one keys its transitions on `Route`, and the viewer is not a
 * route — it is a cover, keyed on the tapped message's id. Sharing a namespace
 * would pool two id schemes in one matching set, and a mismatch there is not a
 * compile error but a transition that silently never fires.
 *
 * Optional for the same reason as `zoomNamespace`: a bubble drawn outside
 * ChatScreen — a thread, a preview — has no viewer cover of its own to zoom
 * into, and the photo simply opens the way it always has.
 */
private struct MediaZoomNamespaceKey: EnvironmentKey {
    static let defaultValue: Namespace.ID? = nil
}

extension EnvironmentValues {
    var mediaZoomNamespace: Namespace.ID? {
        get { self[MediaZoomNamespaceKey.self] }
        set { self[MediaZoomNamespaceKey.self] = newValue }
    }
}

extension View {
    /**
     * Marks a thumbnail as the thing the media viewer grows out of.
     *
     * The id is the message id — the same value `viewerAt` carries and the
     * viewer anchors its first page on — so the transition cannot disagree
     * with the pager about which photo was tapped.
     */
    func mediaZoomSource(_ id: String) -> some View {
        modifier(MediaZoomSource(id: id))
    }

    /// The other half: the presented viewer, growing out of `id`'s thumbnail.
    func mediaZoomDestination(_ id: String) -> some View {
        modifier(MediaZoomDestination(id: id))
    }
}

private struct MediaZoomSource: ViewModifier {
    @Environment(\.mediaZoomNamespace) private var namespace
    let id: String

    func body(content: Content) -> some View {
        if let namespace {
            content.matchedTransitionSource(id: id, in: namespace)
        } else {
            content
        }
    }
}

private struct MediaZoomDestination: ViewModifier {
    @Environment(\.mediaZoomNamespace) private var namespace
    let id: String

    func body(content: Content) -> some View {
        if let namespace {
            content.navigationTransition(.zoom(sourceID: id, in: namespace))
        } else {
            content
        }
    }
}

// ── Haptics ──────────────────────────────────────────────────────────────────

/**
 * Touch feedback, from generators that are kept alive and warmed.
 *
 * The call sites this replaces each built a fresh
 * `UIImpactFeedbackGenerator` and fired it in the same statement, which is the
 * one usage the API is explicitly not designed for: a generator asks the
 * Taptic Engine to spin up when it is *created*, and firing before that
 * completes gets a tap that is late by tens of milliseconds or silently
 * dropped altogether. The symptom is a long-press that sometimes buzzes — the
 * kind of inconsistency that reads as a cheap phone rather than as a bug.
 *
 * Held as singletons and re-prepared after each use, so the engine is already
 * awake by the next gesture. Cheap: an idle generator costs nothing, and the
 * engine powers down on its own a second or two after the last `prepare`.
 *
 * Deliberately imperative rather than SwiftUI's `sensoryFeedback(_:trigger:)`.
 * That modifier needs a piece of `Equatable` state that changes at the moment
 * the feedback should fire, and most of these fire inside a gesture callback
 * where no such state exists — inventing a counter per call site to satisfy it
 * would be more code and one more thing to keep in sync.
 */
@MainActor
enum Haptics {
    /// A light tick. Picking something up, revealing a menu, a reaction landing.
    static func tap() { fire(light) }
    /// Heavier. A destructive confirmation, a swipe passing its commit point.
    static func thud() { fire(medium) }
    /// Moving between discrete values — a picker, a segmented control.
    static func select() {
        selection.selectionChanged()
        selection.prepare()
    }

    /// Something the user was watching went wrong — a send that failed.
    /// Distinct from `thud`: this is the system's error pattern, and it should
    /// only ever mean "look at the screen, that didn't work".
    static func error() {
        notice.notificationOccurred(.error)
        notice.prepare()
    }

    /// A quiet completion — a refresh landing, a wizard finishing.
    static func success() {
        notice.notificationOccurred(.success)
        notice.prepare()
    }

    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let medium = UIImpactFeedbackGenerator(style: .medium)
    private static let selection = UISelectionFeedbackGenerator()
    private static let notice = UINotificationFeedbackGenerator()

    private static func fire(_ generator: UIImpactFeedbackGenerator) {
        generator.impactOccurred()
        // Re-arm for the next one. Without this the second tap in a burst pays
        // the same wake-up cost the first one did.
        generator.prepare()
    }
}

// ── Emoji burst ──────────────────────────────────────────────────────────────

/**
 * A one-shot handful of glyphs thrown upward from wherever this view sits —
 * the double-tap heart, your own reaction landing on a chip.
 *
 * It plays once, on appearance, and never loops: celebration is an event, and
 * the one ambient loop a screen is allowed belongs to live state, not to
 * decoration. Replaying is the caller's job — hand a fresh instance a fresh
 * `.id` and the flight starts over.
 *
 * Each copy takes its lane from its index and its wobble from a seed fixed at
 * creation, so a body re-evaluation mid-flight cannot reshuffle glyphs that
 * are already in the air, while no two bursts ever fly quite the same path.
 */
struct EmojiBurst: View {
    let emoji: String
    var copies: Int = 3
    var glyphSize: CGFloat = 20

    /// Decided once per burst, at init, and never again.
    private let seed: Double

    @State private var released = false

    init(emoji: String, copies: Int = 3, glyphSize: CGFloat = 20) {
        self.emoji = emoji
        self.copies = copies
        self.glyphSize = glyphSize
        seed = Double.random(in: 0 ..< 1)
    }

    var body: some View {
        ZStack {
            ForEach(0 ..< copies, id: \.self) { index in
                glyph(index)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { released = true }
    }

    private func glyph(_ index: Int) -> some View {
        // The lane spreads the copies sideways around the launch point; the
        // wobble bends each figure a little so the spread never reads as a
        // stamp; the phase staggers the lift-offs so three glyphs read as a
        // burst rather than one thick one.
        let lane = Double(index) - Double(copies - 1) / 2
        let wobble = (seed + Double(index) * 0.37).truncatingRemainder(dividingBy: 1) - 0.5
        let phase = Double(index) * 0.06 + seed * 0.05

        return Text(emoji)
            .font(.system(size: glyphSize))
            .rotationEffect(.degrees(lane * 9 + wobble * 14))
            .scaleEffect(released ? 1.1 : 0.3)
            .offset(
                x: released ? lane * 15 + wobble * 10 : 0,
                y: released ? -36 - wobble * 10 : 0
            )
            .animation(.easeOut(duration: 0.55).delay(phase), value: released)
            // Scoped separately so the glyph rises on the ease-out above while
            // the fade trails it — gone by the time the drift settles.
            .opacity(released ? 0 : 1)
            .animation(.easeIn(duration: 0.45).delay(phase + 0.15), value: released)
    }
}
