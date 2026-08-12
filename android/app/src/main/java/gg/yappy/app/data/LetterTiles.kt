package gg.yappy.app.data

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import androidx.core.graphics.drawable.IconCompat
import gg.yappy.app.ui.components.colorForId

/**
 * The app's letter avatar, as a bitmap for surfaces Compose cannot reach:
 * notification Persons, launcher shortcuts, share-sheet targets.
 *
 * Same deterministic colour table the Avatar composable uses, so the face in
 * the shade matches the face in the app. Drawing beats fetching here — the
 * letter is instant, works offline, and is never wrong, only plain.
 */
object LetterTiles {

    fun icon(id: String, name: String, size: Int = 128): IconCompat =
        IconCompat.createWithAdaptiveBitmap(bitmap(id, name, size))

    fun bitmap(id: String, name: String, size: Int = 128): Bitmap {
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)

        val color = colorForId(id)
        val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            this.color = android.graphics.Color.argb(
                255,
                (color.red * 255).toInt(),
                (color.green * 255).toInt(),
                (color.blue * 255).toInt(),
            )
        }
        // Painted edge to edge, not as a circle: adaptive icons are masked by
        // the launcher, and a pre-drawn circle inside the safe zone shrinks
        // into a circle-in-a-squircle with the background showing through.
        canvas.drawRect(0f, 0f, size.toFloat(), size.toFloat(), fill)

        val initial = name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"
        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            this.color = android.graphics.Color.WHITE
            textSize = size * 0.42f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            textAlign = Paint.Align.CENTER
        }
        val baseline = size / 2f - (text.descent() + text.ascent()) / 2f
        canvas.drawText(initial, size / 2f, baseline, text)

        return bitmap
    }
}
