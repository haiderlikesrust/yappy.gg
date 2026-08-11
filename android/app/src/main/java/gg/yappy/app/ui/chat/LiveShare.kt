package gg.yappy.app.ui.chat

import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import gg.yappy.app.AppContainer
import gg.yappy.app.ui.util.Locator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The thing that keeps a live share moving.
 *
 * Deliberately not owned by the chat screen. A share is a promise that lasts
 * until its end time, and a ViewModel dies when you tap back — so a broadcaster
 * living there would leave a card saying "live" over a dot that had quietly
 * stopped moving, which is worse than not offering the feature at all.
 *
 * One at a time. Sharing in a second conversation replaces the first, because
 * there is one GPS and one person, and keeping two dots in sync that are always
 * in the same place is a way to flatten a battery for nothing.
 *
 * Updates are driven by movement, not by a timer: ten metres of displacement
 * before a new fix, so a phone on a table sends nothing at all. That is both
 * the correct answer and the one that survives eight hours.
 */
object LiveShare {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private var manager: LocationManager? = null
    private var listener: LocationListener? = null
    private var container: AppContainer? = null

    var conversationId: String? = null
        private set
    var messageId: String? = null
        private set

    val isSharing: Boolean get() = messageId != null

    fun start(container: AppContainer, conversationId: String, messageId: String) {
        stop()
        val context = container.appContext
        if (!Locator.granted(context)) return
        val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: return

        val provider = when {
            locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            else -> return
        }

        this.container = container
        this.conversationId = conversationId
        this.messageId = messageId

        val callback = object : LocationListener {
            override fun onLocationChanged(location: Location) = push(location)

            @Deprecated("Required below API 30")
            override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
            override fun onProviderEnabled(provider: String) {}
            override fun onProviderDisabled(provider: String) = stop()
        }
        listener = callback
        manager = locationManager

        runCatching {
            locationManager.requestLocationUpdates(provider, 10_000L, 10f, callback, Looper.getMainLooper())
        }.onFailure { stop() }
    }

    private fun push(location: Location) {
        val container = this.container ?: return
        val conversationId = this.conversationId ?: return
        val messageId = this.messageId ?: return

        scope.launch {
            runCatching {
                container.repo.pingLocation(
                    conversationId,
                    messageId,
                    location.latitude,
                    location.longitude,
                    if (location.hasAccuracy()) location.accuracy.toDouble() else null,
                    Locator.headingOf(location),
                )
            }.onFailure {
                // The server refuses a ping for a share that has ended or run
                // out. Holding the GPS open after that is battery spent on
                // nobody's behalf.
                stop()
            }
        }
    }

    fun stop() {
        listener?.let { active -> runCatching { manager?.removeUpdates(active) } }
        listener = null
        manager = null
        container = null
        conversationId = null
        messageId = null
    }

    /** Stop only if this is the share in question. */
    fun stopIfSharing(messageId: String) {
        if (this.messageId == messageId) stop()
    }
}
