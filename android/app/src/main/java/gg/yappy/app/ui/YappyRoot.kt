package gg.yappy.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.fragment.app.FragmentActivity
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.CallCoordinator
import gg.yappy.app.data.DeepLink
import gg.yappy.app.data.ReleaseNote
import gg.yappy.app.data.contentOrNull
import gg.yappy.app.ui.auth.AuthFlow
import gg.yappy.app.ui.call.CallScreen
import gg.yappy.app.ui.chat.ChatScreen
import gg.yappy.app.ui.chat.ThreadScreen
import gg.yappy.app.ui.conversations.ConversationsScreen
import gg.yappy.app.ui.explore.ExploreScreen
import gg.yappy.app.ui.group.GroupScreen
import gg.yappy.app.ui.group.GroupSettingsScreen
import gg.yappy.app.ui.invite.InviteSheet
import gg.yappy.app.ui.newchat.NewChatScreen
import gg.yappy.app.ui.profile.ProfileScreen
import gg.yappy.app.ui.settings.AboutScreen
import gg.yappy.app.ui.settings.AppLockScreen
import gg.yappy.app.ui.settings.LocalAppLock
import gg.yappy.app.ui.settings.SettingsScreen
import gg.yappy.app.ui.settings.WhatsNewGate
import gg.yappy.app.ui.settings.WhatsNewSheet
import gg.yappy.app.ui.space.SpaceScreen
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

object Routes {
    const val CONVERSATIONS = "conversations"
    const val CHAT = "chat/{id}"
    const val NEW_CHAT = "new-chat"
    const val SETTINGS = "settings"
    const val ABOUT = "about"
    const val PROFILE = "profile/{id}"
    const val GROUP = "group/{id}"
    const val GROUP_SETTINGS = "group/{id}/settings"
    const val CALL = "call/{id}"
    const val THREAD = "thread/{id}/{rootId}"
    const val SPACE = "space/{id}"
    const val EXPLORE = "explore"

    fun chat(id: String) = "chat/$id"
    fun profile(id: String) = "profile/$id"
    fun group(id: String) = "group/$id"
    fun groupSettings(id: String) = "group/$id/settings"
    fun call(id: String) = "call/$id"
    fun space(id: String) = "space/$id"
    fun thread(id: String, rootId: String) = "thread/$id/$rootId"
}

@Composable
fun YappyRoot() {
    val container = LocalContainer.current
    val lock = LocalAppLock.current
    val context = LocalContext.current
    val signedIn by container.signedIn.collectAsState()
    val locked by lock.locked.collectAsState()
    val lockFailed by lock.failed.collectAsState()

    AnimatedContent(
        targetState = signedIn,
        transitionSpec = { fadeIn(tween(220)) togetherWith fadeOut(tween(180)) },
        label = "root",
    ) { state ->
        when (state) {
            // Still reading the stored token. A spinner rather than a flash of
            // the sign-in screen, which is what users of a logged-in app notice.
            null -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                CircularProgressIndicator(color = neuColors.accent)
            }

            false -> AuthFlow(onAuthenticated = { container.onAuthenticated() })

            true -> SignedInNav()
        }
    }

    // Over everything, including the sign-in screen: an app that shows its
    // conversation list for one frame before locking has not locked anything.
    if (locked) {
        AppLockScreen(
            failed = lockFailed,
            onUnlock = { (context as? FragmentActivity)?.let(lock::unlock) },
        )
        // Prompt immediately, rather than making someone tap Unlock first. The
        // button stays for the retry after a cancel.
        LaunchedEffect(Unit) { (context as? FragmentActivity)?.let(lock::unlock) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SignedInNav() {
    val container = LocalContainer.current
    val context = LocalContext.current
    val nav = rememberNavController()
    val scope = rememberCoroutineScope()

    // A link tapped anywhere on the device. Only read once we are signed in, so
    // an invite followed while signed out waits at the door rather than being
    // answered with a sign-in screen and then forgotten.
    val pendingLink by container.pendingLink.collectAsState()

    val incoming by CallCoordinator.incoming.collectAsState()
    val openCallId by CallCoordinator.openCallId.collectAsState()

    /**
     * Release notes.
     *
     * Owned here rather than in Settings so it can be shown once at the
     * conversation list — never on top of a chat someone opened from a
     * notification, and never while a call is ringing.
     */
    val gate = remember { WhatsNewGate(container.session, container.repo) }
    var notes by remember { mutableStateOf<List<ReleaseNote>>(emptyList()) }
    var notesOpen by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) {
        val pending = gate.check()
        // Decided once, here, rather than continuously: the sheet should reflect
        // the moment the notes arrived, not re-open itself later because the
        // stack happened to empty.
        //
        // Suppressed when something else is already the point of this launch —
        // a chat opened from a notification, an invite being followed, a phone
        // that is ringing. An update note on top of any of those is worse than
        // one that waits for the next launch.
        if (pending.isNotEmpty() &&
            container.pendingLink.value == null &&
            CallCoordinator.incoming.value == null
        ) {
            notes = pending
            notesOpen = true
        }
    }

    when (val link = pendingLink) {
        is DeepLink.Conversation -> LaunchedEffect(link) {
            container.consumeLink()
            nav.navigate(Routes.chat(link.id))
        }

        is DeepLink.Call -> LaunchedEffect(link) {
            container.consumeLink()
            nav.navigate(Routes.call(link.id))
        }

        is DeepLink.Invite -> InviteSheet(
            code = link.code,
            onJoined = { conversationId, isSpace ->
                container.consumeLink()
                // A space has no timeline of its own; the same rule the
                // conversation list follows when you tap one.
                nav.navigate(if (isSpace) Routes.space(conversationId) else Routes.chat(conversationId))
            },
            onDismiss = { container.consumeLink() },
        )

        null -> Unit
    }

    // A call answered from the notification, the lock screen, or the in-app
    // ring. The coordinator sets it and this consumes it.
    LaunchedEffect(openCallId) {
        val id = openCallId ?: return@LaunchedEffect
        CallCoordinator.consumeOpen()
        nav.navigate(Routes.call(id))
    }

    Box(Modifier.fillMaxSize()) {
        NavHost(
            navController = nav,
            startDestination = Routes.CONVERSATIONS,
            // Horizontal slide: the stack has a clear left-to-right depth order,
            // and matching it makes back gestures feel like they undo rather
            // than jump.
            enterTransition = { slideInHorizontally(tween(260)) { it / 4 } + fadeIn(tween(200)) },
            exitTransition = { slideOutHorizontally(tween(260)) { -it / 6 } + fadeOut(tween(180)) },
            popEnterTransition = { slideInHorizontally(tween(260)) { -it / 6 } + fadeIn(tween(200)) },
            popExitTransition = { slideOutHorizontally(tween(260)) { it / 4 } + fadeOut(tween(180)) },
        ) {
            composable(Routes.CONVERSATIONS) {
                ConversationsScreen(
                    // A space has no timeline of its own, so tapping it opens
                    // its channel list rather than a chat with nothing in it.
                    onOpenChat = { nav.navigate(Routes.chat(it)) },
                    onOpenSpace = { nav.navigate(Routes.space(it)) },
                    onNewChat = { nav.navigate(Routes.NEW_CHAT) },
                    onSettings = { nav.navigate(Routes.SETTINGS) },
                    onExplore = { nav.navigate(Routes.EXPLORE) },
                )
            }

            composable(
                Routes.CHAT,
                arguments = listOf(navArgument("id") { type = NavType.StringType }),
            ) { entry ->
                val chatId = entry.arguments?.getString("id").orEmpty()
                ChatScreen(
                    conversationId = chatId,
                    onBack = { nav.popBackStack() },
                    onOpenProfile = { nav.navigate(Routes.profile(it)) },
                    onOpenGroup = { nav.navigate(Routes.group(it)) },
                    onOpenCall = { nav.navigate(Routes.call(it)) },
                    onOpenThread = { rootId -> nav.navigate(Routes.thread(chatId, rootId)) },
                )
            }

            composable(
                Routes.THREAD,
                arguments = listOf(
                    navArgument("id") { type = NavType.StringType },
                    navArgument("rootId") { type = NavType.StringType },
                ),
            ) { entry ->
                ThreadScreen(
                    conversationId = entry.arguments?.getString("id").orEmpty(),
                    rootId = entry.arguments?.getString("rootId").orEmpty(),
                    onBack = { nav.popBackStack() },
                )
            }

            composable(Routes.EXPLORE) {
                ExploreScreen(
                    onBack = { nav.popBackStack() },
                    onOpenChat = { id ->
                        nav.popBackStack()
                        nav.navigate(Routes.chat(id))
                    },
                )
            }

            composable(Routes.NEW_CHAT) {
                NewChatScreen(
                    onBack = { nav.popBackStack() },
                    onOpenChat = { id ->
                        nav.popBackStack()
                        nav.navigate(Routes.chat(id))
                    },
                )
            }

            composable(Routes.SETTINGS) {
                SettingsScreen(
                    onBack = { nav.popBackStack() },
                    onOpenAbout = { nav.navigate(Routes.ABOUT) },
                )
            }

            composable(Routes.ABOUT) {
                AboutScreen(onBack = { nav.popBackStack() })
            }

            composable(
                Routes.PROFILE,
                arguments = listOf(navArgument("id") { type = NavType.StringType }),
            ) { entry ->
                ProfileScreen(
                    userId = entry.arguments?.getString("id").orEmpty(),
                    onBack = { nav.popBackStack() },
                    onOpenChat = { nav.navigate(Routes.chat(it)) },
                )
            }

            composable(
                Routes.GROUP,
                arguments = listOf(navArgument("id") { type = NavType.StringType }),
            ) { entry ->
                GroupScreen(
                    conversationId = entry.arguments?.getString("id").orEmpty(),
                    onBack = { nav.popBackStack() },
                    onOpenProfile = { nav.navigate(Routes.profile(it)) },
                    onOpenCall = { nav.navigate(Routes.call(it)) },
                    onOpenSettings = { nav.navigate(Routes.groupSettings(it)) },
                )
            }

            composable(
                Routes.SPACE,
                arguments = listOf(navArgument("id") { type = NavType.StringType }),
            ) { entry ->
                val id = entry.arguments?.getString("id").orEmpty()
                SpaceScreen(
                    spaceId = id,
                    onBack = { nav.popBackStack() },
                    onOpenChannel = { nav.navigate(Routes.chat(it)) },
                    // A space's people and settings are the group screens: the
                    // membership and roles genuinely are the same objects.
                    onOpenMembers = { nav.navigate(Routes.group(id)) },
                    onOpenSettings = { nav.navigate(Routes.groupSettings(id)) },
                )
            }

            composable(
                Routes.GROUP_SETTINGS,
                arguments = listOf(navArgument("id") { type = NavType.StringType }),
            ) { entry ->
                GroupSettingsScreen(
                    conversationId = entry.arguments?.getString("id").orEmpty(),
                    onBack = { nav.popBackStack() },
                )
            }

            composable(
                Routes.CALL,
                arguments = listOf(navArgument("id") { type = NavType.StringType }),
            ) { entry ->
                CallScreen(
                    callId = entry.arguments?.getString("id").orEmpty(),
                    onLeave = { nav.popBackStack() },
                )
            }
        }

        InAppBanners(
            onOpen = { conversationId -> nav.navigate(Routes.chat(conversationId)) },
            modifier = Modifier.align(Alignment.TopCenter).statusBarsPadding(),
        )
    }

    // Over the whole stack: a ring is not somewhere you navigate to, it is
    // something that happens to you.
    incoming?.let { call ->
        IncomingCallSheet(
            call = call,
            onAnswer = { CallCoordinator.answer(context, call.callId) },
            onDecline = { CallCoordinator.decline(context, call.callId) },
        )
    }

    if (notesOpen) {
        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(
            onDismissRequest = {
                notesOpen = false
                scope.launch { gate.markSeen() }
            },
            sheetState = sheetState,
            containerColor = neuColors.surface,
            contentColor = neuColors.textPrimary,
        ) {
            WhatsNewSheet(
                notes = notes,
                onClose = {
                    notesOpen = false
                    scope.launch { gate.markSeen() }
                },
            )
        }
    }
}

/**
 * A message landed somewhere you are not looking.
 *
 * Socket-driven, not push-driven: it works with notification permission denied,
 * and it beats FCM by a second — which is why [gg.yappy.app.data.YappyPushService]
 * drops a push for the conversation currently on screen, or every message would
 * announce itself twice.
 *
 * What suppresses it: your own messages, the chat currently on screen, muted
 * conversations (and mentions-only ones — a level that says "only when someone
 * names me" should not banner smalltalk), and the in-app setting itself.
 */
@Composable
private fun InAppBanners(onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    val container = LocalContainer.current
    val me by container.me.collectAsState()

    // One at a time — a newer message replaces it rather than queueing behind
    // it, because by the time a queue drained its contents would be old.
    var banner by remember { mutableStateOf<InAppBanner?>(null) }

    LaunchedEffect(Unit) {
        container.gateway.events.collect { event ->
            if (event.type != "message.create") return@collect
            val data = runCatching { event.data.jsonObject }.getOrNull() ?: return@collect
            fun str(key: String) = data[key]?.jsonPrimitive?.contentOrNull()

            val conversationId = str("conversationId") ?: return@collect
            val messageId = str("id") ?: return@collect
            val senderId = str("senderId") ?: return@collect

            if (senderId == container.session.currentUserId()) return@collect
            if (conversationId == container.foregroundConversationId) return@collect
            if ((container.notificationLevels[conversationId] ?: "all") != "all") return@collect

            val prefs = me?.notifications
            val inApp = runCatching {
                prefs?.get("inApp")?.jsonPrimitive?.content?.toBooleanStrictOrNull()
            }.getOrNull() ?: true
            if (!inApp) return@collect

            val showPreview = runCatching {
                prefs?.get("showPreview")?.jsonPrimitive?.content?.toBooleanStrictOrNull()
            }.getOrNull() ?: true

            val senderObject = runCatching { data["sender"]?.jsonObject }.getOrNull()
            val sender = senderObject?.let { s ->
                s["displayName"]?.jsonPrimitive?.contentOrNull()
                    ?: s["username"]?.jsonPrimitive?.contentOrNull()
            } ?: "Someone"

            val seed = container.headerSeeds[conversationId]
            val isGroupish = seed != null && seed.title != sender

            val hasAttachment = runCatching { data["attachments"]?.jsonArray?.isNotEmpty() }
                .getOrNull() ?: false

            val preview = when {
                !showPreview -> "New message"
                !str("content").isNullOrBlank() -> str("content").orEmpty()
                hasAttachment -> "Sent a photo"
                str("stickerId") != null -> "Sent a sticker"
                data["gif"] != null -> "Sent a GIF"
                else -> "New message"
            }

            banner = InAppBanner(
                id = messageId,
                conversationId = conversationId,
                title = seed?.title ?: sender,
                body = if (isGroupish) "$sender: $preview" else preview,
                avatarUrl = senderObject?.get("avatarUrl")?.jsonPrimitive?.contentOrNull()
                    ?: seed?.avatarUrl,
                avatarSeed = senderId,
            )
        }
    }

    // Four seconds, then away. Restarted whenever a newer message replaces it.
    LaunchedEffect(banner?.id) {
        if (banner == null) return@LaunchedEffect
        delay(4_000)
        banner = null
    }

    AnimatedVisibility(
        visible = banner != null,
        enter = slideInVertically { -it } + fadeIn(),
        exit = slideOutVertically { -it } + fadeOut(),
        modifier = modifier,
    ) {
        banner?.let { current ->
            InAppBannerView(current) {
                banner = null
                onOpen(current.conversationId)
            }
        }
    }
}

