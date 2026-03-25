package com.hushh.app.plugins.PersonalKnowledgeModel

import com.getcapacitor.*
import com.getcapacitor.annotation.CapacitorPlugin
import com.hushh.app.plugins.shared.BackendUrl
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import android.util.Base64
import java.net.URLEncoder

/**
 * PersonalKnowledgeModel Plugin - Android Implementation
 * 
 * Native plugin for PKM operations.
 * Provides access to user's PKM data for native platforms.
 * 
 * Methods:
 * - getMetadata: Get user's PKM metadata (domains, attribute counts)
 * - getAttributes: Get attributes for a specific domain
 * - storeAttribute: Store an encrypted attribute
 * - getInitialChatState: Get initial chat state for proactive welcome
 * - importPortfolio: Import portfolio from file
 * - listDomains: List all registered domains
 * - getUserDomains: Get domains for a specific user
 * - getAvailableScopes: Get available consent scopes for a user
 */

@CapacitorPlugin(name = "PersonalKnowledgeModel")
class PersonalKnowledgeModelPlugin : Plugin() {
    
    private val TAG = "PersonalKnowledgeModelPlugin"

    // OkHttp client with reasonable timeouts
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .callTimeout(90, TimeUnit.SECONDS)
        .build()

    // Longer timeout client for file uploads
    private val uploadClient: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(120, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .callTimeout(180, TimeUnit.SECONDS)
        .build()

    private fun getBackendUrl(call: PluginCall? = null): String {
        return BackendUrl.resolve(bridge, call, "PersonalKnowledgeModel")
    }

    private fun getAuthToken(call: PluginCall): String? {
        // Consent-first: PKM access is consent-gated. Do not fall back to Firebase tokens.
        val raw = call.getString("vaultOwnerToken")
        return if (raw.isNullOrBlank()) null else raw
    }
    
    /**
     * Get user's PKM metadata.
     * 
     * Parameters:
     * - userId: User's Firebase UID
     * - authToken: Firebase ID token for authentication
     */
    @PluginMethod
    fun getMetadata(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }
        
        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/pkm/metadata/$userId"
        
        val requestBuilder = Request.Builder().url(url).get()
        
        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }
        
        executeRequest(requestBuilder.build(), call)
    }

    /**
     * Get user's PKM index.
     */
    @PluginMethod
    fun getIndex(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }

        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/pkm/index/$userId"

        val requestBuilder = Request.Builder().url(url).get()

        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }

        executeRequest(requestBuilder.build(), call)
    }
    
    /**
     * Get attributes for a specific domain.
     * 
     * Parameters:
     * - userId: User's Firebase UID
     * - domain: Domain key (e.g., "financial", "food")
     * - authToken: Firebase ID token for authentication
     */
    @PluginMethod
    fun getAttributes(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }
        
        val domain = call.getString("domain")
        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = if (!domain.isNullOrBlank()) {
            "$backendUrl/api/pkm/attributes/$userId?domain=$domain"
        } else {
            "$backendUrl/api/pkm/attributes/$userId"
        }
        
        val requestBuilder = Request.Builder().url(url).get()
        
        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }
        
        executeRequest(requestBuilder.build(), call)
    }
    
    /**
     * Store an encrypted attribute.
     * 
     * Parameters:
     * - userId: User's Firebase UID
     * - domain: Domain key
     * - attributeKey: Attribute key
     * - ciphertext: Encrypted value
     * - iv: Initialization vector
     * - tag: Authentication tag
     * - authToken: Firebase ID token for authentication
     */
    @PluginMethod
    fun storeAttribute(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }
        
        val attributeKey = call.getString("attributeKey") ?: run {
            call.reject("Missing attributeKey")
            return
        }
        
        val ciphertext = call.getString("ciphertext") ?: run {
            call.reject("Missing ciphertext")
            return
        }
        
        val iv = call.getString("iv") ?: run {
            call.reject("Missing iv")
            return
        }
        
        val tag = call.getString("tag") ?: run {
            call.reject("Missing tag")
            return
        }
        
        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/pkm/attributes"
        
        val json = JSONObject().apply {
            put("user_id", userId)
            put("attribute_key", attributeKey)
            put("ciphertext", ciphertext)
            put("iv", iv)
            put("tag", tag)
            if (!call.getString("domain").isNullOrBlank()) {
                put("domain", call.getString("domain"))
            }
            
            // Optional fields
            call.getString("source")?.let { put("source", it) }
            call.getFloat("confidence")?.let { put("confidence", it) }
            call.getString("displayName")?.let { put("display_name", it) }
            call.getString("dataType")?.let { put("data_type", it) }
        }
        
        val body = json.toString().toRequestBody("application/json".toMediaType())
        
        val requestBuilder = Request.Builder().url(url).post(body)
        
        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }
        
        executeRequest(requestBuilder.build(), call)
    }

    /**
     * Delete a specific attribute.
     */
    @PluginMethod
    fun deleteAttribute(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }

        val domain = call.getString("domain") ?: run {
            call.reject("Missing domain")
            return
        }

        val attributeKey = call.getString("attributeKey") ?: run {
            call.reject("Missing attributeKey")
            return
        }

        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/pkm/attributes/$userId/$domain/$attributeKey"

        val requestBuilder = Request.Builder().url(url).delete()

        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }

        executeRequest(requestBuilder.build(), call)
    }
    
    /**
     * Get initial chat state for proactive welcome.
     * 
     * Parameters:
     * - userId: User's Firebase UID
     * - authToken: Firebase ID token for authentication
     */
    @PluginMethod
    fun getInitialChatState(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }
        
        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/kai/chat/initial-state/$userId"
        
        val requestBuilder = Request.Builder().url(url).get()
        
        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }
        
        executeRequest(requestBuilder.build(), call)
    }
    
    /**
     * Import portfolio from file.
     * 
     * Parameters:
     * - userId: User's Firebase UID
     * - fileData: Base64 encoded file data
     * - fileName: Original file name
     * - fileType: MIME type (e.g., "text/csv", "application/pdf")
     * - authToken: Firebase ID token for authentication
     */
    @PluginMethod
    fun importPortfolio(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }
        
        val fileData = call.getString("fileData") ?: run {
            call.reject("Missing fileData")
            return
        }
        
        val fileName = call.getString("fileName") ?: run {
            call.reject("Missing fileName")
            return
        }
        
        val fileType = call.getString("fileType") ?: "text/csv"
        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/kai/portfolio/import"
        
        // Decode base64 file data
        val fileBytes = try {
            Base64.decode(fileData, Base64.DEFAULT)
        } catch (e: Exception) {
            call.reject("Invalid base64 file data: ${e.message}")
            return
        }
        
        // Create multipart form data
        val requestBody = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("user_id", userId)
            .addFormDataPart(
                "file",
                fileName,
                fileBytes.toRequestBody(fileType.toMediaType())
            )
            .build()
        
        val requestBuilder = Request.Builder()
            .url(url)
            .post(requestBody)
        
        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }
        
        // Use upload client with longer timeouts
        uploadClient.newCall(requestBuilder.build()).enqueue(object : Callback {
            override fun onFailure(httpCall: Call, e: IOException) {
                call.reject("Network error: ${e.message}")
            }
            
            override fun onResponse(httpCall: Call, response: Response) {
                response.use {
                    if (!response.isSuccessful) {
                        val errorBody = response.body?.string() ?: "Unknown error"
                        call.reject("HTTP Error ${response.code}: $errorBody")
                        return
                    }
                    
                    val responseBody = response.body?.string()
                    if (responseBody == null) {
                        call.reject("Empty response")
                        return
                    }
                    
                    try {
                        val json = JSONObject(responseBody)
                        val result = JSObject()
                        json.keys().forEach { key ->
                            result.put(key, json.get(key))
                        }
                        call.resolve(result)
                    } catch (e: Exception) {
                        call.reject("JSON parsing error: ${e.message}")
                    }
                }
            }
        })
    }
    
    /**
     * List all registered domains.
     * 
     * Parameters:
     * - includeEmpty: Include domains with no attributes (default: false)
     * - authToken: Firebase ID token for authentication
     * 
     * Returns:
     * - domains: Array of domain metadata objects
     */
    @PluginMethod
    fun listDomains(call: PluginCall) {
        val includeEmpty = call.getBoolean("includeEmpty") ?: false
        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/pkm/domains?include_empty=$includeEmpty"
        
        val requestBuilder = Request.Builder().url(url).get()
        
        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }
        
        executeRequest(requestBuilder.build(), call)
    }
    
    /**
     * Get domains for a specific user (only domains with data).
     * 
     * Parameters:
     * - userId: User's Firebase UID
     * - authToken: Firebase ID token for authentication
     * 
     * Returns:
     * - domains: Array of domain metadata objects with user-specific counts
     */
    @PluginMethod
    fun getUserDomains(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }
        
        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/pkm/domains/$userId"
        
        val requestBuilder = Request.Builder().url(url).get()
        
        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }
        
        executeRequest(requestBuilder.build(), call)
    }
    
    /**
     * Get available consent scopes for a user.
     * 
     * Parameters:
     * - userId: User's Firebase UID
     * - authToken: Firebase ID token for authentication
     * 
     * Returns:
     * - scopes: Array of available scopes with display information
     * - wildcards: Array of wildcard scopes (e.g., "attr.financial.*")
     */
    @PluginMethod
    fun getAvailableScopes(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }
        
        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/pkm/scopes/$userId"
        
        val requestBuilder = Request.Builder().url(url).get()
        
        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }
        
        executeRequest(requestBuilder.build(), call)
    }

    /**
     * Get user's portfolio.
     */
    @PluginMethod
    fun getPortfolio(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }

        val portfolioName = call.getString("portfolioName") ?: "Main Portfolio"
        val encodedName = URLEncoder.encode(portfolioName, "UTF-8")
        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/pkm/portfolio/$userId?portfolio_name=$encodedName"

        val requestBuilder = Request.Builder().url(url).get()

        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }

        executeRequest(requestBuilder.build(), call)
    }

    /**
     * List all portfolios for a user.
     */
    @PluginMethod
    fun listPortfolios(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }

        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/pkm/portfolios/$userId"

        val requestBuilder = Request.Builder().url(url).get()

        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }

        executeRequest(requestBuilder.build(), call)
    }

    /**
     * Get full encrypted PKM blob for a user.
     */
    @PluginMethod
    fun getEncryptedData(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }

        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/pkm/data/$userId"

        val requestBuilder = Request.Builder().url(url).get()
        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }

        executeRequest(requestBuilder.build(), call)
    }

    /**
     * Store encrypted domain blob.
     */
    @PluginMethod
    fun storeDomainData(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }

        val domain = call.getString("domain") ?: run {
            call.reject("Missing domain")
            return
        }

        val encryptedBlob = call.getObject("encryptedBlob") ?: run {
            call.reject("Missing encryptedBlob")
            return
        }

        val ciphertext = encryptedBlob.getString("ciphertext")
        val iv = encryptedBlob.getString("iv")
        val tag = encryptedBlob.getString("tag")
        if (ciphertext == null || iv == null || tag == null) {
            call.reject("Missing encryptedBlob fields")
            return
        }

        val summary = call.getObject("summary") ?: JSObject()
        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/pkm/store-domain"

        val blob = JSONObject().apply {
            put("ciphertext", ciphertext)
            put("iv", iv)
            put("tag", tag)
            encryptedBlob.getString("algorithm")?.let { put("algorithm", it) }
            encryptedBlob.optJSONObject("segments")?.let { put("segments", it) }
        }

        val json = JSONObject().apply {
            put("user_id", userId)
            put("domain", domain)
            put("encrypted_blob", blob)
            put("summary", summary)
            call.getObject("structureDecision")?.let { put("structure_decision", it) }
            call.getObject("manifest")?.let { put("manifest", it) }
            call.getInt("expectedDataVersion")?.let { put("expected_data_version", it) }
            call.getObject("upgradeContext")?.let { upgradeContext ->
                val runId = upgradeContext.getString("runId")
                if (!runId.isNullOrBlank()) {
                    put(
                        "upgrade_context",
                        JSONObject().apply {
                            put("run_id", runId)
                            if (upgradeContext.has("priorDomainContractVersion")) {
                                put(
                                    "prior_domain_contract_version",
                                    upgradeContext.optInt("priorDomainContractVersion")
                                )
                            }
                            if (upgradeContext.has("newDomainContractVersion")) {
                                put(
                                    "new_domain_contract_version",
                                    upgradeContext.optInt("newDomainContractVersion")
                                )
                            }
                            if (upgradeContext.has("priorReadableSummaryVersion")) {
                                put(
                                    "prior_readable_summary_version",
                                    upgradeContext.optInt("priorReadableSummaryVersion")
                                )
                            }
                            if (upgradeContext.has("newReadableSummaryVersion")) {
                                put(
                                    "new_readable_summary_version",
                                    upgradeContext.optInt("newReadableSummaryVersion")
                                )
                            }
                            if (upgradeContext.has("retryCount")) {
                                put("retry_count", upgradeContext.optInt("retryCount"))
                            }
                        }
                    )
                }
            }
        }

        val body = json.toString().toRequestBody("application/json".toMediaType())
        val requestBuilder = Request.Builder().url(url).post(body)

        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }

        httpClient.newCall(requestBuilder.build()).enqueue(object : Callback {
            override fun onFailure(httpCall: Call, e: IOException) {
                call.reject("Network error: ${e.message}")
            }

            override fun onResponse(httpCall: Call, response: Response) {
                response.use {
                    val responseBody = response.body?.string().orEmpty()
                    if (response.code == 409) {
                        val detail = try {
                            JSONObject(responseBody).optJSONObject("detail")
                        } catch (_: Exception) {
                            null
                        }
                        val result = JSObject().apply {
                            put("success", false)
                            put("conflict", true)
                            put(
                                "message",
                                detail?.optString("message")?.takeIf { !it.isNullOrBlank() }
                                    ?: "PKM version conflict."
                            )
                            if (detail != null && detail.has("current_data_version")) {
                                put("dataVersion", detail.optInt("current_data_version"))
                            }
                            detail?.optString("updated_at")
                                ?.takeIf { it.isNotBlank() }
                                ?.let { put("updatedAt", it) }
                        }
                        call.resolve(result)
                        return
                    }

                    if (!response.isSuccessful) {
                        val truncatedBody = if (responseBody.length > 200) {
                            responseBody.substring(0, 200) + "..."
                        } else {
                            responseBody
                        }
                        call.reject("HTTP Error ${response.code}: $truncatedBody")
                        return
                    }

                    try {
                        val jsonResult = JSONObject(responseBody)
                        val result = JSObject().apply {
                            put("success", jsonResult.optBoolean("success", true))
                            put("conflict", jsonResult.optBoolean("conflict", false))
                            jsonResult.optString("message")
                                .takeIf { it.isNotBlank() }
                                ?.let { put("message", it) }
                            if (jsonResult.has("data_version")) {
                                put("dataVersion", jsonResult.optInt("data_version"))
                            }
                            jsonResult.optString("updated_at")
                                .takeIf { it.isNotBlank() }
                                ?.let { put("updatedAt", it) }
                        }
                        call.resolve(result)
                    } catch (e: Exception) {
                        call.reject("JSON parsing error: ${e.message}")
                    }
                }
            }
        })
    }

    /**
     * Get encrypted domain blob.
     */
    @PluginMethod
    fun getDomainData(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }

        val domain = call.getString("domain") ?: run {
            call.reject("Missing domain")
            return
        }

        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/pkm/domain-data/$userId/$domain"

        val requestBuilder = Request.Builder().url(url).get()

        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }

        executeRequest(requestBuilder.build(), call)
    }

    /**
     * Clear a domain blob.
     */
    @PluginMethod
    fun clearDomain(call: PluginCall) {
        val userId = call.getString("userId") ?: run {
            call.reject("Missing userId")
            return
        }

        val domain = call.getString("domain") ?: run {
            call.reject("Missing domain")
            return
        }

        val authToken = getAuthToken(call)
        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/pkm/domain-data/$userId/$domain"

        val requestBuilder = Request.Builder().url(url).delete()

        if (authToken != null) {
            requestBuilder.addHeader("Authorization", "Bearer $authToken")
        }

        executeRequest(requestBuilder.build(), call)
    }
    
    // Helper method to execute HTTP requests
    private fun executeRequest(request: Request, call: PluginCall) {
        httpClient.newCall(request).enqueue(object : Callback {
            override fun onFailure(httpCall: Call, e: IOException) {
                call.reject("Network error: ${e.message}")
            }
            
            override fun onResponse(httpCall: Call, response: Response) {
                response.use {
                    if (!response.isSuccessful) {
                        val errorBody = response.body?.string() ?: "Unknown error"
                        val truncatedBody = if (errorBody.length > 200) {
                            errorBody.substring(0, 200) + "..."
                        } else {
                            errorBody
                        }
                        call.reject("HTTP Error ${response.code}: $truncatedBody")
                        return
                    }
                    
                    val responseBody = response.body?.string()
                    if (responseBody == null) {
                        call.reject("Empty response")
                        return
                    }
                    
                    try {
                        val json = JSONObject(responseBody)
                        val result = JSObject()
                        json.keys().forEach { key ->
                            result.put(key, json.get(key))
                        }
                        call.resolve(result)
                    } catch (e: Exception) {
                        // Try parsing as array
                        try {
                            val jsonArray = org.json.JSONArray(responseBody)
                            val result = JSObject()
                            result.put("data", jsonArray)
                            call.resolve(result)
                        } catch (e2: Exception) {
                            call.reject("JSON parsing error: ${e.message}")
                        }
                    }
                }
            }
        })
    }
}
