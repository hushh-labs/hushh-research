package com.hussh.app.plugins.HushhCalling

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Purpose-bound Android calling keys. Credential storage is available after first unlock. */
internal class CallingIdentity private constructor(
    context: Context,
    val ownerId: String,
    private val scope: String,
    allowEnrollment: Boolean,
) {
    private val store = context.getSharedPreferences("hussh_calling_identity_v1", Context.MODE_PRIVATE)
    private val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private val signerAlias = "hussh.calling.sign.$scope"
    private val wrapAlias = "hussh.calling.wrap.$scope"
    private val record: JSONObject
    val deviceId: String get() = record.optString("deviceId")
    val keyId: String get() = record.getString("keyId")
    val publicKey: String get() = record.getString("publicKey")
    val signingKey: String get() = CallingWire.encode(keys.getCertificate(signerAlias).publicKey.encoded)

    init {
        val saved = store.getString(scope, null)
        if (saved != null) {
            check(keys.isKeyEntry(signerAlias) && keys.isKeyEntry(wrapAlias))
            record = JSONObject(saved)
        } else {
            check(allowEnrollment)
            // An interrupted initial write has no registered identity to preserve.
            if (!keys.containsAlias(signerAlias)) KeyPairGenerator.getInstance("EC", "AndroidKeyStore").run {
                initialize(KeyGenParameterSpec.Builder(signerAlias, KeyProperties.PURPOSE_SIGN)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256).build())
                generateKeyPair()
            }
            if (!keys.containsAlias(wrapAlias)) KeyGenerator.getInstance("AES", "AndroidKeyStore").run {
                init(KeyGenParameterSpec.Builder(wrapAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
                generateKey()
            }
            val pair = CallingWire.generateAgreement()
            val privateBytes = pair.private.encoded
            val cipher = agreementCipher(Cipher.ENCRYPT_MODE)
            val encrypted = try { cipher.doFinal(privateBytes) } finally { privateBytes.fill(0) }
            record = JSONObject().put("keyId", UUID.randomUUID().toString())
                .put("publicKey", CallingWire.encode(pair.public.encoded))
                .put("agreement", CallingWire.encode(encrypted)).put("iv", CallingWire.encode(cipher.iv))
            save()
        }
    }

    private fun agreementCipher(mode: Int, iv: ByteArray? = null): Cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
        val key = keys.getKey(wrapAlias, null) as SecretKey
        if (iv == null) init(mode, key) else init(mode, key, GCMParameterSpec(128, iv))
        updateAAD(scope.toByteArray(Charsets.UTF_8))
    }

    private fun save() { check(store.edit().putString(scope, record.toString()).commit()) }

    fun enroll(id: String) {
        require(id.isNotBlank() && (deviceId.isEmpty() || deviceId == id))
        record.put("deviceId", id)
        save()
    }

    fun proof(operation: String, payload: JSONObject): JSONObject {
        check(deviceId.isNotEmpty())
        val proof = JSONObject().put("deviceId", deviceId).put("nonce", UUID.randomUUID().toString())
            .put("expiresAt", System.currentTimeMillis() / 1000 + 90)
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign((keys.getEntry(signerAlias, null) as KeyStore.PrivateKeyEntry).privateKey)
            update(CallingWire.proofBytes(ownerId, operation, payload, proof))
            sign()
        }
        return proof.put("signature", CallingWire.encode(signature))
    }

    fun open(envelope: JSONObject, info: ByteArray): JSONObject {
        val cipher = agreementCipher(Cipher.DECRYPT_MODE, CallingWire.decode(record.getString("iv")))
        val clear = cipher.doFinal(CallingWire.decode(record.getString("agreement")))
        try {
            val factory = KeyFactory.getInstance("EC")
            val secret = factory.generatePrivate(PKCS8EncodedKeySpec(clear)) as ECPrivateKey
            val public = factory.generatePublic(X509EncodedKeySpec(CallingWire.decode(publicKey))) as ECPublicKey
            return CallingWire.open(CallingWire.agreementPair(secret, public), envelope, info, deviceId, keyId)
        } finally {
            clear.fill(0)
        }
    }

    fun isVerified(fingerprint: String): Boolean = pins().contains(fingerprint)

    fun verify(fingerprint: String) {
        require(fingerprint.matches(Regex("[0-9a-f]{64}")))
        record.put("verified", JSONArray((pins().filter { it != fingerprint } + fingerprint).takeLast(100)))
        save()
    }

    private fun pins(): List<String> {
        val verified = record.optJSONArray("verified") ?: return emptyList()
        return (0 until verified.length()).map { verified.getString(it) }
    }

    companion object {
        @Synchronized
        fun load(context: Context, ownerId: String, origin: String, allowEnrollment: Boolean): CallingIdentity =
            CallingIdentity(context, ownerId, CallingWire.digest(CallingWire.objectArray(origin, ownerId, "calling-installation-v1")),
                allowEnrollment)
    }
}
