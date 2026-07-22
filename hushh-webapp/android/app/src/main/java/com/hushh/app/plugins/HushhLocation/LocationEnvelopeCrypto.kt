package com.hushh.app.plugins.HushhLocation

import android.util.Base64
import org.json.JSONObject
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Matches the Web Crypto and iOS ECDH-P256 + AES-256-GCM envelope. */
internal object LocationEnvelopeCrypto {
    private val random = SecureRandom()

    fun encrypt(
        pointJson: ByteArray,
        recipientPublicKeyJwk: JSONObject,
        recipientKeyId: String,
        capturedAt: String
    ): JSONObject {
        val parameters = AlgorithmParameters.getInstance("EC").apply {
            init(ECGenParameterSpec("secp256r1"))
        }
        val ecSpec = parameters.getParameterSpec(java.security.spec.ECParameterSpec::class.java)
        val recipientKey = KeyFactory.getInstance("EC").generatePublic(
            ECPublicKeySpec(
                ECPoint(
                    BigInteger(1, decode(recipientPublicKeyJwk.getString("x"))),
                    BigInteger(1, decode(recipientPublicKeyJwk.getString("y")))
                ),
                ecSpec
            )
        )
        val ephemeral = KeyPairGenerator.getInstance("EC").apply {
            initialize(ECGenParameterSpec("secp256r1"), random)
        }.generateKeyPair()
        val agreement = KeyAgreement.getInstance("ECDH").apply {
            init(ephemeral.private)
            doPhase(recipientKey, true)
        }
        val sharedSecret = agreement.generateSecret()
        val aesKey = SecretKeySpec(sharedSecret.copyOf(32), "AES")
        val iv = ByteArray(12).also(random::nextBytes)
        val ciphertextWithTag = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, aesKey, GCMParameterSpec(128, iv))
            doFinal(pointJson)
        }
        val ephemeralPublic = ephemeral.public as ECPublicKey
        val ephemeralJwk = JSONObject()
            .put("kty", "EC")
            .put("crv", "P-256")
            .put("x", encode(toFixed32(ephemeralPublic.w.affineX)))
            .put("y", encode(toFixed32(ephemeralPublic.w.affineY)))

        return JSONObject()
            .put("algorithm", "ECDH-P256-AES256-GCM")
            .put("recipientKeyId", recipientKeyId)
            .put("ciphertext", encode(ciphertextWithTag))
            .put("iv", encode(iv))
            .put("senderEphemeralPublicKeyJwk", ephemeralJwk)
            .put("capturedAt", capturedAt)
            .put("sourcePlatform", "android")
            .put(
                "metadata",
                JSONObject().put("payload", "coordinate_envelope").put("plaintext", false)
            )
    }

    private fun decode(value: String): ByteArray =
        Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    private fun encode(value: ByteArray): String =
        Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    private fun toFixed32(value: BigInteger): ByteArray {
        val raw = value.toByteArray()
        val unsigned = if (raw.size > 32) raw.copyOfRange(raw.size - 32, raw.size) else raw
        return ByteArray(32 - unsigned.size) + unsigned
    }
}
