package com.hussh.app.plugins.HushhSettings

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Hushh Settings Plugin - App Settings Management
 * Port of iOS HushhSettingsPlugin.swift
 */
@CapacitorPlugin(name = "HushhSettings")
class HushhSettingsPlugin : Plugin() {

    private val TAG = "HushhSettings"
    private val PREFS_NAME = "hushh_settings"

    // Default settings (regulated cutover defaults to local-only sync)
    private val defaultSettings = mapOf(
        "useRemoteSync" to false,
        "syncOnWifiOnly" to false,
        "useRemoteLLM" to true,
        "preferredLLMProvider" to "google",
        "requireBiometricUnlock" to false,
        "autoLockTimeout" to 5,
        "theme" to "system",
        "hapticFeedback" to true,
        "showDebugInfo" to false,
        "verboseLogging" to false
    )

    private fun getPrefs(): SharedPreferences {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    // ==================== Get Settings ====================

    @PluginMethod
    fun getSettings(call: PluginCall) {
        val prefs = getPrefs()

        call.resolve(JSObject().apply {
            put("useRemoteSync", prefs.getBoolean("useRemoteSync", defaultSettings["useRemoteSync"] as Boolean))
            put("syncOnWifiOnly", prefs.getBoolean("syncOnWifiOnly", defaultSettings["syncOnWifiOnly"] as Boolean))
            put("useRemoteLLM", prefs.getBoolean("useRemoteLLM", defaultSettings["useRemoteLLM"] as Boolean))
            put("preferredLLMProvider", prefs.getString("preferredLLMProvider", defaultSettings["preferredLLMProvider"] as String))
            put("requireBiometricUnlock", prefs.getBoolean("requireBiometricUnlock", defaultSettings["requireBiometricUnlock"] as Boolean))
            put("autoLockTimeout", prefs.getInt("autoLockTimeout", defaultSettings["autoLockTimeout"] as Int))
            put("theme", prefs.getString("theme", defaultSettings["theme"] as String))
            put("hapticFeedback", prefs.getBoolean("hapticFeedback", defaultSettings["hapticFeedback"] as Boolean))
            put("showDebugInfo", prefs.getBoolean("showDebugInfo", defaultSettings["showDebugInfo"] as Boolean))
            put("verboseLogging", prefs.getBoolean("verboseLogging", defaultSettings["verboseLogging"] as Boolean))
        })
    }

    // ==================== Update Settings ====================

    @PluginMethod
    fun updateSettings(call: PluginCall) {
        val editor = getPrefs().edit()

        // Update only provided settings
        if (call.hasOption("useRemoteSync")) {
            editor.putBoolean("useRemoteSync", call.getBoolean("useRemoteSync", false) ?: false)
        }
        if (call.hasOption("syncOnWifiOnly")) {
            editor.putBoolean("syncOnWifiOnly", call.getBoolean("syncOnWifiOnly", false) ?: false)
        }
        if (call.hasOption("useRemoteLLM")) {
            editor.putBoolean("useRemoteLLM", call.getBoolean("useRemoteLLM", true) ?: true)
        }
        if (call.hasOption("preferredLLMProvider")) {
            editor.putString("preferredLLMProvider", call.getString("preferredLLMProvider"))
        }
        if (call.hasOption("requireBiometricUnlock")) {
            editor.putBoolean("requireBiometricUnlock", call.getBoolean("requireBiometricUnlock", false) ?: false)
        }
        if (call.hasOption("autoLockTimeout")) {
            editor.putInt("autoLockTimeout", call.getInt("autoLockTimeout", 5) ?: 5)
        }
        if (call.hasOption("theme")) {
            editor.putString("theme", call.getString("theme"))
        }
        if (call.hasOption("hapticFeedback")) {
            editor.putBoolean("hapticFeedback", call.getBoolean("hapticFeedback", true) ?: true)
        }
        if (call.hasOption("showDebugInfo")) {
            editor.putBoolean("showDebugInfo", call.getBoolean("showDebugInfo", false) ?: false)
        }
        if (call.hasOption("verboseLogging")) {
            editor.putBoolean("verboseLogging", call.getBoolean("verboseLogging", false) ?: false)
        }

        editor.apply()
        Log.d(TAG, "✅ [HushhSettings] Settings updated")

        call.resolve(JSObject().put("success", true))
    }

    // ==================== Reset Settings ====================

    @PluginMethod
    fun resetSettings(call: PluginCall) {
        getPrefs().edit().clear().apply()
        Log.d(TAG, "✅ [HushhSettings] Settings reset to defaults")
        call.resolve(JSObject().put("success", true))
    }

    // ==================== Convenience Methods ====================

    @PluginMethod
    fun shouldUseLocalAgents(call: PluginCall) {
        val useRemoteLLM = getPrefs().getBoolean("useRemoteLLM", true)
        call.resolve(JSObject().put("value", !useRemoteLLM))
    }

    @PluginMethod
    fun shouldSyncToCloud(call: PluginCall) {
        val useRemoteSync = getPrefs().getBoolean("useRemoteSync", false)
        call.resolve(JSObject().put("value", useRemoteSync))
    }
}
