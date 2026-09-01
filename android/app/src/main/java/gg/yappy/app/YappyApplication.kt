package gg.yappy.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.os.Build
import androidx.compose.runtime.staticCompositionLocalOf
import coil.ImageLoader
import coil.ImageLoaderFactory
import coil.decode.GifDecoder
import coil.decode.ImageDecoderDecoder
import coil.decode.VideoFrameDecoder
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import gg.yappy.app.data.CallCoordinator
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

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
        initialiseFirebase()
    }

    /**
     * Firebase, configured in code rather than by the google-services plugin.
     *
     * The plugin fails the build when `google-services.json` is absent, and
     * that file is gitignored — a fresh clone would not compile. These four
     * values come from `android/firebase.properties` through BuildConfig, and
     * when they are blank this does nothing at all: no FirebaseApp, no token,
     * no push. The app is fully usable that way, which is the right outcome for
     * anyone running against a local backend.
     */
    private fun initialiseFirebase() {
        if (BuildConfig.FIREBASE_PROJECT_ID.isBlank() || BuildConfig.FIREBASE_APP_ID.isBlank()) return
        if (FirebaseApp.getApps(this).isNotEmpty()) return

        runCatching {
            FirebaseApp.initializeApp(
                this,
                FirebaseOptions.Builder()
                    .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                    .setApplicationId(BuildConfig.FIREBASE_APP_ID)
                    .setApiKey(BuildConfig.FIREBASE_API_KEY)
                    .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
                    .build(),
            )
        }
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
                // Video posters. The video-note circle and the media wall both
                // hand Coil a video URL and expect a frame back; without this
                // decoder Coil has no idea what the bytes are and renders
                // nothing — which drew every video note as a black circle.
                add(VideoFrameDecoder.Factory())
            }
            .okHttpClient {
                // Built on the API's own client rather than from scratch, so
                // images share its connection pool and dispatcher instead of
                // maintaining a parallel set of sockets and threads.
                container.api.http.newBuilder()
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
                            // The in-memory copy of the token, not a DataStore
                            // read — runBlocking over a preference file here
                            // was stalling a network thread on every single
                            // image request. MediaFactory already trusts the
                            // same cache for the same reason.
                            container.session.cachedAccess?.let { token ->
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
                // The ringtone, not the notification sound: a call announces
                // itself the way a call does, and it has to keep ringing rather
                // than making one chirp. Android decides both at the channel,
                // so this is the only place it can be said.
                CallCoordinator.ringtoneUri()?.let { uri ->
                    setSound(
                        uri,
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                            .build(),
                    )
                }
            },
        )

        /**
         * Silent twins of the two message channels.
         *
         * Android decides sound at the channel, and a channel's importance can
         * never be lowered once created — the OS treats that as the user's
         * territory, not the app's. So "turn the sound off" cannot be a flag on
         * the message; it has to be a second channel that the server addresses
         * instead. `FcmClient` appends `_silent` when the account has chosen no
         * sound, and falls back to the loud channel if one is missing.
         *
         * DEFAULT rather than LOW: importance also governs whether the
         * notification appears at all prominently, and the point here is a
         * visible notification without a noise, not a buried one.
         */
        manager.createNotificationChannel(
            NotificationChannel("messages_silent", "Messages (silent)", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "New messages, without a sound"
                setSound(null, null)
                enableVibration(false)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel("mentions_silent", "Mentions (silent)", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Mentions, without a sound"
                setSound(null, null)
                enableVibration(false)
            },
        )
    }
}
