import Foundation

/// Things that are built but not switched on.
///
/// A flag here means the code below it is finished and wired — it is the way
/// *in* that is closed, not the feature that is missing. Deleting the screens
/// instead would make turning one back on a rewrite; this way it is one line.
enum Feature {
    /// Voice and video calls.
    ///
    /// The whole stack is real and works: CallKit, the VoIP push, LiveKit, the
    /// ring, the in-call screen, the summary card a call leaves behind. iOS is
    /// simply not shipping it yet.
    ///
    /// Off closes both directions.
    ///
    /// Out: the two buttons in a chat header, the hangout button on a group,
    /// the (actionless) Call button on a profile, and the "Live" badge in the
    /// conversation list — a badge is only worth showing to somebody who can
    /// act on it.
    ///
    /// In: the socket's `call.ring` is ignored, and — the part that matters —
    /// `CallSystem` does not register for VoIP push at all. A delivered VoIP
    /// push *must* be reported to CallKit or iOS kills the app and eventually
    /// stops delivering VoIP to this bundle for good, so the only safe way not
    /// to ring is to never be sent one.
    ///
    /// Android still has calling, so an Android caller can still ring an
    /// iPhone. Nothing will happen on this end and they will wait out the
    /// timeout with no explanation. That is the known cost of this flag.
    ///
    /// Turning it back on restores all of it. Nothing else has to change.
    static let calling = false
}
