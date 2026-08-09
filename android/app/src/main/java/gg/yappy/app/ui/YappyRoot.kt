package gg.yappy.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import androidx.navigation.NavType
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.DeepLink
import gg.yappy.app.ui.auth.AuthFlow
import gg.yappy.app.ui.invite.InviteSheet
import gg.yappy.app.ui.call.CallScreen
import gg.yappy.app.ui.chat.ChatScreen
import gg.yappy.app.ui.chat.ThreadScreen
import gg.yappy.app.ui.conversations.ConversationsScreen
import gg.yappy.app.ui.explore.ExploreScreen
import gg.yappy.app.ui.group.GroupScreen
import gg.yappy.app.ui.group.GroupSettingsScreen
import gg.yappy.app.ui.newchat.NewChatScreen
import gg.yappy.app.ui.profile.ProfileScreen
import gg.yappy.app.ui.settings.SettingsScreen
import gg.yappy.app.ui.space.SpaceScreen
import gg.yappy.app.ui.theme.neuColors

object Routes {
    const val CONVERSATIONS = "conversations"
    const val CHAT = "chat/{id}"
    const val NEW_CHAT = "new-chat"
    const val SETTINGS = "settings"
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
    val signedIn by container.signedIn.collectAsState()

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
}

@Composable
private fun SignedInNav() {
    val container = LocalContainer.current
    val nav = rememberNavController()

    // A link tapped anywhere on the device. Only read once we are signed in, so
    // an invite followed while signed out waits at the door rather than being
    // answered with a sign-in screen and then forgotten.
    val pendingLink by container.pendingLink.collectAsState()

    when (val link = pendingLink) {
        is DeepLink.Conversation -> LaunchedEffect(link) {
            container.consumeLink()
            nav.navigate(Routes.chat(link.id))
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

    NavHost(
        navController = nav,
        startDestination = Routes.CONVERSATIONS,
        // Horizontal slide: the stack has a clear left-to-right depth order, and
        // matching it makes back gestures feel like they undo rather than jump.
        enterTransition = { slideInHorizontally(tween(260)) { it / 4 } + fadeIn(tween(200)) },
        exitTransition = { slideOutHorizontally(tween(260)) { -it / 6 } + fadeOut(tween(180)) },
        popEnterTransition = { slideInHorizontally(tween(260)) { -it / 6 } + fadeIn(tween(200)) },
        popExitTransition = { slideOutHorizontally(tween(260)) { it / 4 } + fadeOut(tween(180)) },
    ) {
        composable(Routes.CONVERSATIONS) {
            ConversationsScreen(
                // A space has no timeline of its own, so tapping it opens its
                // channel list rather than a chat with nothing in it.
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
            SettingsScreen(onBack = { nav.popBackStack() })
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
}
