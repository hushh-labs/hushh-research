package com.hussh.app.plugins.HushhAccount

import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.hussh.app.plugins.shared.BackendUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * HushhAccountPlugin - Account Management
 * Port of iOS HushhAccountPlugin.swift
 *
 * Handles account-level operations like deletion.
 */
@CapacitorPlugin(name = "HushhAccount")
class HushhAccountPlugin : Plugin() {

    private val TAG = "HushhAccount"
    private val maxErrorPayloadBytes = 16_384
    private val maxErrorPayloadDepth = 6
    private val maxErrorPayloadNodes = 64
    private val maxErrorPayloadEntries = 32
    private val maxErrorCodeLength = 128
    private val maxErrorMessageLength = 512

    // Longer timeout for deletion operations
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(45, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(45, TimeUnit.SECONDS)
        .build()

    private fun getBackendUrl(call: PluginCall): String {
        return BackendUrl.resolve(bridge, call, "HushhAccount")
    }

    private fun normalizedMachineCode(value: Any?): String? {
        if (value !is String) return null
        val code = value.trim()
        if (code.isEmpty() || code.length > maxErrorCodeLength) return null
        return code.takeIf {
            it.all { character ->
                character == '_' || character in 'A'..'Z' || character in '0'..'9'
            }
        }
    }

    private fun machineCode(
        value: Any?,
        depth: Int,
        remainingNodes: IntArray,
    ): String? {
        if (depth > maxErrorPayloadDepth || remainingNodes[0] <= 0) return null
        remainingNodes[0] -= 1

        if (value is JSONObject) {
            for (key in listOf("code", "error_code")) {
                normalizedMachineCode(value.opt(key))?.let { return it }
            }
            val keys = value.keys()
            var entries = 0
            while (keys.hasNext() && entries < maxErrorPayloadEntries) {
                val code = machineCode(value.opt(keys.next()), depth + 1, remainingNodes)
                if (code != null) return code
                entries += 1
            }
        } else if (value is org.json.JSONArray) {
            val entries = minOf(value.length(), maxErrorPayloadEntries)
            for (index in 0 until entries) {
                val code = machineCode(value.opt(index), depth + 1, remainingNodes)
                if (code != null) return code
            }
        }
        return null
    }

    private fun errorMessage(payload: JSONObject?, fallback: String): String {
        val detail = payload?.opt("detail")
        val detailObject = detail as? JSONObject
        val candidates = listOf(
            detailObject?.opt("message"),
            detailObject?.opt("error"),
            payload?.opt("message"),
            payload?.opt("error"),
            detail,
        )
        for (candidate in candidates) {
            if (candidate !is String) continue
            val message = candidate.trim()
            if (message.isNotEmpty()) return message.take(maxErrorMessageLength)
        }
        return fallback
    }

    private fun parseBoundedErrorPayload(responseBody: String?): JSONObject? {
        if (responseBody.isNullOrBlank()) return null
        if (responseBody.toByteArray(Charsets.UTF_8).size > maxErrorPayloadBytes) return null
        return try {
            JSONObject(responseBody)
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Delete the user's account and user-owned data. Required retained evidence
     * follows the backend's approved retention/redaction policy.
     * Requires VAULT_OWNER token (Unlock to Delete).
     * This action is irreversible.
     */
    @PluginMethod
    fun deleteAccount(call: PluginCall) {
        val authToken = call.getString("authToken")
        if (authToken == null) {
            call.reject("Missing required parameter: authToken")
            return
        }
        val target = call.getString("target") ?: "both"

        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/account/delete"
        val requestBody = JSONObject().apply {
            put("target", target)
        }.toString().toRequestBody("application/json; charset=utf-8".toMediaType())

        Log.w(TAG, "🚨 [HushhAccountPlugin] Requesting account deletion for target: $target")

        Thread {
            try {
                val request = Request.Builder()
                    .url(url)
                    .delete(requestBody)
                    .addHeader("Content-Type", "application/json")
                    .addHeader("Authorization", "Bearer $authToken")
                    .build()

                val response = httpClient.newCall(request).execute()
                val responseBody = response.body?.string()

                activity.runOnUiThread {
                    if (response.isSuccessful) {
                        Log.i(TAG, "✅ [HushhAccountPlugin] Account deleted successfully")
                        val payload = JSObject()
                        var parsed = false
                        try {
                            if (!responseBody.isNullOrBlank()) {
                                val json = JSONObject(responseBody)
                                val keys = json.keys()
                                while (keys.hasNext()) {
                                    val key = keys.next()
                                    payload.put(key, json.get(key))
                                }
                                parsed = true
                            }
                        } catch (_: Exception) {
                            parsed = false
                        }
                        if (!parsed) {
                            payload.put("success", true)
                        }
                        call.resolve(payload)
                    } else {
                        val payload = parseBoundedErrorPayload(responseBody)
                        val remainingNodes = intArrayOf(maxErrorPayloadNodes)
                        val code = machineCode(payload, 0, remainingNodes)
                        val errorMessage = errorMessage(
                            payload,
                            "Server returned ${response.code}",
                        )
                        val rejectionData = JSObject().put("status", response.code)
                        if (payload != null) {
                            rejectionData.put("payload", payload)
                        }
                        Log.e(TAG, "❌ [HushhAccountPlugin] Deletion failed: $errorMessage")
                        call.reject(errorMessage, code, rejectionData)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "❌ [HushhAccountPlugin] Network error: ${e.message}")
                activity.runOnUiThread {
                    call.reject("Network error: ${e.message}")
                }
            }
        }.start()
    }
}
