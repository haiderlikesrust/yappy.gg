package gg.yappy.app.ui.auth

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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.ClickableText
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
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
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import gg.yappy.app.BuildConfig
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

    Box(
        Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .imePadding()
            .padding(horizontal = 24.dp),
    ) {
        Column(
            Modifier
                .fillMaxSize()
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
                if (registering) "Make an account" else "Welcome back",
                style = MaterialTheme.typography.displaySmall,
                color = colors.textPrimary,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                if (registering) {
                    "Pick a username your friends will recognise."
                } else {
                    "Sign in with your email and password."
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

            Spacer(Modifier.height(12.dp))

            NeuTextField(
                value = state.password,
                onValueChange = vm::setPassword,
                placeholder = if (registering) "At least 8 characters" else "Password",
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
                modifier = Modifier.fillMaxWidth(),
            )

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
                onClick = vm::submit,
                enabled = state.canSubmit,
                accent = true,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (state.loading) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = colors.onAccent, strokeWidth = 2.dp)
                } else {
                    Text(
                        if (registering) "Create account" else "Sign in",
                        style = MaterialTheme.typography.labelLarge,
                        color = colors.onAccent,
                    )
                }
            }

            Spacer(Modifier.height(18.dp))
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
                Text(
                    if (registering) "Sign in" else "Make one",
                    style = MaterialTheme.typography.labelLarge,
                    color = colors.accent,
                    modifier = Modifier.softClickable {
                        vm.setMode(if (registering) AuthMode.SignIn else AuthMode.Register)
                    },
                )
            }

            Spacer(Modifier.height(18.dp))
            // The links are real now — a "By continuing you agree to…" line that
            // points nowhere is worse than none, because it claims consent to a
            // document the person cannot read.
            val agreement = buildAnnotatedString {
                append("By continuing you agree to the ")
                pushStringAnnotation("url", "$WEB_BASE/terms/")
                withStyle(SpanStyle(color = colors.accent)) { append("Terms") }
                pop()
                append(" and ")
                pushStringAnnotation("url", "$WEB_BASE/privacy/")
                withStyle(SpanStyle(color = colors.accent)) { append("Privacy Policy") }
                pop()
                append(".")
            }
            val uriHandler = LocalUriHandler.current
            ClickableText(
                text = agreement,
                style = MaterialTheme.typography.labelSmall.copy(color = colors.textTertiary),
                onClick = { offset ->
                    agreement.getStringAnnotations("url", offset, offset).firstOrNull()
                        ?.let { runCatching { uriHandler.openUri(it.item) } }
                },
            )
            Spacer(Modifier.height(24.dp))
        }
    }
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
