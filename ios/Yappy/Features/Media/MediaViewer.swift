import SwiftUI
import UIKit

/// One image in the viewer, plus the context needed to caption and share it.
///
/// A flat struct rather than passing `Message` around: the viewer opens from the
/// timeline *and* from the media wall, and those carry different shapes.
/// Flattening at the call site keeps the viewer from knowing about either.
struct ViewerItem: Identifiable, Hashable {
    let id: String
    let url: String
    var caption: String?
    var senderName: String?
    var filename: String?
}

/// Full-screen media.
///
/// Presented as a cover rather than a navigation destination on purpose: it
/// opens from the timeline, the media wall and (later) profiles, and routing it
/// would mean every one of those needing a route argument big enough to carry a
/// list of images. As a cover it composes over whatever is already on screen and
/// the back stack is untouched.
///
/// Gestures follow what every photo viewer does, because this is the one place
/// where being unsurprising beats being distinctive:
///   · pinch to zoom, drag to pan while zoomed
///   · double-tap toggles 1× and 2.5×
///   · drag down at 1× dismisses, with the background fading as you go
struct MediaViewer: View {
    let items: [ViewerItem]
    let onDismiss: () -> Void

    /// Seeded in `init` rather than corrected in `onAppear`, which runs after
    /// the pager has already laid out and drawn page zero — opening the seventh
    /// photo on a wall showed the first one and then jumped.
    @State private var index: Int

    init(items: [ViewerItem], initialIndex: Int, onDismiss: @escaping () -> Void) {
        self.items = items
        self.onDismiss = onDismiss
        _index = State(initialValue: min(max(initialIndex, 0), max(items.count - 1, 0)))
    }

    /// How far the current page has been dragged down. Drives both the dismiss
    /// threshold and the scrim's opacity, so the gesture explains itself as it
    /// happens.
    @State private var dragY: CGFloat = 0
    /// Hoisted out of the image so paging can stand down while one is zoomed.
    @State private var zoomed = false
    /// The photo is for looking at; the buttons and the caption are for acting
    /// on it. One tap puts the furniture away, another brings it back.
    @State private var chromeHidden = false

    /// Items already written to the photo library this presentation, so the
    /// button can answer with a checkmark instead of silently writing twice.
    @State private var saved: Set<String> = []
    @State private var saving = false
    /// `UIImageWriteToSavedPhotosAlbum` calls back through a target/selector;
    /// held in state so the target outlives the write.
    @State private var saveRelay: SaveRelay?

    /// A `Double` because it only ever feeds `opacity`, and mixing CGFloat into
    /// that expression makes the literal `1` ambiguous.
    private var dismissProgress: Double { min(Double(abs(dragY)) / 600, 1) }

    var body: some View {
        ZStack {
            Color.black
                .opacity(1 - dismissProgress * 0.7)
                .ignoresSafeArea()

            TabView(selection: $index) {
                ForEach(Array(items.enumerated()), id: \.element.id) { position, item in
                    ZoomableImage(
                        url: item.url,
                        onDragged: { dragY = $0 },
                        onZoomChanged: { zoomed = $0 },
                        onTap: { chromeHidden.toggle() },
                        onDismiss: onDismiss
                    )
                    .tag(position)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            // Deliberately *not* `.disabled(zoomed)`. That was meant to stop a
            // pan on a zoomed photo flipping to the next one, but `disabled`
            // propagates through the whole subtree — it switched off the pinch,
            // the pan and the double-tap inside the image as well. Zooming in
            // was therefore permanent: nothing left could zoom back out, and
            // since only those gestures clear `zoomed`, the only way out of the
            // viewer was the Close button. `ZoomableImage` already swallows the
            // drag itself once it is zoomed, which is the part that mattered.

            VStack {
                chrome
                Spacer()
                caption
            }
            // Faded rather than removed, so bringing it back is a reappearance
            // in place and not a relayout. Hit-testing goes with it: an
            // invisible Close button that still swallows taps would make the
            // photo unresponsive in exactly the corners people tap.
            .opacity(chromeHidden ? 0 : 1)
            .animation(.easeInOut(duration: 0.2), value: chromeHidden)
            .allowsHitTesting(!chromeHidden)
        }
        .statusBarHidden()
    }

    private var chrome: some View {
        HStack {
            ViewerButton(systemName: "xmark", label: "Close", action: onDismiss)
            Spacer()
            if items.count > 1 {
                Text("\(index + 1) / \(items.count)")
                    .font(YappyFont.labelLarge)
                    .foregroundStyle(.white.opacity(0.85))
                Spacer()
            }
            if let current = items[safe: index] {
                ViewerButton(
                    systemName: saved.contains(current.id) ? "checkmark" : "arrow.down.to.line",
                    label: "Save to Photos"
                ) { save(current) }
                .opacity(saving ? 0.5 : 1)
                .padding(.trailing, 10)

                // Sharing the URL rather than the bytes: the file lives in a
                // private bucket behind an authorised route, so handing another
                // app the link is the honest thing — it will only resolve for
                // someone who may see it.
                ShareLink(item: URL(string: current.url) ?? URL(string: "https://yappy.gg")!) {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(.white.opacity(0.14), in: Circle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    /// Save the picture to the photo library.
    ///
    /// The bytes come from `ImageLoader` — the same authed, cached pipeline
    /// that put the image on screen — so a save is usually a cache hit and
    /// never leaks the session token to a foreign host. Failure is silent by
    /// design: the viewer has no chrome for errors, and the write asks for
    /// add-only photo permission on its own (the purpose string is in the
    /// Info.plist).
    private func save(_ item: ViewerItem) {
        guard !saving, !saved.contains(item.id) else { return }
        saving = true
        Task {
            guard let loaded = await ImageLoader.shared.load(item.url) else {
                saving = false
                return
            }
            // A GIF decodes to an animated UIImage; the photo write wants a
            // still, so take the first frame rather than leaving UIKit to guess.
            let image = loaded.images?.first ?? loaded
            let relay = SaveRelay { ok in
                saving = false
                // Animated so the button's `.symbolEffect(.replace)` has a
                // transaction to ride — without one the arrow just becomes a
                // checkmark between frames.
                if ok { withAnimation { saved.insert(item.id) } }
            }
            saveRelay = relay
            UIImageWriteToSavedPhotosAlbum(
                image,
                relay,
                #selector(SaveRelay.image(_:didFinishSavingWithError:contextInfo:)),
                nil
            )
        }
    }

    @ViewBuilder
    private var caption: some View {
        if let current = items[safe: index],
           current.senderName != nil || !(current.caption ?? "").isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                if let sender = current.senderName {
                    Text(sender)
                        .font(YappyFont.labelMedium)
                        .foregroundStyle(.white.opacity(0.7))
                }
                if let caption = current.caption, !caption.isEmpty {
                    Text(caption)
                        .font(YappyFont.bodyLarge)
                        .foregroundStyle(.white)
                        .lineLimit(4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .background(.black.opacity(0.45))
        }
    }
}

/// The completion target `UIImageWriteToSavedPhotosAlbum` requires: an NSObject
/// with exactly this selector. A wrong or missing selector there is a crash,
/// which is why the callback is not optional sugar.
private final class SaveRelay: NSObject {
    private let done: (Bool) -> Void

    init(done: @escaping (Bool) -> Void) {
        self.done = done
    }

    @objc func image(_ image: UIImage, didFinishSavingWithError error: NSError?, contextInfo: UnsafeRawPointer) {
        done(error == nil)
    }
}

private struct ViewerButton: View {
    let systemName: String
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(.white)
                // The arrow becomes a checkmark by replacement rather than by
                // redraw, so a save reads as the same button answering instead
                // of a different button appearing.
                .contentTransition(.symbolEffect(.replace))
                .frame(width: 40, height: 40)
                .background(.white.opacity(0.14), in: Circle())
                .contentShape(Circle())
        }
        .buttonStyle(ViewerPress())
        .accessibilityLabel(label)
    }
}

/// The viewer's press: the same small dip `softPress` gives buttons on the
/// sheet, rebuilt plainly here because these float on a photograph — the neu
/// treatment itself stays home.
private struct ViewerPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.92 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private struct ZoomableImage: View {
    let url: String
    let onDragged: (CGFloat) -> Void
    let onZoomChanged: (Bool) -> Void
    /// A single tap on the photo — the viewer uses it to put the chrome away.
    let onTap: () -> Void
    let onDismiss: () -> Void

    @State private var scale: CGFloat = 1
    @State private var committedScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var committedOffset: CGSize = .zero
    @State private var dragY: CGFloat = 0
    /// Past the point where letting go dismisses. Tracked so the tick fires
    /// once per gesture, on the way in, rather than on every frame.
    @State private var armed = false

    /// Far enough that a resting thumb never trips it, close enough that a
    /// deliberate pull does not feel refused.
    private let commit: CGFloat = 220

    var body: some View {
        GeometryReader { geometry in
            RemoteImage(url: url, contentMode: .fit)
                .frame(width: geometry.size.width, height: geometry.size.height)
                .scaleEffect(scale)
                .offset(
                    x: offset.width,
                    y: scale > 1 ? offset.height : dragY
                )
                .gesture(magnify(in: geometry.size))
                .simultaneousGesture(pan(in: geometry.size))
                .onTapGesture(count: 2) { toggleZoom() }
                // Declared after the double-tap on purpose: with both present
                // SwiftUI waits out the double before delivering the single,
                // so hiding the chrome cannot eat the zoom.
                .onTapGesture { onTap() }
        }
    }

    private func magnify(in size: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                scale = min(max(committedScale * value.magnification, 1), 5)
                onZoomChanged(scale > 1)
            }
            .onEnded { _ in
                committedScale = scale
                if scale <= 1 {
                    // Snapping back is animated so a released pinch settles
                    // rather than jumps.
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                        offset = .zero
                    }
                    committedOffset = .zero
                }
                onZoomChanged(scale > 1)
            }
    }

    /// At 1× a decisively vertical drag means "put this away"; anything else
    /// belongs to the pager. Once zoomed, the same gesture pans the picture and
    /// is clamped to the scaled bounds so it cannot be dragged into empty space.
    private func pan(in size: CGSize) -> some Gesture {
        DragGesture()
            .onChanged { value in
                if scale > 1 {
                    let maxX = size.width * (scale - 1) / 2
                    let maxY = size.height * (scale - 1) / 2
                    offset = CGSize(
                        width: min(max(committedOffset.width + value.translation.width, -maxX), maxX),
                        height: min(max(committedOffset.height + value.translation.height, -maxY), maxY)
                    )
                } else if value.translation.height > 0 {
                    dragY = value.translation.height
                    onDragged(dragY)
                    // The tick at the moment letting go would dismiss — the
                    // gesture says what it will do before it does it.
                    if dragY > commit, !armed {
                        armed = true
                        Haptics.tap()
                    }
                }
            }
            .onEnded { value in
                armed = false
                if scale > 1 {
                    committedOffset = offset
                    return
                }
                // Predicted rather than actual: a flick travels a short
                // distance fast, and it means "away" just as clearly as a
                // long slow pull does.
                if value.predictedEndTranslation.height > commit {
                    // Carry the photo off the bottom before the cover goes,
                    // so the dismissal reads as the throw finishing rather
                    // than the picture blinking out. The dismiss itself waits
                    // for the exit — called cold, it tore the view down on
                    // the first frame of the slide.
                    withAnimation(.easeIn(duration: 0.18)) {
                        dragY = size.height
                        onDragged(size.height)
                    }
                    Task {
                        try? await Task.sleep(for: .milliseconds(180))
                        onDismiss()
                    }
                    return
                }
                // Released without committing: settle back.
                withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { dragY = 0 }
                onDragged(0)
            }
    }

    private func toggleZoom() {
        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
            if scale > 1 {
                scale = 1
                offset = .zero
            } else {
                scale = 2.5
            }
            committedScale = scale
            committedOffset = offset
        }
        onZoomChanged(scale > 1)
    }
}

extension Array {
    /// Bounds-checked lookup. The viewer indexes by page and a page can be one
    /// past the end for a frame while the list shrinks under it.
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
