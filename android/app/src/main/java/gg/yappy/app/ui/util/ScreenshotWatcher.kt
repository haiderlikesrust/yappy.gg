package gg.yappy.app.ui.util

import android.Manifest
import android.app.Activity
import android.content.ContentResolver
import android.content.Context
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/**
 * "Someone took a screenshot."
 *
 * Two mechanisms, because Android changed its mind halfway through:
 *
 * **Android 14 and up** has a real callback. It costs nothing, sees only
 * captures of our own window, and needs no access to anything. Where it exists
 * it is the only sensible answer.
 *
 * **Below that** there is no such signal, and the only workable substitute is
 * to watch the media store for a new image that looks like a screenshot. That
 * needs permission to read images — a large, permanent grant in exchange for a
 * courtesy line, which is why it is asked for once, in the moment it makes
 * sense, and never again if refused. A person who says no gets an app that
 * stays quiet, not one that keeps asking.
 *
 * Both paths are best-effort, and neither is a control. A modified client says
 * nothing, a second phone pointed at the screen is invisible, and on the older
 * path a device that names its screenshots something unexpected will be missed.
 * Say what happened; never imply the room is sealed.
 */
object ScreenshotWatcher {
    private val _events = MutableSharedFlow<Unit>(extraBufferCapacity = 4)

    /** Emits once per capture, while the app is in the foreground. */
    val events: SharedFlow<Unit> = _events.asSharedFlow()

    /** The platform tells us directly, with nothing to ask for. */
    private val hasNativeCallback: Boolean get() = Build.VERSION.SDK_INT >= 34

    /**
     * What reading the media store needs on this version. Null when the native
     * callback exists and nothing has to be asked for at all.
     */
    val permission: String? get() = when {
        hasNativeCallback -> null
        Build.VERSION.SDK_INT >= 33 -> Manifest.permission.READ_MEDIA_IMAGES
        else -> Manifest.permission.READ_EXTERNAL_STORAGE
    }

    fun granted(context: Context): Boolean {
        val required = permission ?: return true
        return ContextCompat.checkSelfPermission(context, required) == PackageManager.PERMISSION_GRANTED
    }

    /** True when asking would achieve something: old enough to need it, and not yet held. */
    fun needsPermission(context: Context): Boolean = permission != null && !granted(context)

    @RequiresApi(34)
    private val nativeCallback = Activity.ScreenCaptureCallback { _events.tryEmit(Unit) }

    private var observer: ContentObserver? = null
    private var resolver: ContentResolver? = null

    /**
     * The id of the last image already reported.
     *
     * The media store fires several change notifications for one insert — the
     * row, then its thumbnail, then the metadata pass — and without this a
     * single screenshot would be announced three times.
     */
    private var lastSeenId: Long = -1

    /**
     * Registration is tied to the foreground, not to the process: a capture
     * while some other app is on screen is not ours to report.
     */
    fun start(activity: Activity) {
        if (hasNativeCallback) {
            runCatching { activity.registerScreenCaptureCallback(activity.mainExecutor, nativeCallback) }
            return
        }
        if (!granted(activity)) return
        if (observer != null) return

        val contentResolver = activity.contentResolver
        val watcher = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                if (newestIsAScreenshot(contentResolver)) _events.tryEmit(Unit)
            }
        }
        runCatching {
            contentResolver.registerContentObserver(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                true,
                watcher,
            )
            observer = watcher
            resolver = contentResolver
        }
    }

    fun stop(activity: Activity) {
        if (hasNativeCallback) {
            runCatching { activity.unregisterScreenCaptureCallback(nativeCallback) }
            return
        }
        observer?.let { active -> runCatching { resolver?.unregisterContentObserver(active) } }
        observer = null
        resolver = null
    }

    /**
     * Was the image that just appeared a screenshot?
     *
     * Three tests, and all three have to pass, because the alternative is
     * telling a room somebody screenshotted it when they actually saved a photo
     * from another app — a false accusation is far worse than a missed one.
     *
     *  - It is new. `date_added` within the last ten seconds, so an old row
     *    being re-indexed cannot trigger anything.
     *  - It has not been reported. One insert produces several notifications.
     *  - It looks like a screenshot: the file name or its folder says so, which
     *    is how every Android build names them.
     */
    private fun newestIsAScreenshot(resolver: ContentResolver): Boolean {
        val pathColumn = if (Build.VERSION.SDK_INT >= 29) {
            MediaStore.Images.Media.RELATIVE_PATH
        } else {
            @Suppress("DEPRECATION")
            MediaStore.Images.Media.DATA
        }

        val projection = arrayOf(
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.DATE_ADDED,
            pathColumn,
        )

        return runCatching {
            resolver.query(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                projection,
                null,
                null,
                "${MediaStore.Images.Media._ID} DESC",
            )?.use { cursor ->
                if (!cursor.moveToFirst()) return@use false

                val id = cursor.getLong(0)
                if (id == lastSeenId) return@use false

                // Seconds, not milliseconds — the one thing about this column
                // that catches everybody out.
                val addedAt = cursor.getLong(2)
                val ageSeconds = (System.currentTimeMillis() / 1_000) - addedAt
                if (ageSeconds !in 0..10) return@use false

                val name = cursor.getString(1).orEmpty().lowercase()
                val path = cursor.getString(3).orEmpty().lowercase()
                val looksRight = name.contains("screenshot") || name.contains("screen_shot") ||
                    path.contains("screenshot")
                if (!looksRight) return@use false

                lastSeenId = id
                true
            } ?: false
        }.getOrDefault(false)
    }
}
