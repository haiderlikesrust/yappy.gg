import SwiftUI

/// What you picked, before it is sent.
///
/// Picking a photo used to post it immediately. Every other messenger stops
/// here first, and not for ceremony: the picker is a grid of thumbnails, the
/// wrong one is a tap away from the right one, and an image sent by accident
/// cannot be unsent for the person who already saw it. This is the half-second
/// in which that is still recoverable.
///
/// It is also where the caption belongs. The caption used to be whatever
/// happened to be in the composer when you opened the picker — text written
/// before you chose the picture, silently attached to it and cleared from the
/// box. Written here, it is obviously *about* this image.
struct AttachmentPreview: View {
    @Environment(\.neu) private var colors

    let picked: AttachmentUploader.Picked
    let initialCaption: String
    /// The group's accent, when the conversation carries one — this screen's
    /// send button stands in for the composer's, so it should wear the same
    /// colour. Defaulted, so callers without a group colour change nothing.
    var accentOverride: Color? = nil
    let onCancel: () -> Void
    let onSend: (String?) -> Void

    @State private var caption = ""
    @FocusState private var captionFocused: Bool
    /// Flipped on appear: the picture springs up from slightly small rather
    /// than being cut to, so the jump from a grid of thumbnails to one
    /// full-bleed image reads as the thumbnail growing rather than a scene
    /// change.
    @State private var arrived = false

    var body: some View {
        ZStack {
            image
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .scaleEffect(arrived ? 1 : 0.92)
                .opacity(arrived ? 1 : 0)

            // The controls overlay the photo on gradient scrims — glass at the
            // edges — instead of butting onto the flat dim background above
            // and below it.
            VStack(spacing: 0) {
                header
                    .background { scrim(.top) }
                Spacer(minLength: 0)
                composer
                    .background { scrim(.bottom) }
            }
        }
        // Nearly opaque rather than a dim: the point of this screen is to look
        // at the picture, and a timeline showing through it is exactly what
        // made a mis-tap easy in the first place.
        .background(Color.black.opacity(0.94).ignoresSafeArea())
        .onAppear {
            caption = initialCaption
            withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) { arrived = true }
        }
    }

    /// The glass an edge row sits on: black fading to nothing toward the
    /// picture, so a button stays legible over a bright sky without a bar
    /// being drawn across the photo.
    private func scrim(_ edge: VerticalEdge) -> some View {
        LinearGradient(
            colors: [.black.opacity(0.6), .clear],
            startPoint: edge == .top ? .top : .bottom,
            endPoint: edge == .top ? .bottom : .top
        )
        .ignoresSafeArea(.container, edges: edge == .top ? .top : .bottom)
    }

    private var header: some View {
        HStack(spacing: 12) {
            NeuIconButton(systemName: "xmark", label: "Cancel", size: 42, iconSize: 17, action: onCancel)
            Text(isVideo ? "Send video" : "Send photo")
                .font(YappyFont.titleSmall)
                .foregroundStyle(.white)
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var image: some View {
        if let uiImage = UIImage(data: picked.data) {
            Image(uiImage: uiImage)
                // Fit, not fill. A preview that crops is lying about what will
                // be sent, which defeats the point of showing it.
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.horizontal, 12)
        } else {
            // A video, or something the phone cannot decode into a still. The
            // name and size are what is honestly known about it.
            VStack(spacing: 10) {
                Image(systemName: isVideo ? "film" : "doc")
                    .font(.system(size: 44))
                    .foregroundStyle(.white.opacity(0.8))
                Text(picked.filename)
                    .font(YappyFont.labelMedium)
                    .foregroundStyle(.white.opacity(0.8))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var composer: some View {
        HStack(spacing: 10) {
            NeuTextField(text: $caption, placeholder: "Add a caption")
                .focused($captionFocused)

            NeuIconButton(
                systemName: "arrow.up",
                label: "Send",
                size: 52,
                iconSize: 20,
                accent: true,
                fillColor: accentOverride
            ) {
                onSend(caption.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? nil
                    : caption.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    private var isVideo: Bool { picked.mimeType.hasPrefix("video/") }
}
