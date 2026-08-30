package gg.yappy.app.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
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
 * The cipher and the ratchet under it, against vectors the other clients
 * produced and against the things that actually go wrong.
 *
 * A round trip here proves only that this file agrees with itself, which is not
 * the property that matters: three platforms implement this format, and a
 * shared misunderstanding round-trips perfectly on each of them. What matters
 * is that an envelope sealed by the web client opens here and the envelope
 * sealed here opens there — so the vectors are committed and every platform
 * reads the same file.
 *
 *   ./gradlew :app:testDebugUnitTest
 */
class CipherTest {

    private val vectors: JsonObject =
        Json.parseToJsonElement(File("../../packages/shared/vectors/e2e.json").readText()).jsonObject

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
    private val me = Ratchet.Privates(
        deviceId = bundle.deviceId,
        userId = bundle.userId,
        identityPrivate = "",
        signedPreKeyId = bundle.signedPreKey.id,
        signedPreKeyPrivate = recipient["signedPreKeyPrivate"]!!.jsonPrimitive.content,
        preKeys = recipient["preKeys"]!!.jsonObject.entries.associate {
            it.key.toInt() to it.value.jsonPrimitive.content
        },
    )

    private val senderPrivates = Ratchet.Privates(
        deviceId = sender["deviceId"]!!.jsonPrimitive.content,
        userId = sender["userId"]!!.jsonPrimitive.content,
        identityPrivate = sender["identityPrivate"]!!.jsonPrimitive.content,
        signedPreKeyId = 1,
        signedPreKeyPrivate = "",
        preKeys = emptyMap(),
    )

    private val senderIdentity = sender["identityPublic"]!!.jsonPrimitive.content
    private val senderUser = senderPrivates.userId

    private fun open(envelope: String?, session: Ratchet.Session? = null) =
        Cipher.openSealed(envelope, session, me, senderIdentity, senderUser)

    // ── the vectors ──────────────────────────────────────────────────────────

    @Test
    fun `opens every platform's vector`() {
        val sealed = vectors["sealed"]!!.jsonObject
        assertTrue("no vectors to check", sealed.isNotEmpty())
        for ((platform, envelope) in sealed) {
            assertEquals(
                "the $platform vector did not open",
                plaintext,
                open(envelope.jsonPrimitive.content)?.plaintext,
            )
        }
    }

    /**
     * Prints what this platform produces, for the vectors file.
     *
     * The ephemeral key, the ratchet key and the nonce are fresh every run, so
     * the value changes each time and cannot be asserted against — it is
     * committed once, and the test above is what keeps it honest.
     */
    @Test
    fun `seals a first message the others can open`() {
        val sealed = Cipher.sealWith(Cipher.beginSession(bundle), plaintext, senderPrivates, MessageFormats.NEWEST)!!
        println("android vector: ${sealed.envelope}")
        assertEquals(plaintext, open(sealed.envelope)?.plaintext)
    }

    // ── the ratchet ──────────────────────────────────────────────────────────

    @Test
    fun `a conversation runs both ways`() {
        var alice = Cipher.beginSession(bundle)
        val opening = Cipher.sealWith(alice, "are you there", senderPrivates, MessageFormats.NEWEST)!!
        alice = opening.session

        val read = open(opening.envelope)
        assertEquals("are you there", read?.plaintext)
        assertEquals(bundle.oneTimePreKey?.id, read?.consumedPreKeyId)

        // The reply turns the ratchet, and has to open back on the other side.
        val bobPrivates = me.copy(identityPrivate = recipient["identityPrivate"]!!.jsonPrimitive.content)
        val reply = Cipher.sealWith(read!!.session, "i am", bobPrivates, MessageFormats.NEWEST)!!
        val backAtAlice = Cipher.openSealed(
            reply.envelope,
            alice,
            Ratchet.Privates(
                deviceId = senderPrivates.deviceId,
                userId = senderUser,
                identityPrivate = "",
                signedPreKeyId = 1,
                signedPreKeyPrivate = "",
                preKeys = emptyMap(),
            ),
            recipient["identityPublic"]!!.jsonPrimitive.content,
            bundle.userId,
        )
        assertEquals("i am", backAtAlice?.plaintext)
    }

    @Test
    fun `messages that arrive backwards all open`() {
        var alice = Cipher.beginSession(bundle)
        val wire = mutableListOf<String>()
        for (i in 0 until 5) {
            val sealed = Cipher.sealWith(alice, "message $i", senderPrivates, MessageFormats.NEWEST)!!
            alice = sealed.session
            wire += sealed.envelope
        }

        var session: Ratchet.Session? = null
        val seen = mutableListOf<String>()
        for (envelope in wire.reversed()) {
            val read = open(envelope, session) ?: break
            session = read.session
            seen += read.plaintext
        }
        assertEquals(
            (0 until 5).map { "message $it" }.sorted(),
            seen.sorted(),
        )
    }

    @Test
    fun `a message opens once and not twice`() {
        val sealed = Cipher.sealWith(Cipher.beginSession(bundle), "once", senderPrivates, MessageFormats.NEWEST)!!
        val first = open(sealed.envelope)
        assertEquals("once", first?.plaintext)

        // With the prekey spent — which is what the caller does with
        // consumedPreKeyId — the preamble cannot rebuild the session either.
        val spent = me.copy(preKeys = me.preKeys - first!!.consumedPreKeyId!!)
        assertNull(
            "a spent message must not open again",
            Cipher.openSealed(sealed.envelope, first.session, spent, senderIdentity, senderUser),
        )
    }

    // ── what it must refuse ──────────────────────────────────────────────────

    @Test
    fun `refuses what it should refuse`() {
        val sealed = Cipher.sealWith(Cipher.beginSession(bundle), plaintext, senderPrivates, MessageFormats.NEWEST)!!

        assertNull(
            "a copy for another device must not open",
            Cipher.openSealed(sealed.envelope, null, me.copy(deviceId = "someone-else"), senderIdentity, senderUser),
        )
        assertNull(
            "a body attributed to the wrong author must not open",
            Cipher.openSealed(sealed.envelope, null, me, senderIdentity, "00000000-0000-4000-8000-000000000bad"),
        )
        assertNull(
            "without the sender's key there is no decryption",
            Cipher.openSealed(sealed.envelope, null, me, null, senderUser),
        )
        assertNull(
            "a prekey this device never had must not open",
            Cipher.openSealed(sealed.envelope, null, me.copy(preKeys = emptyMap()), senderIdentity, senderUser),
        )
        assertNull("an envelope from the previous format must not open", open("yx3dh.v1.abc"))
        assertNull("nonsense must not open", open("yr.v2.not-base64!"))

        // A prekey the server swapped: right shape, wrong signature.
        val forged = bundle.copy(
            signedPreKey = bundle.signedPreKey.copy(key = Cipher.b64(ByteArray(32) { 7 })),
        )
        val threw = try {
            Cipher.beginSession(forged)
            false
        } catch (_: Exception) {
            true
        }
        assertTrue("a prekey the server swapped must be refused, not encrypted to", threw)
    }

    @Test
    fun `says who a message claims to be from`() {
        val sealed = Cipher.sealWith(Cipher.beginSession(bundle), plaintext, senderPrivates, MessageFormats.NEWEST)!!
        val claim = Cipher.sealedSender(sealed.envelope)
        assertNotNull(claim)
        assertEquals(senderUser, claim!!.first)
        assertEquals(senderPrivates.deviceId, claim.second)
    }

    @Test
    fun `a session survives being stored`() {
        val sealed = Cipher.sealWith(Cipher.beginSession(bundle), "through storage", senderPrivates, MessageFormats.NEWEST)!!
        val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
        val revived = json.decodeFromString(
            Ratchet.Session.serializer(),
            json.encodeToString(Ratchet.Session.serializer(), sealed.session),
        )
        val next = Cipher.sealWith(revived, "and again", senderPrivates, MessageFormats.NEWEST)!!

        var session = open(sealed.envelope)!!.session
        session = open(next.envelope, session)!!.session
        assertNotNull(session)
    }

    // ── which format two devices agree on ────────────────────────────────────

    /**
     * The advertisement in the vectors was signed by the web client.
     *
     * Verifying it here proves the two platforms agree on the exact bytes that
     * get signed — not just on the cipher. A mismatch would not break anything
     * visibly; it would quietly make every device look like it speaks only the
     * oldest format, and every sender would downgrade to match.
     */
    @Test
    fun `believes an advertisement another platform signed`() {
        val advertised = recipient["formats"]!!.jsonPrimitive.content
        val signature = recipient["formatsSignature"]!!.jsonPrimitive.content
        assertEquals(
            MessageFormats.parse(advertised),
            Cipher.readFormats(advertised, signature, bundle.identityKey),
        )
    }

    @Test
    fun `refuses a downgrade`() {
        val signature = recipient["formatsSignature"]!!.jsonPrimitive.content

        // The attack this exists for: the directory shrinks the list so every
        // sender falls back to the weakest thing anybody still implements.
        assertEquals(
            listOf(MessageFormats.OLDEST),
            Cipher.readFormats("1", signature, bundle.identityKey),
        )
        assertEquals(
            "a list signed by somebody else means nothing",
            listOf(MessageFormats.OLDEST),
            Cipher.readFormats(recipient["formats"]!!.jsonPrimitive.content, signature, senderIdentity),
        )
        assertEquals(
            "and a missing signature falls back rather than trusting the server",
            listOf(MessageFormats.OLDEST),
            Cipher.readFormats("2,3", null, bundle.identityKey),
        )
    }

    @Test
    fun `picks the newest format both ends know`() {
        assertEquals(3, MessageFormats.choose(listOf(2, 3, 4), listOf(1, 2, 3)))
        assertNull(MessageFormats.choose(listOf(4, 5), listOf(1, 2)))
        assertEquals(
            MessageFormats.NEWEST,
            MessageFormats.choose(MessageFormats.SUPPORTED, MessageFormats.SUPPORTED),
        )

        // A format this build cannot write is refused rather than approximated.
        assertNull(Cipher.sealWith(Cipher.beginSession(bundle), plaintext, senderPrivates, 99))
    }
}
