package com.hussh.app.plugins.HushhKeystore

import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Hushh Keystore Plugin - Secure Storage
 * Android equivalent of iOS Keychain using EncryptedSharedPreferences + Android Keystore
 *
 * Note: Plugin is named "HushhKeychain" for TypeScript compatibility with iOS
 */
@CapacitorPlugin(name = "HushhKeychain")
class HushhKeystorePlugin : Plugin() {

    private val TAG = "HushhKeystore"
    private val PREFS_NAME = "hushh_keystore_prefs"
    private val biometricOperationLock = Any()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var activeBiometricOperation: ActiveBiometricOperation? = null

    /**
     * Retains the prompt and original bridge call until its callback settles.
     * A cancellation is therefore not allowed to open a replacement prompt
     * while Android is still dismissing the current system surface.
     */
    private class ActiveBiometricOperation(
        val requestId: String?,
        val call: PluginCall,
    ) {
        var prompt: BiometricPrompt? = null
        var cancellationRequested = false
        var cancellationFallback: Runnable? = null
    }

    private companion object {
        const val BIOMETRIC_CANCELLATION_SETTLE_TIMEOUT_MS = 2_000L
    }

    // ==================== Set ====================

    @PluginMethod
    fun set(call: PluginCall) {
        val key = call.getString("key")
        val value = call.getString("value")

        if (key == null || value == null) {
            call.reject("Missing required parameters: key, value")
            return
        }

        try {
            getEncryptedPrefs()?.edit()?.apply {
                putString(key, value)
                apply()
            }
            Log.d(TAG, "Secure value saved")
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save secure value")
            call.reject("Failed to save to secure storage")
        }
    }

    // ==================== Get ====================

    @PluginMethod
    fun get(call: PluginCall) {
        val key = call.getString("key")

        if (key == null) {
            call.reject("Missing required parameter: key")
            return
        }

        try {
            val value = getEncryptedPrefs()?.getString(key, null)
            call.resolve(JSObject().put("value", value))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get secure value")
            call.reject("Failed to get from secure storage")
        }
    }

    // ==================== Delete ====================

    @PluginMethod
    fun delete(call: PluginCall) {
        val key = call.getString("key")

        if (key == null) {
            call.reject("Missing required parameter: key")
            return
        }

        try {
            getEncryptedPrefs()?.edit()?.apply {
                remove(key)
                apply()
            }
            Log.d(TAG, "Secure value deleted")
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to delete secure value")
            call.reject("Failed to delete from secure storage")
        }
    }

    // ==================== Biometric Availability ====================

    @PluginMethod
    fun isBiometricAvailable(call: PluginCall) {
        val biometricManager = BiometricManager.from(context)
        val result = biometricManager.canAuthenticate(
            BiometricManager.Authenticators.BIOMETRIC_STRONG or 
            BiometricManager.Authenticators.BIOMETRIC_WEAK
        )

        val available = result == BiometricManager.BIOMETRIC_SUCCESS

        // Determine type (Android doesn't differentiate like iOS Face ID vs Touch ID)
        val type = when {
            available -> "biometric"  // Android doesn't expose Face vs Fingerprint distinction
            else -> "none"
        }

        call.resolve(JSObject().apply {
            put("available", available)
            put("type", type)
        })
    }

    // ==================== Biometric Set ====================

    @PluginMethod
    fun setBiometric(call: PluginCall) {
        val key = call.getString("key")
        val value = call.getString("value")
        val promptMessage = call.getString("promptMessage") ?: "Authenticate to save"

        if (key == null || value == null) {
            call.reject("Missing required parameters: key, value")
            return
        }

        // For now, just save with encrypted prefs (biometric protection is implicit via Keystore)
        // Full biometric-gated access would require BiometricPrompt integration
        try {
            getEncryptedPrefs()?.edit()?.apply {
                putString("bio_$key", value)
                apply()
            }
            Log.d(TAG, "Biometric value saved")
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to save biometric value")
        }
    }

    // ==================== Biometric Delete ====================

    @PluginMethod
    fun deleteBiometric(call: PluginCall) {
        val key = call.getString("key")
        if (key == null) {
            call.reject("Missing required parameter: key")
            return
        }

        try {
            // Biometric values intentionally use a separate namespace. The
            // normal delete method only removes its non-biometric sibling.
            getEncryptedPrefs()?.edit()?.apply {
                remove("bio_$key")
                apply()
            }
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to delete biometric value")
            call.reject("Failed to delete biometric value")
        }
    }

    // ==================== Biometric Get ====================

    @PluginMethod
    fun getBiometric(call: PluginCall) {
        val key = call.getString("key")
        val promptMessage = call.getString("promptMessage") ?: "Authenticate to access"
        val requestId = call.getString("requestId")?.trim()?.takeIf { it.isNotEmpty() }

        if (key == null) {
            call.reject("Missing required parameter: key")
            return
        }

        val fragmentActivity = activity as? FragmentActivity
        if (fragmentActivity == null) {
            call.reject("Activity is not a FragmentActivity")
            return
        }

        val executor = ContextCompat.getMainExecutor(context)
        val operation = ActiveBiometricOperation(requestId, call)
        synchronized(biometricOperationLock) {
            if (activeBiometricOperation != null) {
                call.reject("A biometric authentication is already in progress.", "BIOMETRIC_AUTH_IN_PROGRESS")
                return
            }
            activeBiometricOperation = operation
        }

        fragmentActivity.runOnUiThread {
            synchronized(biometricOperationLock) {
                if (activeBiometricOperation !== operation || operation.cancellationRequested) {
                    return@runOnUiThread
                }
            }

            val biometricPrompt = BiometricPrompt(fragmentActivity, executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        finishBiometricOperation(operation) { wasCancelled ->
                            if (wasCancelled) {
                                call.reject("Biometric authentication cancelled", "USER_CANCELLED")
                                return@finishBiometricOperation
                            }
                            try {
                                val value = getEncryptedPrefs()?.getString("bio_$key", null)
                                call.resolve(JSObject().put("value", value))
                            } catch (e: Exception) {
                                Log.e(TAG, "Failed to get biometric value")
                                call.reject("Failed to get biometric value")
                            }
                        }
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        finishBiometricOperation(operation) { wasCancelled ->
                            if (wasCancelled || isBiometricCancellation(errorCode)) {
                                call.reject("Biometric authentication cancelled", "USER_CANCELLED")
                            } else {
                                call.reject("Biometric authentication failed", "BIOMETRIC_AUTH_FAILED")
                            }
                        }
                    }

                    override fun onAuthenticationFailed() {
                        // Don't reject yet - Android lets the user retry in the
                        // same system-owned prompt.
                        Log.w(TAG, "Biometric authentication failed; retry remains available")
                    }
                })

            synchronized(biometricOperationLock) {
                if (activeBiometricOperation !== operation || operation.cancellationRequested) {
                    return@runOnUiThread
                }
                operation.prompt = biometricPrompt
            }

            val promptInfo = BiometricPrompt.PromptInfo.Builder()
                .setTitle("Hushh PDA")
                .setSubtitle(promptMessage)
                .setNegativeButtonText("Cancel")
                .build()
            biometricPrompt.authenticate(promptInfo)
        }
    }

    // ==================== Biometric Cancellation ====================

    @PluginMethod
    fun cancelBiometricAuthentication(call: PluginCall) {
        val requestedId = call.getString("requestId")?.trim()?.takeIf { it.isNotEmpty() }
        val operation = synchronized(biometricOperationLock) {
            val active = activeBiometricOperation
            if (active == null || active.cancellationRequested ||
                (requestedId != null && requestedId != active.requestId)) {
                null
            } else {
                active.cancellationRequested = true
                active
            }
        }

        if (operation == null) {
            call.resolve(JSObject().put("cancelled", false))
            return
        }

        val fallback = Runnable {
            finishBiometricOperation(operation) {
                operation.call.reject("Biometric authentication cancelled", "USER_CANCELLED")
            }
        }
        val shouldScheduleFallback = synchronized(biometricOperationLock) {
            if (activeBiometricOperation === operation && operation.cancellationFallback == null) {
                operation.cancellationFallback = fallback
                true
            } else {
                false
            }
        }
        if (shouldScheduleFallback) {
            mainHandler.postDelayed(fallback, BIOMETRIC_CANCELLATION_SETTLE_TIMEOUT_MS)
        }

        // Keep the operation latched until its original callback or the
        // bounded fallback above settles it; do not release it here.
        operation.prompt?.cancelAuthentication()
        call.resolve(JSObject().put("cancelled", true))
    }

    private fun finishBiometricOperation(
        operation: ActiveBiometricOperation,
        completion: (wasCancelled: Boolean) -> Unit,
    ) {
        val wasCancelled = synchronized(biometricOperationLock) {
            if (activeBiometricOperation !== operation) {
                return
            }
            activeBiometricOperation = null
            operation.cancellationFallback?.let(mainHandler::removeCallbacks)
            operation.cancellationFallback = null
            operation.cancellationRequested
        }
        completion(wasCancelled)
    }

    private fun isBiometricCancellation(errorCode: Int): Boolean =
        errorCode == BiometricPrompt.ERROR_CANCELED ||
            errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
            errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON

    // ==================== Private Helpers ====================

    private fun getEncryptedPrefs() = try {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()

        EncryptedSharedPreferences.create(
            context,
            PREFS_NAME,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    } catch (e: Exception) {
        Log.e(TAG, "Failed to create encrypted prefs")
        null
    }
}
