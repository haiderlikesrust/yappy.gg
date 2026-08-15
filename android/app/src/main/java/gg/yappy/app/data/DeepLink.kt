package gg.yappy.app.data

import android.net.Uri

/**
 * Somewhere in the app a link can point.
 *
 * Both forms the backend hands out are understood, plus the custom scheme:
 *
 *   https://yappy.gg/join/<code>    the URL `POST /conversations/:id/invites` returns
 *   https://tenku.xyz/join/<code>   the same link on the backup domain
 *   yappy://join/<code>             works with no domain verification at all
 *   yappy://conversation/<id>       used by a tapped notification
 *   yappy://call/<id>               used by the incoming-call notification
 *
 * Kept in step with ios/Yappy/Data/DeepLink.swift, which parses the same set.
 */
sealed interface DeepLink {
    data class Conversation(val id: String) : DeepLink
    data class Invite(val code: String) : DeepLink

    /** A person. What the share-profile QR encodes. */
    data class User(val id: String) : DeepLink

    /**
     * A ring answered from the notification or the lock screen. Distinct from
     * [Conversation] because the destination is the call screen, and the call
     * may not have a conversation open behind it at all.
     */
    data class Call(val id: String) : DeepLink

    companion object {
        /**
         * Hosts we will follow a `/join/` link from.
         *
         * An allowlist rather than "any https URL". An intent is something any
         * app on the device can send us, so without this, anyone could hand us
         * `https://evil.example/join/<code>` and have the app treat that path
         * segment as a code to redeem against our own API.
         */
        private val KNOWN_HOSTS = setOf("yappy.gg", "www.yappy.gg", "tenku.xyz", "www.tenku.xyz")

        fun parse(uri: Uri?): DeepLink? {
            if (uri == null) return null
            val path = uri.pathSegments.orEmpty()

            return when (uri.scheme?.lowercase()) {
                "yappy" -> {
                    // In yappy://join/<code> the host carries the first segment.
                    val parts = listOfNotNull(uri.host) + path
                    if (parts.size < 2) return null
                    when (parts[0]) {
                        "join" -> Invite(parts[1])
                        "conversation", "chat" -> Conversation(parts[1])
                        "call" -> Call(parts[1])
                        "user" -> User(parts[1])
                        else -> null
                    }
                }

                "https", "http" -> {
                    val host = uri.host?.lowercase() ?: return null
                    if (host !in KNOWN_HOSTS) return null
                    if (path.size < 2 || path[0] != "join") return null
                    Invite(path[1])
                }

                else -> null
            }
        }
    }
}
