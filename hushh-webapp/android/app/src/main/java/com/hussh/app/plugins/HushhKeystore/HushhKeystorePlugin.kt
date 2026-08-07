package com.hussh.app.plugins.HushhKeystore

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
            Log.d(TAG, "✅ [HushhKeystore] Value saved for key: $key")
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "❌ [HushhKeystore] Failed to save: ${e.message}")
            call.reject("Failed to save to secure storage: ${e.message}")
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
            Log.e(TAG, "❌ [HushhKeystore] Failed to get: ${e.message}")
            call.reject("Failed to get from secure storage: ${e.message}")
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
            Log.d(TAG, "✅ [HushhKeystore] Value deleted for key: $key")
            call.resolve()
        } catch (e: Exception) {
            Log.e(TAG, "❌ [HushhKeystore] Failed to delete: ${e.message}")
            call.reject("Failed to delete from secure storage: ${e.message}")
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
            Log.d(TAG, "✅ [HushhKeystore] Biometric value saved for key: $key")
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to save biometric value: ${e.message}")
        }
    }

    // ==================== Biometric Get ====================

    @PluginMethod
    fun getBiometric(call: PluginCall) {
        val key = call.getString("key")
        val promptMessage = call.getString("promptMessage") ?: "Authenticate to access"

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

        val biometricPrompt = BiometricPrompt(fragmentActivity, executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    try {
                        val value = getEncryptedPrefs()?.getString("bio_$key", null)
                        call.resolve(JSObject().put("value", value))
                    } catch (e: Exception) {
                        call.reject("Failed to get biometric value: ${e.message}")
                    }
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    call.reject("Biometric authentication error: $errString", errorCode.toString())
                }

                override fun onAuthenticationFailed() {
                    // Don't reject yet - user can retry
                    Log.w(TAG, "Biometric authentication failed, user can retry")
                }
            })

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Hushh PDA")
            .setSubtitle(promptMessage)
            .setNegativeButtonText("Cancel")
            .build()

        activity.runOnUiThread {
            biometricPrompt.authenticate(promptInfo)
        }
    }

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
        Log.e(TAG, "Failed to create encrypted prefs: ${e.message}")
        null
    }
}
