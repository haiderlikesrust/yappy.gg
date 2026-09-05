package gg.yappy.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.tween
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.fragment.app.FragmentActivity
import androidx.navigation.NamedNavArgument
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.CallCoordinator
import gg.yappy.app.data.DeepLink
import gg.yappy.app.data.GatewayState
import gg.yappy.app.data.ReleaseNote
import gg.yappy.app.data.contentOrNull
import gg.yappy.app.ui.auth.AuthFlow
import gg.yappy.app.ui.call.CallScreen
import gg.yappy.app.ui.chat.ChatScreen
import gg.yappy.app.ui.chat.ThreadScreen
import gg.yappy.app.ui.components.LocalSnackbar
import gg.yappy.app.ui.components.LocalSnackbarClearance
import gg.yappy.app.ui.components.NeuSnackbarHost
import gg.yappy.app.ui.components.NeuSurface
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
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import gg.yappy.app.ui.chat.MentionsScreen
import gg.yappy.app.ui.group.AuditLogScreen

object Routes {
    const val CONVERSATIONS = "conversations"
    /**
     * `at` is a message seq to land on, when the chat was opened from
     * somewhere that knows which message it means — the mentions inbox.
     * Without it the chat opens where it always did, at the newest message.
     */
    const val CHAT = "chat/{id}?at={at}"
    const val NEW_CHAT = "new-chat"
    const val SETTINGS = "settings"
    const val ABOUT = "about"
    /**
     * `in` is the conversation the profile was opened from, when there was
     * one. With it the card can also show what that group knows about the
     * person — their roles there — which is the half `GET /users/:id` has
     * never had, because it knows about no group at all.
     */
    const val PROFILE = "profile/{id}?in={in}"
    const val GROUP = "group/{id}"
    const val GROUP_SETTINGS = "group/{id}/settings"
    const val CALL = "call/{id}"
    const val THREAD = "thread/{id}/{rootId}"
    const val SPACE = "space/{id}"
    const val EXPLORE = "explore"
    const val MENTIONS = "mentions"
    const val AUDIT = "group/{id}/audit"

    fun chat(id: String, at: Long? = null) =
        if (at == null) "chat/$id" else "chat/$id?at=$at"
    fun profile(id: String, inConversation: String? = null) =
        if (inConversation == null) "profile/$id" else "profile/$id?in=$inConversation"
    fun group(id: String) = "group/$id"
    fun groupSettings(id: String) = "group/$id/settings"
    fun audit(id: String) = "group/$id/audit"
    fun call(id: String) = "call/$id"
    fun space(id: String) = "space/$id"
    fun thread(id: String, rootId: String) = "thread/$id/$rootId"
}

/**
 * Navigation for an entry from *outside* the app — a notification, a link, a
 * share, a call answered from the shade.
 *
 * Plain `navigate` stacks: tapping the shade for the chat already open pushed
 * a second copy of it, and a notification over Settings › About left
 * Home › Settings › About › Chat for Back to walk through. An external entry
 * has no in-app history worth keeping, so the stack is cut back to the home
 * list first and the target pushed once. In-app taps keep plain `navigate`,
 * because profile → chat → thread genuinely should unwind.
 */
private fun NavController.open(route: String) {
    // Except while a call is up. Cutting the stack back to home pops the call
    // entry, and a popped call entry is a hung-up call: tapping a message
    // banner or a message notification during a call ended it without a word.
    // The new screen goes on top instead and the call waits underneath, which
    // is what the ongoing "Call in progress" notification promises anyway.
    val onCall = runCatching { getBackStackEntry(Routes.CALL) }.isSuccess
    navigate(route) {
        if (!onCall) popUpTo(Routes.CONVERSATIONS) { inclusive = false }
        launchSingleTop = true
    }
}

/**
 * True when the screen on top is already [pattern] showing [id] — the case
 * where opening it again would only re-run its effects (a call screen would
 * re-join the call it is already in).
 */
private fun NavController.isShowing(pattern: String, id: String): Boolean {
    val entry = currentBackStackEntry ?: return false
    return entry.destination.route == pattern && entry.arguments?.getString("id") == id
}

/**
 * An external entry into a chat. A channel goes in with its space underneath,
 * when the app has seen the channel and knows which space that is, so Back
 * lands on the channel list the way it does from inside the app rather than
 * dropping straight to home.
 *
 * Not short-circuited when the chat is already up: the screen consumes a
 * pending share in its own launch effect, and a fresh entry is how a share
 * into the chat you are already reading gets delivered. `launchSingleTop`
 * replaces the top entry rather than stacking a second copy.
 */
/**
 * A destination, on ground of its own.
 *
 * The window paints one surface behind everything and no screen painted its
 * own, so the two screens in a transition were composited onto that same
 * ground: for the length of every slide the chat being opened and the list
 * being left were legible through each other, which read as a flash on the
 * way in. Opaque here rather than in twenty screens, so the twenty-first
 * cannot forget — and it costs nothing, since the surface underneath is the
 * same colour and only ever shows through in that gap.
 */
private fun NavGraphBuilder.screen(
    route: String,
    arguments: List<NamedNavArgument> = emptyList(),
    // Null means "whatever the NavHost does", which is the horizontal slide
    // nearly every page wants; a destination that arrives differently — the
    // profile card, which scales up rather than sliding in — names only the
    // halves it changes.
    enterTransition: (AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition?)? = null,
    exitTransition: (AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition?)? = null,
    popEnterTransition: (AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition?)? = null,
    popExitTransition: (AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition?)? = null,
    content: @Composable (NavBackStackEntry) -> Unit,
) = composable(
    route = route,
    arguments = arguments,
    enterTransition = enterTransition,
    exitTransition = exitTransition,
    popEnterTransition = popEnterTransition,
    popExitTransition = popExitTransition,
) { entry ->
    Box(Modifier.fillMaxSize().background(neuColors.surface)) { content(entry) }
}

private fun NavController.openChat(container: gg.yappy.app.AppContainer, id: String) {
    val parent = container.headerSeeds[id]?.parentId
    if (parent != null && !isShowing(Routes.CHAT, id)) {
        open(Routes.space(parent))
        navigate(Routes.chat(id))
    } else {
        open(Routes.chat(id))
    }
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
            // Still reading the stored token. The splash is held over this
            // (MainActivity keeps it until `signedIn` resolves), so nothing is
            // drawn: a spinner here was a third state between the splash and
            // the list that nobody was meant to see. The bare sheet is the
            // fallback if the hold ever times out.
            null -> Box(Modifier.fillMaxSize())

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

    // One snackbar host for the signed-in shell, so Undo and Retry land in
    // the same place from every screen that has no foot of its own (chat and
    // thread host theirs above the composer). Provided here and hosted at the
    // foot of the content area below; screens reach it through LocalSnackbar.
    val snackbar = remember { SnackbarHostState() }

    // How tall the host is right now, measured, so Home can lift its floating
    // button out from under an Undo the way Material's scaffold lifts a FAB.
    // Zero while nothing is showing: the host composes nothing then.
    var snackbarClearance by remember { mutableStateOf(0.dp) }
    val density = LocalDensity.current

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

    // Shared content rides to its conversation; the chat screen consumes the
    // payload itself, so this only has to get there.
    val pendingShare by container.pendingShare.collectAsState()
    pendingShare?.let { share ->
        LaunchedEffect(share) { nav.openChat(container, share.conversationId) }
    }

    when (val link = pendingLink) {
        is DeepLink.Conversation -> LaunchedEffect(link) {
            container.consumeLink()
            nav.openChat(container, link.id)
        }

        is DeepLink.Call -> LaunchedEffect(link) {
            container.consumeLink()
            // Already on this call: opening it again would rebuild the screen
            // and re-join the call it is already in.
            if (nav.isShowing(Routes.CALL, link.id)) return@LaunchedEffect
            // On the stack but buried — the call was minimised to read a chat,
            // and this is the ongoing notification asking to come back. Pop to
            // it rather than build a second screen: a second screen clears the
            // first, and the first's clearing is what leaves the call.
            if (!nav.popBackStack(Routes.call(link.id), inclusive = false)) {
                nav.open(Routes.call(link.id))
            }
        }

        // A scanned profile QR. Straight to the person, where Follow lives.
        is DeepLink.User -> LaunchedEffect(link) {
            container.consumeLink()
            nav.open(Routes.profile(link.id))
        }

        is DeepLink.Group -> LaunchedEffect(link) {
            container.consumeLink()
            nav.open(Routes.group(link.id))
        }

        // The chat goes underneath so Back from the thread lands on it, the
        // way it does when the thread is opened from inside the app.
        is DeepLink.Thread -> LaunchedEffect(link) {
            container.consumeLink()
            nav.open(Routes.chat(link.conversationId))
            nav.navigate(Routes.thread(link.conversationId, link.rootId))
        }

        is DeepLink.Invite -> InviteSheet(
            code = link.code,
            onJoined = { conversationId, isSpace ->
                container.consumeLink()
                // A space has no timeline of its own; the same rule the
                // conversation list follows when you tap one.
                nav.open(if (isSpace) Routes.space(conversationId) else Routes.chat(conversationId))
            },
            onDismiss = { container.consumeLink() },
        )

        null -> Unit
    }

    // The in-app ring, answered. Plain `navigate`, not `open`: the ring sat
    // over a chat someone was reading, and when the call ends Back should
    // land on it, the way it does for a call started from that chat. Answers
    // from the shade and the lock screen never come this way — they arrive
    // as `DeepLink.Call` above, where cutting the stack is the right call.
    LaunchedEffect(openCallId) {
        val id = openCallId ?: return@LaunchedEffect
        CallCoordinator.consumeOpen()
        if (nav.isShowing(Routes.CALL, id)) return@LaunchedEffect
        nav.navigate(Routes.call(id)) {
            // Answering a second call while the first one's screen is still up:
            // `launchSingleTop` alone reuses the back-stack entry, and reusing
            // the entry keeps its ViewModel — so the previous call's room and
            // its published microphone stayed alive underneath a screen that
            // now claimed to be on the new call. Popping the old entry builds a
            // real new one. A no-op when no call screen is on the stack, which
            // is every other time this runs.
            popUpTo(Routes.CALL) { inclusive = true }
            launchSingleTop = true
        }
    }

    CompositionLocalProvider(
        LocalSnackbar provides snackbar,
        LocalSnackbarClearance provides snackbarClearance,
    ) {
        // The connection strip sits above this and pushes it down; what is
        // here is the content area's own scope, so the overlays below still
        // align to the screen's edges.
        ConnectionShell {
            NavHost(
                navController = nav,
                startDestination = Routes.CONVERSATIONS,
                // Horizontal slide: the stack has a clear left-to-right depth order,
                // and matching it makes back gestures feel like they undo rather
                // than jump.
                //
                // A push, not a cross-fade. The page used to arrive a quarter of
                // the way in *and* fade up from nothing, which meant that for a
                // fifth of a second the chat being opened and the list being left
                // were both legible, one printed through the other — read as a
                // flash on the way into every screen. The incoming page is opaque
                // from its first frame and comes the whole width, and the one
                // underneath parallaxes a fifth of the way out, the way Android
                // has pushed pages since it had pages.
                enterTransition = { slideInHorizontally(tween(260)) { it } },
                exitTransition = { slideOutHorizontally(tween(260)) { -it / 5 } },
                popEnterTransition = { slideInHorizontally(tween(260)) { -it / 5 } },
                popExitTransition = { slideOutHorizontally(tween(260)) { it } },
            ) {
                screen(Routes.CONVERSATIONS) {
                    ConversationsScreen(
                        // A space has no timeline of its own, so tapping it opens
                        // its channel list rather than a chat with nothing in it.
                        onOpenChat = { nav.navigate(Routes.chat(it)) },
                        onOpenSpace = { nav.navigate(Routes.space(it)) },
                        onNewChat = { nav.navigate(Routes.NEW_CHAT) },
                        onSettings = { nav.navigate(Routes.SETTINGS) },
                        onExplore = { nav.navigate(Routes.EXPLORE) },
                        onOpenProfile = { nav.navigate(Routes.profile(it)) },
                        onOpenMentions = { nav.navigate(Routes.MENTIONS) },
                    )
                }

                screen(
                    Routes.AUDIT,
                    arguments = listOf(navArgument("id") { type = NavType.StringType }),
                ) { entry ->
                    AuditLogScreen(
                        conversationId = entry.arguments?.getString("id").orEmpty(),
                        onBack = { nav.popBackStack() },
                    )
                }

                screen(Routes.MENTIONS) {
                    MentionsScreen(
                        onBack = { nav.popBackStack() },
                        onOpenMessage = { conversationId, seq ->
                            nav.navigate(Routes.chat(conversationId, at = seq))
                        },
                    )
                }

                screen(
                    Routes.CHAT,
                    arguments = listOf(
                        navArgument("id") { type = NavType.StringType },
                        navArgument("at") {
                            type = NavType.StringType
                            nullable = true
                            defaultValue = null
                        },
                    ),
                ) { entry ->
                    val chatId = entry.arguments?.getString("id").orEmpty()
                    ChatScreen(
                        conversationId = chatId,
                        focusSeq = entry.arguments?.getString("at")?.toLongOrNull(),
                        onBack = { nav.popBackStack() },
                        // Carrying the room along: a profile opened from a chat
                        // can then say what this group knows about them.
                        onOpenProfile = { nav.navigate(Routes.profile(it, chatId)) },
                        onOpenGroup = { nav.navigate(Routes.group(it)) },
                        onOpenCall = { nav.navigate(Routes.call(it)) },
                        onOpenThread = { rootId -> nav.navigate(Routes.thread(chatId, rootId)) },
                        /*
                         * Pushed rather than replacing, so Back returns to the
                         * message that pointed you there — except when it points
                         * *here*, which does nothing at all.
                         *
                         * The composer never offers the current channel, so this
                         * is not reachable by typing one. It is reachable by
                         * reading: a message written elsewhere, or moved, or
                         * seeded. Following it stacked a second copy of the
                         * channel on top of itself, and Back then walked you
                         * through both.
                         */
                        onOpenChannel = { if (it != chatId) nav.navigate(Routes.chat(it)) },
                    )
                }

                screen(
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

                screen(Routes.EXPLORE) {
                    ExploreScreen(
                        onBack = { nav.popBackStack() },
                        // The same branch the invite sheet takes: a space has
                        // no timeline of its own, and sending every joined
                        // place to the chat route landed a space on an empty
                        // timeline instead of its channel list.
                        onOpenPlace = { id, isSpace ->
                            nav.popBackStack()
                            nav.navigate(if (isSpace) Routes.space(id) else Routes.chat(id))
                        },
                        // A peek, not a join: the directory stays underneath,
                        // so Back returns to the list being browsed rather
                        // than to Home with the search lost.
                        onOpenJoined = { id, isSpace ->
                            nav.navigate(if (isSpace) Routes.space(id) else Routes.chat(id))
                        },
                        onStartGroup = { nav.navigate(Routes.NEW_CHAT) },
                    )
                }

                screen(Routes.NEW_CHAT) {
                    NewChatScreen(
                        onBack = { nav.popBackStack() },
                        // Same branch as Explore and the invite sheet: a pasted
                        // space invite used to land on an empty timeline.
                        onOpenPlace = { id, isSpace ->
                            nav.popBackStack()
                            nav.navigate(if (isSpace) Routes.space(id) else Routes.chat(id))
                        },
                    )
                }

                screen(Routes.SETTINGS) {
                    SettingsScreen(
                        onBack = { nav.popBackStack() },
                        onOpenAbout = { nav.navigate(Routes.ABOUT) },
                        onOpenProfile = { nav.navigate(Routes.profile(it)) },
                    )
                }

                screen(Routes.ABOUT) {
                    AboutScreen(onBack = { nav.popBackStack() })
                }

                screen(
                    Routes.PROFILE,
                    arguments = listOf(
                        navArgument("id") { type = NavType.StringType },
                        navArgument("in") {
                            type = NavType.StringType
                            nullable = true
                            defaultValue = null
                        },
                    ),
                    // A profile "peeks" up over the screen you were on rather than
                    // sliding in as a sibling page: it is a card about a person,
                    // not the next room. Growing into place says exactly that —
                    // and it grows opaque, since a card you can read the old
                    // screen through is a ghost, not a card. Only the way out
                    // dissolves, where fading is the reveal.
                    enterTransition = { scaleIn(tween(220), initialScale = 0.92f) },
                    popExitTransition = {
                        scaleOut(tween(200), targetScale = 0.94f) + fadeOut(tween(160))
                    },
                ) { entry ->
                    ProfileScreen(
                        userId = entry.arguments?.getString("id").orEmpty(),
                        inConversation = entry.arguments?.getString("in"),
                        onBack = { nav.popBackStack() },
                        onOpenChat = { nav.navigate(Routes.chat(it)) },
                    )
                }

                screen(
                    Routes.GROUP,
                    arguments = listOf(navArgument("id") { type = NavType.StringType }),
                ) { entry ->
                    val groupId = entry.arguments?.getString("id").orEmpty()
                    GroupScreen(
                        conversationId = groupId,
                        onBack = { nav.popBackStack() },
                        // The member list is the other place a profile is opened
                        // from a room, and it should say the same thing about them.
                        onOpenProfile = { nav.navigate(Routes.profile(it, groupId)) },
                        onOpenCall = { nav.navigate(Routes.call(it)) },
                        onOpenSettings = { nav.navigate(Routes.groupSettings(it)) },
                    )
                }

                screen(
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

                screen(
                    Routes.GROUP_SETTINGS,
                    arguments = listOf(navArgument("id") { type = NavType.StringType }),
                ) { entry ->
                    GroupSettingsScreen(
                        conversationId = entry.arguments?.getString("id").orEmpty(),
                        onBack = { nav.popBackStack() },
                        onOpenAudit = { nav.navigate(Routes.audit(entry.arguments?.getString("id").orEmpty())) },
                    )
                }

                screen(
                    Routes.CALL,
                    arguments = listOf(navArgument("id") { type = NavType.StringType }),
                ) { entry ->
                    CallScreen(
                        callId = entry.arguments?.getString("id").orEmpty(),
                        onLeave = { nav.popBackStack() },
                    )
                }
            }

            // What the shell has to say over whatever screen is up. Below the
            // connection strip, never over it: a banner for a message that
            // just arrived is proof the socket is fine. The status-bar padding
            // collapses to zero while the strip is up (the shell consumes the
            // inset then), so the banner tucks in right under the band.
            InAppBanners(
                onOpen = { conversationId -> nav.openChat(container, conversationId) },
                modifier = Modifier.align(Alignment.TopCenter).statusBarsPadding(),
            )

            // Above the navigation bar and the keyboard: a snackbar the keyboard
            // covers is a snackbar nobody saw, and Undo is the point of it.
            NeuSnackbarHost(
                hostState = snackbar,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .imePadding()
                    // After the paddings, so the size is the message's own
                    // and not the navigation bar's.
                    .onSizeChanged { snackbarClearance = with(density) { it.height.toDp() } },
            )
        }
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

/** What the connection strip shows: whether it is up at all, and what it says. */
private data class ConnectionStatus(val visible: Boolean, val label: String)

/**
 * The socket is down, and has been for long enough to say so.
 *
 * Two seconds of grace, because the gateway drops and resumes on every app
 * foreground and on most network hand-offs, and a strip that flickers through
 * each of those teaches people to ignore it. What it says depends on whose
 * problem it is: "No connection" when the device has no network at all,
 * "Reconnecting…" when it does and the socket is what is missing, and plain
 * "Connecting…" only for the first connect of a session. A fatal gateway state
 * shows nothing — that is a sign-out, not a wait.
 *
 * Hoisted into the shell rather than kept inside the strip's own animation,
 * because the shell lays the screens out around the strip: it has to know the
 * band is coming before the band draws.
 */
@Composable
private fun rememberConnectionStatus(): ConnectionStatus {
    val container = LocalContainer.current
    val gatewayState by container.gateway.state.collectAsState()
    val online by container.online.collectAsState()

    val down = gatewayState is GatewayState.Disconnected || gatewayState is GatewayState.Connecting
    var everConnected by remember { mutableStateOf(false) }
    LaunchedEffect(gatewayState) {
        if (gatewayState is GatewayState.Connected) everConnected = true
    }

    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(down) {
        if (!down) {
            visible = false
        } else {
            delay(2_000)
            visible = true
        }
    }

    val label = when {
        !online -> "No connection"
        everConnected -> "Reconnecting…"
        else -> "Connecting…"
    }
    return ConnectionStatus(visible, label)
}

/**
 * The signed-in frame: the connection strip, and the screen it makes room for.
 *
 * A band the layout makes room for, not a pill floating over the screen. The
 * pill had no safe place on Home, whose header holds three buttons on the
 * right — it landed on the mentions button — and any other corner would
 * collide with some other screen's header. So the status became a strip
 * across the top that pushes every screen down by its own height, the way
 * Signal and Slack show theirs: nothing underneath it can be covered, because
 * nothing is underneath it.
 *
 * The strip pads for the status bar itself, so the area under the clock stays
 * the sheet colour, and while it is up the content area consumes the
 * status-bar inset: every screen pads for that bar on its own, and with the
 * strip already sitting under it that padding would be paid twice. Consumed,
 * each screen's `statusBarsPadding()` collapses to zero and the screen shifts
 * down by exactly the band. Never consumed otherwise, so a screen that draws
 * under the status bar still can.
 *
 * That hand-off happens outside the animation on purpose. The strip's padding
 * appears in the same frame the content stops padding, so the two cancel and
 * only the well's own height animates; keeping both tied to the animated
 * visibility made every screen jump by a status bar and slide back. The
 * shell counts the strip as present for the whole of its exit as well, so the
 * hand-off back lands in the one frame the band has fully gone.
 *
 * @param content The content area's own scope, so overlays that belong to the
 *   screen — banners at the top, the snackbar at the foot — align to it.
 */
@Composable
private fun ConnectionShell(content: @Composable BoxScope.() -> Unit) {
    val connection = rememberConnectionStatus()
    val strip = remember { MutableTransitionState(false) }.apply { targetState = connection.visible }
    val occupied = strip.currentState || strip.targetState

    Column(Modifier.fillMaxSize()) {
        Column(
            Modifier
                .fillMaxWidth()
                .then(if (occupied) Modifier.statusBarsPadding() else Modifier),
        ) {
            AnimatedVisibility(
                visibleState = strip,
                enter = expandVertically() + fadeIn(),
                exit = shrinkVertically() + fadeOut(),
            ) {
                ConnectionStrip(label = connection.label)
            }
        }

        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                .then(if (occupied) Modifier.consumeWindowInsets(WindowInsets.statusBars) else Modifier),
            content = content,
        )
    }
}

/**
 * The band itself. Pressed, not raised: a well in the sheet, the same register
 * as the empty-state dish — something the app is waiting on, not offering.
 * Edge to edge and square, so it reads as part of the frame rather than as a
 * control somebody could tap.
 */
@Composable
private fun ConnectionStrip(label: String, modifier: Modifier = Modifier) {
    val colors = neuColors
    NeuSurface(
        modifier = modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Polite },
        shape = RectangleShape,
        state = NeuState.Pressed,
        elevation = 4.dp,
        contentPadding = 0.dp,
    ) {
        Row(
            Modifier.fillMaxWidth().height(28.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Rounded.CloudOff,
                contentDescription = null,
                tint = colors.textTertiary,
                modifier = Modifier.size(13.dp),
            )
            Spacer(Modifier.width(6.dp))
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                color = colors.textSecondary,
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
        // Read once per collection, not once per message — currentUserId()
        // is a DataStore read, and this was paying a preference-file round
        // trip for every message.create the account received anywhere.
        val myId = container.session.currentUserId()
        container.gateway.events.collect { event ->
            if (event.type != "message.create") return@collect
            val data = runCatching { event.data.jsonObject }.getOrNull() ?: return@collect
            fun str(key: String) = data[key]?.jsonPrimitive?.contentOrNull()

            val conversationId = str("conversationId") ?: return@collect
            val messageId = str("id") ?: return@collect
            val senderId = str("senderId") ?: return@collect

            if (senderId == myId) return@collect
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
            InAppBannerView(
                banner = current,
                onDismiss = { banner = null },
                onTap = {
                    banner = null
                    onOpen(current.conversationId)
                },
            )
        }
    }
}

