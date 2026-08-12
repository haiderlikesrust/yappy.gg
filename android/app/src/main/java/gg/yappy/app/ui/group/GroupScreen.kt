package gg.yappy.app.ui.group

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Call
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.Conversation
import gg.yappy.app.data.GroupSummary
import gg.yappy.app.data.KnownPerson
import gg.yappy.app.data.Message
import gg.yappy.app.data.SummaryMember
import gg.yappy.app.data.RoleEntry
import gg.yappy.app.ui.components.Avatar
import gg.yappy.app.ui.components.BadgeMark
import gg.yappy.app.ui.components.flairColor
import gg.yappy.app.ui.components.FlairAvatar
import gg.yappy.app.ui.components.IdentityMarks
import gg.yappy.app.ui.components.badgeLabel
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.SectionLabel
import gg.yappy.app.ui.media.MediaViewer
import gg.yappy.app.ui.media.ViewerItem
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch

/**
 * The group profile — the screen behind the group-first bet.
 *
 * A group is a *place*, and a place answers three questions the moment you walk
 * in: who is here right now, what is happening (a call you can drop into), and
 * what have we collected together (pins, the media wall). The timeline answers
 * "what was said"; this screen answers everything else.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun GroupScreen(
    conversationId: String,
    onBack: () -> Unit,
    onOpenProfile: (String) -> Unit,
    onOpenCall: (String) -> Unit,
    onOpenSettings: (String) -> Unit,
) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    // Seeded from the last visit so re-entering the group paints whole, not in
    // five pops as each fetch lands. See ScreenSnapshots on the container.
    var conversation by remember {
        mutableStateOf(container.screenSnapshots.get<Conversation>("group_$conversationId"))
    }
    var summary by remember {
        mutableStateOf(container.screenSnapshots.get<GroupSummary>("group_summary_$conversationId"))
    }
    var pinned by remember {
        mutableStateOf(
            container.screenSnapshots.get<List<Message>>("group_pins_$conversationId") ?: emptyList()
        )
    }
    var wall by remember {
        mutableStateOf(
            container.screenSnapshots.get<List<Message>>("group_wall_$conversationId") ?: emptyList()
        )
    }
    /** People you already know in here — mutuals, then follows, then contacts. */
    var known by remember {
        mutableStateOf(
            container.screenSnapshots.get<List<KnownPerson>>("group_known_$conversationId") ?: emptyList()
        )
    }
    var callBusy by remember { mutableStateOf(false) }
    var memberTarget by remember { mutableStateOf<SummaryMember?>(null) }
    var meId by remember { mutableStateOf<String?>(null) }
    var refresh by remember { mutableStateOf(0) }
    /** Every role defined on this group, for the assignment chips. */
    var groupRoles by remember { mutableStateOf<List<RoleEntry>>(emptyList()) }
    /** Wall tile the media viewer should open on, or null when it is closed. */
    var wallViewerAt by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(conversationId, refresh) {
        meId = container.session.currentUserId()
        // Five independent fetches; each section renders as its data lands
        // rather than the whole screen waiting on the slowest query. Every
        // assignment is success-only — the old `getOrNull()`/`getOrElse`
        // pattern wiped an already-drawn section back to blank whenever a
        // refetch failed, which read as the screen blinking.
        launch {
            runCatching { container.repo.conversation(conversationId).conversation }.getOrNull()?.let {
                conversation = it
                container.screenSnapshots.put("group_$conversationId", it)
            }
        }
        launch {
            runCatching { container.repo.summary(conversationId).summary }.getOrNull()?.let {
                summary = it
                container.screenSnapshots.put("group_summary_$conversationId", it)
            }
        }
        launch {
            runCatching { container.repo.pins(conversationId).pins.map { it.message } }.getOrNull()?.let {
                pinned = it
                container.screenSnapshots.put("group_pins_$conversationId", it)
            }
        }
        launch {
            runCatching { container.repo.mediaWall(conversationId, limit = 12).messages }.getOrNull()?.let {
                wall = it
                container.screenSnapshots.put("group_wall_$conversationId", it)
            }
        }
        launch {
            runCatching { container.repo.roles(conversationId).roles }.getOrNull()?.let {
                groupRoles = it
            }
        }
        launch {
            runCatching { container.repo.knownPeople(conversationId).people }.getOrNull()?.let {
                known = it
                container.screenSnapshots.put("group_known_$conversationId", it)
            }
        }
    }

    /**
     * The page stays honest while it is open.
     *
     * This screen's whole argument is "who is around right now", and it went
     * blind the moment it was on screen: someone joined, pinned a photo, or a
     * call started, and the page said what was true when it was opened. Any
     * event for this conversation now refreshes it — debounced, so a burst of
     * messages is one refetch, not a refetch per message — and a slow tick
     * keeps the here-now count moving, since presence events are per-person
     * and do not name a conversation to match on.
     */
    LaunchedEffect(conversationId) {
        launch {
            var pending: kotlinx.coroutines.Job? = null
            container.gateway.events.collect { event ->
                val target = runCatching {
                    event.data.jsonObject["conversationId"]?.jsonPrimitive?.content
                }.getOrNull()
                if (target != conversationId) return@collect
                pending?.cancel()
                pending = launch {
                    kotlinx.coroutines.delay(800)
                    refresh++
                }
            }
        }
        launch {
            while (true) {
                kotlinx.coroutines.delay(30_000)
                refresh++
            }
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .verticalScroll(rememberScrollState()),
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp)) {
            NeuIconButton(Icons.AutoMirrored.Rounded.ArrowBack, "Back", onBack, size = 42.dp, iconSize = 19.dp)
            Spacer(Modifier.weight(1f))
            // Visible to everyone; the server rejects edits from members who
            // lack MANAGE_CONVERSATION, so gating the button adds nothing.
            NeuIconButton(
                Icons.Rounded.Tune,
                "Group settings",
                onClick = { onOpenSettings(conversationId) },
                size = 42.dp,
                iconSize = 19.dp,
            )
        }

        val conv = conversation
        if (conv == null) {
            Box(Modifier.fillMaxWidth().height(280.dp), Alignment.Center) {
                CircularProgressIndicator(color = colors.accent)
            }
            return@Column
        }

        // ── Header ───────────────────────────────────────────────────────────
        Column(
            Modifier.fillMaxWidth().padding(horizontal = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            FlairAvatar(
                conv.appearance, conv.displayAvatar, conv.displayName, conv.avatarSeed,
                size = 96.dp, shape = gg.yappy.app.ui.theme.PlaceShape,
            )
            Spacer(Modifier.height(14.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(conv.displayName, style = MaterialTheme.typography.headlineMedium, color = colors.textPrimary)
                if (conv.badge != null) {
                    Spacer(Modifier.width(8.dp))
                    BadgeMark(conv.badge, size = 20.dp)
                }
                conv.appearance?.emoji?.let {
                    Spacer(Modifier.width(8.dp))
                    Text(it, style = MaterialTheme.typography.headlineSmall)
                }
            }

            // Spelled out rather than left as a glyph to decode. A mark whose
            // meaning is guessed at is a mark that can be misread.
            badgeLabel(conv.badge)?.let {
                Spacer(Modifier.height(4.dp))
                Text(it, style = MaterialTheme.typography.labelLarge, color = colors.accent)
            }

            val here = summary?.onlineCount ?: 0
            Spacer(Modifier.height(4.dp))
            Text(
                buildString {
                    append("${conv.memberCount} members")
                    if (here > 0) append(" · $here here now")
                },
                style = MaterialTheme.typography.bodyMedium,
                // "Here now" is the pulse of the place — it earns the accent.
                color = if (here > 0) colors.accent else colors.textTertiary,
            )

            /**
             * "You know four people here."
             *
             * The single most useful thing to know about an unfamiliar group,
             * and it has been derivable from the follow graph all along. Sits
             * directly under the member count because that is the number it
             * reframes: 300 strangers and 4 friends is a different room.
             */
            if (known.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Row(horizontalArrangement = Arrangement.spacedBy((-7).dp)) {
                        known.take(4).forEach { person ->
                            Avatar(
                                url = person.avatarUrl,
                                name = person.label,
                                id = person.id,
                                size = 24.dp,
                            )
                        }
                    }
                    Spacer(Modifier.width(10.dp))
                    Text(
                        when (known.size) {
                            1 -> "You know ${known[0].label}"
                            2 -> "You know ${known[0].label} and ${known[1].label}"
                            else -> "You know ${known.size} people here"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textSecondary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            conv.description?.takeIf { it.isNotBlank() }?.let {
                Spacer(Modifier.height(10.dp))
                Text(
                    it,
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                )
            }
        }

        Spacer(Modifier.height(18.dp))

        // ── Voice: join what's live, or open the room ────────────────────────
        // Not for a space: a call ends by writing a summary card, and a space
        // has no timeline. Voice happens in a channel.
        val activeCall = summary?.activeCall
        if (!conv.isSpace) NeuButton(
            onClick = {
                if (callBusy) return@NeuButton
                callBusy = true
                scope.launch {
                    runCatching {
                        if (activeCall != null) activeCall.id
                        else container.repo.startCall(conversationId, video = false).call.id
                    }.onSuccess(onOpenCall)
                    callBusy = false
                }
            },
            accent = activeCall != null,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp),
        ) {
            Icon(
                Icons.Rounded.Call,
                null,
                tint = if (activeCall != null) colors.onAccent else colors.textSecondary,
                modifier = Modifier.size(18.dp),
            )
            Spacer(Modifier.width(10.dp))
            Text(
                when {
                    activeCall != null && activeCall.participantCount > 0 ->
                        "Join the call · ${activeCall.participantCount} in"
                    activeCall != null -> "Join the call"
                    else -> "Start a voice hangout"
                },
                style = MaterialTheme.typography.labelLarge,
                color = if (activeCall != null) colors.onAccent else colors.textSecondary,
            )
        }

        // ── Here now ─────────────────────────────────────────────────────────
        val hereMembers = summary?.members.orEmpty().filter { it.isHere }
        if (hereMembers.isNotEmpty()) {
            Spacer(Modifier.height(20.dp))
            SectionLabel("Here now", Modifier.padding(start = 24.dp))
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                hereMembers.take(8).forEach { m ->
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.softClickable { onOpenProfile(m.user.id) },
                    ) {
                        Avatar(m.user.avatarUrl, m.user.label, m.user.id, size = 48.dp, presence = m.presence)
                        Spacer(Modifier.height(4.dp))
                        Text(
                            m.user.displayName?.substringBefore(' ') ?: m.user.label,
                            style = MaterialTheme.typography.labelSmall,
                            color = colors.textSecondary,
                            maxLines = 1,
                        )
                    }
                }
            }
        }

        // ── Pinned canon ─────────────────────────────────────────────────────
        if (pinned.isNotEmpty()) {
            Spacer(Modifier.height(22.dp))
            SectionLabel("Pinned · ${pinned.size}", Modifier.padding(start = 24.dp))
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                pinned.take(3).forEach { message ->
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(Neu.CornerSmall))
                            .background(colors.incoming)
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Rounded.PushPin, null, tint = colors.accent, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(10.dp))
                        Column {
                            message.sender?.let {
                                Text(
                                    it.label,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = colors.textTertiary,
                                )
                            }
                            Text(
                                message.content ?: message.gif?.title ?: "Attachment",
                                style = MaterialTheme.typography.bodyMedium,
                                color = colors.textPrimary,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }

        // ── The media wall ───────────────────────────────────────────────────
        if (wall.isNotEmpty()) {
            Spacer(Modifier.height(22.dp))
            SectionLabel(
                "Shared media${summary?.counts?.media?.let { " · $it" } ?: ""}",
                Modifier.padding(start = 24.dp),
            )
            // Chunked rows rather than a lazy grid: the screen scrolls as one
            // column, and twelve thumbnails do not need lazy composition.
            Column(
                Modifier.fillMaxWidth().padding(horizontal = 20.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                wall.chunked(3).forEach { rowItems ->
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        rowItems.forEach { message ->
                            val url = message.gif?.previewUrl
                                ?: message.attachments.firstOrNull()?.let { it.thumbnailUrl ?: it.url }
                            AsyncImage(
                                model = url,
                                contentDescription = message.gif?.title ?: "Shared media",
                                contentScale = ContentScale.Crop,
                                modifier = Modifier
                                    .weight(1f)
                                    .aspectRatio(1f)
                                    .clip(RoundedCornerShape(10.dp))
                                    .softClickable { wallViewerAt = message.id },
                            )
                        }
                        // Keep a short row's cells square instead of stretching.
                        repeat(3 - rowItems.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
        }

        // ── Members ──────────────────────────────────────────────────────────
        val members = summary?.members.orEmpty()
        if (members.isNotEmpty()) {
            Spacer(Modifier.height(22.dp))
            SectionLabel("Members · ${conv.memberCount}", Modifier.padding(start = 24.dp))
            Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
                members.forEach { member ->
                    MemberRow(member, onClick = { memberTarget = member })
                }
            }
        }

        Spacer(Modifier.height(40.dp))
    }

    // ── The wall, full screen ────────────────────────────────────────────────
    wallViewerAt?.let { anchorId ->
        // GIFs are in the wall too but are not still images; the viewer pages
        // through photos, so they are filtered out rather than shown frozen.
        val items = remember(wall, anchorId) {
            wall.mapNotNull { m ->
                val attachment = m.attachments.firstOrNull { it.mimeType.startsWith("image/") }
                    ?: return@mapNotNull null
                m.id to ViewerItem(
                    url = attachment.url,
                    caption = m.content,
                    senderName = m.sender?.label,
                    filename = attachment.filename,
                )
            }
        }
        if (items.isEmpty()) {
            wallViewerAt = null
        } else {
            MediaViewer(
                items = items.map { it.second },
                initialIndex = items.indexOfFirst { it.first == anchorId }.coerceAtLeast(0),
                onDismiss = { wallViewerAt = null },
            )
        }
    }

    // ── Member sheet: profile + role management ──────────────────────────────

    memberTarget?.let { target ->
        val myRole = summary?.members?.find { it.user.id == meId }?.role ?: "member"
        val amOwner = myRole == "owner"
        val amAdmin = myRole == "admin" || amOwner
        val isSelf = target.user.id == meId
        // Rank is enforced server-side too; the sheet just avoids offering
        // actions that would 403.
        val canManage = amAdmin && !isSelf && target.role != "owner" &&
            (amOwner || target.role == "member")

        val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        androidx.compose.material3.ModalBottomSheet(
            onDismissRequest = { memberTarget = null },
            sheetState = sheetState,
            containerColor = colors.surface,
            contentColor = colors.textPrimary,
        ) {
            Column(Modifier.padding(horizontal = 16.dp).padding(bottom = 28.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 10.dp)) {
                    Avatar(target.user.avatarUrl, target.user.label, target.user.id, size = 44.dp)
                    Spacer(Modifier.width(12.dp))
                    Column {
                        Text(target.user.label, style = MaterialTheme.typography.titleMedium, color = colors.textPrimary)
                        Text(target.role, style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
                    }
                }

                SheetRow("View profile") {
                    memberTarget = null
                    onOpenProfile(target.user.id)
                }

                // ── Roles ────────────────────────────────────────────────────
                // Tap to toggle. Saved immediately as a full set, which is what
                // the endpoint takes — two admins editing at once then land on
                // one intent rather than the union of both.
                if (amAdmin && groupRoles.isNotEmpty()) {
                    Spacer(Modifier.height(6.dp))
                    Text(
                        "ROLES",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                        modifier = Modifier.padding(start = 6.dp, bottom = 6.dp),
                    )
                    var held by remember(target.user.id) {
                        mutableStateOf(target.roles.map { it.id }.toSet())
                    }
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        groupRoles.forEach { role ->
                            val on = role.id in held
                            val tint = flairColor(role.color) ?: colors.accent
                            Box(
                                Modifier
                                    .padding(bottom = 8.dp)
                                    .clip(RoundedCornerShape(Neu.CornerPill))
                                    .background(if (on) tint.copy(alpha = 0.18f) else colors.incoming)
                                    .softClickable {
                                        val next = if (on) held - role.id else held + role.id
                                        held = next
                                        scope.launch {
                                            runCatching {
                                                container.repo.setMemberRoles(
                                                    conversationId, target.user.id, next.toList(),
                                                )
                                            }.onFailure { held = if (on) held + role.id else held - role.id }
                                            refresh++
                                        }
                                    }
                                    .padding(horizontal = 12.dp, vertical = 7.dp),
                            ) {
                                Text(
                                    role.name,
                                    style = MaterialTheme.typography.labelMedium,
                                    color = if (on) tint else colors.textTertiary,
                                )
                            }
                        }
                    }
                }
                if (canManage && amOwner) {
                    if (target.role == "admin") {
                        SheetRow("Remove admin") {
                            scope.launch {
                                runCatching { container.repo.setMemberRole(conversationId, target.user.id, "member") }
                                memberTarget = null; refresh++
                            }
                        }
                    } else {
                        SheetRow("Make admin") {
                            scope.launch {
                                runCatching { container.repo.setMemberRole(conversationId, target.user.id, "admin") }
                                memberTarget = null; refresh++
                            }
                        }
                    }
                }
                // Affiliation lends the group's own credibility to a person, so
                // it is owner/admin only and only offered by a badged group.
                if (amAdmin && !isSelf && conversation?.badge != null) {
                    val on = target.isAffiliate
                    SheetRow(if (on) "Remove as affiliate" else "Mark as affiliate") {
                        scope.launch {
                            runCatching {
                                container.repo.setMemberAffiliate(conversationId, target.user.id, !on)
                            }
                            memberTarget = null; refresh++
                        }
                    }
                }
                if (canManage) {
                    SheetRow("Remove from group", danger = true) {
                        scope.launch {
                            runCatching { container.repo.removeMember(conversationId, target.user.id) }
                            memberTarget = null; refresh++
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SheetRow(label: String, danger: Boolean = false, onClick: () -> Unit) {
    val colors = neuColors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Neu.CornerSmall))
            .softClickable(onClick = onClick)
            .padding(vertical = 13.dp, horizontal = 6.dp),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodyLarge,
            color = if (danger) colors.danger else colors.textPrimary,
        )
    }
}

@Composable
private fun MemberRow(member: SummaryMember, onClick: () -> Unit) {
    val colors = neuColors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Neu.CornerSmall))
            .softClickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(member.user.avatarUrl, member.user.label, member.user.id, size = 42.dp, presence = member.presence)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    member.nickname ?: member.user.label,
                    style = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.Medium),
                    color = flairColor(member.roleColor) ?: colors.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (member.user.badge != null || member.user.affiliation != null) {
                    Spacer(Modifier.width(5.dp))
                    IdentityMarks(member.user, size = 14.dp)
                }
                // Only the top role, and only if it is hoisted: a member list
                // where everyone carries four chips stops being a member list.
                member.roles.firstOrNull { it.isHoisted }?.let { role ->
                    val tint = flairColor(role.color) ?: colors.accent
                    Spacer(Modifier.width(6.dp))
                    Box(
                        Modifier
                            .clip(RoundedCornerShape(Neu.CornerPill))
                            .background(tint.copy(alpha = 0.16f))
                            .padding(horizontal = 7.dp, vertical = 2.dp),
                    ) {
                        Text(role.name, style = MaterialTheme.typography.labelSmall, color = tint)
                    }
                }
            }
            member.user.username?.let {
                Text("@$it", style = MaterialTheme.typography.labelSmall, color = colors.textTertiary)
            }
        }
        if (member.role == "owner" || member.role == "admin") {
            Box(
                Modifier
                    .clip(CircleShape)
                    .background(colors.accentSoft)
                    .padding(horizontal = 9.dp, vertical = 3.dp),
            ) {
                Text(member.role, style = MaterialTheme.typography.labelSmall, color = colors.accent)
            }
        }
    }
}
