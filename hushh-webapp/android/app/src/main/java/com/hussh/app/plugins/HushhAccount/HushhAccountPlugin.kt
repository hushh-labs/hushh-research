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

    // Longer timeout for deletion operations
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(45, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(45, TimeUnit.SECONDS)
        .build()

    private fun getBackendUrl(call: PluginCall): String {
        return BackendUrl.resolve(bridge, call, "HushhAccount")
    }

    /**
     * Delete the user's account and all associated data.
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
                        // Try to parse error message from response
                        val errorMessage = try {
                            responseBody?.let {
                                JSONObject(it).optString("detail", "Server returned ${response.code}")
                            } ?: "Server returned ${response.code}"
                        } catch (e: Exception) {
                            "Server returned ${response.code}"
                        }
                        Log.e(TAG, "❌ [HushhAccountPlugin] Deletion failed: $errorMessage")
                        call.reject(errorMessage)
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
