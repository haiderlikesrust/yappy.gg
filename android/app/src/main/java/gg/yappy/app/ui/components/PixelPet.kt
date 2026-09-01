package gg.yappy.app.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.abs

/**
 * The group pet: a pixel creature, drawn from character grids, animated by
 * flipping between two frames the way a Tamagotchi did.
 *
 * Sprites are code, not assets — each frame is sixteen strings of sixteen
 * characters, one character per pixel, so the art is diffable, palette-swaps
 * with the group's identity colour, and never ships a PNG. The vocabulary:
 *
 *   .  transparent      o  outline          b  body (identity colour)
 *   B  body shade       w  white            p  pink (tongue, inner ear)
 *   e  eye              y  brand yellow (sparkles, crown)
 *
 * Species is derived from the conversation id: half the world's groups get a
 * dog, half a cat, nobody chooses and everybody agrees.
 */

enum class PetSpecies { Dog, Cat }

fun petSpecies(conversationId: String): PetSpecies =
    if (conversationId.hashCode() and 1 == 0) PetSpecies.Dog else PetSpecies.Cat

// ─── Sprites ─────────────────────────────────────────────────────────────────

private val EGG = listOf(
    listOf(
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
    ),
    listOf(
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
    ),
)

// Dog: floppy ears, big muzzle. Frame two lifts the ears and wags.
private fun dogFrames(mood: String): List<List<String>> {
    // Rows 10-11 are the mouth region, swapped per mood.
    fun body(earUp: Boolean, mouthA: String, mouthB: String): List<String> {
        val e1 = if (earUp) "..oo........oo.." else "................"
        val e2 = if (earUp) ".obbo......obbo." else "..oo........oo.."
        val e3 = if (earUp) ".obBbo....obBbo." else ".obbo......obbo."
        return listOf(
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
        )
    }
    return when (mood) {
        "happy" -> listOf(
            body(false, "..obbboppobbbo..", "...obbboppbbo..."),
            body(true, "..obbboppobbbo..", "...obbbbppbo...."),
        )
        "hungry" -> listOf(
            body(false, "..obbbboobbbbo..", "...obbbbbbbbo..."),
            body(false, "..obbboooobbbo..", "...obbbbbbbbo..."),
        )
        else -> listOf( // sad
            body(false, "..obbbboobbbbo..", "...obbboobbbo..."),
            body(false, "..obbbboobbbbo..", "...obbboobbbo..."),
        )
    }
}

// Cat: pointed ears, small mouth. Frame two flicks an ear and the tail.
private fun catFrames(mood: String): List<List<String>> {
    fun body(flick: Boolean, mouthA: String, mouthB: String): List<String> {
        val e1 = if (flick) "..o..........o.." else "..o.........o..."
        val e2 = if (flick) "..opo......opo.." else "..opo......opo.."
        return listOf(
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
        )
    }
    return when (mood) {
        "happy" -> listOf(
            body(false, "..obbbopbobbbo..", "...obbbbbbbbo..."),
            body(true, "..obbbobpobbbo..", "...obbbbbbbbo..."),
        )
        "hungry" -> listOf(
            body(false, "..obbbboobbbbo..", "...obbbbbbbbo..."),
            body(true, "..obbbboobbbbo..", "...obbbbbbbbo..."),
        )
        else -> listOf( // sad
            body(false, "..obbboBBobbbo..", "...obbbbbbbbo..."),
            body(false, "..obbboBBobbbo..", "...obbbbbbbbo..."),
        )
    }
}

// Wandered off: an empty spot — footprints trailing away and a question.
private val GONE = listOf(
    listOf(
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
    ),
)

// Elder crown, drawn over the sprite's head rows.
private val CROWN = listOf(
    "....y..y..y.....",
    "....yyyyyy......",
)

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * @param conversationId decides species and the body colour.
 * @param stage egg | baby | kid | grown | elder — size and form.
 * @param mood happy | hungry | sad | gone — expression and tempo.
 */
@Composable
fun PixelPet(
    conversationId: String,
    stage: String,
    mood: String,
    size: Dp,
    modifier: Modifier = Modifier,
    animated: Boolean = true,
) {
    val species = petSpecies(conversationId)
    val body = colorForId(conversationId)
    val shade = Color(
        red = body.red * 0.72f,
        green = body.green * 0.72f,
        blue = body.blue * 0.72f,
        alpha = 1f,
    )

    val frames = when {
        mood == "gone" -> GONE
        stage == "egg" -> EGG
        species == PetSpecies.Dog -> dogFrames(mood)
        else -> catFrames(mood)
    }

    // Sad pets breathe slowly; happy ones can barely sit still.
    val periodMs = when (mood) {
        "happy" -> 380
        "hungry" -> 650
        else -> 900
    }

    /*
     * The clock, kept away from composition.
     *
     * The first version read `phase` in the composition scope, which
     * invalidated every visible pet's composition at 60fps, forever — the
     * home list literally never went idle. Three changes hold it down:
     *   • a pet with nothing to animate gets no transition at all;
     *   • the two-frame flip goes through derivedStateOf, so composition
     *     only invalidates when the frame actually changes (~2/sec);
     *   • the bob offset is read inside the Canvas draw lambda, which is a
     *     repaint, not a recomposition.
     */
    val bobActive = animated && mood == "happy" && stage != "egg"
    val animate = animated && (frames.size > 1 || bobActive)
    val phase: State<Float> = if (animate) {
        rememberInfiniteTransition(label = "pet").animateFloat(
            initialValue = 0f,
            targetValue = 2f,
            animationSpec = infiniteRepeatable(
                animation = tween(periodMs * 2, easing = LinearEasing),
                repeatMode = RepeatMode.Restart,
            ),
            label = "petFrame",
        )
    } else {
        remember { mutableStateOf(0f) }
    }
    val frame by remember(frames, animate) {
        derivedStateOf { if (animate && frames.size > 1 && phase.value >= 1f) 1 else 0 }
    }

    val grid = frames[frame]
    // Babies are the same creature, smaller in the same box.
    val scale = when (stage) {
        "baby" -> 0.72f
        "kid" -> 0.88f
        else -> 1f
    }

    // Each grid resolved to coloured cells once — the draw pass used to walk
    // all 256 characters and re-answer the palette per cell, per frame.
    val bodyCells = remember(grid, body, shade) { resolveCells(grid, body, shade) }
    val crown = stage == "elder" && mood != "gone"
    val crownCells = if (crown) remember(body, shade) { resolveCells(CROWN, body, shade) } else null

    Canvas(modifier.size(size)) {
        val cells = 16
        val cell = (this.size.minDimension / cells) * scale
        val originX = (this.size.width - cell * cells) / 2f
        // A gentle bob for the happy ones, half a pixel of life — read here,
        // in the draw phase, so it repaints without recomposing.
        val bob = if (bobActive) abs(phase.value - 1f) else 0f
        val originY = (this.size.height - cell * cells) / 2f + (bob * cell * 0.5f)

        fun draw(list: List<PetCell>, yOffsetRows: Int) {
            for (c in list) {
                drawRect(
                    color = c.color,
                    topLeft = Offset(originX + c.x * cell, originY + (c.y + yOffsetRows) * cell),
                    size = Size(cell + 0.5f, cell + 0.5f),
                )
            }
        }

        draw(bodyCells, 0)
        if (crownCells != null) draw(crownCells, -1)
    }
}

private class PetCell(val x: Int, val y: Int, val color: Color)

private fun resolveCells(rows: List<String>, body: Color, shade: Color): List<PetCell> {
    val out = ArrayList<PetCell>()
    rows.forEachIndexed { y, row ->
        row.forEachIndexed { x, ch ->
            val color = when (ch) {
                'o' -> Color(0xFF1A1721)
                'b' -> body
                'B' -> shade
                'w' -> Color(0xFFF2F0F8)
                'p' -> Color(0xFFFF8FA3)
                'e' -> Color(0xFF17151F)
                'y' -> Color(0xFFFCCE09)
                else -> null
            } ?: return@forEachIndexed
            out += PetCell(x, y, color)
        }
    }
    return out
}
