package gg.yappy.app.ui.auth

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.ChatBubbleOutline
import androidx.compose.material.icons.rounded.Phone
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import gg.yappy.app.LocalContainer
import gg.yappy.app.R
import gg.yappy.app.ui.components.LogoMark
import gg.yappy.app.ui.components.NeuButton
import gg.yappy.app.ui.components.NeuIconButton
import gg.yappy.app.ui.components.NeuSurface
import gg.yappy.app.ui.components.NeuTextField
import gg.yappy.app.ui.components.softClickable
import gg.yappy.app.ui.theme.Neu
import gg.yappy.app.ui.theme.PlaceShape
import gg.yappy.app.ui.theme.NeuState
import gg.yappy.app.ui.theme.neu
import gg.yappy.app.ui.theme.neuColors

@Composable
fun AuthFlow(onAuthenticated: () -> Unit) {
    val container = LocalContainer.current
    val vm: AuthViewModel = viewModel(factory = AuthViewModel.factory(container))
    val state by vm.state.collectAsStateWithLifecycle()

    if (state.done) {
        onAuthenticated()
        return
    }

    Box(
        Modifier
            .fillMaxSize()
            .systemBarsPadding()
            .imePadding()
            .padding(horizontal = 24.dp),
    ) {
        AnimatedContent(
            targetState = state.step,
            transitionSpec = {
                (slideInHorizontally(tween(280)) { it / 3 } + fadeIn(tween(220))) togetherWith
                    (slideOutHorizontally(tween(280)) { -it / 3 } + fadeOut(tween(180)))
            },
            label = "auth-step",
        ) { step ->
            when (step) {
                AuthStep.Phone -> PhoneStep(state, vm)
                AuthStep.Code -> CodeStep(state, vm)
                AuthStep.Profile -> ProfileStep(state, vm)
            }
        }
    }
}

@Composable
private fun PhoneStep(state: AuthState, vm: AuthViewModel) {
    val colors = neuColors
    Column(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.Center,
    ) {
        // The mark on the brand yellow, in the app's own squircle — the first
        // screen anyone sees, and the only place the launcher icon's colour
        // reappears inside the app, so arriving from the home screen feels
        // like the same product.
        Box(
            Modifier
                .size(84.dp)
                .neu(PlaceShape, colors, NeuState.Raised, 10.dp)
                .clip(PlaceShape)
                .background(colorResource(R.color.brand_yellow)),
            contentAlignment = Alignment.Center,
        ) {
            LogoMark(height = 34.dp, tint = Color.White)
        }

        Spacer(Modifier.height(28.dp))
        Text("Welcome to yappy", style = MaterialTheme.typography.displaySmall, color = colors.textPrimary)
        Spacer(Modifier.height(8.dp))
        Text(
            "Enter your phone number and we'll text you a code.",
            style = MaterialTheme.typography.bodyLarge,
            color = colors.textSecondary,
        )

        Spacer(Modifier.height(32.dp))
        NeuTextField(
            value = state.phone,
            onValueChange = vm::setPhone,
            placeholder = "+1 555 000 0001",
            leading = { Icon(Icons.Rounded.Phone, null, tint = colors.textTertiary, modifier = Modifier.size(20.dp)) },
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
            modifier = Modifier.fillMaxWidth(),
        )

        ErrorText(state.error)

        Spacer(Modifier.height(20.dp))
        NeuButton(
            onClick = vm::requestCode,
            enabled = state.phone.length >= 8 && !state.loading,
            accent = true,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (state.loading) {
                CircularProgressIndicator(Modifier.size(20.dp), color = colors.onAccent, strokeWidth = 2.dp)
            } else {
                Text("Continue", style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
            }
        }

        Spacer(Modifier.height(18.dp))
        Text(
            "By continuing you agree to the Terms and Privacy Policy.",
            style = MaterialTheme.typography.labelSmall,
            color = colors.textTertiary,
        )
    }
}

@Composable
private fun CodeStep(state: AuthState, vm: AuthViewModel) {
    val colors = neuColors
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            NeuIconButton(
                Icons.AutoMirrored.Rounded.ArrowBack,
                "Back",
                onClick = vm::back,
                size = 42.dp,
                iconSize = 19.dp,
            )
        }

        Spacer(Modifier.height(28.dp))
        Text("Enter your code", style = MaterialTheme.typography.headlineMedium, color = colors.textPrimary)
        Spacer(Modifier.height(8.dp))
        Text(
            "Sent to ${state.phone}",
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textSecondary,
        )

        Spacer(Modifier.height(28.dp))
        CodeBoxes(state.code)

        Spacer(Modifier.height(16.dp))
        // The visible boxes above are decoration; this is the real input. Keeping
        // one hidden field avoids the focus-juggling that per-digit fields need
        // and makes SMS autofill work without any extra plumbing.
        NeuTextField(
            value = state.code,
            onValueChange = vm::setCode,
            placeholder = "6-digit code",
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            modifier = Modifier.fillMaxWidth(),
        )

        ErrorText(state.error)

        Spacer(Modifier.height(20.dp))
        NeuButton(
            onClick = vm::verify,
            enabled = state.code.length == 6 && !state.loading,
            accent = true,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (state.loading) {
                CircularProgressIndicator(Modifier.size(20.dp), color = colors.onAccent, strokeWidth = 2.dp)
            } else {
                Text("Verify", style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
            }
        }

        Spacer(Modifier.height(14.dp))
        Text(
            if (state.resendIn > 0) "Resend in ${state.resendIn}s" else "Resend code",
            style = MaterialTheme.typography.labelMedium,
            color = if (state.resendIn > 0) colors.textTertiary else colors.accent,
            modifier = Modifier
                .align(Alignment.CenterHorizontally)
                .padding(8.dp)
                .then(if (state.resendIn == 0) Modifier.softClickable { vm.requestCode() } else Modifier),
        )
    }
}

@Composable
private fun CodeBoxes(code: String) {
    val colors = neuColors
    Row(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        repeat(6) { index ->
            val filled = index < code.length
            Box(
                Modifier
                    .weight(1f)
                    .height(56.dp)
                    .neu(
                        RoundedCornerShape(Neu.CornerSmall),
                        colors,
                        if (filled) NeuState.Raised else NeuState.Pressed,
                        if (filled) 5.dp else 4.dp,
                    ),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    if (filled) code[index].toString() else "",
                    style = MaterialTheme.typography.headlineSmall,
                    color = colors.textPrimary,
                )
            }
        }
    }
}

@Composable
private fun ProfileStep(state: AuthState, vm: AuthViewModel) {
    val colors = neuColors
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center) {
        Text("Pick a handle", style = MaterialTheme.typography.headlineMedium, color = colors.textPrimary)
        Spacer(Modifier.height(8.dp))
        Text(
            "This is how people find and mention you.",
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textSecondary,
        )

        Spacer(Modifier.height(28.dp))
        NeuTextField(
            value = state.displayName,
            onValueChange = vm::setDisplayName,
            placeholder = "Your name",
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(12.dp))
        NeuTextField(
            value = state.username,
            onValueChange = vm::setUsername,
            placeholder = "username",
            leading = { Text("@", color = colors.textTertiary, style = MaterialTheme.typography.bodyLarge) },
            trailing = {
                when (state.usernameAvailable) {
                    true -> Text("free", style = MaterialTheme.typography.labelSmall, color = colors.success)
                    false -> Text("taken", style = MaterialTheme.typography.labelSmall, color = colors.danger)
                    null -> Unit
                }
            },
            modifier = Modifier.fillMaxWidth(),
        )

        ErrorText(state.error)

        Spacer(Modifier.height(20.dp))
        NeuButton(
            onClick = vm::completeProfile,
            enabled = state.username.length >= 3 && state.displayName.isNotBlank() && !state.loading,
            accent = true,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (state.loading) {
                CircularProgressIndicator(Modifier.size(20.dp), color = colors.onAccent, strokeWidth = 2.dp)
            } else {
                Text("Start yapping", style = MaterialTheme.typography.labelLarge, color = colors.onAccent)
            }
        }
    }
}

@Composable
private fun ErrorText(error: String?) {
    if (error == null) return
    val colors = neuColors
    Spacer(Modifier.height(12.dp))
    NeuSurface(
        shape = RoundedCornerShape(Neu.CornerSmall),
        state = NeuState.Pressed,
        elevation = 3.dp,
        contentPadding = 12.dp,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(error, style = MaterialTheme.typography.bodyMedium, color = colors.danger)
    }
}

