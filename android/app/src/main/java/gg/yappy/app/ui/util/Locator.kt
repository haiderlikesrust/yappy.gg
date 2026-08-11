package gg.yappy.app.ui.util

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Looper
import androidx.core.content.ContextCompat
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Where the phone is.
 *
 * Built on the platform's own [LocationManager] rather than Play Services'
 * fused provider. The fused one is better — it blends GPS, wifi and the
 * accelerometer, and it is what every other app uses — but it arrives with
 * Google Play Services as a dependency, and yappy has none. A messenger that
 * cannot share a location on a phone without Google services is a worse
 * outcome than a location that takes a couple of seconds longer to settle.
 *
 * Nothing here caches. A stale position sent as "here I am" is the one bug in
 * this feature that would actually mislead somebody.
 */
object Locator {

    fun granted(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED

    /**
     * One fix, or null.
     *
     * Asks for a single update rather than reading `getLastKnownLocation`,
     * which can be hours old and somewhere else entirely. The last known
     * position is used only as an immediate answer while the real one is
     * pending, and only when it is recent enough to still be true.
     */
    suspend fun current(context: Context): Location? {
        if (!granted(context)) return null
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: return null

        val provider = when {
            manager.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            else -> return null
        }

        return suspendCancellableCoroutine { cont ->
            val listener = object : LocationListener {
                override fun onLocationChanged(location: Location) {
                    runCatching { manager.removeUpdates(this) }
                    if (cont.isActive) cont.resume(location)
                }

                // Deprecated and abstract on older API levels: without these
                // overrides this does not compile below 30.
                @Deprecated("Required below API 30")
                override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
                override fun onProviderEnabled(provider: String) {}
                override fun onProviderDisabled(provider: String) {
                    runCatching { manager.removeUpdates(this) }
                    if (cont.isActive) cont.resume(null)
                }
            }

            val started = runCatching {
                manager.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper())
            }.isSuccess
            if (!started) {
                cont.resume(null)
                return@suspendCancellableCoroutine
            }

            cont.invokeOnCancellation { runCatching { manager.removeUpdates(listener) } }
        }
    }

    /**
     * The last fix, if it is recent enough to be worth showing while a real one
     * is on its way. Two minutes: long enough to cover a walk to the door,
     * short enough that it is not a different part of town.
     */
    fun lastKnown(context: Context, maxAgeMs: Long = 120_000): Location? {
        if (!granted(context)) return null
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
            ?: return null
        val now = System.currentTimeMillis()
        return listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .mapNotNull { provider -> runCatching { manager.getLastKnownLocation(provider) }.getOrNull() }
            .filter { now - it.time <= maxAgeMs }
            .maxByOrNull { it.time }
    }

    /** Degrees, or null when the device has no idea which way it is pointing. */
    fun headingOf(location: Location): Double? =
        if (location.hasBearing() && (Build.VERSION.SDK_INT < 26 || location.bearingAccuracyDegrees > 0f)) {
            location.bearing.toDouble()
        } else {
            null
        }
}
