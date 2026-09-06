package gg.yappy.app.data

import android.net.Uri
import gg.yappy.app.BuildConfig

object SupportLinks {
    /** Carry only the case capability onto our configured support site. */
    fun url(appeal: Boolean = false, source: String? = null): String {
        val builder = Uri.parse(BuildConfig.WEB_URL.trimEnd('/') + "/support/").buildUpon()
            .appendQueryParameter("client", "Android · ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
        if (appeal) {
            builder.appendQueryParameter("topic", "appeal")
            val token = runCatching {
                val fragment = Uri.parse(source.orEmpty()).encodedFragment ?: return@runCatching null
                Uri.parse("https://yappy.gg/?$fragment").getQueryParameter("appeal")
            }.getOrNull()
            if (token != null && token.length <= 2000 && token.matches(Regex("[A-Za-z0-9._-]+"))) {
                builder.fragment("appeal=$token")
            }
        }
        return builder.build().toString()
    }
}
