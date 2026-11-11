package com.hussh.app.plugins.HushhCalling

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.telecom.DisconnectCause
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.test.filters.SdkSuppress
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.hussh.app.MainActivity
import com.hussh.app.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyFactory
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class CallingWireInstrumentedTest {
    @Test
    @SdkSuppress(minSdkVersion = 26)
    fun telecomRegistersAndClosesAnIncomingCall() = runBlocking {
        withContext(Dispatchers.Main.immediate) {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val manager = context.getSystemService(NotificationManager::class.java)
            val channel = "sms_telecom_local_test"
            val noticeId = 8705
            manager.createNotificationChannel(NotificationChannel(channel, "Calling test", NotificationManager.IMPORTANCE_LOW))
            val button = PendingIntent.getActivity(context, 0, Intent(context, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
            val person = Person.Builder().setName("Calling test").build()
            var accepted = false
            var ended = false
            val voice = object : TelecomCall.Voice {
                override suspend fun accept() { accepted = true }
                override fun active(active: Boolean) = Unit
                override fun systemMuted(muted: Boolean) = Unit
                override fun end(cause: DisconnectCause) { ended = true }
                override fun telecomClosed() = Unit
            }
            val adapter = TelecomCall(context, this, voice, "Calling test") { ringing ->
                val style = if (ringing) NotificationCompat.CallStyle.forIncomingCall(person, button, button)
                    else NotificationCompat.CallStyle.forOngoingCall(person, button)
                manager.notify(noticeId, NotificationCompat.Builder(context, channel)
                    .setSmallIcon(R.mipmap.ic_launcher).setCategory(NotificationCompat.CATEGORY_CALL)
                    .setStyle(style).build())
            }
            val job = launch { adapter.add(UUID.randomUUID().toString(), incoming = true) }
            try {
                adapter.registered()
                adapter.answer()
                assertTrue(accepted)
                adapter.disconnect(DisconnectCause(DisconnectCause.LOCAL))
                assertTrue(ended)
                withTimeout(5_000) { job.join() }
            } finally {
                job.cancel()
                manager.cancel(noticeId)
                manager.deleteNotificationChannel(channel)
            }
        }
    }

    @Test
    fun browserOfferDecryptsOnlyForItsOwnCall() {
        // Synthetic browser fixture generated with the app's @hpke/core suite.
        val key = KeyFactory.getInstance("EC")
        val privateKey = key.generatePrivate(PKCS8EncodedKeySpec(CallingWire.decode(
            "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgJaiIG7b7G1kB8bCiT4+eAPRNfhmiBJBbHBmeWpOu08ihRANCAARvZqUfTJahBIBuX1lePnBZP+bzTD+DyKYCVT0B5Gi6UvXjtnEESBBWorzM7Y0iEKcloIsz2LcTdzgFKSeu7vKL"
        ))) as ECPrivateKey
        val publicKey = key.generatePublic(X509EncodedKeySpec(CallingWire.decode(
            "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEb2alH0yWoQSAbl9ZXj5wWT/m80w/g8imAlU9AeRoulL147ZxBEgQVqK8zO2NIhCnJaCLM9i3E3c4BSknru7yiw=="
        ))) as ECPublicKey
        val call = JSONObject().put("id", "fixture-call").put("conversationId", "fixture-conversation")
        val envelope = JSONObject().put("algorithm", CallingWire.ALGORITHM).put("deviceId", "fixture-recipient")
            .put("keyId", "fixture-key").put("enc", "BMw+RkxqXlFrGlafr4nGQeMvBOP/JcchPKNa+03fe/wSPIGG9eM5T/1s7sISUtPJ3TYnyiTYxxA5c1FIZZBY5XY=")
            .put("ciphertext", "quBFTbxL2/wsscGxYXgQG0EBc5SdB/UG77GCy9+2zcSjMyybHZXyCIUj8Yl+qvEczrCT7L/9n5bC9YceGmL6KGL8iQzo+J4G8hehPH/CoJ/cE0ieZOYise5LccPEqzflMNiMH9h4pMzdpwHHGLezcb1e2+zGel5vOnB+bhYpDLisse1bdD4KzSO7aKvMBYQXFB6n7msgTNNnkEQN3eV9H0JoFYW4Q4TsI0so98XyqIAhPJ7xmAcww8bvPRbEAt+B3RQpDO+Pwz2zZB2BDF8ca0E/VuwB8CZIXa4=")
        val pair = CallingWire.agreementPair(privateKey, publicKey)
        val info = CallingWire.signalContext(call, "fixture-sender", "fixture-recipient", "offer", 0)
        val description = CallingWire.open(pair, envelope, info, "fixture-recipient", "fixture-key")
        val sdp = CallingWire.validateDescription(description, "offer")
        assertEquals("v=0\r\na=fingerprint:sha-256 " + List(32) { "AB" }.joinToString(":") +
            "\r\na=candidate:1 1 UDP 1 192.0.2.1 443 typ relay\r\n", sdp)
        assertTrue(runCatching {
            CallingWire.open(pair, envelope, info, "foreign-device", "fixture-key")
        }.isFailure)
        assertTrue(runCatching {
            val foreign = CallingWire.signalContext(call.put("id", "foreign-call"), "fixture-sender", "fixture-recipient", "offer", 0)
            CallingWire.open(pair, envelope, foreign, "fixture-recipient", "fixture-key")
        }.isFailure)
    }
}
