package com.hussh.app.plugins.HushhCalling

import android.content.Context
import com.getcapacitor.CapConfig
import com.google.android.gms.tasks.Task
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl
import okhttp3.Call
import okhttp3.Callback
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal class SmsCallSettled : IllegalStateException()

internal class CallingClient private constructor(
    private val origin: HttpUrl,
    private val user: FirebaseUser,
    val identity: CallingIdentity,
) {
    fun current(): Boolean = FirebaseAuth.getInstance().currentUser === user

    suspend fun initialize() {
        if (identity.deviceId.isEmpty()) {
            val response = request(user, origin, "api/account/trusted-devices/self-enroll",
                JSONObject().put("devicePublicKey", identity.signingKey).put("deviceName", "Android calling")
                    .put("platform", "android"))
            identity.enroll(response.getString("device_id"))
        }
        command("register-key", JSONObject().put("keyId", identity.keyId).put("publicKey", identity.publicKey))
    }

    suspend fun command(operation: String, payload: JSONObject = JSONObject()): JSONObject =
        request(user, origin, "api/one/messages/calls/$operation",
            JSONObject().put("payload", payload).put("proof", identity.proof(operation, payload)))

    suspend fun directory(conversation: String): List<JSONObject> {
        val items = command("directory", JSONObject().put("conversationId", conversation)).getJSONArray("items")
        require(items.length() in 2..40)
        val devices = (0 until items.length()).map { items.getJSONObject(it) }
        require(devices.map { it.getString("deviceId") }.toSet().size == devices.size &&
            devices.map { it.getString("userId") }.toSet().size == 2)
        for (device in devices) {
            val signed = device.getJSONObject("enrollment")
            val payload = signed.getJSONObject("payload")
            require(payload.getString("keyId") == device.getString("keyId") &&
                payload.getString("publicKey") == device.getString("publicKey"))
            CallingWire.verify(device, "register-key", signed, historical = true)
        }
        require(devices.any {
            it.getString("deviceId") == identity.deviceId && it.getString("userId") == identity.ownerId &&
                it.getString("keyId") == identity.keyId && it.getString("publicKey") == identity.publicKey &&
                it.getString("signingKey") == identity.signingKey
        })
        return devices
    }

    companion object {
        private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .callTimeout(15, TimeUnit.SECONDS).build()
        private val json = "application/json".toMediaType()

        suspend fun admitted(context: Context, allowEnrollment: Boolean, expectedOwner: String? = null): CallingClient = withContext(Dispatchers.IO) {
            val user = checkNotNull(FirebaseAuth.getInstance().currentUser)
            val origin = checkNotNull(CapConfig.loadDefault(context)
                .getPluginConfiguration("HushhRuntime").getString("backendUrl")).toHttpUrl()
            require(origin.isHttps && origin.username.isEmpty() && origin.password.isEmpty() &&
                origin.query == null && origin.fragment == null && origin.encodedPath == "/")
            val status = request(user, origin, "api/account/session-status", limit = 4096)
            require(status.opt("active") == true && status.getString("firebase_uid") == user.uid)
            val generation = status.get("account_generation")
            require(generation is Int || generation is Long)
            val owner = status.getString("owner_id")
            require(if ((generation as Number).toLong() == 0L) owner == user.uid
                else generation.toLong() in 1..9_007_199_254_740_991L && owner.matches(Regex("acct_[0-9a-f]{32}")))
            require(expectedOwner == null || expectedOwner == owner)
            val caps = request(user, origin, "api/one/messages/calls/capabilities")
            require(caps.opt("available") == true && caps.opt("androidAvailable") == true)
            check(FirebaseAuth.getInstance().currentUser === user)
            val identity = CallingIdentity.load(context, owner, origin.toString(), allowEnrollment)
            if (!allowEnrollment) require(identity.deviceId.isNotEmpty())
            CallingClient(origin, user, identity)
        }

        private suspend fun request(user: FirebaseUser, origin: HttpUrl, path: String,
            payload: JSONObject? = null, limit: Long = 650_000): JSONObject = withContext(Dispatchers.IO) {
            check(FirebaseAuth.getInstance().currentUser === user)
            val token = checkNotNull(user.getIdToken(false).resultAwait().token)
            ensureActive()
            check(FirebaseAuth.getInstance().currentUser === user)
            val request = Request.Builder().url(origin.newBuilder().addPathSegments(path).build())
                .header("Authorization", "Bearer $token")
                .header("Cache-Control", "no-store")
            if (payload != null) request.post(CallingWire.bytes(payload).toRequestBody(json))
            val data = send(request.build(), limit)
            ensureActive()
            check(FirebaseAuth.getInstance().currentUser === user)
            data
        }

        private suspend fun send(request: Request, limit: Long): JSONObject = suspendCancellableCoroutine { continuation ->
            val call = http.newCall(request)
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (continuation.isActive) continuation.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    val result = runCatching {
                        response.use {
                            val source = checkNotNull(it.body).source()
                            require(!source.request(limit + 1))
                            val data = JSONObject(source.readUtf8())
                            if (it.code == 409 && data.optJSONObject("detail")?.optString("code") == "SMS_CALL_SETTLED") {
                                throw SmsCallSettled()
                            }
                            check(it.isSuccessful)
                            data
                        }
                    }
                    if (continuation.isActive) continuation.resumeWith(result)
                }
            })
        }
    }
}

internal suspend fun <T> Task<T>.resultAwait(): T = suspendCancellableCoroutine { continuation ->
    addOnCompleteListener { result ->
        if (!continuation.isActive) return@addOnCompleteListener
        if (result.isSuccessful) continuation.resume(result.result)
        else continuation.resumeWithException(result.exception ?: IllegalStateException("Android calling request failed"))
    }
}
