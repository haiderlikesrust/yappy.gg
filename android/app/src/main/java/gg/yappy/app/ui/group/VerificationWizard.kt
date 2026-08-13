package gg.yappy.app.ui.group

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.unit.dp
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.material3.Icon
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.ApiException
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.neu
import gg.yappy.app.ui.theme.neuColors
import kotlinx.coroutines.launch

/**
 * Asking for the badge, one question at a time.
 *
 * The X-signup shape on purpose: a single large question, one field, Next —
 * each answer earns the next screen, sliding in from the right. Three fields
 * on one form would be *faster*, and that is exactly what it should not be:
 * a verification request read by a human deserves a moment's thought per
 * answer, and the pacing is the prompt.
 *
 * Steps: what the group is (required) → where else it lives (optional) → why
 * verified (optional) → review → sent. Back walks the same path in reverse,
 * including the system back gesture.
 */
@Composable
fun VerificationWizard(
    conversationId: String,
    groupName: String,
    onDismiss: () -> Unit,
) {
    val container = LocalContainer.current
    val colors = neuColors
    val scope = rememberCoroutineScope()

    var step by remember { mutableStateOf(0) }
    // Which way the next screen enters: forward slides in from the right,
    // back from the left — the animation says which way you moved.
    var forward by remember { mutableStateOf(true) }

    var purpose by remember { mutableStateOf("") }
    var link by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val steps = 4 // question, question, question, review — "sent" is its own state
    var sent by remember { mutableStateOf(false) }

    fun goBack() {
        if (sent) { onDismiss(); return }
        if (step == 0) onDismiss() else { forward = false; step-- }
    }

    // Not a Dialog, deliberately. targetSdk 35 enforces edge-to-edge on every
    // window, and a Compose dialog does not deliver the system-bar insets back
    // into its own composition — navigationBarsPadding() read zero and the
    // Next button rendered under the gesture pill. As a plain overlay in the
    // activity's composition the insets are the same ones every other screen
    // already handles correctly.
    run {
        BackHandler { goBack() }

        Column(
            Modifier
                .fillMaxSize()
                .background(colors.surface)
                // An overlay is opaque to the eye and transparent to the
                // finger unless told otherwise — without this, a tap on empty
                // space lands on whatever settings row is underneath.
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                ) {}
                .statusBarsPadding()
                .navigationBarsPadding()
                .imePadding(),
        ) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                NeuIconButton(
                    Icons.AutoMirrored.Rounded.ArrowBack,
                    "Back",
                    { goBack() },
                    size = 42.dp,
                    iconSize = 19.dp,
                )
                Spacer(Modifier.weight(1f))
                // Progress dots: where you are, out of how much. Hidden on the
                // sent screen — there is nothing left to progress through.
                if (!sent) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        repeat(steps) { i ->
                            val active = i == step
                            Box(
                                Modifier
                                    .size(if (active) 8.dp else 6.dp)
                                    .clip(CircleShape)
                                    .background(if (active) colors.accent else colors.surfaceRecessed),
                            )
                        }
                    }
                }
                Spacer(Modifier.weight(1f))
                Spacer(Modifier.width(42.dp))
            }

            if (sent) {
                SentScreen(groupName, onDone = onDismiss)
                return@Column
            }

            AnimatedContent(
                targetState = step,
                transitionSpec = {
                    val enter = slideInHorizontally(spring(stiffness = 380f)) {
                        if (forward) it else -it
                    } + fadeIn()
                    val exit = slideOutHorizontally(spring(stiffness = 380f)) {
                        if (forward) -it else it
                    } + fadeOut()
                    enter.togetherWith(exit)
                },
                label = "wizard",
                modifier = Modifier.weight(1f),
            ) { current ->
                Column(Modifier.fillMaxSize().padding(horizontal = 24.dp)) {
                    Spacer(Modifier.height(26.dp))
                    when (current) {
                        0 -> Question(
                            title = "What is $groupName about?",
                            hint = "A couple of sentences. This is what staff read first.",
                            value = purpose,
                            onValue = { purpose = it },
                            placeholder = "We're the group for…",
                            minLines = 3,
                        )

                        1 -> Question(
                            title = "Where else does it live?",
                            hint = "A link that shows the group is real — a site, a Discord, an Instagram. Optional.",
                            value = link,
                            onValue = { link = it },
                            placeholder = "https://…",
                            minLines = 1,
                        )

                        2 -> Question(
                            title = "Why should it be verified?",
                            hint = "Your pitch, if you have one. Optional.",
                            value = note,
                            onValue = { note = it },
                            placeholder = "Because…",
                            minLines = 3,
                        )

                        3 -> Review(
                            groupName = groupName,
                            purpose = purpose,
                            link = link,
                            note = note,
                            error = error,
                        )
                    }
                }
            }

            // One primary action, pinned under the keyboard's reach. The label
            // is the state machine: Next, Next, Next, Send.
            val purposeOk = purpose.trim().length >= 12
            val linkOk = link.isBlank() || link.trim().startsWith("http")
            val canAdvance = when (step) {
                0 -> purposeOk
                1 -> linkOk
                else -> true
            }
            NeuButton(
                onClick = {
                    error = null
                    when {
                        step < 3 -> { forward = true; step++ }
                        !sending -> {
                            sending = true
                            scope.launch {
                                try {
                                    container.repo.requestVerification(
                                        conversationId,
                                        purpose.trim(),
                                        link.trim().ifBlank { null },
                                        note.trim().ifBlank { null },
                                    )
                                    sent = true
                                } catch (e: ApiException) {
                                    error = e.message
                                }
                                sending = false
                            }
                        }
                    }
                },
                accent = true,
                enabled = canAdvance && !sending,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 18.dp),
            ) {
                Text(
                    when {
                        sending -> "Sending…"
                        step < 3 -> "Next"
                        else -> "Send it"
                    },
                    style = MaterialTheme.typography.labelLarge,
                    color = colors.onAccent,
                )
            }
        }
    }
}

@Composable
private fun Question(
    title: String,
    hint: String,
    value: String,
    onValue: (String) -> Unit,
    placeholder: String,
    minLines: Int,
) {
    val colors = neuColors
    Text(title, style = MaterialTheme.typography.headlineMedium, color = colors.textPrimary)
    Spacer(Modifier.height(8.dp))
    Text(hint, style = MaterialTheme.typography.bodyMedium, color = colors.textTertiary)
    Spacer(Modifier.height(22.dp))
    NeuTextField(
        value = value,
        onValueChange = onValue,
        placeholder = placeholder,
        singleLine = minLines == 1,
        maxLines = if (minLines == 1) 1 else 6,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun Review(
    groupName: String,
    purpose: String,
    link: String,
    note: String,
    error: String?,
) {
    val colors = neuColors
    Text("Ready to send", style = MaterialTheme.typography.headlineMedium, color = colors.textPrimary)
    Spacer(Modifier.height(8.dp))
    Text(
        "Staff read this and decide. You will see the badge on $groupName if it goes through.",
        style = MaterialTheme.typography.bodyMedium,
        color = colors.textTertiary,
    )
    Spacer(Modifier.height(22.dp))
    ReviewRow("About", purpose)
    if (link.isNotBlank()) ReviewRow("Link", link)
    if (note.isNotBlank()) ReviewRow("Why", note)
    error?.let {
        Spacer(Modifier.height(14.dp))
        Text(it, style = MaterialTheme.typography.bodyMedium, color = colors.danger)
    }
}

@Composable
private fun ReviewRow(label: String, value: String) {
    val colors = neuColors
    Column(Modifier.fillMaxWidth().padding(bottom = 14.dp)) {
        Text(
            label.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = colors.textTertiary,
        )
        Spacer(Modifier.height(3.dp))
        Text(value, style = MaterialTheme.typography.bodyLarge, color = colors.textPrimary)
    }
}

/** The full stop: a check that springs in, and nothing else asked of anyone. */
@Composable
private fun SentScreen(groupName: String, onDone: () -> Unit) {
    val colors = neuColors
    var shown by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(
        if (shown) 1f else 0.4f,
        spring(dampingRatio = 0.5f, stiffness = 240f),
        label = "check",
    )
    androidx.compose.runtime.LaunchedEffect(Unit) { shown = true }

    Column(
        Modifier.fillMaxSize().padding(horizontal = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            Modifier
                .size(84.dp)
                .scale(scale)
                .neu(CircleShape, colors, NeuState.Raised, 5.dp, colors.accent),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Rounded.Check,
                contentDescription = null,
                tint = colors.onAccent,
                modifier = Modifier.size(38.dp),
            )
        }
        Spacer(Modifier.height(24.dp))
        Text("Sent", style = MaterialTheme.typography.headlineMedium, color = colors.textPrimary)
        Spacer(Modifier.height(8.dp))
        Text(
            "Staff will look at $groupName. If it is verified, the badge simply appears — nothing else to do.",
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textTertiary,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        Spacer(Modifier.height(28.dp))
        NeuButton(onClick = onDone, accent = true) {
            Text("Done", style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
        }
    }
}
