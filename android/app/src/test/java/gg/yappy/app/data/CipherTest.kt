package gg.yappy.app.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The cipher, against vectors the other clients produced.
 *
 * A round trip here proves only that this file agrees with itself, which is not
 * the property that matters: three platforms implement this format and a shared
 * misunderstanding round-trips perfectly on each of them. What matters is that
 * an envelope sealed by the web client opens here, and that the envelope sealed
 * here opens there — so the vectors are committed and every platform reads the
 * same file.
 *
 *   ./gradlew :app:testDebugUnitTest
 *
 * When this fails after a change to the format, the format changed on one
 * platform only. That is the whole point of the test.
 */
class CipherTest {

    private val vectors: JsonObject =
        Json.parseToJsonElement(
            File("../../packages/shared/vectors/e2e.json").readText(),
        ).jsonObject

    private val plaintext = vectors["plaintext"]!!.jsonPrimitive.content
    private val recipient = vectors["recipient"]!!.jsonObject
    private val sender = vectors["sender"]!!.jsonObject

    private val bundle = KeyBundle(
        userId = recipient["userId"]!!.jsonPrimitive.content,
        deviceId = recipient["deviceId"]!!.jsonPrimitive.content,
        identityKey = recipient["identityPublic"]!!.jsonPrimitive.content,
        signedPreKey = recipient["signedPreKey"]!!.jsonObject.let {
            SignedPreKey(
                id = it["id"]!!.jsonPrimitive.int,
                key = it["key"]!!.jsonPrimitive.content,
                signature = it["signature"]!!.jsonPrimitive.content,
            )
        },
        oneTimePreKey = recipient["oneTimePreKey"]!!.jsonObject.let {
            OneTimePreKey(id = it["id"]!!.jsonPrimitive.int, key = it["key"]!!.jsonPrimitive.content)
        },
    )

    /** The receiving side of the vectors: this is the device they were sealed to. */
    private val me = Cipher.Privates(
        deviceId = bundle.deviceId,
        userId = bundle.userId,
        identityPrivate = "",
        signedPreKeyId = bundle.signedPreKey.id,
        signedPreKeyPrivate = recipient["signedPreKeyPrivate"]!!.jsonPrimitive.content,
        preKeys = recipient["preKeys"]!!.jsonObject.entries.associate {
            it.key.toInt() to it.value.jsonPrimitive.content
        },
    )

    private val senderPrivates = Cipher.Privates(
        deviceId = sender["deviceId"]!!.jsonPrimitive.content,
        userId = sender["userId"]!!.jsonPrimitive.content,
        identityPrivate = sender["identityPrivate"]!!.jsonPrimitive.content,
        signedPreKeyId = 1,
        signedPreKeyPrivate = "",
        preKeys = emptyMap(),
    )

    private val senderIdentity = sender["identityPublic"]!!.jsonPrimitive.content
    private val senderUser = sender["userId"]!!.jsonPrimitive.content

    @Test
    fun `opens every platform's vector`() {
        val sealed = vectors["sealed"]!!.jsonObject
        assertTrue("no vectors to check", sealed.isNotEmpty())
        for ((platform, envelope) in sealed) {
            val text = envelope.jsonPrimitive.contentOrNull
            assertEquals(
                "the $platform vector did not open",
                plaintext,
                Cipher.openSealed(text, me, senderIdentity, senderUser),
            )
        }
    }

    /**
     * Prints what this platform produces, for the vectors file.
     *
     * The ephemeral key and the nonce are fresh every run, so the value changes
     * each time and cannot be asserted against — it is committed once, and the
     * test above is what keeps it honest.
     */
    @Test
    fun `seals something the others can open`() {
        val sealed = Cipher.sealTo(plaintext, bundle, senderPrivates)
        println("android vector: $sealed")
        assertEquals(plaintext, Cipher.openSealed(sealed, me, senderIdentity, senderUser))
    }

    @Test
    fun `refuses what it should refuse`() {
        val sealed = Cipher.sealTo(plaintext, bundle, senderPrivates)

        assertNull(
            "a copy for another device must not open",
            Cipher.openSealed(sealed, me.copy(deviceId = "someone-else"), senderIdentity, senderUser),
        )
        assertNull(
            "a body attributed to the wrong author must not open",
            Cipher.openSealed(sealed, me, senderIdentity, "00000000-0000-4000-8000-000000000bad"),
        )
        assertNull(
            "without the sender's key there is no decryption",
            Cipher.openSealed(sealed, me, null, senderUser),
        )
        assertNull(
            "a prekey this device never had must not open",
            Cipher.openSealed(sealed, me.copy(preKeys = emptyMap()), senderIdentity, senderUser),
        )
        assertNull(
            "an envelope from the placeholder build must not open",
            Cipher.openSealed("stub.v0.abc", me, senderIdentity, senderUser),
        )

        // A prekey the server swapped: right shape, wrong signature.
        val forged = bundle.copy(
            signedPreKey = bundle.signedPreKey.copy(
                key = Cipher.b64(ByteArray(32) { 7 }),
            ),
        )
        val threw = try {
            Cipher.sealTo(plaintext, forged, senderPrivates)
            false
        } catch (_: Exception) {
            true
        }
        assertTrue("a prekey the server swapped must be refused, not encrypted to", threw)
    }

    @Test
    fun `says who a message claims to be from`() {
        val sealed = Cipher.sealTo(plaintext, bundle, senderPrivates)
        val claim = Cipher.sealedSender(sealed)
        assertNotNull(claim)
        assertEquals(senderUser, claim!!.first)
        assertEquals(senderPrivates.deviceId, claim.second)
    }
}
