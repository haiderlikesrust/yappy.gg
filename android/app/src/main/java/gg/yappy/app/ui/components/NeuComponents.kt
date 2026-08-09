package gg.yappy.app.ui.components

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.neu
import gg.yappy.app.ui.theme.neuColors

/**
 * The component vocabulary.
 *
 * Every interactive element animates between Raised and Pressed on touch
 * instead of drawing a ripple — a ripple over a soft-shadowed surface reads as
 * a smudge. That is why each `clickable` below passes `indication = null`: the
 * state change *is* the feedback, and it is a better one, because it matches
 * the physical metaphor the whole style is built on.
 */

/**
 * Tap target with no ripple, for text and rows that are not full components.
 * Public because several screens need it directly.
 */
@Composable
fun Modifier.softClickable(enabled: Boolean = true, onClick: () -> Unit): Modifier {
    val interaction = remember { MutableInteractionSource() }
    return clickable(
        interactionSource = interaction,
        indication = null,
        enabled = enabled,
        onClick = onClick,
    )
}

/** Press feedback without a ripple. */
private fun Modifier.softClick(
    interaction: MutableInteractionSource,
    enabled: Boolean = true,
    onClick: () -> Unit,
): Modifier = clickable(
    interactionSource = interaction,
    indication = null,
    enabled = enabled,
    onClick = onClick,
)

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun NeuSurface(
    modifier: Modifier = Modifier,
    shape: Shape = RoundedCornerShape(Neu.CornerMedium),
    state: NeuState = NeuState.Raised,
    elevation: Dp = 6.dp,
    fill: Color? = null,
    contentPadding: Dp = 16.dp,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    val colors = neuColors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()

    val elevationAnim by animateDpAsState(
        targetValue = if (pressed && onClick != null) (elevation / 2) else elevation,
        animationSpec = spring(dampingRatio = 0.7f, stiffness = 900f),
        label = "surface-elevation",
    )

    Box(
        modifier = modifier
            .neu(shape, colors, state, elevationAnim, fill)
            .clip(shape)
            .then(
                if (onClick != null) {
                    Modifier.combinedClickable(
                        interactionSource = interaction,
                        indication = null,
                        onClick = onClick,
                        onLongClick = onLongClick,
                    )
                } else {
                    Modifier
                },
            )
            .padding(contentPadding),
    ) { content() }
}

@Composable
fun NeuButton(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    shape: Shape = RoundedCornerShape(Neu.CornerMedium),
    accent: Boolean = false,
    elevation: Dp = 7.dp,
    content: @Composable RowScope.() -> Unit,
) {
    val colors = neuColors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()

    // Springs, not tweens: the shadow should settle the way a physical key does.
    val elevationAnim by animateDpAsState(
        targetValue = if (pressed) 2.dp else elevation,
        animationSpec = spring(dampingRatio = 0.7f, stiffness = 900f),
        label = "neu-elevation",
    )

    Row(
        modifier = modifier
            .neu(
                shape = shape,
                colors = colors,
                state = if (pressed) NeuState.Pressed else NeuState.Raised,
                elevation = elevationAnim,
                fill = if (accent) colors.accent else null,
            )
            .clip(shape)
            .then(if (enabled) Modifier else Modifier.alpha(0.45f))
            .softClick(interaction, enabled, onClick)
            .padding(horizontal = 20.dp, vertical = 14.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

@Composable
fun NeuIconButton(
    icon: ImageVector,
    contentDescription: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 46.dp,
    iconSize: Dp = 21.dp,
    tint: Color? = null,
    accent: Boolean = false,
    /** Overrides the accent fill — how a group's own colour reaches buttons. */
    fillColor: Color? = null,
    /** Sticky on/off state, e.g. a mute toggle during a call. */
    active: Boolean = false,
    enabled: Boolean = true,
) {
    val colors = neuColors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val shape = CircleShape

    val state = if (pressed || active) NeuState.Pressed else NeuState.Raised
    val elevation by animateDpAsState(
        targetValue = if (pressed || active) 3.dp else 6.dp,
        animationSpec = spring(dampingRatio = 0.7f, stiffness = 900f),
        label = "neu-icon-elevation",
    )

    val fill = fillColor ?: if (accent) colors.accent else null

    Box(
        modifier = modifier
            .size(size)
            .neu(shape, colors, state, elevation, fill)
            .clip(shape)
            .then(if (enabled) Modifier else Modifier.alpha(0.4f))
            .softClick(interaction, enabled, onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = contentDescription,
            tint = tint ?: when {
                fill != null -> colors.onAccent
                active -> colors.accent
                else -> colors.textSecondary
            },
            modifier = Modifier.size(iconSize),
        )
    }
}

/**
 * Text input.
 *
 * Always Pressed — an input is a hole in the sheet you drop text into. Raising
 * it makes it look like a button, which is the single most common neumorphic
 * affordance failure.
 */
@Composable
fun NeuTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    leading: @Composable (() -> Unit)? = null,
    trailing: @Composable (() -> Unit)? = null,
    singleLine: Boolean = true,
    maxLines: Int = if (singleLine) 1 else 6,
    enabled: Boolean = true,
    shape: Shape = RoundedCornerShape(Neu.CornerMedium),
    textStyle: TextStyle = MaterialTheme.typography.bodyLarge,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    /**
     * Height, in effect. Raised on the sign-in screen, where two or three
     * fields are the entire page and a compact list row's proportions read as
     * cramped rather than tidy. Everywhere else the field sits among other
     * content and the tighter default is right.
     */
    verticalPadding: Dp = 12.dp,
) {
    val colors = neuColors
    Row(
        modifier = modifier
            .neu(shape, colors, NeuState.Pressed, 5.dp)
            .clip(shape)
            .padding(horizontal = 16.dp, vertical = verticalPadding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) {
            leading()
            Spacer(Modifier.size(10.dp))
        }
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (value.isEmpty() && placeholder != null) {
                Text(placeholder, style = textStyle, color = colors.textTertiary)
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                enabled = enabled,
                singleLine = singleLine,
                maxLines = maxLines,
                textStyle = textStyle.copy(color = colors.textPrimary),
                cursorBrush = SolidColor(colors.accent),
                keyboardOptions = keyboardOptions,
                visualTransformation = visualTransformation,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (trailing != null) {
            Spacer(Modifier.size(10.dp))
            trailing()
        }
    }
}

@Composable
fun NeuChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    leadingEmoji: String? = null,
) {
    val colors = neuColors
    val interaction = remember { MutableInteractionSource() }
    val shape = RoundedCornerShape(Neu.CornerPill)
    val scale by animateFloatAsState(
        targetValue = if (selected) 1.03f else 1f,
        animationSpec = spring(dampingRatio = 0.55f, stiffness = 700f),
        label = "chip-scale",
    )

    Row(
        modifier = modifier
            .scale(scale)
            .neu(
                shape,
                colors,
                if (selected) NeuState.Pressed else NeuState.Raised,
                if (selected) 3.dp else 5.dp,
            )
            .clip(shape)
            .softClick(interaction, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (leadingEmoji != null) Text(leadingEmoji, style = MaterialTheme.typography.labelMedium)
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = if (selected) colors.accent else colors.textSecondary,
        )
    }
}

@Composable
fun NeuSwitch(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = neuColors
    val interaction = remember { MutableInteractionSource() }
    val knobOffset by animateDpAsState(
        targetValue = if (checked) 22.dp else 2.dp,
        animationSpec = spring(dampingRatio = 0.65f, stiffness = 800f),
        label = "switch-knob",
    )

    Box(
        modifier = modifier
            .size(width = 48.dp, height = 28.dp)
            // The track is always recessed and only the knob is raised — that is
            // what makes it read as a physical slider sitting in a groove.
            .neu(RoundedCornerShape(Neu.CornerPill), colors, NeuState.Pressed, 4.dp)
            .clip(RoundedCornerShape(Neu.CornerPill))
            .softClick(interaction) { onCheckedChange(!checked) },
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            Modifier
                .offset(x = knobOffset)
                .size(24.dp)
                .neu(CircleShape, colors, NeuState.Raised, 3.dp, if (checked) colors.accent else null)
                .clip(CircleShape),
        )
    }
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = neuColors.textTertiary,
        modifier = modifier.padding(start = 6.dp, bottom = 8.dp),
    )
}

/** Presence indicator. The surface-coloured ring keeps it legible over avatars. */
@Composable
fun PresenceDot(status: String, modifier: Modifier = Modifier, size: Dp = 12.dp) {
    val colors = neuColors
    val color = when (status) {
        "online" -> colors.success
        "idle" -> colors.warning
        "dnd" -> colors.danger
        else -> colors.textTertiary
    }
    Box(
        modifier
            .size(size)
            .background(colors.surface, CircleShape)
            .padding(2.5.dp)
            .background(color, CircleShape),
    )
}
