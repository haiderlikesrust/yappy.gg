package gg.yappy.app.data

/**
 * The API and gateway addresses, with automatic failover to a backup domain.
 *
 * yappy runs on two domains that point at the same server (see the backup
 * section of infra/Caddyfile). If the primary domain stops resolving, for
 * example while a registry propagates a change, the app should keep working on
 * the backup rather than sitting at "network error".
 *
 * This holds both sets and a shared active index. When the API client cannot
 * reach the current domain it advances the index; the gateway reads the same
 * index on its next reconnect, so the two fail over together, which is right
 * because they share a domain's fate. The move is sticky for the session and
 * resets to the primary on the next cold start, so a blip does not pin every
 * future launch to the backup.
 *
 * Blank or duplicate entries collapse away, so a build with no configured
 * backup is simply a one-entry list that never fails over.
 */
class Endpoints(apiUrls: List<String>, gatewayUrls: List<String>) {

    private val apis = apiUrls.map { it.trim() }.filter { it.isNotEmpty() }.distinct()
    private val gateways = gatewayUrls.map { it.trim() }.filter { it.isNotEmpty() }.distinct()

    @Volatile
    private var index = 0

    val apiBase: String get() = apis.getOrElse(index) { apis.first() }

    val gatewayUrl: String get() = gateways.getOrElse(index.coerceAtMost(gateways.size - 1)) { gateways.first() }

    val hasBackup: Boolean get() = apis.size > 1

    /**
     * Advance to the next domain after a connection failure, and return its API
     * base, or null if there is nowhere left to go.
     *
     * Takes the base the caller just failed on. If it no longer matches the
     * active one, another request already failed over; we hand back the current
     * base rather than skipping a domain, so concurrent failures do not race
     * past a working endpoint.
     */
    @Synchronized
    fun failOver(failedBase: String): String? {
        if (apiBase != failedBase) return apiBase
        if (index + 1 >= apis.size) return null
        index += 1
        return apiBase
    }
}
