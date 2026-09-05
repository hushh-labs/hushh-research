package com.hussh.app.plugins.HushhSessionPrivacy

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.hussh.app.MainActivity

/**
 * Narrow bridge for the native resume-time privacy shield.
 *
 * MainActivity owns lifecycle and presentation. The web layer may only read
 * the current generation and release that exact generation after completing
 * its account/session validation.
 */
@CapacitorPlugin(name = "HushhSessionPrivacy")
class HushhSessionPrivacyPlugin : Plugin() {

    @PluginMethod
    fun getState(call: PluginCall) {
        withMainActivity(call) { host ->
            val state = host.readSessionPrivacyState()
            call.resolve(
                JSObject()
                    .put("shielded", state.shielded)
                    .put("generation", state.generation)
            )
        }
    }

    @PluginMethod
    fun completeSessionValidation(call: PluginCall) {
        val generation = call.getInt("generation")
        if (generation == null || generation <= 0) {
            call.reject(
                "A positive session privacy generation is required.",
                "session_privacy/generation_required"
            )
            return
        }

        withMainActivity(call) { host ->
            val result = host.completeSessionValidation(generation)
            call.resolve(
                JSObject()
                    .put("released", result.released)
                    .put("shielded", result.shielded)
                    .put("generation", result.generation)
            )
        }
    }

    private fun withMainActivity(call: PluginCall, action: (MainActivity) -> Unit) {
        val host = activity as? MainActivity
        if (host == null || host.isFinishing || host.isDestroyed) {
            call.reject(
                "The session privacy host is unavailable.",
                "session_privacy/host_unavailable"
            )
            return
        }

        host.runOnUiThread {
            if (host.isFinishing || host.isDestroyed) {
                call.reject(
                    "The session privacy host is unavailable.",
                    "session_privacy/host_unavailable"
                )
            } else {
                action(host)
            }
        }
    }
}
