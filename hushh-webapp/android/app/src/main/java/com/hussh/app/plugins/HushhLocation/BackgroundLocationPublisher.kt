package com.hussh.app.plugins.HushhLocation

import android.location.Location
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.security.interfaces.ECPublicKey
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

internal data class BackgroundGrant(val id: String, val keyId: String, val publicKey: ECPublicKey, val expiresAtMs: Long?)
internal data class BackgroundSession(val token: String, val baseUrl: HttpUrl, val grants: List<BackgroundGrant>, val minMoveMeters: Double, val minIntervalMs: Long, val ownerUid: String)

/** Owns ciphertext transport; credentials and points never leave process memory in plaintext. */
internal class BackgroundLocationPublisher(
    private val client: OkHttpClient = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .callTimeout(30, TimeUnit.SECONDS).build(),
    private val onStop: () -> Unit
) {
    private val queue = BackgroundPublishQueue()
    private val calls = mutableMapOf<Call, BackgroundPublishQueue.Item>()
    private var session: BackgroundSession? = null
    private var lastPoint: Location? = null
    private var lastAt = 0L
    private var retryAt = 0L
    private var retryDelayMs = 1000L
    @Synchronized fun isActive() = session != null
    @Synchronized fun start(value: BackgroundSession) {
        clear()
        session = value
    }
    private fun clear() {
        queue.reset()
        calls.keys.toList().forEach { it.cancel() }
        calls.clear()
        session = null
        lastPoint = null
        lastAt = 0L
        retryAt = 0L
        retryDelayMs = 1000L
    }
    @Synchronized fun stop(notify: Boolean = true) { clear(); if (notify) onStop() }
    @Synchronized fun tick() {
        val current = session ?: return
        if (current.grants.none { queue.active(BackgroundPublishQueue.Item(it.id, it.expiresAtMs, "")) }) stop()
        if (System.currentTimeMillis() >= retryAt) drain()
    }
    @Synchronized fun handle(location: Location) {
        tick()
        val current = session ?: return
        val now = System.currentTimeMillis()
        val last = lastPoint
        if (last != null && location.distanceTo(last) < current.minMoveMeters && now - lastAt < current.minIntervalMs) return
        lastPoint = Location(location)
        lastAt = now
        val capturedAt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date(location.time))
        val point = JSONObject().put("latitude", location.latitude).put("longitude", location.longitude)
            .put("accuracyM", if (location.hasAccuracy()) location.accuracy else JSONObject.NULL)
            .put("capturedAt", capturedAt).put("sourcePlatform", "android")
        for (grant in current.grants) {
            if (!queue.active(BackgroundPublishQueue.Item(grant.id, grant.expiresAtMs, ""))) continue
            val envelope = try { LocationEnvelopeCrypto.encrypt(point, grant.publicKey, grant.keyId) } catch (_: Exception) { continue }
            queue.offer(BackgroundPublishQueue.Item(grant.id, grant.expiresAtMs, JSONObject().put("envelope", envelope).toString()))
        }
        drain()
    }
    private fun drain() {
        val current = session ?: return
        if (System.currentTimeMillis() < retryAt) return
        while (calls.size < 4) {
            val item = queue.next() ?: break
            val generation = queue.generation
            val url = current.baseUrl.newBuilder().addPathSegments("api/one/location/grants")
                .addPathSegment(item.grantId).addPathSegment("envelopes").build()
            val call = client.newCall(Request.Builder().url(url).header("Authorization", "Bearer ${current.token}")
                .post(item.body.toRequestBody("application/json".toMediaType())).build())
            calls[call] = item
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) = complete(call, generation, item, 0)
                override fun onResponse(call: Call, response: Response) {
                    response.use { complete(call, generation, item, it.code) }
                }
            })
        }
    }
    @Synchronized private fun complete(call: Call, generation: Long, item: BackgroundPublishQueue.Item, status: Int) {
        if (queue.generation != generation || session == null) return
        calls.remove(call)
        if (!queue.active(item)) { tick(); return }
        when {
            status == 401 -> stop()
            status in listOf(403, 404, 410) -> {
                queue.refuse(item.grantId)
                calls.filterValues { it.grantId == item.grantId }.keys.toList().forEach { calls.remove(it); it.cancel() }
                tick()
            }
            status == 0 || status == 429 || status >= 500 -> {
                queue.offer(item)
                retryAt = System.currentTimeMillis() + retryDelayMs
                retryDelayMs = (retryDelayMs * 2).coerceAtMost(60000L)
            }
            status in 200..299 -> { retryDelayMs = 1000L; drain() }
            // Other client errors and redirects are terminal for this envelope.
        }
    }
}
