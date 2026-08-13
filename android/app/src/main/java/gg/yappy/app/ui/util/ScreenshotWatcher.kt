package gg.yappy.app.ui.util

import android.app.Activity
import android.content.Context
import android.os.Build
import androidx.annotation.RequiresApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * "Someone took a screenshot."
 *
 * Android 14+ only, on purpose. Below 14 the only substitute was watching the
 * media store for new screenshot-shaped images, which needed READ_MEDIA_IMAGES
 * — a broad, permanent grant to every photo on the device, in exchange for a
 * courtesy line. Google Play now restricts that permission to apps whose core
 * purpose *is* photos, and a messenger declaring it gets rejected; they are
 * right, and the trade was always lopsided. The manifest no longer carries the
 * permission, and devices below 14 simply do not get the courtesy line.
 *
 * The 14+ callback is everything the old path was not: it costs nothing, sees
 * only captures of our own window, and needs no access to anything.
 *
 * Still best-effort, never a control. A modified client says nothing and a
 * second phone pointed at the screen is invisible. Say what happened; never
 * imply the room is sealed.
 */
object ScreenshotWatcher {
    private val _events = MutableSharedFlow<Unit>(extraBufferCapacity = 4)

    /** Emits once per capture, while the app is in the foreground. */
    val events: SharedFlow<Unit> = _events.asSharedFlow()

    private val hasNativeCallback: Boolean get() = Build.VERSION.SDK_INT >= 34

    /**
     * Kept for the callers that ask before asking: always null now, which
     * makes every permission-request flow correctly conclude there is nothing
     * to request. Below 14, detection is simply off.
     */
    val permission: String? get() = null

    fun granted(@Suppress("UNUSED_PARAMETER") context: Context): Boolean = true

    fun needsPermission(@Suppress("UNUSED_PARAMETER") context: Context): Boolean = false

    @RequiresApi(34)
    private val nativeCallback = Activity.ScreenCaptureCallback { _events.tryEmit(Unit) }

    /**
     * Registration is tied to the foreground, not to the process: a capture
     * while some other app is on screen is not ours to report.
     */
    fun start(activity: Activity) {
        if (!hasNativeCallback) return
        runCatching { activity.registerScreenCaptureCallback(activity.mainExecutor, nativeCallback) }
    }

    fun stop(activity: Activity) {
        if (!hasNativeCallback) return
        runCatching { activity.unregisterScreenCaptureCallback(nativeCallback) }
    }
}
