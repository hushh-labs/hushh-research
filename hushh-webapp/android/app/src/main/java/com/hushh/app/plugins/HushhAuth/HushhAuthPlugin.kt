package com.hushh.app.plugins.HushhAuth

import android.content.Intent
import android.util.Base64
import android.util.Log
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInAccount
import com.google.android.gms.auth.api.signin.GoogleSignInClient
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GoogleAuthProvider
import com.google.firebase.auth.OAuthProvider
import org.json.JSONObject

/**
 * Hushh Auth Plugin - Native Android Authentication
 *
 * Production-grade authentication supporting:
 * - Google Sign-In: Native SDK with bottom sheet UI
 * - Apple Sign-In: Firebase OAuthProvider (web-based OAuth flow)
 *
 * Returns credentials compatible with Firebase signInWithCredential().
 *
 * Flow:
 *   1. Native Sign-In UI (Google) or Web OAuth (Apple)
 *   2. Returns idToken + accessToken
 *   3. Frontend syncs with Firebase using appropriate credential provider
 */
@CapacitorPlugin(name = "HushhAuth")
class HushhAuthPlugin : Plugin() {

    private val TAG = "HushhAuth"
    private lateinit var googleSignInClient: GoogleSignInClient
    private var pendingCall: PluginCall? = null
    private lateinit var signInLauncher: ActivityResultLauncher<Intent>

    // Current user data
    private var currentIdToken: String? = null
    private var currentAccessToken: String? = null
    private var currentUser: AuthUser? = null

    // Firebase Auth instance
    private val firebaseAuth: FirebaseAuth by lazy { FirebaseAuth.getInstance() }

    override fun load() {
        super.load()
        Log.d(TAG, "🤖 [HushhAuth] Plugin loaded")

        // Configure Google Sign-In
        val webClientId = getWebClientId()
        Log.d(TAG, "🤖 [HushhAuth] Web Client ID: ${webClientId?.take(20)}...")

        val gso = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestIdToken(webClientId ?: "")
            .requestEmail()
            .build()

        googleSignInClient = GoogleSignIn.getClient(activity, gso)

        // Register activity result launcher
        signInLauncher = activity.registerForActivityResult(
            ActivityResultContracts.StartActivityForResult()
        ) { result ->
            handleSignInResult(result.resultCode, result.data)
        }
    }

    /**
     * Get Web Client ID from google-services.json (client_type 3)
     */
    private fun getWebClientId(): String? {
        try {
            // Read from resources
            val resourceId = context.resources.getIdentifier(
                "default_web_client_id",
                "string",
                context.packageName
            )
            if (resourceId != 0) {
                return context.getString(resourceId)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get web client id: ${e.message}")
        }
        return null
    }

    // ==================== Sign In ====================

    @PluginMethod
    fun signIn(call: PluginCall) {
        Log.d(TAG, "🤖 [HushhAuth] signIn() CALLED - Native plugin invoked!")

        pendingCall = call

        activity.runOnUiThread {
            val signInIntent = googleSignInClient.signInIntent
            signInLauncher.launch(signInIntent)
        }
    }

    private fun handleSignInResult(resultCode: Int, data: Intent?) {
        val call = pendingCall
        if (call == null) {
            Log.e(TAG, "❌ [HushhAuth] No pending call!")
            return
        }

        try {
            val task = GoogleSignIn.getSignedInAccountFromIntent(data)
            val account = task.getResult(ApiException::class.java)

            Log.d(TAG, "✅ [HushhAuth] Got Google account: ${account.email}")

            // Exchange for Firebase credential
            firebaseAuthWithGoogle(account, call)

        } catch (e: ApiException) {
            Log.e(TAG, "❌ [HushhAuth] Google Sign-In failed: ${e.statusCode} - ${e.message}")
            when (e.statusCode) {
                12501 -> call.reject("User cancelled sign-in", "USER_CANCELLED")
                else -> call.reject("Sign-in failed: ${e.message}")
            }
            pendingCall = null
        }
    }

    private fun firebaseAuthWithGoogle(account: GoogleSignInAccount, call: PluginCall) {
        Log.d(TAG, "🔥 [HushhAuth] Exchanging Google credential for Firebase credential...")

        val idToken = account.idToken
        if (idToken == null) {
            call.reject("No ID token received from Google")
            pendingCall = null
            return
        }

        val credential = GoogleAuthProvider.getCredential(idToken, null)

        firebaseAuth.signInWithCredential(credential)
            .addOnCompleteListener(activity) { task ->
                if (task.isSuccessful) {
                    val firebaseUser = firebaseAuth.currentUser
                    if (firebaseUser != null) {
                        Log.d(TAG, "✅ [HushhAuth] Firebase sign-in success!")
                        Log.d(TAG, "🔥 [HushhAuth] Firebase UID: ${firebaseUser.uid}")

                        // Get Firebase ID Token
                        firebaseUser.getIdToken(true)
                            .addOnCompleteListener { tokenTask ->
                                if (tokenTask.isSuccessful) {
                                    val firebaseIdToken = tokenTask.result?.token
                                    Log.d(TAG, "✅ [HushhAuth] Got Firebase ID token: ${firebaseIdToken?.take(20)}...")

                                    // Build user info
                                    val authUser = AuthUser(
                                        id = firebaseUser.uid,
                                        email = firebaseUser.email ?: account.email ?: "",
                                        displayName = firebaseUser.displayName ?: account.displayName ?: "",
                                        photoUrl = firebaseUser.photoUrl?.toString() ?: account.photoUrl?.toString() ?: "",
                                        emailVerified = firebaseUser.isEmailVerified
                                    )

                                    // Store locally
                                    currentUser = authUser
                                    currentIdToken = firebaseIdToken
                                    currentAccessToken = idToken

                                    // Save to secure storage
                                    saveCredentialsToSecureStorage(firebaseIdToken ?: "", idToken, authUser)

                                    // Return result
                                    val response = JSObject().apply {
                                        put("idToken", firebaseIdToken)
                                        put("accessToken", idToken)
                                        put("user", JSObject().apply {
                                            put("uid", authUser.id)
                                            put("email", authUser.email)
                                            put("displayName", authUser.displayName)
                                            put("photoUrl", authUser.photoUrl)
                                            put("emailVerified", authUser.emailVerified)
                                        })
                                    }

                                    call.resolve(response)
                                    Log.d(TAG, "✅ [HushhAuth] call.resolve() completed with Firebase UID and Token")
                                } else {
                                    call.reject("Failed to get Firebase ID token: ${tokenTask.exception?.message}")
                                }
                                pendingCall = null
                            }
                    } else {
                        call.reject("No Firebase user returned")
                        pendingCall = null
                    }
                } else {
                    Log.e(TAG, "❌ [HushhAuth] Firebase sign-in failed: ${task.exception?.message}")
                    call.reject("Firebase sign-in failed: ${task.exception?.message}")
                    pendingCall = null
                }
            }
    }

    // ==================== Sign Out ====================

    @PluginMethod
    fun signOut(call: PluginCall) {
        Log.d(TAG, "🤖 [HushhAuth] signOut() called")

        // Sign out from Firebase
        firebaseAuth.signOut()

        // Sign out from Google
        googleSignInClient.signOut().addOnCompleteListener {
            // Clear local state
            currentUser = null
            currentIdToken = null
            currentAccessToken = null

            // Clear secure storage
            clearSecureStorage()

            Log.d(TAG, "🤖 [HushhAuth] Signed out")
            call.resolve()
        }
    }

    // ==================== Get ID Token ====================

    @PluginMethod
    fun getIdToken(call: PluginCall) {
        val user = firebaseAuth.currentUser
        
        if (user != null) {
            // Priority 1: Get fresh token from Firebase SDK (auto-refreshes if needed)
            user.getIdToken(false).addOnCompleteListener(activity) { task ->
                if (task.isSuccessful) {
                    val token = task.result?.token
                    currentIdToken = token
                    // Update storage with fresh token
                    if (token != null && currentUser != null) {
                        saveCredentialsToSecureStorage(token, currentAccessToken ?: "", currentUser!!)
                    }
                    call.resolve(JSObject().put("idToken", token))
                } else {
                    Log.w(TAG, "⚠️ [HushhAuth] Failed to refresh token: ${task.exception?.message}")
                    // Fallback to storage if network fails
                    resolveFromStorage(call)
                }
            }
        } else {
            // Priority 2: Fallback to Secure Storage/Memory if SDK isn't ready
            resolveFromStorage(call)
        }
    }

    private fun resolveFromStorage(call: PluginCall) {
        currentUsableIdToken()?.let {
            call.resolve(JSObject().put("idToken", it))
            return
        }

        call.resolve(JSObject().put("idToken", JSONObject.NULL))
    }

    // ==================== Get Current User ====================

    @PluginMethod
    fun getCurrentUser(call: PluginCall) {
        // Try memory first
        currentUser?.let {
            call.resolve(JSObject().put("user", it.toJSObject()))
            return
        }

        // Try Firebase current user
        firebaseAuth.currentUser?.let { firebaseUser ->
            val user = AuthUser(
                id = firebaseUser.uid,
                email = firebaseUser.email ?: "",
                displayName = firebaseUser.displayName ?: "",
                photoUrl = firebaseUser.photoUrl?.toString() ?: "",
                emailVerified = firebaseUser.isEmailVerified
            )
            currentUser = user
            call.resolve(JSObject().put("user", user.toJSObject()))
            return
        }

        // Try secure storage
        loadUserFromSecureStorage()?.let {
            currentUser = it
            call.resolve(JSObject().put("user", it.toJSObject()))
            return
        }

        call.resolve(JSObject().put("user", JSONObject.NULL))
    }

    // ==================== Is Signed In ====================

    @PluginMethod
    fun isSignedIn(call: PluginCall) {
        val signedIn = firebaseAuth.currentUser != null ||
                       (currentUsableIdToken() != null && loadUserFromSecureStorage() != null)

        call.resolve(JSObject().put("signedIn", signedIn))
    }

    // ==================== Apple Sign In ====================

    @PluginMethod
    fun signInWithApple(call: PluginCall) {
        Log.d(TAG, "🍎 [HushhAuth] signInWithApple() CALLED - Using Firebase OAuthProvider")

        pendingCall = call

        // Android uses Firebase OAuthProvider for Apple Sign-In (web-based OAuth flow)
        val provider = OAuthProvider.newBuilder("apple.com")
            .setScopes(listOf("email", "name"))
            .build()

        activity.runOnUiThread {
            // Check if there's a pending result first
            val pendingResultTask = firebaseAuth.pendingAuthResult
            if (pendingResultTask != null) {
                // There's already a pending sign-in, handle it
                pendingResultTask
                    .addOnSuccessListener { authResult ->
                        handleAppleSignInSuccess(authResult.user, call)
                    }
                    .addOnFailureListener { e ->
                        Log.e(TAG, "❌ [HushhAuth] Apple sign-in pending result failed: ${e.message}")
                        call.reject("Apple sign-in failed: ${e.message}")
                        pendingCall = null
                    }
            } else {
                // Start new sign-in flow
                firebaseAuth.startActivityForSignInWithProvider(activity, provider)
                    .addOnSuccessListener { authResult ->
                        handleAppleSignInSuccess(authResult.user, call)
                    }
                    .addOnFailureListener { e ->
                        Log.e(TAG, "❌ [HushhAuth] Apple sign-in failed: ${e.message}")
                        
                        // Check for user cancellation
                        val errorMessage = e.message ?: "Unknown error"
                        if (errorMessage.contains("canceled", ignoreCase = true) || 
                            errorMessage.contains("cancelled", ignoreCase = true)) {
                            call.reject("User cancelled Apple Sign-In", "USER_CANCELLED")
                        } else {
                            call.reject("Apple sign-in failed: $errorMessage")
                        }
                        pendingCall = null
                    }
            }
        }
    }

    private fun handleAppleSignInSuccess(firebaseUser: FirebaseUser?, call: PluginCall) {
        if (firebaseUser == null) {
            call.reject("No Firebase user returned from Apple Sign-In")
            pendingCall = null
            return
        }

        Log.d(TAG, "✅ [HushhAuth] Apple sign-in success! UID: ${firebaseUser.uid}")

        // Get Firebase ID Token
        firebaseUser.getIdToken(true)
            .addOnCompleteListener { tokenTask ->
                if (tokenTask.isSuccessful) {
                    val firebaseIdToken = tokenTask.result?.token
                    Log.d(TAG, "✅ [HushhAuth] Got Firebase ID token from Apple sign-in: ${firebaseIdToken?.take(20)}...")

                    // Build user info
                    val authUser = AuthUser(
                        id = firebaseUser.uid,
                        email = firebaseUser.email ?: "",
                        displayName = firebaseUser.displayName ?: "",
                        photoUrl = firebaseUser.photoUrl?.toString() ?: "",
                        emailVerified = firebaseUser.isEmailVerified
                    )

                    // Store locally
                    currentUser = authUser
                    currentIdToken = firebaseIdToken
                    currentAccessToken = null  // Apple doesn't provide access token via this flow

                    // Save to secure storage
                    saveCredentialsToSecureStorage(firebaseIdToken ?: "", "", authUser)

                    // Return result
                    val response = JSObject().apply {
                        put("idToken", firebaseIdToken)
                        put("user", JSObject().apply {
                            put("uid", authUser.id)
                            put("email", authUser.email)
                            put("displayName", authUser.displayName)
                            put("photoUrl", authUser.photoUrl)
                            put("emailVerified", authUser.emailVerified)
                        })
                    }

                    call.resolve(response)
                    Log.d(TAG, "✅ [HushhAuth] Apple sign-in call.resolve() completed with Firebase UID and Token")
                } else {
                    call.reject("Failed to get Firebase ID token: ${tokenTask.exception?.message}")
                }
                pendingCall = null
            }
    }

    // ==================== Secure Storage ====================

    private fun getEncryptedPrefs() = try {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        EncryptedSharedPreferences.create(
            context,
            "hushh_auth_prefs",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: Exception) {
        Log.e(TAG, "Failed to create encrypted prefs: ${e.message}")
        null
    }

    private fun saveCredentialsToSecureStorage(idToken: String, accessToken: String, user: AuthUser) {
        getEncryptedPrefs()?.edit()?.apply {
            putString("id_token", idToken)
            putString("access_token", accessToken)
            putString("user_id", user.id)
            putString("user_email", user.email)
            putString("user_display_name", user.displayName)
            putString("user_photo_url", user.photoUrl)
            putBoolean("user_email_verified", user.emailVerified)
            apply()
        }
    }

    private fun decodeJwtPayload(token: String): JSONObject? {
        val parts = token.split(".")
        if (parts.size < 2) return null
        return try {
            val payload = String(Base64.decode(parts[1], Base64.URL_SAFE or Base64.NO_WRAP))
            JSONObject(payload)
        } catch (e: Exception) {
            null
        }
    }

    private fun isUsableIdToken(token: String?): Boolean {
        if (token.isNullOrBlank()) return false
        val payload = decodeJwtPayload(token) ?: return false
        val expiresAtSeconds = payload.optLong("exp", 0L)
        if (expiresAtSeconds <= 0L) return false
        val minRemainingMs = System.currentTimeMillis() + 60_000
        return expiresAtSeconds * 1000 > minRemainingMs
    }

    private fun currentUsableIdToken(): String? {
        val inMemory = currentIdToken
        if (isUsableIdToken(inMemory)) {
            return inMemory
        }

        val stored = getEncryptedPrefs()?.getString("id_token", null)
        return if (isUsableIdToken(stored)) stored else null
    }

    private fun loadIdTokenFromSecureStorage(): String? {
        return currentUsableIdToken()
    }

    private fun loadUserFromSecureStorage(): AuthUser? {
        if (currentUsableIdToken() == null) return null
        val prefs = getEncryptedPrefs() ?: return null
        val id = prefs.getString("user_id", null) ?: return null
        return AuthUser(
            id = id,
            email = prefs.getString("user_email", "") ?: "",
            displayName = prefs.getString("user_display_name", "") ?: "",
            photoUrl = prefs.getString("user_photo_url", "") ?: "",
            emailVerified = prefs.getBoolean("user_email_verified", false)
        )
    }

    private fun clearSecureStorage() {
        getEncryptedPrefs()?.edit()?.clear()?.apply()
    }
}

// ==================== Auth User Model ====================

data class AuthUser(
    val id: String,
    val email: String,
    val displayName: String,
    val photoUrl: String,
    val emailVerified: Boolean
) {
    fun toJSObject(): JSObject = JSObject().apply {
        put("uid", id)
        put("email", email)
        put("displayName", displayName)
        put("photoUrl", photoUrl)
        put("emailVerified", emailVerified)
    }
}
