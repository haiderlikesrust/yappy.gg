import SwiftUI

/// The component vocabulary.
///
/// Every interactive element animates between raised and pressed on touch
/// instead of drawing a highlight — a grey wash over a soft-shadowed surface
/// reads as a smudge. The state change *is* the feedback, and it is a better
/// one, because it matches the physical metaphor the whole style is built on.

// ── Press tracking ───────────────────────────────────────────────────────────

/// Tap and long-press with no system highlight, reporting the held state so the
/// component can sink while a finger is down.
///
/// Written with `onLongPressGesture(maximumDistance:)` rather than a
/// `DragGesture` so a touch that turns into a scroll cancels the press instead
/// of leaving a row stuck in its pressed state halfway up the screen.
private struct SoftPress: ViewModifier {
    var enabled: Bool = true
    var onTap: (() -> Void)?
    var onLongPress: (() -> Void)?
    @Binding var isPressed: Bool

    func body(content: Content) -> some View {
        content
            .contentShape(Rectangle())
            .onLongPressGesture(
                minimumDuration: onLongPress == nil ? 10 : 0.4,
                maximumDistance: 18,
                perform: { if enabled { onLongPress?() } },
                onPressingChanged: { pressing in
                    guard enabled else { return }
                    withAnimation(.spring(response: 0.18, dampingFraction: 0.7)) {
                        isPressed = pressing
                    }
                }
            )
            .simultaneousGesture(
                TapGesture().onEnded { if enabled { onTap?() } }
            )
            .allowsHitTesting(enabled || onTap == nil)
    }
}

extension View {
    /// Tap target with no highlight, for text and rows that are not full
    /// components. Several screens need it directly.
    func softTap(enabled: Bool = true, action: @escaping () -> Void) -> some View {
        contentShape(Rectangle())
            .onTapGesture { if enabled { action() } }
            .opacity(enabled ? 1 : 0.5)
    }

    fileprivate func softPress(
        enabled: Bool = true,
        isPressed: Binding<Bool>,
        onTap: (() -> Void)?,
        onLongPress: (() -> Void)? = nil
    ) -> some View {
        modifier(SoftPress(enabled: enabled, onTap: onTap, onLongPress: onLongPress, isPressed: isPressed))
    }
}

// ── Surface ──────────────────────────────────────────────────────────────────

struct NeuSurface<Content: View>: View {
    @Environment(\.neu) private var colors

    var radius: CGFloat = Neu.cornerMedium
    var state: NeuState = .raised
    var elevation: CGFloat = 6
    var fill: Color?
    var contentPadding: CGFloat = 16
    var onTap: (() -> Void)?
    var onLongPress: (() -> Void)?
    @ViewBuilder var content: () -> Content

    @State private var pressed = false

    var body: some View {
        let shape = NeuShape(radius: radius)
        // Springs, not curves: the shadow should settle the way a physical key
        // does.
        let depth = (pressed && onTap != nil) ? elevation / 2 : elevation

        content()
            .padding(contentPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .neu(shape, colors, state: state, elevation: depth, fill: fill)
            .contentShape(shape)
            .softPress(isPressed: $pressed, onTap: onTap, onLongPress: onLongPress)
    }
}

// ── Buttons ──────────────────────────────────────────────────────────────────

struct NeuButton<Content: View>: View {
    @Environment(\.neu) private var colors

    var enabled: Bool = true
    var radius: CGFloat = Neu.cornerMedium
    var accent: Bool = false
    var elevation: CGFloat = 7
    var action: () -> Void
    @ViewBuilder var content: () -> Content

    @State private var pressed = false

    var body: some View {
        let shape = NeuShape(radius: radius)

        HStack(spacing: 8) { content() }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 20)
            .padding(.vertical, 14)
            .neu(
                shape,
                colors,
                state: pressed ? .pressed : .raised,
                elevation: pressed ? 2 : elevation,
                fill: accent ? colors.accent : nil,
                gradient: accent ? colors.accentGradient : nil,
                glow: accent ? colors.accent : nil
            )
            .opacity(enabled ? 1 : 0.45)
            .contentShape(shape)
            .softPress(enabled: enabled, isPressed: $pressed, onTap: action)
    }
}

struct NeuIconButton: View {
    @Environment(\.neu) private var colors

    let systemName: String
    var label: String?
    var size: CGFloat = 46
    var iconSize: CGFloat = 21
    var tint: Color?
    var accent: Bool = false
    /// Overrides the accent fill — how a group's own colour reaches buttons.
    var fillColor: Color?
    /// Sticky on/off state, e.g. a mute toggle during a call.
    var active: Bool = false
    var enabled: Bool = true
    let action: () -> Void

    @State private var pressed = false

    var body: some View {
        let held = pressed || active
        let fill = fillColor ?? (accent ? colors.accent : nil)
        let resolvedTint: Color = tint ?? {
            if fill != nil { return colors.onAccent }
            if active { return colors.accent }
            return colors.textSecondary
        }()

        Image(systemName: systemName)
            .font(.system(size: iconSize, weight: .medium))
            .foregroundStyle(resolvedTint)
            .frame(width: size, height: size)
            .neu(
                Circle(),
                colors,
                state: held ? .pressed : .raised,
                elevation: held ? 3 : 6,
                fill: fill,
                gradient: fillColor == nil && accent ? colors.accentGradient : nil,
                glow: fill
            )
            .opacity(enabled ? 1 : 0.4)
            .contentShape(Circle())
            .softPress(enabled: enabled, isPressed: $pressed, onTap: action)
            .accessibilityLabel(label ?? "")
    }
}

// ── Text input ───────────────────────────────────────────────────────────────

/// Always pressed — an input is a hole in the sheet you drop text into. Raising
/// it makes it look like a button, which is the single most common neumorphic
/// affordance failure.
struct NeuTextField<Leading: View, Trailing: View>: View {
    @Environment(\.neu) private var colors

    @Binding var text: String
    var placeholder: String = ""
    var radius: CGFloat = Neu.cornerMedium
    var multiline: Bool = false
    var lineLimit: Int = 5
    var secure: Bool = false
    var font: Font = YappyFont.bodyLarge
    /// Height, in effect. Raised on the auth screen, where two or three fields
    /// are the entire page and a compact list row's proportions read as cramped
    /// rather than tidy. Everywhere else the field sits among other content and
    /// the tighter default is right.
    var verticalPadding: CGFloat = 12
    var keyboard: UIKeyboardType = .default
    var autocapitalization: TextInputAutocapitalization = .sentences
    var submitLabel: SubmitLabel = .return
    var onSubmit: (() -> Void)?
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack(spacing: 10) {
            leading()

            ZStack(alignment: .leading) {
                if text.isEmpty {
                    Text(placeholder)
                        .font(font)
                        .foregroundStyle(colors.textTertiary)
                        .allowsHitTesting(false)
                }
                field
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            trailing()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, verticalPadding)
        .neu(NeuShape(radius: radius), colors, state: .pressed, elevation: 5)
    }

    @ViewBuilder
    private var field: some View {
        if secure {
            SecureField("", text: $text)
                .textFieldStyle(.plain)
                .font(font)
                .foregroundStyle(colors.textPrimary)
                .tint(colors.accent)
                .submitLabel(submitLabel)
                .onSubmit { onSubmit?() }
        } else if multiline {
            TextField("", text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1 ... lineLimit)
                .font(font)
                .foregroundStyle(colors.textPrimary)
                .tint(colors.accent)
                .keyboardType(keyboard)
                .textInputAutocapitalization(autocapitalization)
        } else {
            TextField("", text: $text)
                .textFieldStyle(.plain)
                .font(font)
                .foregroundStyle(colors.textPrimary)
                .tint(colors.accent)
                .keyboardType(keyboard)
                .textInputAutocapitalization(autocapitalization)
                .autocorrectionDisabled(keyboard == .emailAddress)
                .submitLabel(submitLabel)
                .onSubmit { onSubmit?() }
        }
    }
}

extension NeuTextField where Leading == EmptyView, Trailing == EmptyView {
    init(
        text: Binding<String>,
        placeholder: String = "",
        radius: CGFloat = Neu.cornerMedium,
        multiline: Bool = false,
        lineLimit: Int = 5,
        secure: Bool = false,
        font: Font = YappyFont.bodyLarge,
        verticalPadding: CGFloat = 12,
        keyboard: UIKeyboardType = .default,
        autocapitalization: TextInputAutocapitalization = .sentences,
        submitLabel: SubmitLabel = .return,
        onSubmit: (() -> Void)? = nil
    ) {
        self.init(
            text: text,
            placeholder: placeholder,
            radius: radius,
            multiline: multiline,
            lineLimit: lineLimit,
            secure: secure,
            font: font,
            verticalPadding: verticalPadding,
            keyboard: keyboard,
            autocapitalization: autocapitalization,
            submitLabel: submitLabel,
            onSubmit: onSubmit,
            leading: { EmptyView() },
            trailing: { EmptyView() }
        )
    }
}

extension NeuTextField where Trailing == EmptyView {
    init(
        text: Binding<String>,
        placeholder: String = "",
        radius: CGFloat = Neu.cornerMedium,
        multiline: Bool = false,
        lineLimit: Int = 5,
        secure: Bool = false,
        font: Font = YappyFont.bodyLarge,
        verticalPadding: CGFloat = 12,
        keyboard: UIKeyboardType = .default,
        autocapitalization: TextInputAutocapitalization = .sentences,
        submitLabel: SubmitLabel = .return,
        onSubmit: (() -> Void)? = nil,
        @ViewBuilder leading: @escaping () -> Leading
    ) {
        self.init(
            text: text,
            placeholder: placeholder,
            radius: radius,
            multiline: multiline,
            lineLimit: lineLimit,
            secure: secure,
            font: font,
            verticalPadding: verticalPadding,
            keyboard: keyboard,
            autocapitalization: autocapitalization,
            submitLabel: submitLabel,
            onSubmit: onSubmit,
            leading: leading,
            trailing: { EmptyView() }
        )
    }
}

// ── Chip, switch, labels ─────────────────────────────────────────────────────

struct NeuChip: View {
    @Environment(\.neu) private var colors

    let label: String
    let selected: Bool
    var leadingEmoji: String?
    let action: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            if let leadingEmoji { Text(leadingEmoji).font(YappyFont.labelMedium) }
            Text(label)
                .font(YappyFont.labelMedium)
                .foregroundStyle(selected ? colors.accent : colors.textSecondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .neu(
            NeuShape(radius: Neu.cornerPill),
            colors,
            state: selected ? .pressed : .raised,
            elevation: selected ? 3 : 5
        )
        .scaleEffect(selected ? 1.03 : 1)
        .animation(.spring(response: 0.3, dampingFraction: 0.55), value: selected)
        .contentShape(Capsule())
        .onTapGesture(perform: action)
    }
}

/// The track is always recessed and only the knob is raised — that is what makes
/// it read as a physical slider sitting in a groove.
struct NeuSwitch: View {
    @Environment(\.neu) private var colors

    @Binding var isOn: Bool

    var body: some View {
        ZStack(alignment: isOn ? .trailing : .leading) {
            Capsule()
                .fill(Color.clear)
                .frame(width: 48, height: 28)
                .neu(NeuShape(radius: Neu.cornerPill), colors, state: .pressed, elevation: 4)

            Circle()
                .fill(Color.clear)
                .frame(width: 24, height: 24)
                .neu(
                    Circle(), colors, state: .raised, elevation: 3,
                    fill: isOn ? colors.accent : nil,
                    gradient: isOn ? colors.accentGradient : nil,
                    glow: isOn ? colors.accent : nil
                )
                .padding(.horizontal, 2)
        }
        .frame(width: 48, height: 28)
        .contentShape(Capsule())
        .onTapGesture {
            withAnimation(.spring(response: 0.28, dampingFraction: 0.65)) { isOn.toggle() }
        }
    }
}

struct SectionLabel: View {
    @Environment(\.neu) private var colors
    let text: String
    /// A hoisted role heads its own section in its own colour.
    var color: Color?

    var body: some View {
        Text(text.uppercased())
            .font(YappyFont.labelSmall)
            .tracking(0.3)
            .foregroundStyle(color ?? colors.textTertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 6)
            .padding(.bottom, 8)
    }
}

/// Presence indicator. The surface-coloured ring keeps it legible over avatars.
struct PresenceDot: View {
    @Environment(\.neu) private var colors
    let status: String
    var size: CGFloat = 12

    var body: some View {
        let color: Color = {
            switch status {
            case "online": return colors.success
            case "idle": return colors.warning
            case "dnd": return colors.danger
            default: return colors.textTertiary
            }
        }()

        Circle()
            .fill(colors.surface)
            .frame(width: size, height: size)
            .overlay(Circle().fill(color).padding(size * 0.21))
    }
}

/// A hairline etched into the sheet rather than drawn on top of it.
struct NeuHairline: View {
    @Environment(\.neu) private var colors

    var body: some View {
        Rectangle()
            // The token, not a hand-mixed opacity: `hairline` flips to a
            // light-tinted line in dark, where dark-on-dark simply vanished.
            .fill(colors.hairline)
            .frame(height: 1)
    }
}

/// The app's spinner: a trimmed arc of the brand gradient, turning.
///
/// Loading is where people stare, so it is one of the few places the brand
/// gradient earns screen time. A `tint` keeps a solid arc instead — it exists
/// for spinners sitting on accent fills, where violet-to-teal would vanish.
struct NeuSpinner: View {
    @Environment(\.neu) private var colors
    var tint: Color?
    var size: CGFloat = 20

    @State private var turning = false

    var body: some View {
        Circle()
            .trim(from: 0.14, to: 1)
            .stroke(
                arcStyle,
                style: StrokeStyle(lineWidth: max(size * 0.14, 2), lineCap: .round)
            )
            .frame(width: size, height: size)
            .rotationEffect(.degrees(turning ? 360 : 0))
            .animation(.linear(duration: 0.85).repeatForever(autoreverses: false), value: turning)
            .onAppear { turning = true }
            .accessibilityLabel("Loading")
    }

    private var arcStyle: AnyShapeStyle {
        if let tint { return AnyShapeStyle(tint) }
        return AnyShapeStyle(AngularGradient(
            colors: [colors.accent, Color(hex: 0x00CEC9), colors.accent],
            center: .center
        ))
    }
}
