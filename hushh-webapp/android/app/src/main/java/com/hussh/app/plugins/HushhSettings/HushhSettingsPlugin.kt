package com.hussh.app.plugins.HushhSettings

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import android.view.HapticFeedbackConstants
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.hussh.app.MainActivity
import org.json.JSONObject

/** Pure, bounded admission. Rejected or uncertain feedback is never replayed. */
class HushhAppHapticFeedbackState {
    private val consumed = ArrayDeque<String>()

    fun consume(
        intentId: String?, kind: String?, issuedAtMs: Double?, nowMs: Double,
        documentAccepted: Boolean, privacyGeneration: Int?, currentPrivacyGeneration: Int,
        appIsActive: Boolean, shielded: Boolean, enabled: Boolean
    ): Boolean {
        if (!documentAccepted || privacyGeneration == null || privacyGeneration < 0 ||
            privacyGeneration != currentPrivacyGeneration || !appIsActive || shielded || !enabled ||
            intentId.isNullOrBlank() || intentId.length > 128 ||
            (kind != "selection" && kind != "light") || issuedAtMs == null ||
            !issuedAtMs.isFinite() || !nowMs.isFinite() ||
            nowMs - issuedAtMs < -50 || nowMs - issuedAtMs > 250 || intentId in consumed) return false
        consumed.addLast(intentId)
        if (consumed.size > 256) consumed.removeFirst()
        return true
    }
}

/** Only the initial migration consults legacy JSON; later native choices win. */
object HushhAppHapticPreference {
    @JvmStatic
    fun enabled(migrated: Boolean, native: Boolean?, legacy: Boolean?): Boolean =
        if (migrated) native ?: true else native != false && legacy != false
}

/**
 * Hushh Settings Plugin - App Settings Management
 * Port of iOS HushhSettingsPlugin.swift
 */
@CapacitorPlugin(name = "HushhSettings")
class HushhSettingsPlugin : Plugin() {

    private val TAG = "HushhSettings"
    private val PREFS_NAME = "hushh_settings"
    private val feedback = HushhAppHapticFeedbackState()
    private val hapticMigrationKey = "hapticFeedbackMigrated.v1"

    // Default settings (regulated cutover defaults to local-only sync)
    private val defaultSettings = mapOf(
        "useRemoteSync" to false,
        "syncOnWifiOnly" to false,
        "useRemoteLLM" to true,
        "preferredLLMProvider" to "google",
        "requireBiometricUnlock" to false,
        "theme" to "system",
        "hapticFeedback" to true,
        "showDebugInfo" to false,
        "verboseLogging" to false
    )

    private fun getPrefs(): SharedPreferences {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    @Synchronized
    private fun hapticsEnabled(): Boolean {
        val prefs = getPrefs()
        val migrated = prefs.all[hapticMigrationKey] == true
        val legacy = if (migrated) null else {
            val stored = context.getSharedPreferences("CapacitorStorage", Context.MODE_PRIVATE)
                .all["hushh_settings"] as? String
            try { stored?.let { JSONObject(it).opt("hapticFeedback") as? Boolean } }
            catch (_: org.json.JSONException) { null }
        }
        val enabled = HushhAppHapticPreference.enabled(migrated, prefs.all["hapticFeedback"] as? Boolean, legacy)
        if (!migrated) prefs.edit().putBoolean("hapticFeedback", enabled)
            .putBoolean(hapticMigrationKey, true).apply()
        return enabled
    }

    @PluginMethod
    fun getFeedbackCapabilities(call: PluginCall) {
        call.resolve(JSObject().put("interactionFeedback", true))
    }

    @PluginMethod
    fun interactionFeedback(call: PluginCall) {
        val host = activity as? MainActivity
        val documentId = call.getString("documentId")
        if (host == null || documentId.isNullOrBlank() || documentId.length > 128) {
            call.resolve(JSObject().put("accepted", false))
            return
        }
        host.runOnUiThread {
            val webView = bridge.webView
            if (host.isFinishing || host.isDestroyed || webView == null) {
                call.resolve(JSObject().put("accepted", false))
                return@runOnUiThread
            }
            val enabled = hapticsEnabled()
            val privacy = host.readSessionPrivacyState()
            val kind = call.getString("kind")
            val admitted = feedback.consume(
                call.getString("intentId"), kind,
                (call.data.opt("issuedAtMs") as? Number)?.toDouble(), System.currentTimeMillis().toDouble(),
                host.acceptsSessionPrivacyDocument(documentId), call.getInt("privacyGeneration"), privacy.generation,
                privacy.appIsActive, privacy.shielded, enabled
            )
            val accepted = admitted && try {
                webView.performHapticFeedback(
                    if (kind == "selection") HapticFeedbackConstants.CLOCK_TICK else HapticFeedbackConstants.VIRTUAL_KEY
                )
            } catch (_: RuntimeException) { false }
            call.resolve(JSObject().put("accepted", accepted))
        }
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
            put("theme", prefs.getString("theme", defaultSettings["theme"] as String))
            put("hapticFeedback", hapticsEnabled())
            put("showDebugInfo", prefs.getBoolean("showDebugInfo", defaultSettings["showDebugInfo"] as Boolean))
            put("verboseLogging", prefs.getBoolean("verboseLogging", defaultSettings["verboseLogging"] as Boolean))
        })
    }

    // ==================== Update Settings ====================

    @PluginMethod
    @Synchronized
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
        if (call.hasOption("theme")) {
            editor.putString("theme", call.getString("theme"))
        }
        call.getBoolean("hapticFeedback")?.let { value ->
            hapticsEnabled()
            editor.putBoolean("hapticFeedback", value)
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
    @Synchronized
    fun resetSettings(call: PluginCall) {
        getPrefs().edit().clear().putBoolean("hapticFeedback", true)
            .putBoolean(hapticMigrationKey, true).apply()
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
