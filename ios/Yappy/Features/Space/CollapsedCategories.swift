import Foundation

/**
 * Which categories this person has folded away in the channel list.
 *
 * Kept on the device rather than on the server, because it is a view
 * preference and not a fact about the space: two people looking at the same
 * sidebar should be able to disagree about which halves of it are folded, and
 * neither should wait for a round trip to find out.
 *
 * A flat set of ids across every space. Ids are unique, so nesting them per
 * space buys nothing, and it makes the stale-id problem solve itself: a
 * category that no longer exists is simply never asked about again.
 */
enum CollapsedCategories {
    private static let key = "yappy.collapsedCategories"

    static func load() -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
    }

    /// Returns the new set, so the caller can drive `@State` off the result.
    static func toggle(_ categoryId: String) -> Set<String> {
        var next = load()
        if next.remove(categoryId) == nil { next.insert(categoryId) }
        UserDefaults.standard.set(Array(next), forKey: key)
        return next
    }
}
