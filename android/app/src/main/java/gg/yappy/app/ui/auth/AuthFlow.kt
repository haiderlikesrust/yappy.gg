package gg.yappy.app.ui.auth

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.AlternateEmail
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Lock
import androidx.compose.material.icons.rounded.MailOutline
import androidx.compose.material.icons.rounded.MarkEmailRead
import androidx.compose.material.icons.rounded.Visibility
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.material3.HorizontalDivider
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import gg.yappy.app.BuildConfig
import kotlinx.coroutines.launch
import gg.yappy.app.LocalContainer
import gg.yappy.app.ui.components.LogoMarkGradient
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.neuColors

/** Where the Terms and Privacy pages live, per build variant. */
private val WEB_BASE = BuildConfig.WEB_URL

/**
 * Taller than the app's default field.
 *
 * Two or three of these *are* the sign-in page, with nothing else competing for
 * the space. At the default height they read as a list of rows rather than as
 * the thing you came here to fill in, and they are the first surface anyone
 * touches.
 */
private val AuthFieldPadding = 16.dp

/**
 * Sign in, or make an account.
 *
 * One screen with two modes rather than a wizard. The previous flow was three
 * steps because an SMS code forces a round trip in the middle; email and
 * password do not, and registration only adds two fields, so making someone
 * page through screens for it would be ceremony.
 */
@Composable
fun AuthFlow(onAuthenticated: () -> Unit) {
    val container = LocalContainer.current
    val vm: AuthViewModel = viewModel(factory = AuthViewModel.factory(container))
    val state by vm.state.collectAsStateWithLifecycle()
    val colors = neuColors

    if (state.done) {
        onAuthenticated()
        return
    }

    val registering = state.mode == AuthMode.Register
    val forgetting = state.mode == AuthMode.Forgot
    val entering = forgetting && state.forgotStep == ForgotStep.Reset

    /**
     * Back walks the modes the way the on-screen links do. The modes are one
     * composable and one destination, so without this the system gesture had
     * nothing to pop and quit the app from the middle of a password reset —
     * with the code already sent and the address already typed.
     */
    BackHandler(enabled = state.mode != AuthMode.SignIn) {
        if (entering) vm.backToAsk() else vm.setMode(AuthMode.SignIn)
    }

    Box(
        Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .imePadding()
            .padding(horizontal = 24.dp),
    ) {
        Column(
            Modifier
                // Capped, and centred within the cap. On a phone this is
                // invisible; in landscape or on a tablet it stops a single
                // text field from stretching into a ribbon the width of the
                // screen, which no other surface in the app does.
                .align(Alignment.Center)
                .widthIn(max = 480.dp)
                .fillMaxWidth()
                .fillMaxHeight()
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.Center,
        ) {
            Spacer(Modifier.height(24.dp))

            // The mark itself, gradient-filled on the sheet — no tile behind
            // it. The launcher icon already showed its yellow a second ago;
            // repeating it here as a badge just puts a sticker on the page,
            // and the same treatment is what the home header uses, so the two
            // screens read as one product.
            LogoMarkGradient(height = 52.dp)

            Spacer(Modifier.height(28.dp))
            Text(
                when {
                    entering -> "Check your email"
                    forgetting -> "Forgot your password"
                    registering -> "Make an account"
                    else -> "Welcome back"
                },
                style = MaterialTheme.typography.displaySmall,
                color = colors.textPrimary,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                when {
                    entering -> "Enter the six-digit code sent to ${state.email}, and pick a new password."
                    forgetting -> "We will send a code to your email."
                    registering -> "Pick a username your friends will recognise."
                    else -> "Sign in with your email and password."
                },
                style = MaterialTheme.typography.bodyLarge,
                color = colors.textSecondary,
            )

            Spacer(Modifier.height(28.dp))

            NeuTextField(
                value = state.email,
                onValueChange = vm::setEmail,
                placeholder = "you@example.com",
                verticalPadding = AuthFieldPadding,
                leading = {
                    Icon(Icons.Rounded.MailOutline, null, tint = colors.textTertiary, modifier = Modifier.size(20.dp))
                },
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Email,
                    capitalization = KeyboardCapitalization.None,
                    imeAction = ImeAction.Next,
                ),
                modifier = Modifier.fillMaxWidth(),
            )

            if (entering) {
                Spacer(Modifier.height(12.dp))
                NeuTextField(
                    value = state.code,
                    onValueChange = vm::setCode,
                    placeholder = "Six-digit code",
                    verticalPadding = AuthFieldPadding,
                    leading = {
                        Icon(
                            Icons.Rounded.MarkEmailRead,
                            null,
                            tint = colors.textTertiary,
                            modifier = Modifier.size(20.dp),
                        )
                    },
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.NumberPassword,
                        imeAction = ImeAction.Next,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            // The password field is the new password while resetting, and is
            // out of the way entirely on the step that only wants an address.
            if (!forgetting || entering) {
            Spacer(Modifier.height(12.dp))

            NeuTextField(
                value = state.password,
                onValueChange = vm::setPassword,
                placeholder = if (registering || entering) "At least 8 characters" else "Password",
                verticalPadding = AuthFieldPadding,
                leading = {
                    Icon(Icons.Rounded.Lock, null, tint = colors.textTertiary, modifier = Modifier.size(20.dp))
                },
                trailing = {
                    Icon(
                        if (state.showPassword) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility,
                        if (state.showPassword) "Hide password" else "Show password",
                        tint = colors.textTertiary,
                        modifier = Modifier
                            .size(20.dp)
                            .softClickable { vm.toggleShowPassword() },
                    )
                },
                visualTransformation =
                    if (state.showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    imeAction = if (registering) ImeAction.Next else ImeAction.Done,
                ),
                // The keyboard's Done key is the sign-in button. Without this
                // the key just closed the keyboard and left the person
                // hunting for the button under it.
                keyboardActions = KeyboardActions(
                    onDone = {
                        if (!state.canSubmit) return@KeyboardActions
                        when {
                            entering -> vm.submitReset()
                            forgetting -> vm.requestReset()
                            else -> vm.submit()
                        }
                    },
                ),
                modifier = Modifier.fillMaxWidth(),
            )
            }

            // Only the extra fields animate. The email and password rows stay
            // put when the mode changes, so switching does not feel like a
            // different screen.
            AnimatedVisibility(
                visible = registering,
                enter = expandVertically() + fadeIn(),
                exit = shrinkVertically() + fadeOut(),
            ) {
                Column {
                    Spacer(Modifier.height(12.dp))
                    NeuTextField(
                        value = state.username,
                        onValueChange = vm::setUsername,
                        placeholder = "username",
                        verticalPadding = AuthFieldPadding,
                        leading = {
                            Icon(
                                Icons.Rounded.AlternateEmail,
                                null,
                                tint = colors.textTertiary,
                                modifier = Modifier.size(20.dp),
                            )
                        },
                        trailing = {
                            // Only ever a confirmation. "Taken" is said in
                            // words below, because a red mark alone leaves
                            // people guessing what is wrong.
                            if (state.usernameAvailable == true) {
                                Icon(
                                    Icons.Rounded.Check,
                                    "Available",
                                    tint = colors.success,
                                    modifier = Modifier.size(18.dp),
                                )
                            }
                        },
                        keyboardOptions = KeyboardOptions(
                            keyboardType = KeyboardType.Text,
                            capitalization = KeyboardCapitalization.None,
                            imeAction = ImeAction.Next,
                        ),
                        modifier = Modifier.fillMaxWidth(),
                    )

                    if (state.usernameAvailable == false) {
                        Spacer(Modifier.height(6.dp))
                        Text(
                            "That username is taken.",
                            style = MaterialTheme.typography.labelMedium,
                            color = colors.danger,
                        )
                    }

                    Spacer(Modifier.height(12.dp))
                    NeuTextField(
                        value = state.displayName,
                        onValueChange = vm::setDisplayName,
                        placeholder = "Display name (optional)",
                        verticalPadding = AuthFieldPadding,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            ErrorText(state.error)

            Spacer(Modifier.height(20.dp))
            NeuButton(
                onClick = {
                    when {
                        entering -> vm.submitReset()
                        forgetting -> vm.requestReset()
                        else -> vm.submit()
                    }
                },
                enabled = state.canSubmit,
                accent = true,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (state.loading) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = colors.onAccent, strokeWidth = 2.dp)
                } else {
                    Text(
                        when {
                            entering -> "Set new password"
                            forgetting -> "Send the code"
                            registering -> "Create account"
                            else -> "Sign in"
                        },
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.onAccent,
                    )
                }
            }

            if (entering) {
                Spacer(Modifier.height(10.dp))
                Text(
                    "The code lasts 15 minutes. Setting a new password signs out every other device.",
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textTertiary,
                )
            }

            // ── Google ───────────────────────────────────────────────────────
            // Present only when a web client id is configured; a button that
            // opens a sheet which immediately fails is worse than no button.
            if (BuildConfig.GOOGLE_WEB_CLIENT_ID.isNotEmpty() && !forgetting) {
                Spacer(Modifier.height(14.dp))
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    HorizontalDivider(Modifier.weight(1f), color = colors.hairline)
                    Text(
                        "  or  ",
                        style = MaterialTheme.typography.labelSmall,
                        color = colors.textTertiary,
                    )
                    HorizontalDivider(Modifier.weight(1f), color = colors.hairline)
                }
                Spacer(Modifier.height(14.dp))

                val context = LocalContext.current
                val scope = rememberCoroutineScope()
                NeuButton(
                    onClick = {
                        if (state.loading) return@NeuButton
                        scope.launch {
                            try {
                                val option = GetGoogleIdOption.Builder()
                                    .setServerClientId(BuildConfig.GOOGLE_WEB_CLIENT_ID)
                                    // Show every Google account, not only ones
                                    // that have used the app — first-timers
                                    // are the whole point of the button.
                                    .setFilterByAuthorizedAccounts(false)
                                    .build()
                                val request = GetCredentialRequest.Builder()
                                    .addCredentialOption(option)
                                    .build()
                                val result = CredentialManager.create(context)
                                    .getCredential(context, request)
                                val credential = result.credential
                                if (
                                    credential is CustomCredential &&
                                    credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL
                                ) {
                                    val idToken = GoogleIdTokenCredential.createFrom(credential.data).idToken
                                    vm.socialSignIn(idToken)
                                } else {
                                    vm.socialFailed("Google didn't hand back a sign-in. Try again.")
                                }
                            } catch (_: GetCredentialCancellationException) {
                                // The person closed the sheet. Not an error.
                            } catch (_: Exception) {
                                vm.socialFailed("Google sign-in didn't complete. Try again.")
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        "Continue with Google",
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.textPrimary,
                    )
                }
            }

            // Only offered on the way in: somebody halfway through making an
            // account has no password to have forgotten.
            // The text links below sit 18dp apart but each one owns a 48dp
            // hit box, so a thumb aimed at "Forgot your password?" lands on it
            // rather than on the line of nothing beside it. The extra height
            // overlaps the spacing instead of adding to it.
            if (state.mode == AuthMode.SignIn) {
                Spacer(Modifier.height(4.dp))
                TextAction(
                    "Forgot your password?",
                    color = colors.textSecondary,
                    modifier = Modifier.align(Alignment.CenterHorizontally),
                ) { vm.setMode(AuthMode.Forgot) }
            }

            if (forgetting) {
                Spacer(Modifier.height(8.dp))
                TextAction(
                    if (entering) "Use a different address" else "Back to sign in",
                    color = colors.accent,
                    modifier = Modifier.align(Alignment.CenterHorizontally),
                ) { if (entering) vm.backToAsk() else vm.setMode(AuthMode.SignIn) }
            } else {
            Spacer(Modifier.height(8.dp))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.Center,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (registering) "Already have an account?" else "New here?",
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.textSecondary,
                )
                Spacer(Modifier.width(6.dp))
                TextAction(
                    if (registering) "Sign in" else "Make one",
                    color = colors.accent,
                ) { vm.setMode(if (registering) AuthMode.SignIn else AuthMode.Register) }
            }
            }

            Spacer(Modifier.height(8.dp))
            // The links are real now — a "By continuing you agree to…" line that
            // points nowhere is worse than none, because it claims consent to a
            // document the person cannot read. Link annotations rather than the
            // old ClickableText: Text resolves them itself, so they are tappable
            // *and* reachable by TalkBack as links, which the tap-offset
            // approach never was.
            val linkStyle = TextLinkStyles(style = SpanStyle(color = colors.accent))
            val agreement = buildAnnotatedString {
                append("By continuing you agree to the ")
                withLink(LinkAnnotation.Url("$WEB_BASE/terms/", linkStyle)) { append("Terms") }
                append(" and ")
                withLink(LinkAnnotation.Url("$WEB_BASE/privacy/", linkStyle)) { append("Privacy Policy") }
                append(".")
            }
            Text(
                agreement,
                style = MaterialTheme.typography.labelSmall,
                color = colors.textTertiary,
            )
            Spacer(Modifier.height(24.dp))
        }
    }
}

/**
 * A line of text that acts like a button, and is one to the platform.
 *
 * The label is a single line of Grotesk — about 20dp tall — which is under
 * half the target Android asks for. `minimumInteractiveComponentSize` grows
 * the touchable area to 48dp around the text without moving the text, and
 * the role means TalkBack says "button" rather than reading it as prose.
 */
@Composable
private fun TextAction(
    label: String,
    color: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Text(
        label,
        style = MaterialTheme.typography.labelLarge,
        color = color,
        modifier = modifier
            .minimumInteractiveComponentSize()
            .semantics { role = Role.Button }
            .softClickable(onClick = onClick),
    )
}

@Composable
private fun ErrorText(error: String?) {
    val colors = neuColors
    AnimatedVisibility(
        visible = error != null,
        enter = expandVertically() + fadeIn(),
        exit = shrinkVertically() + fadeOut(),
    ) {
        Column {
            Spacer(Modifier.height(10.dp))
            Text(
                error.orEmpty(),
                style = MaterialTheme.typography.bodyMedium,
                color = colors.danger,
            )
        }
    }
}
