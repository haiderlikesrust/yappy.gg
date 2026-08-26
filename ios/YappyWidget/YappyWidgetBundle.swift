import SwiftUI
import WidgetKit

/**
 * The widget bundle.
 *
 * One widget for now — the same "who's here" answer Android's `HereWidget`
 * gives, because the product argument behind it is platform-independent: a
 * group is a place with people in it *right now*, and an unread-count widget
 * would say what you owe while this one says what you are missing.
 */
@main
struct YappyWidgetBundle: WidgetBundle {
    var body: some Widget {
        WhosHereWidget()
    }
}
