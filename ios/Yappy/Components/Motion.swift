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

    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let medium = UIImpactFeedbackGenerator(style: .medium)
    private static let selection = UISelectionFeedbackGenerator()

    private static func fire(_ generator: UIImpactFeedbackGenerator) {
        generator.impactOccurred()
        // Re-arm for the next one. Without this the second tap in a burst pays
        // the same wake-up cost the first one did.
        generator.prepare()
    }
}
