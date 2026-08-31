package gg.yappy.app.ui.space

import android.content.Context
import gg.yappy.app.AppContainer

/**
 * Which categories this person has folded away in the channel list.
 *
 * Kept on the device rather than on the server, because it is a view
 * preference and not a fact about the space: two people looking at the same
 * sidebar should be able to disagree about which halves of it are folded, and
 * neither should wait for a round trip to find out.
 *
 * SharedPreferences rather than DataStore, deliberately. This is read while
 * composing the screen — a suspend read would mean drawing the list expanded
 * for a frame and then folding it, which is exactly the flicker the snapshot
 * cache elsewhere in this screen exists to avoid.
 *
 * A flat set of ids across every space. Ids are unique, so nesting them per
 * space buys nothing, and it makes the stale-id problem solve itself: a
 * category that no longer exists is simply never asked about again.
 */
object CollapsedCategories {
    private const val FILE = "yappy_ui"
    private const val KEY = "collapsed_categories"

    private fun prefs(context: Context) =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun load(container: AppContainer): Set<String> =
        prefs(container.appContext).getStringSet(KEY, emptySet())?.toSet() ?: emptySet()

    /** Returns the new set, so the caller can drive state off the result. */
    fun toggle(container: AppContainer, categoryId: String): Set<String> {
        val next = load(container).toMutableSet()
        if (!next.remove(categoryId)) next.add(categoryId)
        prefs(container.appContext).edit().putStringSet(KEY, next).apply()
        return next
    }
}
