import SwiftUI
import UIKit

/// The group pet: a pixel creature, drawn from character grids, animated by
/// flipping between two frames the way a Tamagotchi did.
///
/// Sprites are code, not assets — each frame is sixteen strings of sixteen
/// characters, one character per pixel, so the art is diffable, palette-swaps
/// with the group's identity colour, and never ships a PNG. The vocabulary:
///
///   .  transparent      o  outline          b  body (identity colour)
///   B  body shade       w  white            p  pink (tongue, inner ear)
///   e  eye              y  brand yellow (sparkles, crown)
///
/// Species is derived from the conversation id: half the world's groups get a
/// dog, half a cat, nobody chooses and everybody agrees.
///
/// Kept in step with android/.../ui/components/PixelPet.kt — the grids are
/// copied verbatim, and the species derivation reproduces Kotlin's hash so both
/// platforms draw the same creature for the same group.

enum PetSpecies {
    case dog
    case cat
}

/// Kotlin/Java `String.hashCode()`: h = 31·h + c over UTF-16 code units, with
/// Int32 overflow wrapping. Android picks the species from its own
/// `String.hashCode()`, so parity means reproducing that exact arithmetic —
/// Swift's `hashValue` is per-process seeded and useless here.
func javaHashCode(_ s: String) -> Int32 {
    var h: Int32 = 0
    for unit in s.utf16 {
        h = 31 &* h &+ Int32(unit)
    }
    return h
}

func petSpecies(conversationId: String) -> PetSpecies {
    (javaHashCode(conversationId) & 1) == 0 ? .dog : .cat
}

// ─── Sprites ─────────────────────────────────────────────────────────────────

private let eggFrames: [[String]] = [
    [
        "................",
        "................",
        "......oooo......",
        ".....obbbbo.....",
        "....obbwbbbo....",
        "...obbwbbbbbo...",
        "...obbbbbbbbo...",
        "..obbbbbbbbbbo..",
        "..obbBbbbbBbbo..",
        "..obbbbbbbbbbo..",
        "..obBbbbbbbBbo..",
        "...obbbbbbbbo...",
        "....oobbbboo....",
        "......oooo......",
        "................",
        "................",
    ],
    [
        "................",
        "................",
        "................",
        "......oooo......",
        ".....obbbbo.....",
        "....obbwbbbo....",
        "...obbwbbbbbo...",
        "...obbbbbbbbo...",
        "..obbbbbbbbbbo..",
        "..obbBbbbbBbbo..",
        "..obbbbbbbbbbo..",
        "..obBbbbbbbBbo..",
        "...obbbbbbbbo...",
        ".....oooooo.....",
        "................",
        "................",
    ],
]

// Dog: floppy ears, big muzzle. Frame two lifts the ears and wags.
private func dogFrames(mood: String) -> [[String]] {
    // Rows 10-11 are the mouth region, swapped per mood.
    func body(_ earUp: Bool, _ mouthA: String, _ mouthB: String) -> [String] {
        let e1 = earUp ? "..oo........oo.." : "................"
        let e2 = earUp ? ".obbo......obbo." : "..oo........oo.."
        let e3 = earUp ? ".obBbo....obBbo." : ".obbo......obbo."
        return [
            "................",
            e1,
            e2,
            e3,
            ".obBbooooooBbbo.",
            ".obbobbbbbbobbo.",
            "..oobbbbbbbboo..",
            "..obbebbbbebbo..",
            "..obbbbbbbbbbo..",
            "..obbbBooBbbbo..",
            mouthA,
            mouthB,
            "...obbbbbbbbo...",
            "....oooooooo....",
            "................",
            "................",
        ]
    }
    switch mood {
    case "happy":
        return [
            body(false, "..obbboppobbbo..", "...obbboppbbo..."),
            body(true, "..obbboppobbbo..", "...obbbbppbo...."),
        ]
    case "hungry":
        return [
            body(false, "..obbbboobbbbo..", "...obbbbbbbbo..."),
            body(false, "..obbboooobbbo..", "...obbbbbbbbo..."),
        ]
    default: // sad
        return [
            body(false, "..obbbboobbbbo..", "...obbboobbbo..."),
            body(false, "..obbbboobbbbo..", "...obbboobbbo..."),
        ]
    }
}

// Cat: pointed ears, small mouth. Frame two flicks an ear and the tail.
private func catFrames(mood: String) -> [[String]] {
    func body(_ flick: Bool, _ mouthA: String, _ mouthB: String) -> [String] {
        let e1 = flick ? "..o..........o.." : "..o.........o..."
        let e2 = flick ? "..opo......opo.." : "..opo......opo.."
        return [
            "................",
            e1,
            e2,
            "..obpo....obpo..",
            "..obboooooobbo..",
            ".obbbbbbbbbbbbo.",
            ".obebbbbbbbebbo.",
            ".obbbbbbbbbbbbo.",
            "..obbBwbbwBbbo..",
            mouthA,
            mouthB,
            "..obbbbbbbbbbo..",
            "...obbbbbbbbo...",
            "....oooooooo....",
            "................",
            "................",
        ]
    }
    switch mood {
    case "happy":
        return [
            body(false, "..obbbopbobbbo..", "...obbbbbbbbo..."),
            body(true, "..obbbobpobbbo..", "...obbbbbbbbo..."),
        ]
    case "hungry":
        return [
            body(false, "..obbbboobbbbo..", "...obbbbbbbbo..."),
            body(true, "..obbbboobbbbo..", "...obbbbbbbbo..."),
        ]
    default: // sad
        return [
            body(false, "..obbboBBobbbo..", "...obbbbbbbbo..."),
            body(false, "..obbboBBobbbo..", "...obbbbbbbbo..."),
        ]
    }
}

// Wandered off: an empty spot — footprints trailing away and a question.
private let goneFrames: [[String]] = [
    [
        "................",
        "......ww........",
        ".....w..w.......",
        "........w.......",
        ".......w........",
        ".......w........",
        "................",
        ".......w........",
        "................",
        "..BB............",
        "..BB....BB......",
        "........BB......",
        "............BB..",
        "............BB..",
        "................",
        "................",
    ],
]

// Elder crown, drawn over the sprite's head rows.
private let crownRows: [String] = [
    "....y..y..y.....",
    "....yyyyyy......",
]

// ─── Rendering ───────────────────────────────────────────────────────────────

/// - Parameters:
///   - conversationId: decides species and the body colour.
///   - stage: egg | baby | kid | grown | elder — size and form.
///   - mood: happy | hungry | sad | gone — expression and tempo.
struct PixelPet: View {
    let conversationId: String
    let stage: String
    let mood: String
    let size: CGFloat
    var animated: Bool = true

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !animated)) { timeline in
            sprite(at: timeline.date)
        }
        .frame(width: size, height: size)
    }

    private func sprite(at date: Date) -> some View {
        let bodyColor = colorForId(conversationId)
        let shade = shadeOf(bodyColor)

        let frames: [[String]]
        if mood == "gone" {
            frames = goneFrames
        } else if stage == "egg" {
            frames = eggFrames
        } else if petSpecies(conversationId: conversationId) == .dog {
            frames = dogFrames(mood: mood)
        } else {
            frames = catFrames(mood: mood)
        }

        // Sad pets breathe slowly; happy ones can barely sit still.
        let periodSeconds: Double
        switch mood {
        case "happy": periodSeconds = 0.380
        case "hungry": periodSeconds = 0.650
        default: periodSeconds = 0.900
        }

        // The phase runs 0 → 2 and wraps, the same shape as Android's repeated
        // tween: the frame flips at 1, the bob is the distance from 1.
        let phase = animated
            ? date.timeIntervalSinceReferenceDate
                .truncatingRemainder(dividingBy: periodSeconds * 2) / periodSeconds
            : 0
        let frame = (animated && frames.count > 1 && phase >= 1) ? 1 : 0
        // A gentle bob for the happy ones, half a pixel of life.
        let bob = (animated && mood == "happy" && stage != "egg") ? abs(phase - 1) : 0

        let grid = frames[frame]
        // Babies are the same creature, smaller in the same box.
        let scale: CGFloat
        switch stage {
        case "baby": scale = 0.72
        case "kid": scale = 0.88
        default: scale = 1
        }

        return Canvas { context, canvasSize in
            let cells = 16
            let cell = (min(canvasSize.width, canvasSize.height) / CGFloat(cells)) * scale
            let originX = (canvasSize.width - cell * CGFloat(cells)) / 2
            let originY = (canvasSize.height - cell * CGFloat(cells)) / 2 + CGFloat(bob) * cell * 0.5

            func colorFor(_ ch: Character) -> Color? {
                switch ch {
                case "o": return Color(hex: 0x1A1721)
                case "b": return bodyColor
                case "B": return shade
                case "w": return Color(hex: 0xF2F0F8)
                case "p": return Color(hex: 0xFF8FA3)
                case "e": return Color(hex: 0x17151F)
                case "y": return Color(hex: 0xFCCE09)
                default: return nil
                }
            }

            func drawGrid(_ rows: [String], yOffsetRows: Int = 0) {
                for (y, row) in rows.enumerated() {
                    for (x, ch) in row.enumerated() {
                        guard let color = colorFor(ch) else { continue }
                        // The half-point overlap closes the hairline seams a
                        // non-integral cell size would otherwise leave.
                        let rect = CGRect(
                            x: originX + CGFloat(x) * cell,
                            y: originY + CGFloat(y + yOffsetRows) * cell,
                            width: cell + 0.5,
                            height: cell + 0.5
                        )
                        context.fill(Path(rect), with: .color(color))
                    }
                }
            }

            drawGrid(grid)
            if stage == "elder" && mood != "gone" {
                drawGrid(crownRows, yOffsetRows: -1)
            }
        }
    }

    /// The body colour at 72% — the same factor Android multiplies in.
    private func shadeOf(_ color: Color) -> Color {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        _ = UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
        return Color(.sRGB, red: Double(r) * 0.72, green: Double(g) * 0.72, blue: Double(b) * 0.72, opacity: 1)
    }
}
