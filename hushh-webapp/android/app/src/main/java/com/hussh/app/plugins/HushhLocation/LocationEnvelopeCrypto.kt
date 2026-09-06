package com.hussh.app.plugins.HushhLocation

import android.util.Base64
import org.json.JSONObject
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.SecretKeySpec

/** Same wire contract as Web Crypto and iOS: raw P-256 ECDH → AES-256-GCM. */
internal object LocationEnvelopeCrypto {
    private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    private fun coordinate(value: BigInteger): ByteArray {
        val bytes = value.toByteArray()
        return ByteArray(32).also { bytes.copyInto(it, maxOf(0, 32 - bytes.size), maxOf(0, bytes.size - 32)) }
    }
    fun publicKey(jwk: JSONObject): ECPublicKey {
        require(jwk.getString("kty") == "EC" && jwk.getString("crv") == "P-256")
        fun decode(name: String): BigInteger {
            val bytes = Base64.decode(jwk.getString(name), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
            require(bytes.size == 32)
            return BigInteger(1, bytes)
        }
        val params = AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(
            ECPoint(decode("x"), decode("y")), params.getParameterSpec(ECParameterSpec::class.java)
        )) as ECPublicKey
    }
    fun encrypt(point: JSONObject, recipient: ECPublicKey, keyId: String): JSONObject {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        val secret = KeyAgreement.getInstance("ECDH").run { init(pair.private); doPhase(recipient, true); generateSecret() }
        try {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(secret, "AES"))
            val ciphertext = cipher.doFinal(point.toString().toByteArray(Charsets.UTF_8))
            val pub = pair.public as ECPublicKey
            return JSONObject().put("algorithm", "ECDH-P256-AES256-GCM")
                .put("recipientKeyId", keyId).put("ciphertext", encode(ciphertext)).put("iv", encode(cipher.iv))
                .put("senderEphemeralPublicKeyJwk", JSONObject().put("kty", "EC").put("crv", "P-256")
                    .put("x", encode(coordinate(pub.w.affineX))).put("y", encode(coordinate(pub.w.affineY))))
                .put("capturedAt", point.getString("capturedAt")).put("sourcePlatform", "android")
                .put("metadata", JSONObject().put("payload", "coordinate_envelope").put("plaintext", false))
        } finally { secret.fill(0) }
    }
}
