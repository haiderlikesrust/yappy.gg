package gg.yappy.app.ui.community

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.*
import gg.yappy.app.ui.components.AppHeader
import gg.yappy.app.ui.components.QuietIconButton
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Calendar
import java.util.UUID

private fun localTime(value: String): String = runCatching { DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT).withZone(ZoneId.systemDefault()).format(Instant.parse(value)) }.getOrDefault(value)

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun CommunityScreen(conversationId: String? = null, onBack: () -> Unit, onOpenMessage: (String, Long?) -> Unit, onOpenGroup: (String) -> Unit = {}) {
    val api = LocalContainer.current.repo.community
    val colors = neuColors
    val scope = rememberCoroutineScope()
    var tab by rememberSaveable(conversationId) { mutableStateOf(if (conversationId == null) "Catch up" else "Welcome") }
    var version by remember { mutableIntStateOf(0) }
    var loading by remember { mutableStateOf(true) }; var error by remember { mutableStateOf<String?>(null) }; var busy by remember { mutableStateOf(false) }
    var catchUp by remember { mutableStateOf(CatchUpEnvelope()) }; var events by remember { mutableStateOf(emptyList<CommunityEvent>()) }
    var reminders by remember { mutableStateOf(emptyList<CommunityReminder>()) }; var scheduled by remember { mutableStateOf(emptyList<CommunityScheduled>()) }
    var saved by remember { mutableStateOf(emptyList<CollectionItem>()) }; var collections by remember { mutableStateOf(emptyList<SavedCollection>()) }
    var welcome by remember { mutableStateOf<CommunityWelcome?>(null) }
    var query by rememberSaveable { mutableStateOf("") }; var collection by rememberSaveable { mutableStateOf<String?>(null) }
    var editEvent by remember { mutableStateOf<CommunityEvent?>(null) }; var newEvent by remember { mutableStateOf(false) }
    var editSaved by remember { mutableStateOf<CollectionItem?>(null) }; var editWelcome by remember { mutableStateOf(false) }
    var rename by remember { mutableStateOf<SavedCollection?>(null) }; var confirmCancel by remember { mutableStateOf<CommunityEvent?>(null) }
    fun change(action: suspend () -> Unit) { if (busy) return; busy = true; scope.launch { try { action(); version++ } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } finally { busy = false } } }
    LaunchedEffect(tab, version, query, collection, conversationId) {
        loading = true; error = null
        try {
            if (query.isNotBlank()) delay(250)
            if (conversationId != null) welcome = api.welcome(conversationId)
            when (tab) {
                "Catch up" -> catchUp = api.catchUp()
                "Events" -> events = api.events(conversationId).events
                "Reminders" -> reminders = api.reminders().reminders
                "Scheduled" -> scheduled = api.scheduled().messages
                "Saved" -> { saved = api.saved(query, collection).items; collections = api.collections().collections }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = if (e is ApiException && e.status in 400..499) e.message
                else "We couldn’t load your updates. Please try again."
        } finally {
            loading = false
        }
    }
    Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding()) {
        AppHeader(
            title = if (conversationId == null) "Catch up" else "Events & welcome",
            onBack = onBack,
            actions = { QuietIconButton(Icons.Rounded.Refresh, "Refresh", { version++ }, enabled = !loading) },
        )
        FlowRow(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            (if (conversationId == null) listOf("Catch up", "Events", "Reminders", "Scheduled", "Saved") else listOf("Welcome", "Events")).forEach { label ->
                FilterChip(
                    selected = tab == label,
                    onClick = { tab = label },
                    label = { Text(label) },
                    shape = RoundedCornerShape(20.dp),
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = colors.accentSoft,
                        selectedLabelColor = colors.textPrimary,
                        labelColor = colors.textSecondary,
                    ),
                )
            }
        }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            error?.let { message -> item {
                CommunityCard {
                    Text("Couldn’t load updates", style = MaterialTheme.typography.titleMedium)
                    Text(message, color = colors.textSecondary)
                    TextButton(onClick = { version++ }) { Text("Try again") }
                }
            } }
            if (loading) item {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                Text("Loading updates…", Modifier.padding(top = 12.dp), color = colors.textSecondary)
            }
            if (!loading && error == null) {
            if (tab == "Catch up") {
                item { Text("Waiting for you", style = MaterialTheme.typography.titleLarge) }
                if (!loading && catchUp.items.isEmpty()) item { InfoCard("You’re caught up", "New mentions, replies, pins, and group updates will appear here.") }
                items(catchUp.items, key = { it.id }) { item -> CommunityCard { Text("${item.kind} · ${item.conversationTitle ?: "Direct message"}", style = MaterialTheme.typography.labelMedium); Text(item.title, style = MaterialTheme.typography.titleMedium); Text(item.body); TextButton(onClick = { onOpenMessage(item.conversationId, item.seq) }) { Text("View message") } } }
                item { Text("Unread conversations", style = MaterialTheme.typography.titleLarge) }
                if (catchUp.rooms.isEmpty()) item { InfoCard("All read", "You have no unread conversations.") }
                items(catchUp.rooms, key = { it.conversationId }) { room -> CommunityCard { Text(room.title, style = MaterialTheme.typography.titleMedium); Text("${room.unreadCount} unread"); TextButton(onClick = { onOpenMessage(room.conversationId, null) }) { Text("Open conversation") } } }
            }
            if (tab == "Events") {
                item { Text("Times are shown in your local time zone."); if (welcome?.canManage == true) Button(onClick = { newEvent = true }) { Text("Create event") } }
                if (!loading && events.isEmpty()) item { InfoCard("The calendar’s open", "Group admins can create plans from Events & welcome on the group page.") }
                items(events, key = { it.id }) { event -> CommunityCard {
                    Text(event.conversationTitle, style = MaterialTheme.typography.labelMedium); Text(event.title, style = MaterialTheme.typography.titleLarge); Text(localTime(event.startsAt)); event.endsAt?.let { Text("Until ${localTime(it)}") }
                    if (event.cancelledAt != null) Text("Cancelled") else {
                        if (event.description.isNotBlank()) Text(event.description); if (event.location.isNotBlank()) Text(event.location)
                        Text("${event.going} going · ${event.maybe} maybe")
                        if (runCatching { Instant.parse(event.startsAt).isAfter(Instant.now()) }.getOrDefault(false)) {
                            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) { listOf("going" to "Going", "maybe" to "Maybe", "declined" to "Can’t go").forEach { (value, label) -> FilterChip(selected = event.response == value, enabled = !busy, onClick = { change { api.change("PUT", "/events/${event.id}/rsvp", buildJsonObject { put("response", value); put("remind", event.remind) }) } }, label = { Text(label) }) } }
                            Row { Checkbox(checked = event.remind, enabled = !busy && event.response != null && event.response != "declined", onCheckedChange = { checked -> change { api.change("PUT", "/events/${event.id}/rsvp", buildJsonObject { put("response", event.response); put("remind", checked) }) } }); Text("Remind me 15 minutes before", Modifier.padding(top = 12.dp)) }
                            if (event.canManage || welcome?.canManage == true) Row { TextButton(onClick = { editEvent = event }) { Text("Edit") }; TextButton(onClick = { confirmCancel = event }) { Text("Cancel event") } }
                        }
                    }
                    TextButton(onClick = { onOpenGroup(event.conversationId) }) { Text("Open group") }
                } }
            }
            if (tab == "Reminders") {
                if (!loading && reminders.isEmpty()) item { InfoCard("Nothing on your list", "Hold a message and choose Remind me. You’ll get a notification linking back to it.") }
                items(reminders, key = { it.id }) { reminder -> CommunityCard { Text(localTime(reminder.dueAt), style = MaterialTheme.typography.labelLarge); Text(reminder.title); TextButton(onClick = { onOpenMessage(reminder.conversationId, reminder.seq) }) { Text("Open conversation") }; TextButton(enabled = !busy, onClick = { change { api.change("DELETE", "/reminders/${reminder.id}") } }) { Text("Cancel reminder") } } }
            }
            if (tab == "Scheduled") {
                if (!loading && scheduled.isEmpty()) item { InfoCard("No scheduled messages", "Write a message, then choose Schedule from the attachment menu.") }
                items(scheduled, key = { it.id }) { message -> CommunityCard { Text(message.conversationTitle ?: "Conversation", style = MaterialTheme.typography.titleMedium); Text(localTime(message.sendAt)); Text(message.content); message.failure?.let { Text("Not sent: $it", color = MaterialTheme.colorScheme.error) }; TextButton(enabled = !busy, onClick = { change { api.change("DELETE", "/scheduled/${message.id}") } }) { Text(if (message.failedAt == null) "Cancel scheduled message" else "Dismiss") } } }
            }
            if (tab == "Saved") {
                item { OutlinedTextField(value = query, onValueChange = { query = it }, label = { Text("Search messages and notes") }, modifier = Modifier.fillMaxWidth()) }
                item { Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) { FilterChip(selected = collection == null, onClick = { collection = null }, label = { Text("All saved") }); collections.forEach { c -> FilterChip(selected = collection == c.id, onClick = { collection = c.id }, label = { Text("${c.name} · ${c.count}") }) } } }
                collections.find { it.id == collection }?.let { folder -> item { TextButton(onClick = { rename = folder }) { Text("Manage collection") } } }
                if (!loading && saved.isEmpty()) item { InfoCard("Keep the good stuff here", "Hold a message to save it. Organize your finds with collections and private notes.") }
                items(saved, key = { it.messageId }) { item -> CommunityCard { Text("${item.sender} · ${item.conversationTitle ?: "Direct message"}", style = MaterialTheme.typography.labelMedium); Text(item.content); if (item.note.isNotBlank()) Text("Note: ${item.note}"); TextButton(onClick = { onOpenMessage(item.conversationId, item.seq) }) { Text("View message") }; TextButton(onClick = { editSaved = item }) { Text("Collection & note") }; TextButton(enabled = !busy, onClick = { change { api.unsave(item.conversationId, item.messageId) } }) { Text("Remove") } } }
            }
            if (tab == "Welcome") welcome?.let { page -> item { CommunityCard {
                Text("Welcome to the group", style = MaterialTheme.typography.titleLarge); Text(page.profile.welcome.ifBlank { "Make yourself at home." }); if (page.profile.rules.isNotBlank()) { Text("Group rules", style = MaterialTheme.typography.titleMedium); Text(page.profile.rules) }
                page.profile.startChannelId?.let { channel -> Button(onClick = { onOpenMessage(channel, null) }) { Text("Start here") } }
                if (!page.seen) TextButton(enabled = !busy, onClick = { change { api.change("POST", "/groups/$conversationId/welcome/read") } }) { Text("Got it") }
                if (page.canManage) Button(onClick = { editWelcome = true }) { Text("Edit welcome & interests") }
            } } }
            }
        }
    }
    if (newEvent || editEvent != null) EventDialog(conversationId ?: editEvent!!.conversationId, editEvent, onClose = { newEvent = false; editEvent = null }, onDone = { version++ })
    editSaved?.let { item -> SavedDialog(item, collections, onClose = { editSaved = null }, onDone = { version++ }) }
    if (editWelcome && welcome != null && conversationId != null) WelcomeEditor(conversationId, welcome!!, onClose = { editWelcome = false }, onDone = { version++ })
    rename?.let { folder -> CollectionDialog(folder, onClose = { rename = null }, onDone = { collection = null; version++ }) }
    confirmCancel?.let { event -> AlertDialog(onDismissRequest = { confirmCancel = null }, title = { Text("Cancel ${event.title}?") }, text = { Text("It will be marked cancelled for everyone, and its pending reminders will stop.") }, confirmButton = { TextButton(onClick = { confirmCancel = null; change { api.change("DELETE", "/events/${event.id}") } }) { Text("Cancel event") } }, dismissButton = { TextButton(onClick = { confirmCancel = null }) { Text("Keep event") } }) }
}

@Composable private fun CommunityCard(content: @Composable ColumnScope.() -> Unit) {
    Card(
        Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = neuColors.surfaceRaised, contentColor = neuColors.textPrimary),
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}
@Composable private fun InfoCard(title: String, body: String) { CommunityCard { Text(title, style = MaterialTheme.typography.titleMedium); Text(body) } }

@Composable fun CommunityTimeField(label: String, value: String, onChange: (String) -> Unit) {
    val context = LocalContext.current
    OutlinedButton(onClick = {
        val calendar = Calendar.getInstance().apply { timeInMillis = runCatching { Instant.parse(value).toEpochMilli() }.getOrDefault(System.currentTimeMillis() + 3600000) }
        DatePickerDialog(context, { _, y, m, d ->
            calendar.set(y, m, d)
            TimePickerDialog(context, { _, h, min -> calendar.set(Calendar.HOUR_OF_DAY, h); calendar.set(Calendar.MINUTE, min); calendar.set(Calendar.SECOND, 0); calendar.set(Calendar.MILLISECOND, 0); onChange(calendar.toInstant().toString()) }, calendar.get(Calendar.HOUR_OF_DAY), calendar.get(Calendar.MINUTE), android.text.format.DateFormat.is24HourFormat(context)).show()
        }, calendar.get(Calendar.YEAR), calendar.get(Calendar.MONTH), calendar.get(Calendar.DAY_OF_MONTH)).show()
    }, modifier = Modifier.fillMaxWidth()) { Text("$label: ${localTime(value)}") }
}

@Composable private fun EditDialog(title: String, onClose: () -> Unit, onSave: suspend () -> Unit, content: @Composable ColumnScope.() -> Unit) {
    val scope = rememberCoroutineScope(); var busy by remember { mutableStateOf(false) }; var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(onDismissRequest = { if (!busy) onClose() }, title = { Text(title) }, text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) { content(); error?.let { Text(it, color = MaterialTheme.colorScheme.error) } } }, confirmButton = { TextButton(enabled = !busy, onClick = { busy = true; scope.launch { try { onSave(); onClose() } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } finally { busy = false } } }) { Text(if (busy) "Saving…" else "Save") } }, dismissButton = { TextButton(enabled = !busy, onClick = onClose) { Text("Cancel") } })
}

@Composable fun ReminderDialog(messageId: String? = null, conversationId: String? = null, content: String? = null, onClose: () -> Unit, onDone: () -> Unit = {}) {
    val api = LocalContainer.current.repo.community; val id = remember { UUID.randomUUID().toString() }; var time by rememberSaveable { mutableStateOf(Instant.now().plusSeconds(3600).toString()) }
    EditDialog(if (messageId != null) "Remind me" else "Schedule message", onClose, onSave = { api.change("POST", if (messageId != null) "/reminders" else "/scheduled", buildJsonObject { put("id", id); if (messageId != null) { put("messageId", messageId); put("dueAt", time) } else { put("conversationId", conversationId); put("content", content); put("sendAt", time) } }); onDone() }) {
        Text(if (messageId != null) "Get a notification linking back to this message." else "This text sends even when your devices are offline.")
        content?.let { Text(it.take(300)) }; CommunityTimeField("When", time) { time = it }; Text("Your local time zone. Manage this in Catch up.")
    }
}

@Composable private fun EventDialog(conversationId: String, event: CommunityEvent?, onClose: () -> Unit, onDone: () -> Unit) {
    val api = LocalContainer.current.repo.community; val id = remember { event?.id ?: UUID.randomUUID().toString() }; var title by remember { mutableStateOf(event?.title ?: "") }; var description by remember { mutableStateOf(event?.description ?: "") }; var location by remember { mutableStateOf(event?.location ?: "") }; var starts by remember { mutableStateOf(event?.startsAt ?: Instant.now().plusSeconds(86400).toString()) }; var ends by remember { mutableStateOf(event?.endsAt) }
    EditDialog(if (event == null) "Create event" else "Edit event", onClose, onSave = { require(title.isNotBlank()) { "Give your event a name." }; api.change(if (event == null) "POST" else "PATCH", if (event == null) "/groups/$conversationId/events" else "/events/$id", buildJsonObject { if (event == null) put("id", id); put("title", title); put("description", description); put("location", location); put("startsAt", starts); put("endsAt", ends?.let(::JsonPrimitive) ?: JsonNull) }); onDone() }) {
        OutlinedTextField(title, { title = it.take(120) }, label = { Text("Event name") }); OutlinedTextField(description, { description = it.take(2000) }, label = { Text("About") }); OutlinedTextField(location, { location = it.take(200) }, label = { Text("Where") }); CommunityTimeField("Starts", starts) { starts = it }; Row { Checkbox(ends != null, { ends = if (it) Instant.parse(starts).plusSeconds(3600).toString() else null }); Text("Add an end time", Modifier.padding(top = 12.dp)) }; ends?.let { CommunityTimeField("Ends", it) { ends = it } }; Text("Everyone sees the time in their own time zone.")
    }
}

@Composable fun SavedDialog(item: CollectionItem, collections: List<SavedCollection> = emptyList(), onClose: () -> Unit, onDone: () -> Unit = {}) {
    val api = LocalContainer.current.repo.community; var folders by remember { mutableStateOf(collections) }; var collection by remember { mutableStateOf(item.collectionId) }; var name by remember { mutableStateOf("") }; var note by remember { mutableStateOf(item.note) }; val id = remember { UUID.randomUUID().toString() }
    var ready by remember { mutableStateOf(false) }; var loadError by remember { mutableStateOf<String?>(null) }; var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(reload) { try { folders = api.collections().collections; val existing = api.savedDetails(item.messageId); collection = existing.collectionId; note = existing.note; ready = true; loadError = null } catch (e: CancellationException) { throw e } catch (e: Exception) { loadError = e.message } }
    EditDialog("Collection & note", onClose, onSave = { check(ready) { "Wait for your saved note to load, or tap Retry." }; var target = collection; if (name.isNotBlank()) { api.change("POST", "/collections", buildJsonObject { put("id", id); put("name", name) }); target = id }; api.change("PUT", "/saved/${item.messageId}", buildJsonObject { put("collectionId", target?.let(::JsonPrimitive) ?: JsonNull); put("note", note) }); onDone() }) {
        if (!ready) { Text(loadError ?: "Loading your saved note…"); if (loadError != null) TextButton(onClick = { reload++ }) { Text("Retry") } }
        if (ready) { SingleChoice("Collection", listOf("" to "All saved") + folders.map { it.id to it.name }, collection ?: "") { collection = it.ifBlank { null } }; OutlinedTextField(name, { name = it.take(40) }, label = { Text("Or create a collection") }); OutlinedTextField(note, { note = it.take(2000) }, label = { Text("Personal note") }); Text("Only you can see these notes.") }
    }
}

@Composable private fun CollectionDialog(folder: SavedCollection, onClose: () -> Unit, onDone: () -> Unit) {
    val api = LocalContainer.current.repo.community; var name by remember { mutableStateOf(folder.name) }; var remove by remember { mutableStateOf(false) }
    EditDialog("Manage collection", onClose, onSave = { if (remove) api.change("DELETE", "/collections/${folder.id}") else api.change("PATCH", "/collections/${folder.id}", buildJsonObject { put("name", name) }); onDone() }) { OutlinedTextField(name, { name = it.take(40) }, label = { Text("Name") }); Row { Checkbox(remove, { remove = it }); Text("Delete collection", Modifier.padding(top = 12.dp)) }; if (remove) Text("Your saved messages and notes will stay in All saved.") }
}

@Composable private fun WelcomeEditor(conversationId: String, page: CommunityWelcome, onClose: () -> Unit, onDone: () -> Unit) {
    val api = LocalContainer.current.repo.community; var welcome by remember { mutableStateOf(page.profile.welcome) }; var rules by remember { mutableStateOf(page.profile.rules) }; var tags by remember { mutableStateOf(page.profile.tags.joinToString(", ")) }; var language by remember { mutableStateOf(page.profile.language) }; var channel by remember { mutableStateOf(page.profile.startChannelId) }
    EditDialog("Welcome & interests", onClose, onSave = { api.change("PUT", "/groups/$conversationId/welcome", buildJsonObject { put("welcome", welcome); put("rules", rules); putJsonArray("tags") { tags.split(',').map { it.trim() }.filter { it.isNotBlank() }.forEach { add(it) } }; put("language", language); put("startChannelId", channel?.let(::JsonPrimitive) ?: JsonNull) }); onDone() }) { OutlinedTextField(welcome, { welcome = it.take(2000) }, label = { Text("Welcome message") }); OutlinedTextField(rules, { rules = it.take(3000) }, label = { Text("Rules") }); OutlinedTextField(tags, { tags = it }, label = { Text("Interests · up to 5, comma separated") }); SingleChoice("Language", communityLanguages, language) { language = it }; SingleChoice("Starting channel", listOf("" to "No starting channel") + page.channels.map { it.id to (it.title ?: "Channel") }, channel ?: "") { channel = it.ifBlank { null } } }
}

val communityLanguages = listOf("" to "Any language", "en" to "English", "ar" to "Arabic", "ur" to "Urdu", "hi" to "Hindi", "es" to "Spanish", "fr" to "French", "de" to "German", "pt" to "Portuguese")
@Composable fun WelcomeHint(conversationId: String, onOpen: () -> Unit) {
    val api = LocalContainer.current.repo.community; val scope = rememberCoroutineScope(); var page by remember(conversationId) { mutableStateOf<CommunityWelcome?>(null) }; var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(conversationId) { try { page = api.welcome(conversationId) } catch (e: CancellationException) { throw e } catch (_: Exception) { } }
    page?.takeIf { !it.seen && (it.profile.welcome.isNotBlank() || it.profile.rules.isNotBlank()) }?.let {
        Card(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) { Column(Modifier.padding(12.dp)) { Text("Welcome! Here’s a good place to start.", style = MaterialTheme.typography.titleSmall); Row { TextButton(onClick = onOpen) { Text("Read welcome & rules") }; TextButton(onClick = { scope.launch { try { api.change("POST", "/groups/$conversationId/welcome/read"); page = null } catch (e: CancellationException) { throw e } catch (e: Exception) { error = e.message } } }) { Text("Got it") } }; error?.let { Text(it, color = MaterialTheme.colorScheme.error) } } }
    }
}
@Composable fun SingleChoice(label: String, choices: List<Pair<String, String>>, selected: String, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }; Box { OutlinedButton(onClick = { open = true }) { Text("$label: ${choices.find { it.first == selected }?.second ?: selected}") }; DropdownMenu(expanded = open, onDismissRequest = { open = false }) { choices.forEach { (value, text) -> DropdownMenuItem(text = { Text(text) }, onClick = { onPick(value); open = false }) } } }
}
