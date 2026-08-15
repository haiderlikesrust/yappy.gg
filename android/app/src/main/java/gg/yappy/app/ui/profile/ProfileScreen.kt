package gg.yappy.app.ui.profile

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Message
import android.content.Intent
import androidx.compose.material.icons.rounded.Block
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Flag
import androidx.compose.material.icons.rounded.Groups
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.People
import androidx.compose.material.icons.rounded.PersonAdd
import androidx.compose.material.icons.rounded.Share
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.ui.platform.LocalContext
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.unit.Dp
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import coil.compose.AsyncImage
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.FullUser
import gg.yappy.app.data.Relationship
import gg.yappy.app.ui.components.AffiliateMark
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.colorForId
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.BadgeMarks
import gg.yappy.app.ui.components.heldBadges
import gg.yappy.app.ui.components.BotTag
import gg.yappy.app.ui.components.badgeDescription
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.PresenceDot
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import gg.yappy.app.ui.util.relativeTime
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** Tall enough to be a header, short enough not to push the name off screen. */
private val BANNER_HEIGHT = 132.dp
private val AVATAR_SIZE = 104.dp

@Composable
fun ProfileScreen(userId: String, onBack: () -> Unit, onOpenChat: (String) -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    // Seeded from whatever the app is already holding, so reopening somebody
    // draws them immediately and the fetch below only corrects. Keyed on userId
    // so walking from one profile to another does not leave the previous person
    // on screen while theirs loads.
    var user by remember(userId) { mutableStateOf(container.repo.cachedUser(userId)) }
    var busy by remember { mutableStateOf(false) }
    var blocked by remember { mutableStateOf(false) }

    /**
     * Your own profile is reachable — from Settings, and from your own name in
     * a chat — and it was offering to block and report you.
     */
    var meId by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { meId = container.session.currentUserId() }
    val isSelf = meId != null && meId == userId

    // Held apart from `user` so a press can move it immediately and put it back
    // if the request fails, without rebuilding the whole profile.
    var relationship by remember(userId) { mutableStateOf(container.repo.cachedUser(userId)?.relationship) }
    var followBusy by remember { mutableStateOf(false) }

    LaunchedEffect(userId) {
        val fetched = runCatching { container.repo.user(userId).user }.getOrNull()
        user = fetched
        relationship = fetched?.relationship
    }

    /**
     * React to them following you back while you are stood on their profile.
     *
     * `relationship.update` is delivered to the person on the receiving end of
     * the follow, so this fires when *they* act, never when you do — your own
     * presses are settled by the response to the request.
     *
     * Refetched rather than patched from the payload: the event carries the
     * follow edge but not `canAddToGroups`, which also depends on their privacy
     * setting, and patching would leave the caption contradicting the button.
     */
    LaunchedEffect(userId) {
        container.gateway.events.collect { event ->
            if (event.type != "relationship.update") return@collect
            val obj = runCatching { event.data.jsonObject }.getOrNull() ?: return@collect
            if (obj["userId"]?.jsonPrimitive?.content != userId) return@collect

            runCatching { container.repo.user(userId).user.relationship }
                .getOrNull()
                ?.let { relationship = it }
        }
    }

    val context = LocalContext.current
    var menuOpen by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .verticalScroll(rememberScrollState()),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            NeuIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack, size = 42.dp, iconSize = 19.dp)
            Spacer(Modifier.weight(1f))
            Box {
                NeuIconButton(Icons.Rounded.MoreVert, "More", { menuOpen = true }, size = 42.dp, iconSize = 19.dp)
                DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                    DropdownMenuItem(
                        text = { Text("Share profile") },
                        leadingIcon = { Icon(Icons.Rounded.Share, null) },
                        onClick = {
                            menuOpen = false
                            val u = user ?: return@DropdownMenuItem
                            val text = buildString {
                                u.username?.let { append("@$it ") }
                                append("on yappy — yappy://user/${u.id}")
                            }
                            val send = Intent(Intent.ACTION_SEND).apply {
                                type = "text/plain"
                                putExtra(Intent.EXTRA_TEXT, text)
                            }
                            context.startActivity(Intent.createChooser(send, "Share profile"))
                        },
                    )
                    if (!isSelf) {
                        DropdownMenuItem(
                            text = { Text(if (blocked) "Unblock" else "Block") },
                            leadingIcon = { Icon(Icons.Rounded.Block, null) },
                            onClick = {
                                menuOpen = false
                                val u = user ?: return@DropdownMenuItem
                                scope.launch {
                                    runCatching {
                                        if (blocked) container.repo.unblock(u.id) else container.repo.block(u.id)
                                    }.onSuccess { blocked = !blocked }
                                }
                            },
                        )
                        DropdownMenuItem(
                            text = { Text("Report") },
                            leadingIcon = { Icon(Icons.Rounded.Flag, null) },
                            onClick = {
                                menuOpen = false
                                val u = user ?: return@DropdownMenuItem
                                scope.launch {
                                    runCatching { container.repo.report("user", u.id, "spam", null) }
                                }
                            },
                        )
                    }
                }
            }
        }

        if (user == null) {
            // A spinner in the middle of an empty page, replaced a moment later
            // by a full profile, is the flash. Nothing about the request got
            // faster — what changed is that the page is already the right shape
            // before the answer arrives, so nothing jumps when it does. The
            // invite page does the same thing for the same reason.
            ProfileSkeleton()
            return@Column
        }

        val u = user!!

        /**
         * The banner, and a place for the avatar to sit on.
         *
         * `bannerUrl` has been on the profile payload since the beginning and
         * neither client drew it, so a profile was an avatar floating in empty
         * space with no top to the page. A banner gives the screen a header
         * rather than a gap.
         *
         * Without one it is not blank: the fallback is the person's own
         * deterministic colour, faded into the page, which is the same idea
         * Discord uses and the reason a profile with no banner still looks
         * designed rather than unfinished. Every profile has a top edge; only
         * some of them have a picture.
         */
        Box(Modifier.fillMaxWidth()) {
            val tint = colorForId(u.id)
            // Chosen flair beats the derived colour; both fade into the page
            // the same way, so a flaired profile and a plain one share a shape.
            val flairStops = u.flair?.gradient
                ?.mapNotNull { hex -> runCatching { Color(android.graphics.Color.parseColor(hex)) }.getOrNull() }
                ?.takeIf { it.size >= 2 }
            Box(
                Modifier
                    .fillMaxWidth()
                    .height(BANNER_HEIGHT)
                    /**
                     * Rounded across the top, square across the bottom.
                     *
                     * The banner does not touch the top of the screen — the
                     * back button sits above it — so a hard corner up there
                     * read as an unfinished block in an app where nothing else
                     * has one. The bottom is left square on purpose: the fade
                     * below already dissolves that edge, and a radius under a
                     * gradient is a radius nobody can see.
                     *
                     * Full width rather than an inset card. A card with margins
                     * would read as *a card that happens to be at the top*; this
                     * should read as the top of the page.
                     */
                    .clip(RoundedCornerShape(topStart = Neu.CornerLarge, topEnd = Neu.CornerLarge))
                    .background(
                        Brush.verticalGradient(
                            listOf(
                                (flairStops?.get(0) ?: tint).copy(alpha = 0.85f),
                                (flairStops?.get(1) ?: tint).copy(alpha = 0.25f),
                            ),
                        ),
                    ),
            ) {
                u.bannerUrl?.let { url ->
                    AsyncImage(
                        model = url,
                        contentDescription = null,
                        contentScale = ContentScale.Crop,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
                // Into the page rather than stopping at a hard line — the edge
                // is what makes a coloured block read as a banner instead of a
                // rectangle somebody forgot to fill.
                Box(
                    Modifier
                        .fillMaxSize()
                        // Colour stops rather than pixel offsets: the fade has
                        // to start at the same fraction of the banner whatever
                        // height it ends up being.
                        .background(
                            Brush.verticalGradient(
                                0.45f to Color.Transparent,
                                1f to colors.surface,
                            ),
                        ),
                )
            }
        }

        Column(
            Modifier
                .fillMaxWidth()
                // Pulls the avatar up so it straddles the banner's lower edge.
                .offset(y = -(AVATAR_SIZE / 2))
                .padding(horizontal = 24.dp)
                .padding(bottom = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            // A ring in the page colour, so the avatar reads as sitting *on*
            // the banner rather than being punched out of it.
            Box(
                Modifier
                    .clip(CircleShape)
                    .background(colors.surface)
                    .padding(4.dp),
            ) {
                Avatar(u.avatarUrl, u.displayName, u.id, size = AVATAR_SIZE)
            }
            Spacer(Modifier.height(12.dp))

            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    u.displayName ?: "Someone",
                    style = MaterialTheme.typography.headlineMedium,
                    color = colors.textPrimary,
                )
                val held = heldBadges(u)
                if (held.isNotEmpty()) {
                    Spacer(Modifier.width(8.dp))
                    BadgeMarks(held, size = 20.dp, max = 4)
                }
                // A bot's own profile is exactly where "is this a person?" gets
                // asked, and it was the one place not answering.
                if (u.isBot) {
                    Spacer(Modifier.width(8.dp))
                    BotTag(size = 20.dp)
                }
            }
            // Pronouns ride the username line: identity facts, one glance.
            listOfNotNull(
                u.username?.let { "@$it" },
                u.pronouns?.takeIf { it.isNotBlank() },
            ).takeIf { it.isNotEmpty() }?.let {
                Text(
                    it.joinToString(" · "),
                    style = MaterialTheme.typography.bodyLarge,
                    color = colors.textTertiary,
                )
            }

            // The profile is the one place with room to say what a mark means,
            // so it does — in words, not a second glyph. One row per badge now
            // that somebody can hold several: a single line naming one of four
            // would be worse than saying nothing.
            heldBadges(u).forEach { badge ->
                badgeDescription(badge)?.let {
                    Spacer(Modifier.height(10.dp))
                    Row(
                        Modifier
                            .clip(RoundedCornerShape(Neu.CornerPill))
                            .background(colors.accentSoft)
                            .padding(horizontal = 12.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        BadgeMark(badge, size = 14.dp)
                        Spacer(Modifier.width(7.dp))
                        Text(it, style = MaterialTheme.typography.labelMedium, color = colors.accent)
                    }
                }
            }

            u.affiliation?.let { af ->
                Spacer(Modifier.height(10.dp))
                Row(
                    Modifier
                        .clip(RoundedCornerShape(Neu.CornerPill))
                        .background(colors.accentSoft.copy(alpha = 0.6f))
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    AffiliateMark(af, size = 18.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Affiliated with ${af.title ?: "a group"}",
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.textSecondary,
                    )
                }
            }

            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                PresenceDot(u.presence.status, size = 10.dp)
                Spacer(Modifier.width(6.dp))
                Text(
                    when {
                        u.presence.status == "online" -> "Online"
                        u.presence.lastSeenAt != null -> "Last seen ${relativeTime(u.presence.lastSeenAt)}"
                        // The backend suppresses both status and last-seen
                        // together when privacy forbids it, so there is nothing
                        // to show rather than a misleading "Offline".
                        else -> ""
                    },
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.textTertiary,
                )
            }

            // Above the bio, because a status is what someone is doing *now* and
            // a bio is who they are. The server withholds it along with the rest
            // of the presence block when privacy forbids it, so a null here is
            // "not for you" rather than "not set" — either way, nothing shows.
            u.presence.customStatus?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(10.dp))
                Box(
                    Modifier
                        .clip(RoundedCornerShape(Neu.CornerPill))
                        .background(colors.veil)
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                ) {
                    Text(
                        it,
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.textSecondary,
                        textAlign = TextAlign.Center,
                    )
                }
            }

            u.bio?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(14.dp))
                Text(
                    it,
                    style = MaterialTheme.typography.bodyLarge,
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                )
            }

            /**
             * The rooms you share — the social proof a group-first app has
             * instead of follower counts. Every group named here is one the
             * viewer is in themselves, so nothing is disclosed that their own
             * home screen does not already show.
             */
            u.mutualGroups?.takeIf { it.count > 0 }?.let { mutual ->
                Spacer(Modifier.height(14.dp))
                Row(
                    Modifier
                        .clip(RoundedCornerShape(Neu.CornerPill))
                        .background(colors.veil)
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Rounded.Groups,
                        null,
                        tint = colors.textSecondary,
                        modifier = Modifier.size(15.dp),
                    )
                    Spacer(Modifier.width(7.dp))
                    val names = mutual.preview.mapNotNull { ref ->
                        ref.title?.let { t -> listOfNotNull(t, ref.emoji).joinToString(" ") }
                    }
                    Text(
                        buildString {
                            append(if (mutual.count == 1) "1 group in common" else "${mutual.count} groups in common")
                            if (names.isNotEmpty()) append(" · ${names.joinToString(", ")}")
                        },
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.textSecondary,
                    )
                }
            }

            Spacer(Modifier.height(24.dp))

            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                NeuIconButton(
                    Icons.AutoMirrored.Rounded.Message,
                    "Message",
                    onClick = {
                        busy = true
                        scope.launch {
                            runCatching { container.repo.createDm(u.id).conversation.id }
                                .onSuccess(onOpenChat)
                            busy = false
                        }
                    },
                    accent = true,
                    size = 56.dp,
                    iconSize = 23.dp,
                    enabled = !busy,
                )
                NeuIconButton(Icons.Rounded.Call, "Call", onClick = {}, size = 56.dp, iconSize = 23.dp)
            }

            // Bots have no social graph — following one would do nothing, and
            // offering it invites the question of why it did nothing.
            val rel = relationship
            if (!u.isBot && rel != null) {
                Spacer(Modifier.height(20.dp))
                FollowControl(
                    rel = rel,
                    busy = followBusy,
                    onToggle = {
                        if (!followBusy) {
                            val previous = rel
                            followBusy = true
                            // False either way for now: unfollowing definitely
                            // breaks the pair, following only *might* complete
                            // one. The response says which.
                            relationship = rel.copy(following = !rel.following, isMutual = false)

                            scope.launch {
                                val result = runCatching {
                                    if (previous.following) container.repo.unfollow(u.id)
                                    else container.repo.follow(u.id)
                                }.getOrNull()

                                if (result == null) {
                                    relationship = previous
                                } else {
                                    relationship = relationship?.copy(
                                        following = result.following,
                                        isMutual = result.isMutual,
                                    )
                                    // One refetch for canAddToGroups, which
                                    // depends on their privacy setting and so
                                    // cannot be derived from the follow result.
                                    // The button is already right by now; this
                                    // only settles the caption.
                                    runCatching { container.repo.user(u.id).user.relationship }
                                        .getOrNull()
                                        ?.let { relationship = it }
                                }
                                followBusy = false
                            }
                        }
                    },
                )
            }
        }

        // Block and Report live in the top-right overflow now — a standard
        // place, reachable without scrolling past the whole profile.
        Spacer(Modifier.height(40.dp))
    }
}

/**
 * The four states a follow can be in, and what each one is for.
 *
 * Following is not a feed subscription here — there is no feed. It is the only
 * way to become someone's *contact*, and being contacts is what the privacy
 * defaults require before you can add each other to a group or call. So the
 * button says what it does and the caption says what it is worth; "Following"
 * on its own means nothing to anyone who has not read the privacy settings.
 */
@Composable
private fun FollowControl(
    rel: Relationship,
    busy: Boolean,
    onToggle: () -> Unit,
) {
    val colors = neuColors

    val label = when {
        rel.isMutual -> "Contacts"
        rel.following -> "Following"
        // Naming the asymmetry is the nudge: they have already done their half.
        rel.followedBy -> "Follow back"
        else -> "Follow"
    }

    val icon = when {
        rel.isMutual -> Icons.Rounded.People
        rel.following -> Icons.Rounded.Check
        else -> Icons.Rounded.PersonAdd
    }

    // The truthful answer, from the server, rather than "mutual therefore yes" —
    // they may have opened group adds to everyone, or closed them to nobody, and
    // both make the obvious inference wrong.
    val caption = when {
        rel.canAddToGroups && rel.isMutual ->
            "You are contacts. You can add each other to groups and call each other."
        rel.canAddToGroups -> "You can add them to groups."
        rel.following -> "They will need to follow you back before you can add them to a group."
        rel.followedBy -> "They follow you. Follow back to become contacts."
        else -> "Follow each other to become contacts, so you can add them to groups."
    }

    Column(
        Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        NeuButton(
            onClick = onToggle,
            modifier = Modifier.fillMaxWidth(),
            enabled = !busy,
            // Accent only when there is something to gain by pressing. A filled
            // button that undoes a thing reads as the thing.
            accent = !rel.following,
        ) {
            val content = if (rel.following) colors.textPrimary else colors.onAccent
            if (busy) {
                CircularProgressIndicator(
                    Modifier.size(18.dp),
                    color = content,
                    strokeWidth = 2.dp,
                )
            } else {
                Icon(icon, null, tint = content, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(8.dp))
                Text(label, style = MaterialTheme.typography.labelLarge, color = content)
            }
        }

        Spacer(Modifier.height(10.dp))
        Text(
            caption,
            style = MaterialTheme.typography.labelMedium,
            color = if (rel.isMutual) colors.accent else colors.textTertiary,
            textAlign = TextAlign.Center,
        )
    }
}

/**
 * The profile at the right size, before the answer arrives.
 *
 * Mirrors the real layout's measurements — the same BANNER_HEIGHT, the same
 * AVATAR_SIZE straddling its lower edge, the same centred column — so the swap
 * to the loaded page moves nothing. A spinner cannot do that: it is the wrong
 * shape by definition, so every load ends in a jump, and a load short enough
 * that you barely see the spinner is exactly the one that reads as a flash.
 */
@Composable
private fun ProfileSkeleton() {
    val colors = neuColors
    val pulse = rememberInfiniteTransition(label = "profile-skeleton")
    val alpha by pulse.animateFloat(
        initialValue = 0.4f,
        targetValue = 0.85f,
        animationSpec = infiniteRepeatable(tween(850), repeatMode = RepeatMode.Reverse),
        label = "pulse",
    )

    Box(
        Modifier
            .fillMaxWidth()
            .height(BANNER_HEIGHT)
            .clip(RoundedCornerShape(topStart = Neu.CornerLarge, topEnd = Neu.CornerLarge))
            .alpha(alpha)
            .background(colors.surfaceRecessed),
    )

    Column(
        Modifier
            .fillMaxWidth()
            .offset(y = -(AVATAR_SIZE / 2))
            .padding(horizontal = 24.dp)
            .padding(bottom = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier
                .clip(CircleShape)
                .background(colors.surface)
                .padding(4.dp),
        ) {
            Box(
                Modifier
                    .size(AVATAR_SIZE)
                    .alpha(alpha)
                    .clip(CircleShape)
                    .background(colors.surfaceRecessed),
            )
        }
        Spacer(Modifier.height(14.dp))
        SkeletonBar(width = 150.dp, height = 26.dp, alpha = alpha)
        Spacer(Modifier.height(9.dp))
        SkeletonBar(width = 84.dp, height = 15.dp, alpha = alpha)
        Spacer(Modifier.height(24.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            repeat(2) {
                Box(
                    Modifier
                        .size(56.dp)
                        .alpha(alpha)
                        .clip(CircleShape)
                        .background(colors.surfaceRecessed),
                )
            }
        }
        Spacer(Modifier.height(20.dp))
        SkeletonBar(width = null, height = 52.dp, alpha = alpha)
    }
}

/** One grey block. Null width fills the row. */
@Composable
private fun SkeletonBar(width: Dp?, height: Dp, alpha: Float) {
    val colors = neuColors
    Box(
        Modifier
            .then(if (width == null) Modifier.fillMaxWidth() else Modifier.width(width))
            .height(height)
            .alpha(alpha)
            .clip(RoundedCornerShape(Neu.CornerSmall))
            .background(colors.surfaceRecessed),
    )
}
