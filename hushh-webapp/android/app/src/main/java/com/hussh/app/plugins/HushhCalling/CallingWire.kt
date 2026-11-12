package com.hussh.app.plugins.HushhCalling

import org.bouncycastle.crypto.AsymmetricCipherKeyPair
import org.bouncycastle.crypto.hpke.HPKE
import org.bouncycastle.util.encoders.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.X509EncodedKeySpec

internal object CallingWire {
    const val ALGORITHM = "HPKE-P256-SHA256-AES256GCM-v1"
    private val curve = ECGenParameterSpec("secp256r1")
    private val parameters = AlgorithmParameters.getInstance("EC").run {
        init(curve)
        getParameterSpec(ECParameterSpec::class.java)
    }
    private val fingerprintLine = Regex("^a=fingerprint:sha-256 (?:[0-9a-f]{2}:){31}[0-9a-f]{2}\\r?$", setOf(RegexOption.MULTILINE, RegexOption.IGNORE_CASE))
    private val candidate = Regex("^a=candidate:[^\\r\\n]*? typ (\\S+)", setOf(RegexOption.MULTILINE, RegexOption.IGNORE_CASE))

    fun encode(bytes: ByteArray): String = Base64.toBase64String(bytes)
    fun decode(value: String): ByteArray = Base64.decode(value).also { require(encode(it) == value) }
    fun generateAgreement() = KeyPairGenerator.getInstance("EC").run { initialize(curve); generateKeyPair() }
    private fun hpke() = HPKE(HPKE.mode_base, HPKE.kem_P256_SHA256, HPKE.kdf_HKDF_SHA256, HPKE.aead_AES_GCM256)

    private fun canonical(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { key ->
            "${canonical(key)}:${canonical(value.get(key))}"
        }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
        is String -> JSONObject.quote(value).replace("\\/", "/")
        is Boolean, is Int, is Long -> value.toString()
        else -> throw IllegalArgumentException("Invalid calling wire value")
    }

    fun bytes(value: Any): ByteArray = canonical(value).toByteArray(Charsets.UTF_8)
    fun digest(value: Any): String = sha256(bytes(value))
    fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it) }
    fun objectArray(vararg values: Any): JSONArray = JSONArray(values.toList())

    fun proofBytes(owner: String, operation: String, payload: JSONObject, proof: JSONObject): ByteArray =
        bytes(objectArray("hussh-communications-command-v1", owner, operation, proof.getString("deviceId"),
            proof.getString("nonce"), proof.getLong("expiresAt"), digest(payload)))

    fun verify(device: JSONObject, operation: String, signed: JSONObject, historical: Boolean = false) {
        val proof = signed.getJSONObject("proof")
        val payload = signed.getJSONObject("payload")
        require(proof.getString("deviceId") == device.getString("deviceId"))
        require(historical || proof.getLong("expiresAt") > System.currentTimeMillis() / 1000)
        val valid = Signature.getInstance("SHA256withECDSA").run {
            initVerify(publicKey(device.getString("signingKey")))
            update(proofBytes(device.getString("userId"), operation, payload, proof))
            verify(decode(proof.getString("signature")))
        }
        require(valid)
    }

    fun signalContext(call: JSONObject, from: String, to: String, kind: String, sequence: Int): ByteArray =
        bytes(objectArray("hussh-call-signal-v1", call.getString("id"), call.getString("conversationId"), from, to, kind, sequence))

    private fun publicKey(value: String): ECPublicKey =
        (KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(decode(value))) as ECPublicKey).also {
            val spec = it.params
            require(spec.curve == parameters.curve && spec.generator == parameters.generator &&
                spec.order == parameters.order && spec.cofactor == parameters.cofactor)
        }

    private fun coordinate(value: ByteArray): ByteArray {
        require(value.size <= 32 || (value.size == 33 && value[0] == 0.toByte()))
        val start = (value.size - 32).coerceAtLeast(0)
        return ByteArray(32).also { value.copyInto(it, 32 - (value.size - start), start) }
    }

    private fun raw(key: ECPublicKey): ByteArray =
        byteArrayOf(4) + coordinate(key.w.affineX.toByteArray()) + coordinate(key.w.affineY.toByteArray())

    fun agreementPair(privateKey: ECPrivateKey, publicKey: ECPublicKey): AsymmetricCipherKeyPair {
        val scalar = coordinate(privateKey.s.toByteArray())
        return try { hpke().deserializePrivateKey(scalar, raw(publicKey)) } finally { scalar.fill(0) }
    }

    fun seal(device: JSONObject, context: ByteArray, description: JSONObject): JSONObject {
        val suite = hpke()
        val sender = suite.setupBaseS(suite.deserializePublicKey(raw(publicKey(device.getString("publicKey")))), context)
        return JSONObject().put("algorithm", ALGORITHM).put("deviceId", device.getString("deviceId"))
            .put("keyId", device.getString("keyId")).put("enc", encode(sender.encapsulation))
            .put("ciphertext", encode(sender.seal(byteArrayOf(), bytes(description))))
    }

    fun open(pair: AsymmetricCipherKeyPair, envelope: JSONObject, context: ByteArray, deviceId: String, keyId: String): JSONObject {
        require(envelope.getString("algorithm") == ALGORITHM && envelope.getString("deviceId") == deviceId &&
            envelope.getString("keyId") == keyId)
        val enc = decode(envelope.getString("enc"))
        val ciphertext = decode(envelope.getString("ciphertext"))
        require(enc.size == 65 && ciphertext.size in 16..131_072)
        return JSONObject(hpke().setupBaseR(enc, pair, context).open(byteArrayOf(), ciphertext).toString(Charsets.UTF_8))
    }

    fun validateDescription(description: JSONObject, kind: String): String {
        val sdp = description.getString("sdp")
        require(description.getString("type") == kind && sdp.toByteArray(Charsets.UTF_8).size <= 60_000 &&
            fingerprintLine.containsMatchIn(sdp))
        val candidates = candidate.findAll(sdp).toList()
        require(candidates.isNotEmpty() && candidates.all { it.groupValues[1].equals("relay", ignoreCase = true) })
        return sdp
    }

    fun fingerprint(local: JSONObject, peer: JSONObject): String {
        val pair = listOf(local, peer).sortedBy { it.getString("deviceId") }.map { device ->
            val fields = listOf("deviceId", "keyId", "publicKey", "signingKey", "userId")
            JSONObject(fields.associateWith { device.getString(it) })
        }
        return digest(JSONArray(pair))
    }
}
