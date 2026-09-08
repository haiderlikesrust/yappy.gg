package gg.yappy.app.ui.group

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.LocalFireDepartment
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.yappy.app.LocalContainer
import gg.yappy.app.data.PetDay
import gg.yappy.app.data.PetEnvelope
import gg.yappy.app.ui.components.AppHeader
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.PixelPet
import gg.yappy.app.ui.components.SectionLabel
import gg.yappy.app.ui.components.petDescription
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.neuColors
import java.time.LocalDate
import java.time.format.TextStyle
import java.util.Locale

/**
 * The pet, given a place.
 *
 * On the group page it is a 64dp sprite, a name and a mood line — which says
 * a creature exists and that it is peckish, and stops there. That is the whole
 * problem with it: the pet is meant to be the group's own activity reflected
 * back, and a reflection you cannot read tells you nothing to do about it.
 *
 * So this answers the three questions the card raises and never addresses.
 * How long has this been going (the streak, and the growth behind it). What
 * happened this week (seven days, fed or not, with the numbers). And what
 * would change it — said as a shortfall in the units the rule is written in,
 * because "talk more" is not an instruction and "two more messages from one
 * more person" is.
 *
 * Every number here is the server's, including whether a day counted: the
 * feeding rule lives in one place and is read by the nightly job too, so a
 * week drawn here can never disagree with the streak printed above it.
 */
@Composable
fun PetScreen(conversationId: String, onBack: () -> Unit) {
    val container = LocalContainer.current
    val colors = neuColors

    var data by remember(conversationId) { mutableStateOf<PetEnvelope?>(null) }
    var failed by remember(conversationId) { mutableStateOf(false) }

    LaunchedEffect(conversationId) {
        runCatching { container.repo.pet(conversationId) }
            .onSuccess { data = it }
            .onFailure { failed = true }
    }

    Column(Modifier.fillMaxSize().background(colors.surface)) {
        AppHeader(title = "The pet", onBack = onBack)

        val envelope = data
        when {
            failed -> Note("Couldn't load the pet.")
            envelope == null -> Note("Loading…")
            else -> Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .navigationBarsPadding()
                    .padding(horizontal = 20.dp)
                    .padding(bottom = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                val pet = envelope.pet

                Spacer(Modifier.height(8.dp))
                PixelPet(
                    conversationId = conversationId,
                    stage = pet.stage,
                    mood = pet.mood,
                    size = 120.dp,
                    contentDescription = petDescription(pet.stage, pet.mood, pet.name),
                )
                Spacer(Modifier.height(14.dp))
                Text(
                    pet.name ?: "Unnamed",
                    style = MaterialTheme.typography.headlineSmall,
                    color = colors.textPrimary,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    moodLine(pet.mood, pet.stage),
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textTertiary,
                    textAlign = TextAlign.Center,
                )

                Spacer(Modifier.height(20.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Stat(
                        value = pet.streak.toString(),
                        label = "day streak",
                        modifier = Modifier.weight(1f),
                        flame = pet.streak > 1 && pet.mood != "gone",
                    )
                    Stat(
                        value = pet.fedDays.toString(),
                        label = "days fed",
                        modifier = Modifier.weight(1f),
                    )
                    Stat(
                        value = stageLabel(pet.stage),
                        label = "stage",
                        modifier = Modifier.weight(1f),
                    )
                }

                Spacer(Modifier.height(24.dp))
                SectionLabel("THIS WEEK")
                Spacer(Modifier.height(10.dp))
                NeuSurface(
                    Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(Neu.CornerMedium),
                    contentPadding = 16.dp,
                ) {
                    Column {
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            envelope.week.forEach { day -> DayPip(day) }
                        }
                        Spacer(Modifier.height(14.dp))
                        Text(
                            weekLine(envelope),
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.textSecondary,
                        )
                    }
                }

                Spacer(Modifier.height(20.dp))
                SectionLabel("WHAT FEEDS IT")
                Spacer(Modifier.height(10.dp))
                NeuSurface(
                    Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(Neu.CornerMedium),
                    contentPadding = 16.dp,
                ) {
                    Column {
                        Text(
                            "A day counts when there are ${envelope.needs.messages} messages " +
                                "from ${envelope.needs.speakers} different people. " +
                                "Bots do not count, and neither does one person talking to themselves.",
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.textSecondary,
                        )
                        todayLine(envelope)?.let {
                            Spacer(Modifier.height(10.dp))
                            Text(
                                it,
                                style = MaterialTheme.typography.labelLarge,
                                color = colors.accent,
                            )
                        }
                        Spacer(Modifier.height(10.dp))
                        Text(
                            "Two silent weeks and it wanders off. The streak goes with it; " +
                                "the days fed stay, because it is the same creature when it " +
                                "comes back.",
                            style = MaterialTheme.typography.bodySmall,
                            color = colors.textTertiary,
                        )
                    }
                }
            }
        }
    }
}

/** The mood line the group card shows, in the longer register a screen affords. */
private fun moodLine(mood: String, stage: String): String = when (mood) {
    "gone" -> "Wandered off. Talk in here and it will come back."
    "sad" -> "Lonely. It has been quiet for a few days."
    "hungry" -> "Peckish. A conversation would help."
    else -> when (stage) {
        "egg" -> "Still an egg. Keep talking and it will hatch."
        else -> "Thriving, on this group talking."
    }
}

private fun stageLabel(stage: String) = stage.replaceFirstChar { it.uppercase() }

/**
 * Seven pips, oldest on the left.
 *
 * A filled pip is a fed day and a hollow one is not; the numbers behind them
 * are in the line underneath rather than on each pip, because seven counts in
 * a row is a table, and the shape of the week is the thing worth seeing at a
 * glance.
 */
@Composable
private fun DayPip(day: PetDay) {
    val colors = neuColors
    val date = runCatching { LocalDate.parse(day.day) }.getOrNull()
    val letter = date?.dayOfWeek?.getDisplayName(TextStyle.NARROW, Locale.getDefault()) ?: "·"

    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        // One description for the column: three separate stops per day would
        // make a swipe through the week twenty-one gestures long.
        modifier = Modifier.semantics(mergeDescendants = true) {
            contentDescription = buildString {
                append(date?.dayOfWeek?.getDisplayName(TextStyle.FULL, Locale.getDefault()) ?: day.day)
                append(if (day.fed) ", fed" else ", not fed")
                append(", ${day.messages} messages from ${day.speakers}")
            }
        },
    ) {
        Box(
            Modifier
                .size(26.dp)
                // A rounded square, not a disc: a circle in this app is a
                // person, and seven small circles in a row would read as
                // faces before they read as days.
                .clip(RoundedCornerShape(7.dp))
                .background(if (day.fed) colors.success else colors.veil),
        )
        Spacer(Modifier.height(6.dp))
        Text(
            letter,
            style = MaterialTheme.typography.labelSmall,
            color = colors.textTertiary,
            modifier = Modifier.clearAndSetSemantics {},
        )
    }
}

/** "Fed on 5 of the last 7 days." — the week in one sentence. */
private fun weekLine(envelope: PetEnvelope): String {
    val fed = envelope.week.count { it.fed }
    return when (fed) {
        0 -> "Not fed once this week."
        envelope.week.size -> "Fed every day this week."
        else -> "Fed on $fed of the last ${envelope.week.size} days."
    }
}

/**
 * What today is still short of, in the rule's own units.
 *
 * Null once the day already counts — a screen that keeps telling you to do
 * something you have done is a screen people stop reading.
 */
private fun todayLine(envelope: PetEnvelope): String? {
    val today = envelope.week.lastOrNull() ?: return null
    if (today.fed) return "Today already counts."
    val messages = (envelope.needs.messages - today.messages).coerceAtLeast(0)
    val speakers = (envelope.needs.speakers - today.speakers).coerceAtLeast(0)
    if (messages == 0 && speakers == 0) return null
    val parts = buildList {
        if (messages > 0) add(if (messages == 1) "1 more message" else "$messages more messages")
        if (speakers > 0) {
            add(if (speakers == 1) "1 more person talking" else "$speakers more people talking")
        }
    }
    return "Today needs ${parts.joinToString(" and ")}."
}

@Composable
private fun Stat(value: String, label: String, modifier: Modifier = Modifier, flame: Boolean = false) {
    val colors = neuColors
    NeuSurface(
        modifier,
        shape = RoundedCornerShape(Neu.CornerMedium),
        contentPadding = 14.dp,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (flame) {
                    // A drawn flame, not the emoji: emoji are content here,
                    // never chrome, and the platform glyph changes shape with
                    // every OS release.
                    Icon(
                        Icons.Rounded.LocalFireDepartment,
                        null,
                        tint = colors.warning,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                }
                Text(
                    value,
                    style = MaterialTheme.typography.titleLarge,
                    color = colors.textPrimary,
                )
            }
            Spacer(Modifier.height(2.dp))
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun Note(text: String) {
    val colors = neuColors
    Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
        Text(text, style = MaterialTheme.typography.bodyMedium, color = colors.textTertiary)
    }
}
