package com.hushh.app.plugins.HushhConsent

import android.util.Base64
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.hushh.app.plugins.shared.BackendUrl
import java.security.InvalidKeyException
import java.security.NoSuchAlgorithmException
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Hushh Consent Plugin - Token Management + Backend API
 * Port of Python consent-protocol/hushh_mcp/consent/token.py
 *
 * Token format: HCT:base64(userId|agentId|scope|issuedAt|expiresAt).hmac_sha256_signature
 */
@CapacitorPlugin(name = "HushhConsent")
class HushhConsentPlugin : Plugin() {

    private val TAG = "HushhConsent"
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(75, TimeUnit.SECONDS)
        .build()
    
    private fun getBackendUrl(call: PluginCall? = null): String {
        return BackendUrl.resolve(bridge, call, "HushhConsent")
    }

    companion object {
        private const val CONSENT_TOKEN_PREFIX = "HCT"
        private const val TRUST_LINK_PREFIX = "HTL"
        private const val DEFAULT_CONSENT_TOKEN_EXPIRY_MS = 1000L * 60 * 60 * 24 * 7  // 7 days
        private const val DEFAULT_TRUST_LINK_EXPIRY_MS = 1000L * 60 * 60 * 24 * 30   // 30 days

        // In-memory revocation registry (matches Python implementation)
        private val revokedTokens = mutableSetOf<String>()
    }

    /**
     * Get secret key from BuildConfig or environment
     */
    private val secretKey: String
        get() {
            // In production, this should come from secure storage
            return System.getenv("SECRET_KEY") ?: "development_secret_key_32_chars!"
        }

    // ==================== Issue Token ====================

    @PluginMethod
    fun issueToken(call: PluginCall) {
        val userId = call.getString("userId")
        val agentId = call.getString("agentId")
        val scope = call.getString("scope")

        if (userId == null || agentId == null || scope == null) {
            call.reject("Missing required parameters: userId, agentId, scope")
            return
        }

        val expiresInMs = call.getInt("expiresInMs")?.toLong() ?: DEFAULT_CONSENT_TOKEN_EXPIRY_MS

        val issuedAt = System.currentTimeMillis()
        val expiresAt = issuedAt + expiresInMs

        // Build raw payload: userId|agentId|scope|issuedAt|expiresAt
        val raw = "$userId|$agentId|$scope|$issuedAt|$expiresAt"

        // Sign with HMAC-SHA256
        val signature = sign(raw)

        // Encode to base64 (URL-safe)
        val encoded = Base64.encodeToString(raw.toByteArray(Charsets.UTF_8), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

        // Build token: HCT:base64.signature
        val token = "$CONSENT_TOKEN_PREFIX:$encoded.$signature"

        // Generate a short token ID for reference
        val tokenId = token.take(32)

        Log.d(TAG, "✅ [HushhConsent] Token issued for $userId, scope: $scope")

        call.resolve(JSObject().apply {
            put("token", token)
            put("tokenId", tokenId)
            put("expiresAt", expiresAt)
        })
    }

    // ==================== Validate Token ====================

    @PluginMethod
    fun validateToken(call: PluginCall) {
        val tokenStr = call.getString("token")
        if (tokenStr == null) {
            call.reject("Missing required parameter: token")
            return
        }

        val expectedScope = call.getString("expectedScope")

        // Check if revoked
        if (revokedTokens.contains(tokenStr)) {
            call.resolve(JSObject().apply {
                put("valid", false)
                put("reason", "Token has been revoked")
            })
            return
        }

        try {
            val result = parseAndValidateToken(tokenStr, expectedScope)
            call.resolve(result)
        } catch (e: TokenException) {
            call.resolve(JSObject().apply {
                put("valid", false)
                put("reason", e.message)
            })
        } catch (e: Exception) {
            call.resolve(JSObject().apply {
                put("valid", false)
                put("reason", "Malformed token: ${e.message}")
            })
        }
    }

    // ==================== Revoke Token ====================

    @PluginMethod
    fun revokeToken(call: PluginCall) {
        val token = call.getString("token")
        if (token == null) {
            call.reject("Missing required parameter: token")
            return
        }

        revokedTokens.add(token)
        Log.d(TAG, "🔒 [HushhConsent] Token revoked")
        call.resolve()
    }

    @PluginMethod
    fun revokeConsent(call: PluginCall) {
        val userId = call.getString("userId")
        val scope = call.getString("scope")
        
        if (userId == null || scope == null) {
            call.reject("Missing required parameters: userId and scope")
            return
        }

        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/consent/revoke"

        Log.d(TAG, "🔒 [revokeConsent] Revoking consent for scope: $scope")

        Thread {
            try {
                val jsonBody = JSONObject().apply {
                    put("userId", userId)
                    put("scope", scope)
                }
                val requestBody = jsonBody.toString().toRequestBody("application/json".toMediaType())
                
                val requestBuilder = Request.Builder()
                    .url(url)
                    .post(requestBody)
                    .addHeader("Content-Type", "application/json")
                    .addHeader("Authorization", "Bearer $vaultOwnerToken")

                val response = httpClient.newCall(requestBuilder.build()).execute()
                val success = response.isSuccessful
                val responseBody = response.body?.string() ?: "{}"

                if (!success) {
                    Log.e(TAG, "❌ [revokeConsent] Backend error: $responseBody")
                }
                
                activity.runOnUiThread {
                    if (success) {
                        // Parse backend response to extract lockVault flag
                        val responseJson = try { JSONObject(responseBody) } catch (e: Exception) { JSONObject() }
                        val lockVault = responseJson.optBoolean("lockVault", false)
                        
                        Log.d(TAG, "🔒 [revokeConsent] Success, lockVault: $lockVault")
                        
                        call.resolve(JSObject().apply {
                            put("success", true)
                            put("lockVault", lockVault)
                        })
                    } else {
                        call.reject("Backend rejected revoke: $responseBody")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "❌ [revokeConsent] Error: ${e.message}")
                activity.runOnUiThread {
                    call.reject("Failed to revoke consent: ${e.message}")
                }
            }
        }.start()
    }

    // ==================== Is Token Revoked ====================

    @PluginMethod
    fun isTokenRevoked(call: PluginCall) {
        val token = call.getString("token")
        if (token == null) {
            call.reject("Missing required parameter: token")
            return
        }

        val revoked = revokedTokens.contains(token)
        call.resolve(JSObject().put("revoked", revoked))
    }

    // ==================== Create Trust Link ====================

    @PluginMethod
    fun createTrustLink(call: PluginCall) {
        val fromAgent = call.getString("fromAgent")
        val toAgent = call.getString("toAgent")
        val scope = call.getString("scope")
        val signedByUser = call.getString("signedByUser")

        if (fromAgent == null || toAgent == null || scope == null || signedByUser == null) {
            call.reject("Missing required parameters")
            return
        }

        val expiresInMs = call.getInt("expiresInMs")?.toLong() ?: DEFAULT_TRUST_LINK_EXPIRY_MS

        val createdAt = System.currentTimeMillis()
        val expiresAt = createdAt + expiresInMs

        // Build raw payload
        val raw = "$fromAgent|$toAgent|$scope|$createdAt|$expiresAt|$signedByUser"

        // Sign with HMAC-SHA256
        val signature = sign(raw)

        Log.d(TAG, "✅ [HushhConsent] TrustLink created from $fromAgent to $toAgent")

        call.resolve(JSObject().apply {
            put("fromAgent", fromAgent)
            put("toAgent", toAgent)
            put("scope", scope)
            put("createdAt", createdAt)
            put("expiresAt", expiresAt)
            put("signedByUser", signedByUser)
            put("signature", signature)
        })
    }

    // ==================== Verify Trust Link ====================

    @PluginMethod
    fun verifyTrustLink(call: PluginCall) {
        val link = call.getObject("link")
        if (link == null) {
            call.reject("Invalid link object")
            return
        }

        val fromAgent = link.getString("fromAgent")
        val toAgent = link.getString("toAgent")
        val scope = link.getString("scope")
        val createdAt = link.getLong("createdAt")
        val expiresAt = link.getLong("expiresAt")
        val signedByUser = link.getString("signedByUser")
        val signature = link.getString("signature")

        if (fromAgent == null || toAgent == null || scope == null || 
            createdAt == null || expiresAt == null || signedByUser == null || signature == null) {
            call.reject("Invalid link object")
            return
        }

        val requiredScope = call.getString("requiredScope")

        // Check expiry
        val now = System.currentTimeMillis()
        if (now > expiresAt) {
            call.resolve(JSObject().apply {
                put("valid", false)
                put("reason", "Trust link expired")
            })
            return
        }

        // Check scope if required
        if (requiredScope != null && scope != requiredScope) {
            call.resolve(JSObject().apply {
                put("valid", false)
                put("reason", "Scope mismatch")
            })
            return
        }

        // Verify signature
        val raw = "$fromAgent|$toAgent|$scope|$createdAt|$expiresAt|$signedByUser"
        val expectedSig = sign(raw)

        if (signature != expectedSig) {
            call.resolve(JSObject().apply {
                put("valid", false)
                put("reason", "Invalid signature")
            })
            return
        }

        call.resolve(JSObject().put("valid", true))
    }

    // ====================Backend API Methods ====================
    // These call the Cloud Run backend directly for consent operations

    /**
     * Issue VAULT_OWNER consent token.
     * 
     * Called after vault unlock. Sends Firebase ID token to backend
     * which verifies it and issues the master VAULT_OWNER scope token.
     */
    @PluginMethod
    fun issueVaultOwnerToken(call: PluginCall) {
        val userId = call.getString("userId")
        val authToken = call.getString("authToken")
        
        if (userId == null || authToken == null) {
            call.reject("Missing required parameters: userId and authToken")
            return
        }

        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/consent/vault-owner-token"

        Log.d(TAG, "🔑 [issueVaultOwnerToken] Requesting VAULT_OWNER token for user: $userId")

        Thread {
            try {
                val jsonBody = JSONObject().apply {
                    put("userId", userId)
                }
                val requestBody = jsonBody.toString().toRequestBody("application/json".toMediaType())
                
                val requestBuilder = Request.Builder()
                    .url(url)
                    .post(requestBody)
                    .addHeader("Content-Type", "application/json")
                    .addHeader("Authorization", "Bearer $authToken")

                val response = httpClient.newCall(requestBuilder.build()).execute()
                val body = response.body?.string() ?: "{}"
                val truncatedBody = if (body.length > 200) body.take(200) + "..." else body
                
                if (!response.isSuccessful) {
                    val errorMsg = "Failed to issue VAULT_OWNER token: HTTP ${response.code} | backendUrl: $backendUrl | body: $truncatedBody"
                    Log.e(TAG, "❌ [issueVaultOwnerToken] $errorMsg")
                    activity.runOnUiThread {
                        call.reject(errorMsg)
                    }
                    return@Thread
                }
                
                val json = JSONObject(body)
                val token = json.getString("token")
                val expiresAt = json.getLong("expiresAt")
                val scope = json.getString("scope")
                
                Log.d(TAG, "✅ [issueVaultOwnerToken] VAULT_OWNER token issued successfully")
                
                activity.runOnUiThread {
                    call.resolve(JSObject().apply {
                        put("token", token)
                        put("expiresAt", expiresAt)
                        put("scope", scope)
                    })
                }
            } catch (e: Exception) {
                val errorMsg = "Failed to issue VAULT_OWNER token: ${e.message} | backendUrl: $backendUrl"
                Log.e(TAG, "❌ [issueVaultOwnerToken] $errorMsg")
                activity.runOnUiThread {
                    call.reject(errorMsg)
                }
            }
        }.start()
    }

    @PluginMethod
    fun getPending(call: PluginCall) {
        val userId = call.getString("userId")
        if (userId == null) {
            call.reject("Missing required parameter: userId")
            return
        }

        // Consent-gated: requires VAULT_OWNER token only
        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/consent/pending?userId=$userId"

        Log.d(TAG, "📋 [getPending] Fetching pending consents for userId: $userId")

        Thread {
            try {
                val requestBuilder = Request.Builder()
                    .url(url)
                    .get()
                    .addHeader("Content-Type", "application/json")
                    .addHeader("Authorization", "Bearer $vaultOwnerToken")

                val response = httpClient.newCall(requestBuilder.build()).execute()
                val body = response.body?.string() ?: "{}"
                
                Log.d(TAG, "📋 [getPending] Response code: ${response.code}")

                activity.runOnUiThread {
                    if (!response.isSuccessful) {
                        call.reject("Failed to get pending consents: HTTP ${response.code}")
                        return@runOnUiThread
                    }
                    val json = JSONObject(body)
                    val pending = json.optJSONArray("pending") ?: org.json.JSONArray()
                    call.resolve(JSObject().put("consents", pending))
                }
            } catch (e: Exception) {
                Log.e(TAG, "❌ [getPending] Error: ${e.message}")
                activity.runOnUiThread {
                    call.reject("Failed to get pending consents: ${e.message}")
                }
            }
        }.start()
    }

    @PluginMethod
    fun getActive(call: PluginCall) {
        val userId = call.getString("userId")
        if (userId == null) {
            call.reject("Missing required parameter: userId")
            return
        }

        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/consent/active?userId=$userId"

        Log.d(TAG, "✅ [getActive] Fetching active consents for userId: $userId")

        Thread {
            try {
                val requestBuilder = Request.Builder()
                    .url(url)
                    .get()
                    .addHeader("Content-Type", "application/json")
                    .addHeader("Authorization", "Bearer $vaultOwnerToken")

                val response = httpClient.newCall(requestBuilder.build()).execute()
                val body = response.body?.string() ?: "{}"
                
                activity.runOnUiThread {
                    if (!response.isSuccessful) {
                        call.reject("Failed to get active consents: HTTP ${response.code}")
                        return@runOnUiThread
                    }
                    val json = JSONObject(body)
                    val active = json.optJSONArray("active") ?: org.json.JSONArray()
                    call.resolve(JSObject().put("consents", active))
                }
            } catch (e: Exception) {
                Log.e(TAG, "❌ [getActive] Error: ${e.message}")
                activity.runOnUiThread {
                    call.reject("Failed to get active consents: ${e.message}")
                }
            }
        }.start()
    }

    @PluginMethod
    fun getHistory(call: PluginCall) {
        val userId = call.getString("userId")
        if (userId == null) {
            call.reject("Missing required parameter: userId")
            return
        }

        val page = call.getInt("page") ?: 1
        val limit = call.getInt("limit") ?: 20
        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/consent/history?userId=$userId&page=$page&limit=$limit"

        Log.d(TAG, "📜 [getHistory] Fetching consent history for userId: $userId")

        Thread {
            try {
                val requestBuilder = Request.Builder()
                    .url(url)
                    .get()
                    .addHeader("Content-Type", "application/json")
                    .addHeader("Authorization", "Bearer $vaultOwnerToken")

                val response = httpClient.newCall(requestBuilder.build()).execute()
                val body = response.body?.string() ?: "{}"
                
                activity.runOnUiThread {
                    if (!response.isSuccessful) {
                        call.reject("Failed to get consent history: HTTP ${response.code}")
                        return@runOnUiThread
                    }
                    call.resolve(JSObject(body))
                }
            } catch (e: Exception) {
                Log.e(TAG, "❌ [getHistory] Error: ${e.message}")
                activity.runOnUiThread {
                    call.reject("Failed to get consent history: ${e.message}")
                }
            }
        }.start()
    }

    @PluginMethod
    fun approve(call: PluginCall) {
        val requestId = call.getString("requestId")
        if (requestId == null) {
            call.reject("Missing required parameter: requestId")
            return
        }

        // Optional encrypted payload
        val encryptedData = call.getString("encryptedData")
        val encryptedIv = call.getString("encryptedIv")
        val encryptedTag = call.getString("encryptedTag")
        val wrappedExportKey = call.getString("wrappedExportKey")
        val wrappedKeyIv = call.getString("wrappedKeyIv")
        val wrappedKeyTag = call.getString("wrappedKeyTag")
        val senderPublicKey = call.getString("senderPublicKey")
        val wrappingAlg = call.getString("wrappingAlg")
        val connectorKeyId = call.getString("connectorKeyId")
        val sourceContentRevision = call.getInt("sourceContentRevision")
        val sourceManifestRevision = call.getInt("sourceManifestRevision")
        val durationHours = call.getInt("durationHours")
        val userId = call.getString("userId") // Optional, but good context

        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/consent/pending/approve"

        Log.d(TAG, "✅ [approve] Approving consent request: $requestId")

        Thread {
            try {
                val jsonBody = JSONObject().apply {
                    put("requestId", requestId)
                    if (userId != null) put("userId", userId)
                    if (encryptedData != null) put("encryptedData", encryptedData)
                    if (encryptedIv != null) put("encryptedIv", encryptedIv)
                    if (encryptedTag != null) put("encryptedTag", encryptedTag)
                    if (wrappedExportKey != null) put("wrappedExportKey", wrappedExportKey)
                    if (wrappedKeyIv != null) put("wrappedKeyIv", wrappedKeyIv)
                    if (wrappedKeyTag != null) put("wrappedKeyTag", wrappedKeyTag)
                    if (senderPublicKey != null) put("senderPublicKey", senderPublicKey)
                    if (wrappingAlg != null) put("wrappingAlg", wrappingAlg)
                    if (connectorKeyId != null) put("connectorKeyId", connectorKeyId)
                    if (sourceContentRevision != null) put("sourceContentRevision", sourceContentRevision)
                    if (sourceManifestRevision != null) put("sourceManifestRevision", sourceManifestRevision)
                    if (durationHours != null) put("durationHours", durationHours)
                }
                
                val requestBody = jsonBody.toString().toRequestBody("application/json".toMediaType())
                
                val requestBuilder = Request.Builder()
                    .url(url)
                    .post(requestBody)
                    .addHeader("Content-Type", "application/json")
                    .addHeader("Authorization", "Bearer $vaultOwnerToken")

                val response = httpClient.newCall(requestBuilder.build()).execute()
                val success = response.isSuccessful
                val responseBody = response.body?.string() ?: ""

                if (!success) {
                    Log.e(TAG, "❌ [approve] Backend error: $responseBody")
                }
                
                activity.runOnUiThread {
                    if (success) {
                        call.resolve(JSObject().put("success", true))
                    } else {
                        call.reject("Backend rejected approval: $responseBody")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "❌ [approve] Error: ${e.message}")
                activity.runOnUiThread {
                    call.reject("Failed to approve consent: ${e.message}")
                }
            }
        }.start()
    }

    @PluginMethod
    fun deny(call: PluginCall) {
        val requestId = call.getString("requestId")
        val userId = call.getString("userId")
        
        if (requestId == null || userId == null) {
            call.reject("Missing required parameters: requestId and userId")
            return
        }

        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        val backendUrl = getBackendUrl(call)
        // Python backend expects userId and requestId as query parameters
        val url = "$backendUrl/api/consent/pending/deny?userId=$userId&requestId=$requestId"

        Log.d(TAG, "❌ [deny] Denying consent request: $requestId for user: $userId")

        Thread {
            try {
                // POST with empty body since params are in URL
                val requestBody = "".toRequestBody("application/json".toMediaType())
                
                val requestBuilder = Request.Builder()
                    .url(url)
                    .post(requestBody)
                    .addHeader("Content-Type", "application/json")
                    .addHeader("Authorization", "Bearer $vaultOwnerToken")

                val response = httpClient.newCall(requestBuilder.build()).execute()
                val success = response.isSuccessful
                val responseBody = response.body?.string() ?: ""
                
                if (!success) {
                    Log.e(TAG, "❌ [deny] Backend error: $responseBody")
                }
                
                activity.runOnUiThread {
                    if (success) {
                        call.resolve(JSObject().put("success", true))
                    } else {
                        call.reject("Backend rejected deny: $responseBody")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "❌ [deny] Error: ${e.message}")
                activity.runOnUiThread {
                    call.reject("Failed to deny consent: ${e.message}")
                }
            }
        }.start()
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val requestId = call.getString("requestId")
        if (requestId == null) {
            call.reject("Missing required parameter: requestId")
            return
        }

        val vaultOwnerToken = call.getString("vaultOwnerToken") ?: run {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/consent/cancel"

        Log.d(TAG, "🚫 [cancel] Canceling consent request: $requestId")

        Thread {
            try {
                val jsonBody = JSONObject().apply { put("requestId", requestId) }
                val requestBody = jsonBody.toString().toRequestBody("application/json".toMediaType())
                
                val requestBuilder = Request.Builder()
                    .url(url)
                    .post(requestBody)
                    .addHeader("Content-Type", "application/json")
                    .addHeader("Authorization", "Bearer $vaultOwnerToken")

                val response = httpClient.newCall(requestBuilder.build()).execute()
                val success = response.isSuccessful
                
                activity.runOnUiThread {
                    call.resolve(JSObject().put("success", success))
                }
            } catch (e: Exception) {
                Log.e(TAG, "❌ [cancel] Error: ${e.message}")
                activity.runOnUiThread {
                    call.reject("Failed to cancel consent: ${e.message}")
                }
            }
        }.start()
    }

    // ==================== Private Helpers ====================

    /**
     * HMAC-SHA256 signing - matches Python _sign() function
     */
    private fun sign(input: String): String {
        return try {
            val mac = Mac.getInstance("HmacSHA256")
            val keySpec = SecretKeySpec(secretKey.toByteArray(Charsets.UTF_8), "HmacSHA256")
            mac.init(keySpec)
            val bytes = mac.doFinal(input.toByteArray(Charsets.UTF_8))
            bytes.joinToString("") { "%02x".format(it) }
        } catch (e: NoSuchAlgorithmException) {
            throw RuntimeException("HmacSHA256 not available", e)
        } catch (e: InvalidKeyException) {
            throw RuntimeException("Invalid key", e)
        }
    }

    /**
     * Parse and validate token structure
     */
    private fun parseAndValidateToken(tokenStr: String, expectedScope: String?): JSObject {
        // Split prefix:signedPart
        val parts = tokenStr.split(":", limit = 2)
        if (parts.size != 2) {
            throw TokenException("Invalid token format")
        }

        val prefix = parts[0]
        val signedPart = parts[1]

        // Validate prefix
        if (prefix != CONSENT_TOKEN_PREFIX) {
            throw TokenException("Invalid token prefix")
        }

        // Split encoded.signature
        val signedParts = signedPart.split(".", limit = 2)
        if (signedParts.size != 2) {
            throw TokenException("Invalid token format")
        }

        val encoded = signedParts[0]
        val signature = signedParts[1]

        // Decode base64 (URL-safe)
        val decoded = try {
            String(Base64.decode(encoded, Base64.URL_SAFE or Base64.NO_WRAP), Charsets.UTF_8)
        } catch (e: Exception) {
            throw TokenException("Failed to decode token")
        }

        // Parse payload: userId|agentId|scope|issuedAt|expiresAt
        val components = decoded.split("|")
        if (components.size != 5) {
            throw TokenException("Invalid token payload")
        }

        val userId = components[0]
        val agentId = components[1]
        val scopeStr = components[2]
        val issuedAt = components[3].toLongOrNull() ?: throw TokenException("Invalid timestamp in token")
        val expiresAt = components[4].toLongOrNull() ?: throw TokenException("Invalid timestamp in token")

        // Verify signature
        val raw = "$userId|$agentId|$scopeStr|$issuedAt|$expiresAt"
        val expectedSig = sign(raw)

        if (signature != expectedSig) {
            throw TokenException("Invalid signature")
        }

        // Check scope
        if (expectedScope != null && scopeStr != expectedScope) {
            throw TokenException("Scope mismatch")
        }

        // Check expiry
        val now = System.currentTimeMillis()
        if (now > expiresAt) {
            throw TokenException("Token expired")
        }

        return JSObject().apply {
            put("valid", true)
            put("userId", userId)
            put("agentId", agentId)
            put("scope", scopeStr)
        }
    }
}

// ==================== Token Exception ====================

private class TokenException(message: String) : Exception(message)
