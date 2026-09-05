package gg.yappy.app.ui.components

import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.FocusState
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
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
 *
 * The platform behaviour lives here too, once, so a screen gets it by using
 * the vocabulary rather than remembering to add it: every control announces a
 * role to TalkBack, reserves a 48dp target around whatever it draws, shows a
 * keyboard-focus halo, and ticks where Android expects a tick. "Native" is
 * the behaviour, not the look — the look stays ours.
 */

/**
 * Keyboard and switch-access focus, made visible.
 *
 * Touch never sets focus on a clickable, so on a phone this draws nothing and
 * the Raised→Pressed change stays the only feedback. Tab through with a
 * keyboard, or land here from TalkBack, and the element gets a thin accent
 * halo inside its own silhouette — the one state the shadows cannot express,
 * since "which control is focused" is not a physical property of the sheet.
 */
private fun Modifier.focusHalo(focused: Boolean, shape: Shape, color: Color): Modifier =
    if (focused) this.border(1.5.dp, color, shape) else this

/**
 * Tap target with no ripple, for text and rows that are not full components.
 * Public because several screens need it directly.
 *
 * @param role What TalkBack calls it. Defaults to a button, because that is
 *   what nearly every soft-clickable text or row is; pass `null` for a plain
 *   container that merely happens to react to a tap, so the reader does not
 *   announce a "button" that looks like nothing of the sort.
 */
@Composable
fun Modifier.softClickable(
    enabled: Boolean = true,
    role: Role? = Role.Button,
    onClick: () -> Unit,
): Modifier {
    val interaction = remember { MutableInteractionSource() }
    return clickable(
        interactionSource = interaction,
        indication = null,
        enabled = enabled,
        role = role,
        onClick = onClick,
    )
}

/** Press feedback without a ripple. */
private fun Modifier.softClick(
    interaction: MutableInteractionSource,
    enabled: Boolean = true,
    role: Role? = Role.Button,
    onClick: () -> Unit,
): Modifier = clickable(
    interactionSource = interaction,
    indication = null,
    enabled = enabled,
    role = role,
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
    /** Announced role when clickable. A card that opens something is a button. */
    role: Role? = Role.Button,
    content: @Composable () -> Unit,
) {
    val colors = neuColors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val focused by interaction.collectIsFocusedAsState()
    val haptics = LocalHapticFeedback.current

    val elevationAnim by animateDpAsState(
        targetValue = if (pressed && onClick != null) (elevation / 2) else elevation,
        animationSpec = spring(dampingRatio = 0.7f, stiffness = 900f),
        label = "surface-elevation",
    )

    Box(
        modifier = modifier
            .neu(shape, colors, state, elevationAnim, fill)
            .clip(shape)
            .focusHalo(focused && onClick != null, shape, colors.accent)
            .then(
                if (onClick != null) {
                    Modifier.combinedClickable(
                        interactionSource = interaction,
                        indication = null,
                        role = role,
                        onClick = onClick,
                        // The long-press tick is the platform's, not the
                        // screen's: every card and row that offers a long
                        // press gets it here, so none of them can forget it
                        // and none of them can pick a different one.
                        onLongClick = onLongClick?.let { action ->
                            {
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                action()
                            }
                        },
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
    val focused by interaction.collectIsFocusedAsState()

    // Springs, not tweens: the shadow should settle the way a physical key does.
    val elevationAnim by animateDpAsState(
        targetValue = if (pressed) 2.dp else elevation,
        animationSpec = spring(dampingRatio = 0.7f, stiffness = 900f),
        label = "neu-elevation",
    )

    Row(
        modifier = modifier
            // Reserves the platform minimum around the drawn key without
            // growing the key: a compact button in a card corner still gets a
            // finger-sized target.
            .minimumInteractiveComponentSize()
            .neu(
                shape = shape,
                colors = colors,
                state = if (pressed) NeuState.Pressed else NeuState.Raised,
                elevation = elevationAnim,
                fill = if (accent) colors.accent else null,
            )
            .clip(shape)
            .focusHalo(focused, shape, if (accent) colors.onAccent else colors.accent)
            .then(if (enabled) Modifier else Modifier.alpha(0.45f))
            .softClick(interaction, enabled, Role.Button, onClick)
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
    /**
     * Whether the layout reserves the platform's 48dp target around the disc.
     * Right for a header button, where the disc is nearly that size anyway.
     * Wrong for a pip inside a text field or an inline strip: the reservation
     * is a layout size, not just a hit box, so a 28dp clear pip would make
     * the search field 25dp taller the moment a query appears. Compose
     * already stretches the touch target of a small pointer node to the
     * minimum on its own, so an inline pip loses nothing by opting out.
     */
    reserveTarget: Boolean = true,
) {
    val colors = neuColors
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val focused by interaction.collectIsFocusedAsState()
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
            // The disc keeps its drawn size — 42dp in headers, 30dp on a
            // dismiss pip — and, where the caller lets it, the layout
            // reserves 48dp around it so the target is right even where the
            // glyph is small. Neighbours in a header row shift by the
            // difference; that is the intended trade there, and the wrong one
            // inside a text field, which is what `reserveTarget` is for.
            .then(if (reserveTarget) Modifier.minimumInteractiveComponentSize() else Modifier)
            .size(size)
            .neu(shape, colors, state, elevation, fill)
            .clip(shape)
            .focusHalo(focused, shape, if (fill != null) colors.onAccent else colors.accent)
            .then(if (enabled) Modifier else Modifier.alpha(0.4f))
            .then(
                // A sticky toggle tells the reader which way it is set; a
                // plain button says nothing extra.
                if (active) Modifier.semantics { stateDescription = "On" } else Modifier,
            )
            .softClick(interaction, enabled, Role.Button, onClick),
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
 *
 * Focus deepens the hole rather than raising anything: the well gets a touch
 * more inset shadow and a faint accent rim, which is what "this is the field
 * you are typing into" looks like in this material. The placeholder is the
 * field's spoken label, not a sibling the reader skips.
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
    /** What the IME's action key does — Done submits, Search searches, Send sends. */
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    /** Lets a screen focus this field itself (the first field on sign-in). */
    focusRequester: FocusRequester? = null,
    /** Focus in and out, for callers that hide chrome while typing. */
    onFocusChanged: ((FocusState) -> Unit)? = null,
) {
    val colors = neuColors
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val requester = focusRequester ?: remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val depth by animateDpAsState(
        targetValue = if (focused) 7.dp else 5.dp,
        animationSpec = spring(dampingRatio = 0.8f, stiffness = 900f),
        label = "field-depth",
    )

    Row(
        modifier = modifier
            .neu(shape, colors, NeuState.Pressed, depth)
            .clip(shape)
            .focusHalo(focused, shape, colors.accent.copy(alpha = 0.55f))
            // The whole well is the target. The text node fills the middle, so
            // a tap on the padding or the leading icon reaches here only when
            // nothing inside claimed it — and then it should still start typing.
            // Focus alone is not enough: requesting it on a field that already
            // has it is a no-op, and after Back (or a Search key that hides the
            // IME) the field is exactly that — focused, keyboard down. The text
            // line's own tap handler shows the keyboard in that state, so the
            // rest of the well does the same.
            .pointerInput(enabled) {
                if (enabled) {
                    detectTapGestures {
                        runCatching { requester.requestFocus() }
                        keyboard?.show()
                    }
                }
            }
            .padding(horizontal = 16.dp, vertical = verticalPadding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (leading != null) {
            leading()
            Spacer(Modifier.size(10.dp))
        }
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
            if (value.isEmpty() && placeholder != null) {
                // Visual only: the same words are the field's own label below,
                // so the reader is not handed them twice.
                Text(
                    placeholder,
                    style = textStyle,
                    color = colors.textTertiary,
                    modifier = Modifier.clearAndSetSemantics {},
                )
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
                keyboardActions = keyboardActions,
                visualTransformation = visualTransformation,
                interactionSource = interaction,
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(requester)
                    .then(if (onFocusChanged != null) Modifier.onFocusChanged(onFocusChanged) else Modifier)
                    .then(
                        if (placeholder != null) Modifier.semantics { contentDescription = placeholder }
                        else Modifier,
                    ),
            )
        }
        if (trailing != null) {
            Spacer(Modifier.size(10.dp))
            trailing()
        }
    }
}

/**
 * A pill that is one of a set — a filter, a tab, a choice. Announced as a
 * radio button because that is how a row of these behaves: exactly one is
 * selected and tapping another moves the selection. Callers that lay several
 * out together should wrap the row in `Modifier.selectableGroup()` so the
 * reader counts them ("2 of 3").
 *
 * A chip that stands alone as an on/off — "Multiple answers" on a poll —
 * passes [role] = `Role.Checkbox` (or `Role.Switch`). Left as a radio
 * button it contradicts itself: the reader calls it "selected", the next
 * tap makes it "not selected", and no radio button un-selects on a tap.
 */
@Composable
fun NeuChip(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    /** Prefer [leading]; kept for existing callers. */
    leadingEmoji: String? = null,
    /**
     * A drawn glyph before the label — an icon from the set, a colour swatch.
     * Emoji as chrome is off the table everywhere else in the app, and a chip
     * with a picture is no exception.
     */
    leading: (@Composable () -> Unit)? = null,
    /**
     * What the reader calls it; see above. Last, so callers that pass the
     * earlier parameters by position are untouched.
     */
    role: Role = Role.RadioButton,
) {
    val colors = neuColors
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val shape = RoundedCornerShape(Neu.CornerPill)
    val scale by animateFloatAsState(
        targetValue = if (selected) 1.03f else 1f,
        animationSpec = spring(dampingRatio = 0.55f, stiffness = 700f),
        label = "chip-scale",
    )

    Row(
        modifier = modifier
            // Chips are short — a label and eight dp either side — so the
            // target is reserved around them; the pill itself stays the size
            // it has always been.
            .minimumInteractiveComponentSize()
            .scale(scale)
            .neu(
                shape,
                colors,
                if (selected) NeuState.Pressed else NeuState.Raised,
                if (selected) 3.dp else 5.dp,
            )
            .clip(shape)
            .focusHalo(focused, shape, colors.accent)
            .then(
                // A toggle is a different node from a selection: the reader
                // gets "checked" / "not checked" and a toggle hint, instead of
                // a radio button it has just called "selected" going back to
                // "not selected" on the next tap.
                if (role == Role.Checkbox || role == Role.Switch) {
                    Modifier.toggleable(
                        value = selected,
                        interactionSource = interaction,
                        indication = null,
                        role = role,
                        onValueChange = { onClick() },
                    )
                } else {
                    Modifier.selectable(
                        selected = selected,
                        interactionSource = interaction,
                        indication = null,
                        role = role,
                        onClick = onClick,
                    )
                },
            )
            .padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (leading != null) leading()
        else if (leadingEmoji != null) Text(leadingEmoji, style = MaterialTheme.typography.labelMedium)
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
    val focused by interaction.collectIsFocusedAsState()
    val view = LocalView.current
    val knobOffset by animateDpAsState(
        targetValue = if (checked) 22.dp else 2.dp,
        animationSpec = spring(dampingRatio = 0.65f, stiffness = 800f),
        label = "switch-knob",
    )
    val trackShape = RoundedCornerShape(Neu.CornerPill)

    Box(
        modifier = modifier
            // The track is 28dp tall by design; the hit box is not. The
            // platform minimum is reserved around it so a thumb lands.
            .minimumInteractiveComponentSize()
            .size(width = 48.dp, height = 28.dp)
            // The track is always recessed and only the knob is raised — that is
            // what makes it read as a physical slider sitting in a groove.
            .neu(trackShape, colors, NeuState.Pressed, 4.dp)
            .clip(trackShape)
            .focusHalo(focused, trackShape, colors.accent)
            .toggleable(
                value = checked,
                interactionSource = interaction,
                indication = null,
                role = Role.Switch,
                onValueChange = { next ->
                    // The light tick a physical toggle makes as it seats —
                    // Compose's own set is only the heavy long-press thump
                    // and the text-handle nudge, so this goes to the view.
                    view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
                    onCheckedChange(next)
                },
            )
            .semantics { stateDescription = if (checked) "On" else "Off" },
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
fun SectionLabel(
    text: String,
    modifier: Modifier = Modifier,
    /** A hoisted role heads its own section in its own colour. */
    color: Color? = null,
) {
    Text(
        text.uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = color ?: neuColors.textTertiary,
        // A heading, so a reader can jump section to section instead of
        // row by row through a long settings page.
        modifier = modifier.padding(start = 6.dp, bottom = 8.dp).semantics { heading() },
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

/**
 * One row of an action sheet: glyph, label, tap. The chat's message sheet,
 * the home row's menu and a channel's long-press all list actions the same
 * way, so they share the row rather than each drawing a near-copy — the
 * differences between three hand-rolled versions are never intentional.
 *
 * @param icon The glyph. `null` for a sheet whose rows are words alone —
 *   the group's member sheet — so it can share the row without inventing
 *   pictures for "Make admin"; the label then starts where the glyph would.
 * @param danger Red ink and glyph, for the row that removes or leaves.
 */
@Composable
fun ActionRow(
    icon: ImageVector?,
    label: String,
    modifier: Modifier = Modifier,
    danger: Boolean = false,
    onClick: () -> Unit,
) {
    val colors = neuColors
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Neu.CornerSmall))
            .softClickable(onClick = onClick)
            .padding(vertical = 13.dp, horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(
                icon,
                null,
                tint = if (danger) colors.danger else colors.textSecondary,
                modifier = Modifier.size(19.dp),
            )
            Spacer(Modifier.width(14.dp))
        }
        Text(
            label,
            style = MaterialTheme.typography.bodyLarge,
            color = if (danger) colors.danger else colors.textPrimary,
        )
    }
}

/**
 * The bottom edge of a scrolling screen.
 *
 * The activity is edge-to-edge, so the navigation bar is drawn over the last
 * few dp of every screen. A fixed spacer guesses at that height and is wrong
 * on one of the two navigation modes: too tall under gestures, too short
 * under three buttons. This reads the real inset and adds the design gap on
 * top, so a list's last row and a form's final button clear the bar exactly.
 */
@Composable
fun screenBottomPadding(gap: Dp = 24.dp): Dp =
    WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding() + gap

/**
 * [screenBottomPadding] as `contentPadding` for a `LazyColumn`, with the
 * horizontal gutter and any top space the screen already used.
 */
@Composable
fun screenContentPadding(
    horizontal: Dp = 0.dp,
    top: Dp = 0.dp,
    gap: Dp = 24.dp,
): PaddingValues = PaddingValues(
    start = horizontal,
    end = horizontal,
    top = top,
    bottom = screenBottomPadding(gap),
)
