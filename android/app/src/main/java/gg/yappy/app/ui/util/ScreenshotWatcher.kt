package gg.yappy.app.ui.util

import android.app.Activity
import android.os.Build
import androidx.annotation.RequiresApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * "Someone took a screenshot."
 *
 * Android 14 added a real callback for this. Before that there was no honest
 * way to know: the trick was to watch the screenshots folder with a
 * `FileObserver`, which means holding a permission to read the user's entire
 * photo library — an enormous, permanent grant, requested at install time, in
 * exchange for a courtesy line in a chat. Not worth it, so on anything older
 * this stays quiet rather than lying about being able to tell.
 *
 * A hot flow with no replay, because a screenshot taken before a chat was
 * opened is not that chat's business.
 */
object ScreenshotWatcher {
    private val _events = MutableSharedFlow<Unit>(extraBufferCapacity = 4)

    /** Emits once per capture, while the app is in the foreground. */
    val events: SharedFlow<Unit> = _events.asSharedFlow()

    /** True where the platform can actually tell us. Android 14 and up. */
    val supported: Boolean get() = Build.VERSION.SDK_INT >= 34

    @RequiresApi(34)
    private val callback = Activity.ScreenCaptureCallback { _events.tryEmit(Unit) }

    /**
     * Registration is tied to the foreground, not to the process: the callback
     * only fires while the activity is resumed, and holding it across a stop
     * would report a screenshot of some other app.
     */
    fun start(activity: Activity) {
        if (!supported) return
        runCatching { activity.registerScreenCaptureCallback(activity.mainExecutor, callback) }
    }

    fun stop(activity: Activity) {
        if (!supported) return
        runCatching { activity.unregisterScreenCaptureCallback(callback) }
    }
}
