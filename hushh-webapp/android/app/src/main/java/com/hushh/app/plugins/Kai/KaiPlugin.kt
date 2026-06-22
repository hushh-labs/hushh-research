package com.hushh.app.plugins.Kai

import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import com.hushh.app.plugins.shared.BackendUrl
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.json.JSONTokener
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/**
 * Kai Plugin - Android Implementation
 * 
 * Native plugin for Agent Kai stock analysis.
 * Makes HTTP calls to backend from native code.
 *
 * Authentication:
 * - All consent-gated operations use VAULT_OWNER token
 * - Token proves both identity (user_id) and consent (vault unlocked)
 * - Firebase is only used for bootstrap (issuing VAULT_OWNER token)
 */

@CapacitorPlugin(name = "Kai")
class KaiPlugin : Plugin() {
    
    private val TAG = "KaiPlugin"

    // OkHttp client with explicit timeouts (Kai analysis can take longer than typical API calls)
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(150, TimeUnit.SECONDS)
        // Stream calls can legitimately run longer than a fixed wall clock budget.
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    private fun getBackendUrl(call: PluginCall? = null): String {
        return BackendUrl.resolve(bridge, call, "Kai")
    }
    
    @PluginMethod
    fun grantConsent(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }
        
        val scopesArray = call.getArray("scopes") ?: run {
            call.reject("Missing scopes")
            return
        }
        
        // Bootstrap route: backend requires Firebase ID token (NOT VAULT_OWNER).
        val authToken = call.getString("authToken") ?: run {
            call.reject("Missing authToken (Firebase ID token)")
            return
        }
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/kai/consent/grant"
        
        val json = JSONObject().apply {
            put("user_id", userId)
            put("scopes", scopesArray)
        }
        
        val body = json.toString().toRequestBody("application/json".toMediaType())
        
        val requestBuilder = Request.Builder().url(url).post(body)
        
        requestBuilder.addHeader("Authorization", "Bearer $authToken")
        
        val request = requestBuilder.build()
        val pluginCall = call // Rename to avoid shadowing in callback
        
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: okhttp3.Call, e: IOException) {
                val errorMsg = "Network error: ${e.message} | backendUrl: $backendUrl"
                android.util.Log.e(TAG, "❌ [analyze] $errorMsg")
                pluginCall.reject(errorMsg)
            }
            
            override fun onResponse(call: okhttp3.Call, response: Response) {
                val responseBody = response.body?.string()
                
                if (!response.isSuccessful || responseBody == null) {
                    pluginCall.reject("Request failed: ${response.code}")
                    return
                }
                
                try {
                    // Normalize to TS contract: { token, expires_at }
                    val json = JSONObject(responseBody)
                    val tokensObj = json.optJSONObject("tokens")
                    if (tokensObj != null) {
                        val token =
                            tokensObj.optString("agent.kai.analyze").takeIf { it.isNotBlank() }
                                ?: run {
                                    val keys = tokensObj.keys()
                                    if (keys.hasNext()) tokensObj.optString(keys.next()) else ""
                                }
                        val expiresAt = json.optString("expires_at", "")
                        pluginCall.resolve(JSObject().apply {
                            put("token", token)
                            put("expires_at", expiresAt)
                        })
                    } else {
                        pluginCall.resolve(JSObject(responseBody))
                    }
                } catch (e: Exception) {
                    pluginCall.reject("JSON parsing error: ${e.message}")
                }
            }
        })
    }
    
    @PluginMethod
    fun analyze(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }
        val ticker = call.getString("ticker") ?: run {
            call.reject("Missing ticker")
            return
        }
        val consentToken = call.getString("consentToken") ?: run {
            call.reject("Missing consentToken")
            return
        }
        val riskProfile = call.getString("riskProfile") ?: run {
            call.reject("Missing riskProfile")
            return
        }
        val processingMode = call.getString("processingMode") ?: run {
            call.reject("Missing processingMode")
            return
        }
        
        // Consent-gated: requires VAULT_OWNER token
        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing vaultOwnerToken")
            return
        }
        val contextObj = call.getObject("context") // Optional context object
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/kai/analyze"
        
        val json = JSONObject().apply {
            put("user_id", userId)
            put("ticker", ticker)
            put("consent_token", consentToken)
            put("risk_profile", riskProfile)
            put("processing_mode", processingMode)
            // Include context if provided
            if (contextObj != null) {
                put("context", contextObj)
            }
        }
        
        val body = json.toString().toRequestBody("application/json".toMediaType())
        
        val requestBuilder = Request.Builder().url(url).post(body)
        
        requestBuilder.addHeader("Authorization", "Bearer $vaultOwnerToken")
        
        val request = requestBuilder.build()
        val pluginCall = call
        
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: okhttp3.Call, e: IOException) {
                val errorMsg = "Network error: ${e.message} | backendUrl: $backendUrl"
                android.util.Log.e(TAG, "❌ [analyze] $errorMsg")
                pluginCall.reject(errorMsg)
            }
            
            override fun onResponse(call: okhttp3.Call, response: Response) {
                val responseBody = response.body?.string()
                val truncatedBody = if (responseBody != null && responseBody.length > 200) responseBody.take(200) + "..." else responseBody
                
                if (!response.isSuccessful || responseBody == null) {
                    val errorMsg = "Request failed: HTTP ${response.code} | backendUrl: $backendUrl" + 
                        if (truncatedBody != null) " | body: $truncatedBody" else ""
                    android.util.Log.e(TAG, "❌ [analyze] $errorMsg")
                    pluginCall.reject(errorMsg)
                    return
                }
                
                try {
                    // Return full response directly, matching web plugin
                    val result = JSObject(responseBody)
                    pluginCall.resolve(result)
                } catch (e: Exception) {
                    val errorMsg = "JSON parsing error: ${e.message} | backendUrl: $backendUrl"
                    android.util.Log.e(TAG, "❌ [analyze] $errorMsg")
                    pluginCall.reject(errorMsg)
                }
            }
        })
    }

    @PluginMethod
    fun analyzePortfolioLosers(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }

        val losersArray = call.getArray("losers") ?: run {
            call.reject("Missing losers")
            return
        }

        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing vaultOwnerToken")
            return
        }

        val thresholdPct = call.getDouble("thresholdPct") ?: -5.0
        val maxPositions = call.getInt("maxPositions") ?: 10

        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/kai/portfolio/analyze-losers"

        val json = JSONObject().apply {
            put("user_id", userId)
            put("losers", losersArray)
            put("threshold_pct", thresholdPct)
            put("max_positions", maxPositions)
        }

        val body = json.toString().toRequestBody("application/json".toMediaType())
        val requestBuilder = Request.Builder().url(url).post(body)
        requestBuilder.addHeader("Authorization", "Bearer $vaultOwnerToken")

        val request = requestBuilder.build()
        val pluginCall = call

        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: okhttp3.Call, e: IOException) {
                val errorMsg = "Network error: ${e.message} | backendUrl: $backendUrl"
                android.util.Log.e(TAG, "❌ [analyzePortfolioLosers] $errorMsg")
                pluginCall.reject(errorMsg)
            }

            override fun onResponse(call: okhttp3.Call, response: Response) {
                val responseBody = response.body?.string()
                val truncatedBody =
                    if (responseBody != null && responseBody.length > 500) responseBody.take(500) + "..." else responseBody

                if (!response.isSuccessful || responseBody == null) {
                    val errorMsg = "Request failed: HTTP ${response.code} | backendUrl: $backendUrl" +
                        if (truncatedBody != null) " | body: $truncatedBody" else ""
                    android.util.Log.e(TAG, "❌ [analyzePortfolioLosers] $errorMsg")
                    pluginCall.reject(errorMsg)
                    return
                }

                try {
                    val result = JSObject(responseBody)
                    pluginCall.resolve(result)
                } catch (e: Exception) {
                    val errorMsg = "JSON parsing error: ${e.message} | backendUrl: $backendUrl"
                    android.util.Log.e(TAG, "❌ [analyzePortfolioLosers] $errorMsg")
                    pluginCall.reject(errorMsg)
                }
            }
        })
    }
    
    @PluginMethod
    fun importPortfolio(call: PluginCall) {
        android.util.Log.d(TAG, "🔍 importPortfolio called")
        
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }
        val fileName = call.getString("fileName") ?: run {
            call.reject("Missing fileName")
            return
        }
        val mimeType = call.getString("mimeType") ?: run {
            call.reject("Missing mimeType")
            return
        }
        // Use VAULT_OWNER token for consent-gated access
        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing vaultOwnerToken")
            return
        }
        val fileBase64 = call.getString("fileBase64") ?: run {
            call.reject("Missing fileBase64")
            return
        }
        
        // Decode base64 file content
        val fileData: ByteArray
        try {
            fileData = android.util.Base64.decode(fileBase64, android.util.Base64.DEFAULT)
        } catch (e: Exception) {
            android.util.Log.e(TAG, "❌ Invalid base64 file content: ${e.message}")
            call.reject("Invalid base64 file content")
            return
        }
        
        // Check file size (max 25MB)
        if (fileData.size > 25 * 1024 * 1024) {
            android.util.Log.e(TAG, "❌ File too large: ${fileData.size} bytes")
            call.reject("File too large. Maximum size is 25MB.")
            return
        }
        
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/kai/portfolio/import"
        
        android.util.Log.d(TAG, "🌐 URL: $url")
        android.util.Log.d(TAG, "📁 File: $fileName (${fileData.size} bytes)")
        
        // Build multipart request body
        val requestBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("user_id", userId)
            .addFormDataPart(
                "file",
                fileName,
                fileData.toRequestBody(mimeType.toMediaType())
            )
            .build()
        
        val request = Request.Builder()
            .url(url)
            .post(requestBody)
            .addHeader("Authorization", "Bearer $vaultOwnerToken")
            .build()
        
        val pluginCall = call
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: okhttp3.Call, e: IOException) {
                val errorMsg = "Network error: ${e.message} | backendUrl: $backendUrl"
                android.util.Log.e(TAG, "❌ [importPortfolio] $errorMsg")
                pluginCall.reject(errorMsg)
            }
            
            override fun onResponse(call: okhttp3.Call, response: Response) {
                val responseBody = response.body?.string()
                val truncatedBody = if (responseBody != null && responseBody.length > 500) {
                    responseBody.take(500) + "..."
                } else {
                    responseBody
                }
                
                if (!response.isSuccessful || responseBody == null) {
                    val errorMsg = "Request failed: HTTP ${response.code} | backendUrl: $backendUrl" +
                        if (truncatedBody != null) " | body: $truncatedBody" else ""
                    android.util.Log.e(TAG, "❌ [importPortfolio] $errorMsg")
                    pluginCall.reject(errorMsg)
                    return
                }
                
                try {
                    val result = JSObject(responseBody)
                    android.util.Log.d(TAG, "✅ importPortfolio success: holdings=${result.optInt("holdings_count", -1)}")
                    pluginCall.resolve(result)
                } catch (e: Exception) {
                    val errorMsg = "JSON parsing error: ${e.message} | backendUrl: $backendUrl"
                    android.util.Log.e(TAG, "❌ [importPortfolio] $errorMsg")
                    pluginCall.reject(errorMsg)
                }
            }
        })
    }

    companion object {
        private const val PORTFOLIO_STREAM_EVENT = "portfolioStreamEvent"
        private const val KAI_STREAM_EVENT = "kaiStreamEvent"
    }

    /** Emit one canonical SSE envelope to JS. */
    private fun emitPortfolioStreamEvent(envelope: JSObject) {
        notifyListeners(PORTFOLIO_STREAM_EVENT, envelope)
    }

    /** Emit one canonical SSE envelope to JS. */
    private fun emitKaiStreamEvent(envelope: JSObject) {
        notifyListeners(KAI_STREAM_EVENT, envelope)
    }

    private fun parseSsePayloadObject(dataText: String): JSObject? {
        return try {
            val parsed = JSONTokener(dataText).nextValue()
            when (parsed) {
                is JSONObject -> JSObject(parsed.toString())
                is String -> {
                    val nested = parsed.trim()
                    if (nested.startsWith("{") && nested.endsWith("}")) JSObject(nested) else null
                }
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun emitPortfolioSseBlock(eventName: String?, eventId: String?, dataText: String) {
        val payload = parseSsePayloadObject(dataText) ?: JSObject().apply { put("raw", dataText) }
        val eventType = eventName ?: "message"
        val envelope = JSObject()
        envelope.put("event", eventType)
        envelope.put("id", eventId ?: "")
        envelope.put("data", payload)
        emitPortfolioStreamEvent(envelope)
    }

    private fun emitKaiSseBlock(eventName: String?, eventId: String?, dataText: String) {
        val payload = parseSsePayloadObject(dataText) ?: JSObject().apply { put("message", dataText) }
        val eventType = eventName ?: "message"

        val envelope = JSObject()
        envelope.put("event", eventType)
        envelope.put("id", eventId ?: "")
        envelope.put("data", payload)
        emitKaiStreamEvent(envelope)
    }

    private fun processSseBlock(block: String, onBlock: (String?, String?, String) -> Unit) {
        var eventName: String? = null
        var eventId: String? = null
        val dataLines = mutableListOf<String>()
        for (line in block.split('\n')) {
            val trimmed = line.trim()
            when {
                trimmed.startsWith("event:") -> {
                    eventName = trimmed.removePrefix("event:").trim().ifEmpty { null }
                }
                trimmed.startsWith("id:") -> {
                    eventId = trimmed.removePrefix("id:").trim().ifEmpty { null }
                }
                trimmed.startsWith("data:") -> {
                    dataLines.add(trimmed.removePrefix("data:").trim())
                }
            }
        }
        if (dataLines.isEmpty()) return
        onBlock(eventName, eventId, dataLines.joinToString("\n"))
    }

    private fun processSseStream(reader: BufferedReader, onBlock: (String?, String?, String) -> Unit) {
        val block = StringBuilder()
        var line: String?
        while (reader.readLine().also { line = it } != null) {
            val current = line ?: continue
            if (current.isBlank()) {
                if (block.isNotEmpty()) {
                    processSseBlock(block.toString(), onBlock)
                    block.setLength(0)
                }
                continue
            }
            block.append(current).append('\n')
        }
        if (block.isNotEmpty()) {
            processSseBlock(block.toString(), onBlock)
        }
    }

    @PluginMethod
    fun streamKaiAnalysis(call: PluginCall) {
        val bodyObj = call.getObject("body") ?: run {
            call.reject("Missing body")
            return
        }
        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing vaultOwnerToken")
            return
        }

        val backendUrl = getBackendUrl(call)
        val runId = bodyObj.optString("run_id", "").trim()
        val request =
            if (runId.isNotEmpty()) {
                val userId = bodyObj.optString("user_id", "").trim()
                if (userId.isEmpty()) {
                    call.reject("Missing user_id for run stream")
                    return
                }
                val cursor = maxOf(0, bodyObj.optInt("resume_cursor", 0))
                val encodedRunId = URLEncoder.encode(runId, "UTF-8")
                val encodedUserId = URLEncoder.encode(userId, "UTF-8")
                val url =
                    "$backendUrl/api/kai/analyze/run/$encodedRunId/stream?user_id=$encodedUserId&cursor=$cursor"
                Request.Builder()
                    .url(url)
                    .get()
                    .addHeader("Authorization", "Bearer $vaultOwnerToken")
                    .addHeader("Accept", "text/event-stream")
                    .build()
            } else {
                val url = "$backendUrl/api/kai/analyze/stream"
                val bodyStr = bodyObj.toString()
                val requestBody = bodyStr.toRequestBody("application/json".toMediaType())
                Request.Builder()
                    .url(url)
                    .post(requestBody)
                    .addHeader("Authorization", "Bearer $vaultOwnerToken")
                    .build()
            }

        val pluginCall = call
        Thread {
            try {
                val response = httpClient.newCall(request).execute()
                if (!response.isSuccessful) {
                    activity.runOnUiThread { pluginCall.reject("HTTP ${response.code}") }
                    return@Thread
                }
                val body = response.body ?: run {
                    activity.runOnUiThread { pluginCall.reject("No response body") }
                    return@Thread
                }
                body.byteStream().use { stream ->
                    BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { reader ->
                        processSseStream(reader) { eventName, eventId, dataText ->
                            emitKaiSseBlock(eventName, eventId, dataText)
                        }
                    }
                }
                activity.runOnUiThread { pluginCall.resolve(JSObject().put("success", true)) }
            } catch (e: Exception) {
                android.util.Log.e(TAG, "streamKaiAnalysis error", e)
                activity.runOnUiThread { pluginCall.reject("Stream error: ${e.message}") }
            }
        }.start()
    }

    @PluginMethod
    fun streamPortfolioImport(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }
        val fileName = call.getString("fileName") ?: run {
            call.reject("Missing fileName")
            return
        }
        val mimeType = call.getString("mimeType") ?: run {
            call.reject("Missing mimeType")
            return
        }
        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing vaultOwnerToken")
            return
        }
        val fileBase64 = call.getString("fileBase64") ?: run {
            call.reject("Missing fileBase64")
            return
        }
        val fileData: ByteArray
        try {
            fileData = android.util.Base64.decode(fileBase64, android.util.Base64.DEFAULT)
        } catch (e: Exception) {
            call.reject("Invalid base64 file content")
            return
        }
        if (fileData.size > 25 * 1024 * 1024) {
            call.reject("File too large. Maximum size is 25MB.")
            return
        }
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/kai/portfolio/import/stream"
        val requestBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("user_id", userId)
            .addFormDataPart("file", fileName, fileData.toRequestBody(mimeType.toMediaType()))
            .build()
        val request = Request.Builder()
            .url(url)
            .post(requestBody)
            .addHeader("Authorization", "Bearer $vaultOwnerToken")
            .build()
        val pluginCall = call
        Thread {
            try {
                val response = httpClient.newCall(request).execute()
                if (!response.isSuccessful) {
                    activity.runOnUiThread { pluginCall.reject("HTTP ${response.code}") }
                    return@Thread
                }
                val body = response.body ?: run {
                    activity.runOnUiThread { pluginCall.reject("No response body") }
                    return@Thread
                }
                body.byteStream().use { stream ->
                    BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { reader ->
                        processSseStream(reader) { eventName, eventId, dataText ->
                            emitPortfolioSseBlock(eventName, eventId, dataText)
                        }
                    }
                }
                activity.runOnUiThread { pluginCall.resolve(JSObject().put("success", true)) }
            } catch (e: Exception) {
                android.util.Log.e(TAG, "streamPortfolioImport error", e)
                activity.runOnUiThread { pluginCall.reject("Stream error: ${e.message}") }
            }
        }.start()
    }

    @PluginMethod
    fun streamPortfolioImportRun(call: PluginCall) {
        val runId = call.getString("runId") ?: run {
            call.reject("Missing runId")
            return
        }
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }
        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing vaultOwnerToken")
            return
        }
        val cursor = call.getInt("cursor") ?: 0

        val backendUrl = getBackendUrl(call)
        val encodedRunId = URLEncoder.encode(runId, "UTF-8")
        val encodedUserId = URLEncoder.encode(userId, "UTF-8")
        val safeCursor = maxOf(0, cursor)
        val url =
            "$backendUrl/api/kai/portfolio/import/run/$encodedRunId/stream?user_id=$encodedUserId&cursor=$safeCursor"
        val request = Request.Builder()
            .url(url)
            .get()
            .addHeader("Authorization", "Bearer $vaultOwnerToken")
            .addHeader("Accept", "text/event-stream")
            .build()

        val pluginCall = call
        Thread {
            try {
                val response = httpClient.newCall(request).execute()
                if (!response.isSuccessful) {
                    activity.runOnUiThread { pluginCall.reject("HTTP ${response.code}") }
                    return@Thread
                }
                val body = response.body ?: run {
                    activity.runOnUiThread { pluginCall.reject("No response body") }
                    return@Thread
                }
                body.byteStream().use { stream ->
                    BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { reader ->
                        processSseStream(reader) { eventName, eventId, dataText ->
                            emitPortfolioSseBlock(eventName, eventId, dataText)
                        }
                    }
                }
                activity.runOnUiThread { pluginCall.resolve(JSObject().put("success", true)) }
            } catch (e: Exception) {
                android.util.Log.e(TAG, "streamPortfolioImportRun error", e)
                activity.runOnUiThread { pluginCall.reject("Stream error: ${e.message}") }
            }
        }.start()
    }

    @PluginMethod
    fun streamPortfolioAnalyzeLosers(call: PluginCall) {
        val bodyObj = call.getObject("body") ?: run {
            call.reject("Missing body")
            return
        }
        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing vaultOwnerToken")
            return
        }
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/kai/portfolio/analyze-losers/stream"
        val bodyStr = bodyObj.toString()
        val requestBody = bodyStr.toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url(url)
            .post(requestBody)
            .addHeader("Authorization", "Bearer $vaultOwnerToken")
            .build()
        val pluginCall = call
        Thread {
            try {
                val response = httpClient.newCall(request).execute()
                if (!response.isSuccessful) {
                    activity.runOnUiThread { pluginCall.reject("HTTP ${response.code}") }
                    return@Thread
                }
                val body = response.body ?: run {
                    activity.runOnUiThread { pluginCall.reject("No response body") }
                    return@Thread
                }
                body.byteStream().use { stream ->
                    BufferedReader(InputStreamReader(stream, Charsets.UTF_8)).use { reader ->
                        processSseStream(reader) { eventName, eventId, dataText ->
                            emitPortfolioSseBlock(eventName, eventId, dataText)
                        }
                    }
                }
                activity.runOnUiThread { pluginCall.resolve(JSObject().put("success", true)) }
            } catch (e: Exception) {
                android.util.Log.e(TAG, "streamPortfolioAnalyzeLosers error", e)
                activity.runOnUiThread { pluginCall.reject("Stream error: ${e.message}") }
            }
        }.start()
    }

    @PluginMethod
    fun chat(call: PluginCall) {
        android.util.Log.d(TAG, "🔍 chat called")
        
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }
        val message = call.getString("message") ?: run {
            call.reject("Missing message")
            return
        }
        // Use VAULT_OWNER token for consent-gated access
        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing vaultOwnerToken")
            return
        }
        
        val conversationId = call.getString("conversationId")
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/kai/chat"
        
        android.util.Log.d(TAG, "🌐 URL: $url")
        
        val json = JSONObject().apply {
            put("user_id", userId)
            put("message", message)
            if (conversationId != null) {
                put("conversation_id", conversationId)
            }
        }
        
        val body = json.toString().toRequestBody("application/json".toMediaType())
        
        val request = Request.Builder()
            .url(url)
            .post(body)
            .addHeader("Authorization", "Bearer $vaultOwnerToken")
            .build()
        
        val pluginCall = call
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: okhttp3.Call, e: IOException) {
                val errorMsg = "Network error: ${e.message} | backendUrl: $backendUrl"
                android.util.Log.e(TAG, "❌ [chat] $errorMsg")
                pluginCall.reject(errorMsg)
            }
            
            override fun onResponse(call: okhttp3.Call, response: Response) {
                val responseBody = response.body?.string()
                val truncatedBody = if (responseBody != null && responseBody.length > 200) {
                    responseBody.take(200) + "..."
                } else {
                    responseBody
                }
                
                if (!response.isSuccessful || responseBody == null) {
                    val errorMsg = "Request failed: HTTP ${response.code} | backendUrl: $backendUrl" +
                        if (truncatedBody != null) " | body: $truncatedBody" else ""
                    android.util.Log.e(TAG, "❌ [chat] $errorMsg")
                    pluginCall.reject(errorMsg)
                    return
                }
                
                try {
                    val result = JSObject(responseBody)
                    android.util.Log.d(TAG, "✅ chat success")
                    pluginCall.resolve(result)
                } catch (e: Exception) {
                    val errorMsg = "JSON parsing error: ${e.message} | backendUrl: $backendUrl"
                    android.util.Log.e(TAG, "❌ [chat] $errorMsg")
                    pluginCall.reject(errorMsg)
                }
            }
        })
    }

    @PluginMethod
    fun getInitialChatState(call: PluginCall) {
        android.util.Log.d(TAG, "🔍 getInitialChatState called")
        
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }
        
        // Use VAULT_OWNER token for consent-gated access
        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing vaultOwnerToken")
            return
        }
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/kai/chat/initial-state/$userId"
        
        android.util.Log.d(TAG, "🌐 URL: $url")
        
        val requestBuilder = Request.Builder()
            .url(url)
            .get()
            .addHeader("Authorization", "Bearer $vaultOwnerToken")
        
        val request = requestBuilder.build()
        val pluginCall = call
        
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: okhttp3.Call, e: IOException) {
                val errorMsg = "Network error: ${e.message} | backendUrl: $backendUrl"
                android.util.Log.e(TAG, "❌ [getInitialChatState] $errorMsg")
                pluginCall.reject(errorMsg)
            }
            
            override fun onResponse(call: okhttp3.Call, response: Response) {
                val responseBody = response.body?.string()
                val truncatedBody = if (responseBody != null && responseBody.length > 200) {
                    responseBody.take(200) + "..."
                } else {
                    responseBody
                }
                
                if (!response.isSuccessful || responseBody == null) {
                    val errorMsg = "Request failed: HTTP ${response.code} | backendUrl: $backendUrl" +
                        if (truncatedBody != null) " | body: $truncatedBody" else ""
                    android.util.Log.e(TAG, "❌ [getInitialChatState] $errorMsg")
                    pluginCall.reject(errorMsg)
                    return
                }
                
                try {
                    val result = JSObject(responseBody)
                    android.util.Log.d(TAG, "✅ getInitialChatState success")
                    pluginCall.resolve(result)
                } catch (e: Exception) {
                    val errorMsg = "JSON parsing error: ${e.message} | backendUrl: $backendUrl"
                    android.util.Log.e(TAG, "❌ [getInitialChatState] $errorMsg")
                    pluginCall.reject(errorMsg)
                }
            }
        })
    }
}
