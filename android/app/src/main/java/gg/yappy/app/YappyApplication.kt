package gg.yappy.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import androidx.compose.runtime.staticCompositionLocalOf
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.decode.GifDecoder
import coil.decode.ImageDecoderDecoder
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient

val LocalContainer = staticCompositionLocalOf<AppContainer> {
    error("AppContainer not provided")
}

class YappyApplication : Application(), ImageLoaderFactory {

    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        container = AppContainer(this)
        createNotificationChannels()
    }

    /**
     * The image pipeline.
     *
     * Two things the default loader cannot do for us:
     *
     *  1. **Authorised media.** Message attachments are private — the API
     *     serves them only to members of the conversation they were posted in,
     *     so image requests to our own host need the access token. Sent only to
     *     our host: attaching it to a Giphy URL would leak the session.
     *  2. **Animated GIFs.** Coil decodes them only if the decoder is
     *     registered, and half the point of the GIF picker is that they move.
     */
    override fun newImageLoader(): ImageLoader {
        val apiHost = BuildConfig.API_URL.toHttpUrlOrNull()?.host

        return ImageLoader.Builder(this)
            .components {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    add(ImageDecoderDecoder.Factory())
                } else {
                    add(GifDecoder.Factory())
                }
            }
            .okHttpClient {
                OkHttpClient.Builder()
                    .addInterceptor { chain ->
                        var request = chain.request()
                        // The server names itself "localhost"; from inside the
                        // emulator that is a different machine entirely.
                        if (BuildConfig.DEBUG &&
                            (request.url.host == "localhost" || request.url.host == "127.0.0.1")
                        ) {
                            request = request.newBuilder()
                                .url(request.url.newBuilder().host("10.0.2.2").build())
                                .build()
                        }
                        if (request.url.host == apiHost) {
                            runBlocking { container.session.currentAccess() }?.let { token ->
                                request = request.newBuilder()
                                    .header("Authorization", "Bearer $token")
                                    .build()
                            }
                        }
                        chain.proceed(request)
                    }
                    .build()
            }
            .build()
    }

    /**
     * Channels must exist before the first notification, and their ids are
     * baked into the server's push payloads (`push.ts` sets `channelId`), so
     * these three names are effectively part of the API contract.
     *
     * Separate channels rather than one: users overwhelmingly want to keep call
     * notifications while silencing group chatter, and Android only lets them
     * do that per channel.
     */
    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return

        manager.createNotificationChannel(
            NotificationChannel("messages", "Messages", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "New messages in your chats"
                enableVibration(true)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel("mentions", "Mentions", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "When someone mentions you"
                enableVibration(true)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel("calls", "Calls", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Incoming voice and video calls"
                setBypassDnd(true)
                enableVibration(true)
                setShowBadge(false)
            },
        )
    }
}
