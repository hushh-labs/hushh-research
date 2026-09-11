package com.hussh.app.plugins.HushhLocation

import android.location.Location
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import okhttp3.OkHttpClient
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyPairGenerator
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Synthetic native execution only: interceptor prevents every external request. */
@RunWith(AndroidJUnit4::class)
class BackgroundLocationPublisherTest {
    @Test fun publisherProducesDecryptableEnvelopeAndStopsOnUnauthorized() {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        var posted: JSONObject? = null
        val sent = CountDownLatch(1)
        val stopped = CountDownLatch(1)
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            assertEquals("/api/one/location/grants/synthetic-grant/envelopes", request.url.encodedPath)
            val buffer = Buffer()
            request.body!!.writeTo(buffer)
            posted = JSONObject(buffer.readUtf8()).getJSONObject("envelope")
            sent.countDown()
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(401)
                .message("Synthetic refusal").body("".toResponseBody()).build()
        }.build()
        val publisher = BackgroundLocationPublisher(client) { stopped.countDown() }
        try {
            publisher.start(BackgroundSession("synthetic-only", "https://publisher.invalid".toHttpUrl(),
                listOf(BackgroundGrant("synthetic-grant", "synthetic-key", pair.public as ECPublicKey, null)), 0.0, 1000, "synthetic-owner"))
            publisher.handle(Location("synthetic").apply { latitude = 0.0; longitude = 0.0; time = 1000 })
            assertTrue(sent.await(5, TimeUnit.SECONDS))
            assertTrue(stopped.await(5, TimeUnit.SECONDS))
            assertFalse(publisher.isActive())
            val envelope = posted!!
            val sender = LocationEnvelopeCrypto.publicKey(envelope.getJSONObject("senderEphemeralPublicKeyJwk"))
            val secret = KeyAgreement.getInstance("ECDH").run { init(pair.private); doPhase(sender, true); generateSecret() }
            val iv = Base64.decode(envelope.getString("iv"), Base64.URL_SAFE)
            assertEquals(12, iv.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(secret, "AES"), GCMParameterSpec(128, iv))
            val plaintext = cipher.doFinal(Base64.decode(envelope.getString("ciphertext"), Base64.URL_SAFE))
            val point = JSONObject(String(plaintext, Charsets.UTF_8))
            assertEquals(0.0, point.getDouble("latitude"), 0.0)
            assertEquals("android", point.getString("sourcePlatform"))
            secret.fill(0)
        } finally { publisher.stop(); client.dispatcher.executorService.shutdownNow() }
    }
}
