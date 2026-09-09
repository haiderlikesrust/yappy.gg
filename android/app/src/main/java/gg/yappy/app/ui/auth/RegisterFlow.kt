package gg.yappy.app.ui.auth

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.AlternateEmail
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.MailOutline
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.yappy.app.ui.components.EditableAvatar
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.neuColors

/**
 * Making an account, one question at a time.
 *
 * Registration used to be the sign-in form with two more rows unfolding under
 * it: four fields, one button, and the only thing that can go wrong on the
 * server — a taken username — reported as a red line in the middle of a form
 * you were still filling in. Every step here asks one thing and can fail in
 * one way, so the answer is always the whole screen.
 *
 * Three steps, not five. Email and password stay together because nothing
 * happens between them — splitting them is a habit borrowed from apps that
 * verify a code in the gap, and yappy has no gap. The username gets its own
 * step because it is the one field the server has an opinion about, and the
 * check mark deserves to be the point of a screen rather than a footnote.
 * Name and face come last and are skippable: they are the account looking
 * like someone, not the account existing.
 *
 * One request, at the end. The server wants the username with the email and
 * password, so nothing is created until the last step — which also means
 * backing out at any point leaves nothing behind.
 *
 * Signing *in* stays a single form. Walking a returning person through
 * screens is where this pattern turns from welcome into obstacle.
 */
@Composable
fun RegisterFlow(
    vm: AuthViewModel,
    state: AuthState,
    onBack: () -> Unit,
) {
    val colors = neuColors

    var step by rememberSaveable { mutableStateOf(0) }
    // Which way the next screen enters: forward slides in from the right,
    // back from the left — the animation says which way you moved.
    var forward by rememberSaveable { mutableStateOf(true) }
    // The picked picture, held here rather than uploaded: there is no account
    // to attach it to until the last step succeeds.
    var avatar by rememberSaveable { mutableStateOf<Uri?>(null) }

    val steps = 3

    val stepOneReady = state.emailLooksValid && state.password.length >= AuthState.MIN_PASSWORD
    // `null` — still checking, or too short to check — does not block, the
    // same call `canSubmit` makes: the server is the authority and rejects a
    // taken name anyway. Only a confirmed "taken" holds the button.
    val stepTwoReady = state.username.length >= 3 && state.usernameAvailable != false

    fun goBack() {
        if (step == 0) onBack() else { forward = false; step-- }
    }

    fun advance() {
        forward = true
        step++
    }

    BackHandler { goBack() }

    Column(
        Modifier
            .fillMaxSize()
            .background(colors.surface)
            .systemBarsPadding()
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
            // Where you are, out of how much — the same dots the verification
            // wizard uses, so the two stepped flows in the app read as one.
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
            Spacer(Modifier.weight(1f))
            Spacer(Modifier.width(42.dp))
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
            label = "register",
            modifier = Modifier.weight(1f),
        ) { current ->
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp),
            ) {
                // Capped, and centred within the cap — the same rule the
                // sign-in form follows, so a tablet does not stretch a single
                // field into a ribbon.
                Column(
                    Modifier
                        .align(Alignment.CenterHorizontally)
                        .widthIn(max = 480.dp)
                        .fillMaxWidth(),
                ) {
                    Spacer(Modifier.height(26.dp))
                    when (current) {
                        0 -> AccountStep(vm, state, ready = stepOneReady, onNext = ::advance)
                        1 -> UsernameStep(vm, state, ready = stepTwoReady, onNext = ::advance)
                        else -> IdentityStep(
                            vm = vm,
                            state = state,
                            avatar = avatar,
                            onAvatar = { avatar = it },
                            onCreate = { vm.submitRegister(avatar) },
                            onSkip = { vm.submitRegister(null) },
                        )
                    }
                }
            }
        }

        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 14.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "Already have an account?",
                style = MaterialTheme.typography.bodyMedium,
                color = colors.textTertiary,
            )
            Spacer(Modifier.width(6.dp))
            Text(
                "Sign in",
                style = MaterialTheme.typography.labelLarge,
                color = colors.accent,
                modifier = Modifier
                    .minimumInteractiveComponentSize()
                    .softClickable(onClick = onBack)
                    .padding(horizontal = 6.dp, vertical = 8.dp),
            )
        }
    }
}

@Composable
private fun StepHeading(title: String, hint: String) {
    val colors = neuColors
    Text(title, style = MaterialTheme.typography.displaySmall, color = colors.textPrimary)
    Spacer(Modifier.height(8.dp))
    Text(hint, style = MaterialTheme.typography.bodyLarge, color = colors.textSecondary)
    Spacer(Modifier.height(28.dp))
}

/** The one primary button every step ends on, with the request's spinner inside it. */
@Composable
private fun StepButton(
    label: String,
    enabled: Boolean,
    loading: Boolean,
    onClick: () -> Unit,
) {
    val colors = neuColors
    NeuButton(
        onClick = onClick,
        enabled = enabled && !loading,
        accent = true,
        modifier = Modifier.fillMaxWidth(),
    ) {
        if (loading) {
            CircularProgressIndicator(Modifier.size(20.dp), color = colors.onAccent, strokeWidth = 2.dp)
        } else {
            Text(label, style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
        }
    }
}

@Composable
private fun AccountStep(vm: AuthViewModel, state: AuthState, ready: Boolean, onNext: () -> Unit) {
    val colors = neuColors
    val passwordFocus = remember { FocusRequester() }

    StepHeading(
        title = "Make an account",
        hint = "Your email and a password. That is the account — the rest is how it looks.",
    )

    NeuTextField(
        value = state.email,
        onValueChange = vm::setEmail,
        placeholder = "you@example.com",
        verticalPadding = 16.dp,
        leading = {
            Icon(Icons.Rounded.MailOutline, null, tint = colors.textTertiary, modifier = Modifier.size(20.dp))
        },
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Email,
            capitalization = KeyboardCapitalization.None,
            imeAction = ImeAction.Next,
        ),
        keyboardActions = KeyboardActions(onNext = { passwordFocus.requestFocus() }),
        modifier = Modifier.fillMaxWidth(),
    )
    Spacer(Modifier.height(12.dp))
    NeuTextField(
        value = state.password,
        onValueChange = vm::setPassword,
        placeholder = "At least ${AuthState.MIN_PASSWORD} characters",
        verticalPadding = 16.dp,
        leading = {
            Icon(Icons.Rounded.Lock, null, tint = colors.textTertiary, modifier = Modifier.size(20.dp))
        },
        trailing = {
            Icon(
                if (state.showPassword) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                if (state.showPassword) "Hide password" else "Show password",
                tint = colors.textTertiary,
                modifier = Modifier
                    .minimumInteractiveComponentSize()
                    .clip(CircleShape)
                    .softClickable { vm.toggleShowPassword() }
                    .padding(10.dp)
                    .size(20.dp),
            )
        },
        visualTransformation = if (state.showPassword) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Next),
        keyboardActions = KeyboardActions(onNext = { if (ready) onNext() }),
        focusRequester = passwordFocus,
        modifier = Modifier.fillMaxWidth(),
    )

    Spacer(Modifier.height(24.dp))
    StepButton("Next", enabled = ready, loading = false, onClick = onNext)
}

@Composable
private fun UsernameStep(vm: AuthViewModel, state: AuthState, ready: Boolean, onNext: () -> Unit) {
    val colors = neuColors
    val focus = remember { FocusRequester() }
    // The field is the whole screen; make it the whole screen's focus too.
    LaunchedEffect(Unit) { focus.requestFocus() }

    StepHeading(
        title = "Pick a username",
        hint = "How friends find you. Letters, numbers, dots and underscores.",
    )

    NeuTextField(
        value = state.username,
        onValueChange = vm::setUsername,
        placeholder = "username",
        verticalPadding = 16.dp,
        leading = {
            Icon(Icons.Rounded.AlternateEmail, null, tint = colors.textTertiary, modifier = Modifier.size(20.dp))
        },
        trailing = {
            // Only ever a confirmation. "Taken" is said in words below,
            // because a red mark alone leaves people guessing what is wrong.
            if (state.usernameAvailable == true) {
                Icon(Icons.Rounded.Check, "Available", tint = colors.success, modifier = Modifier.size(18.dp))
            }
        },
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Text,
            capitalization = KeyboardCapitalization.None,
            imeAction = ImeAction.Next,
        ),
        keyboardActions = KeyboardActions(onNext = { if (ready) onNext() }),
        focusRequester = focus,
        modifier = Modifier.fillMaxWidth(),
    )

    Spacer(Modifier.height(8.dp))
    // A line is always drawn, so the button does not jump when the verdict
    // arrives.
    Text(
        when {
            state.usernameAvailable == false -> "That username is taken."
            state.usernameAvailable == true -> "@${state.username} is yours if you want it."
            state.username.length in 1..2 -> "At least 3 characters."
            else -> " "
        },
        style = MaterialTheme.typography.labelMedium,
        color = if (state.usernameAvailable == false) colors.danger else colors.textTertiary,
    )

    Spacer(Modifier.height(24.dp))
    StepButton("Next", enabled = ready, loading = false, onClick = onNext)
}

@Composable
private fun IdentityStep(
    vm: AuthViewModel,
    state: AuthState,
    avatar: Uri?,
    onAvatar: (Uri) -> Unit,
    onCreate: () -> Unit,
    onSkip: () -> Unit,
) {
    val colors = neuColors

    StepHeading(
        title = "Name and face",
        hint = "Both optional, and both changeable later in Settings.",
    )

    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        // A picked picture is shown straight from the picker's URI: there is
        // no account to upload it to yet, and a preview that only appeared
        // after signing up would make the picker feel like it did nothing.
        EditableAvatar(
            url = avatar?.toString(),
            name = state.displayName.ifBlank { state.username },
            id = state.username.ifBlank { "new" },
            size = 108.dp,
            enabled = !state.loading,
            onPicked = onAvatar,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            if (avatar == null) "Add a photo" else "Change photo",
            style = MaterialTheme.typography.labelMedium,
            color = colors.textTertiary,
            textAlign = TextAlign.Center,
        )
    }

    Spacer(Modifier.height(24.dp))
    NeuTextField(
        value = state.displayName,
        onValueChange = vm::setDisplayName,
        placeholder = "Display name",
        verticalPadding = 16.dp,
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = { if (!state.loading) onCreate() }),
        modifier = Modifier.fillMaxWidth(),
    )

    if (state.error != null) {
        Spacer(Modifier.height(10.dp))
        Text(state.error, style = MaterialTheme.typography.labelMedium, color = colors.danger)
    }

    Spacer(Modifier.height(24.dp))
    StepButton("Create account", enabled = true, loading = state.loading, onClick = onCreate)
    // A real button, not a small link: skipping is the expected path for a
    // lot of people, and a choice that is easy to miss is not a choice.
    Spacer(Modifier.height(10.dp))
    NeuButton(onClick = onSkip, enabled = !state.loading, modifier = Modifier.fillMaxWidth()) {
        Text("Skip for now", style = MaterialTheme.typography.labelLarge, color = colors.textPrimary)
    }
}
