package com.hussh.app.plugins.HushhStream

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.hussh.app.plugins.shared.BackendUrl
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * HushhStream: a generic streaming HTTP transport for the WebView.
 *
 * The app routes native calls through CapacitorHttp, which returns whole
 * bodies, so a server-sent event stream reaches the page only when it has
 * ended. This plugin performs the request with OkHttp on a worker thread and
 * forwards the raw response bytes as they arrive (`hushhStreamEvent`,
 * `type: "chunk"`, base64), then one `end` event. Bytes only: no SSE
 * parsing, no JSON, no retry. Several streams may run at once, each
 * addressed by the caller's `streamId`. Port of the iOS HushhStreamPlugin;
 * the OkHttp pattern is KaiPlugin's.
 */
@CapacitorPlugin(name = "HushhStream")
class HushhStreamPlugin : Plugin() {

    private val TAG = "HushhStreamPlugin"

    companion object {
        private const val EVENT_NAME = "hushhStreamEvent"
        private const val CHUNK_BYTES = 8 * 1024
    }

    private class StreamState(val streamId: String) {
        @Volatile var call: Call? = null
        @Volatile var cancelled = false
    }

    private val streams = ConcurrentHashMap<String, StreamState>()

    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(180, TimeUnit.SECONDS)
        // A stream can legitimately run longer than a fixed wall clock budget.
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private fun emit(payload: JSObject) {
        activity.runOnUiThread { notifyListeners(EVENT_NAME, payload) }
    }

    private fun emitEnd(state: StreamState, error: String?, code: String?) {
        val payload = JSObject().put("streamId", state.streamId).put("type", "end")
        if (error != null) payload.put("error", error)
        if (code != null) payload.put("code", code)
        emit(payload)
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val streamId = call.getString("streamId")?.trim().orEmpty()
        if (streamId.isEmpty()) {
            call.reject("Missing streamId")
            return
        }
        val path = call.getString("path").orEmpty()
        if (path.isEmpty()) {
            call.reject("Missing path")
            return
        }
        if (streams.containsKey(streamId)) {
            call.reject("A stream with this id is already open", "HUSHH_STREAM_BUSY")
            return
        }

        val url = if (path.startsWith("http://", true) || path.startsWith("https://", true)) {
            path
        } else {
            val backendUrl = BackendUrl.resolve(bridge, call, "HushhStream")
            if (backendUrl.isEmpty()) {
                call.reject("Backend URL is not configured", "HUSHH_STREAM_NO_BACKEND")
                return
            }
            backendUrl + (if (path.startsWith("/")) path else "/$path")
        }

        val method = (call.getString("method") ?: "GET").uppercase()
        val builder = Request.Builder().url(url)
        var contentType = "application/json"
        call.getObject("headers")?.let { headers ->
            val keys = headers.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val value = headers.optString(key, "")
                if (value.isNotEmpty()) {
                    builder.addHeader(key, value)
                    if (key.equals("Content-Type", ignoreCase = true)) contentType = value
                }
            }
        }
        val body = call.getString("body")
        if (method == "GET") {
            builder.get()
        } else {
            builder.method(method, (body ?: "").toRequestBody(contentType.toMediaType()))
        }

        val state = StreamState(streamId)
        val httpCall = httpClient.newCall(builder.build())
        state.call = httpCall
        streams[streamId] = state

        Thread {
            var settledOpen = false
            try {
                httpCall.execute().use { response ->
                    val headers = JSObject()
                    for (name in response.headers.names()) {
                        headers.put(name.lowercase(), response.headers[name] ?: "")
                    }
                    val opened = JSObject().put("status", response.code).put("headers", headers)
                    settledOpen = true
                    activity.runOnUiThread { call.resolve(opened) }

                    val stream = response.body?.byteStream()
                    if (stream != null) {
                        val buffer = ByteArray(CHUNK_BYTES)
                        while (!state.cancelled) {
                            val read = stream.read(buffer)
                            if (read < 0) break
                            if (read == 0) continue
                            val encoded = Base64.encodeToString(buffer, 0, read, Base64.NO_WRAP)
                            emit(JSObject().put("streamId", streamId).put("type", "chunk").put("base64", encoded))
                        }
                    }
                }
                if (state.cancelled) emitEnd(state, "Cancelled", "CANCELLED") else emitEnd(state, null, null)
            } catch (e: IOException) {
                val code = if (state.cancelled) "CANCELLED" else if (e is java.net.SocketTimeoutException) "TIMEOUT" else "NETWORK"
                if (!settledOpen) {
                    activity.runOnUiThread { call.reject(e.message ?: "Stream request failed", code) }
                }
                emitEnd(state, e.message ?: "Stream failed", code)
            } catch (e: Exception) {
                android.util.Log.e(TAG, "open error", e)
                if (!settledOpen) {
                    activity.runOnUiThread { call.reject(e.message ?: "Stream request failed", "NETWORK") }
                }
                emitEnd(state, e.message ?: "Stream failed", "NETWORK")
            } finally {
                streams.remove(streamId)
            }
        }.start()
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val streamId = call.getString("streamId").orEmpty()
        val state = streams[streamId]
        if (state == null) {
            call.resolve(JSObject().put("cancelled", false))
            return
        }
        state.cancelled = true
        state.call?.cancel()
        call.resolve(JSObject().put("cancelled", true))
    }
}
