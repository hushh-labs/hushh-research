package com.hussh.app.plugins.HushhNotifications

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.getcapacitor.JSObject
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPublicKeySpec
import java.security.spec.ECPoint
import java.security.spec.PKCS8EncodedKeySpec
import java.math.BigInteger
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import java.util.UUID

/** Preview-only software EC key encrypted by a nonexportable Android Keystore key.
 * This works on API 24+, including devices without hardware ECDH support. */
object ChatPreviewKeys {
    private const val STORE = "hussh_chat_preview_v1"
    private const val ALIAS = "hussh.chat.preview.storage.v1"
    private fun prefs(context: Context) = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)
    private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    private fun decode(text: String) = Base64.decode(text, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    private fun storageKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).build())
        }.generateKey()
    }
    private fun decryptStored(record: JSONObject): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, storageKey(), GCMParameterSpec(128, decode(record.getString("storageIv"))))
        return cipher.doFinal(decode(record.getString("private")))
    }
    @Synchronized fun prepare(context: Context, userId: String, deviceId: String): JSObject {
        UUID.fromString(deviceId)
        val owner = encode(MessageDigest.getInstance("SHA-256").digest(userId.toByteArray(Charsets.UTF_8)))
        val preferences = prefs(context)
        var record = preferences.getString("active", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        if (record?.optString("owner") != owner || record?.optString("deviceId") != deviceId || runCatching { decryptStored(record!!).fill(0) }.isFailure) {
            clearDelivered(context, record?.optString("keyId"))
            preferences.edit().remove("active").remove("seen").commit()
            val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1"), SecureRandom()) }.generateKeyPair()
            fun coordinate(number: BigInteger): ByteArray = number.toByteArray().let { bytes -> ByteArray(32).also { bytes.copyInto(it, maxOf(0, 32 - bytes.size), maxOf(0, bytes.size - 32)) } }
            val point = (pair.public as ECPublicKey).w
            val public = byteArrayOf(4) + coordinate(point.affineX) + coordinate(point.affineY)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, storageKey()) }
            val private = pair.private.encoded
            val sealed = try { cipher.doFinal(private) } finally { private.fill(0) }
            record = JSONObject().put("owner", owner).put("deviceId", deviceId).put("keyId", UUID.randomUUID().toString())
                .put("publicKey", encode(public)).put("storageIv", encode(cipher.iv)).put("private", encode(sealed))
            check(preferences.edit().putString("active", record.toString()).commit())
        }
        return JSObject().put("deviceId", deviceId).put("keyId", record!!.getString("keyId")).put("publicKey", record.getString("publicKey"))
    }
    @Synchronized fun clear(context: Context, userId: String) {
        val owner = encode(MessageDigest.getInstance("SHA-256").digest(userId.toByteArray(Charsets.UTF_8)))
        val record = prefs(context).getString("active", null)?.let { JSONObject(it) }
        if (record != null && record.optString("owner") != owner) return
        check(prefs(context).edit().remove("active").remove("seen").commit())
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS)
        clearDelivered(context, record?.optString("keyId"))
    }
    private fun clearDelivered(context: Context, keyId: String?) {
        if (keyId.isNullOrBlank()) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
        for (item in manager.activeNotifications) {
            if (item.notification.extras.getString("chat_key") == keyId) manager.cancel(item.tag, item.id)
        }
    }
    @Synchronized fun withKey(context: Context, keyId: String, action: () -> Unit): Boolean {
        if (!matches(context, keyId)) return false
        action()
        return true
    }
    @Synchronized fun active(context: Context): Boolean = prefs(context).contains("active")
    @Synchronized fun matches(context: Context, keyId: String): Boolean = prefs(context).getString("active", null)?.let { JSONObject(it).optString("keyId") == keyId } ?: false
    @Synchronized fun legacyKey(context: Context, userId: String): String? {
        val record = prefs(context).getString("active", null)?.let { JSONObject(it) } ?: return null
        val owner = encode(MessageDigest.getInstance("SHA-256").digest(userId.toByteArray(Charsets.UTF_8)))
        return if (record.optString("owner") == owner) record.optString("keyId") else null
    }
    @Synchronized fun legacyHashKey(context: Context, ownerHash: String): String? {
        val record = prefs(context).getString("active", null)?.let { JSONObject(it) } ?: return null
        val hash = decode(record.optString("owner")).joinToString("") { "%02x".format(it) }
        return if (hash == ownerHash) record.optString("keyId") else null
    }
    @Synchronized fun open(context: Context, sealed: String, binding: String): JSONObject? = runCatching {
        require(sealed.length <= 2600 && binding.length <= 160)
        val envelope = JSONArray(sealed)
        val record = JSONObject(prefs(context).getString("active", null) ?: return null)
        require(envelope.length() == 4 && envelope.getString(0) == record.getString("keyId"))
        val raw = decryptStored(record)
        val private = try { KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(raw)) } finally { raw.fill(0) }
        val encoded = decode(envelope.getString(1))
        require(encoded.size == 65 && encoded[0] == 4.toByte())
        val parameters = (KeyFactory.getInstance("EC").generatePublic(java.security.spec.X509EncodedKeySpec(
            byteArrayOf(0x30,0x59,0x30,0x13,0x06,0x07,0x2a,0x86.toByte(),0x48,0xce.toByte(),0x3d,0x02,0x01,0x06,0x08,0x2a,0x86.toByte(),0x48,0xce.toByte(),0x3d,0x03,0x01,0x07,0x03,0x42,0x00) + encoded)) as ECPublicKey).params
        val peer = KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(BigInteger(1, encoded.copyOfRange(1,33)), BigInteger(1,encoded.copyOfRange(33,65))), parameters))
        val secret = KeyAgreement.getInstance("ECDH").apply { init(private); doPhase(peer, true) }.generateSecret()
        val prk = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(ByteArray(32), "HmacSHA256")) }.doFinal(secret)
        secret.fill(0)
        val key = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(prk, "HmacSHA256")) }
            .doFinal("hussh-chat-preview-v1:${envelope.getString(0)}".toByteArray(Charsets.UTF_8) + byteArrayOf(1))
        prk.fill(0)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, decode(envelope.getString(2))))
            updateAAD("${envelope.getString(0)}:$binding".toByteArray(Charsets.UTF_8))
        }
        key.fill(0)
        val plaintext = cipher.doFinal(decode(envelope.getString(3)))
        try { require(plaintext.size <= 1800); JSONObject(String(plaintext, Charsets.UTF_8)) } finally { plaintext.fill(0) }
    }.getOrNull()
    @Synchronized fun seen(context: Context, event: String): Boolean = prefs(context).getStringSet("seen", emptySet())!!.contains(event)
    @Synchronized fun remember(context: Context, event: String) {
        val seen = prefs(context).getStringSet("seen", emptySet())!!.toMutableSet()
        if (seen.size >= 200) seen.clear()
        seen.add(event)
        prefs(context).edit().putStringSet("seen", seen).commit()
    }
}
