package com.hushh.app.plugins.shared

import com.getcapacitor.Bridge
import com.getcapacitor.PluginCall

/**
 * BackendUrl
 *
 * Shared backend URL normalization for Android emulator:
 * - host loopback (localhost/127.0.0.1) must be rewritten to 10.0.2.2
 */
object BackendUrl {
    private val sharedPluginConfigOrder = listOf(
        "HushhRuntime",
        "HushhVault",
        "HushhConsent",
        "PersonalKnowledgeModel",
        "Kai",
        "HushhNotifications",
        "HushhAccount",
        "HushhSync"
    )

    fun normalize(raw: String): String {
        return when {
            raw.contains("localhost") -> raw.replace("localhost", "10.0.2.2")
            raw.contains("127.0.0.1") -> raw.replace("127.0.0.1", "10.0.2.2")
            else -> raw
        }
    }

    fun resolve(
        bridge: Bridge,
        call: PluginCall?,
        pluginName: String
    ): String {
        val candidates = mutableListOf<String?>()
        candidates += call?.getString("backendUrl")
        candidates += bridge.config.getString("plugins.$pluginName.backendUrl")

        sharedPluginConfigOrder
            .filter { it != pluginName }
            .forEach { candidates += bridge.config.getString("plugins.$it.backendUrl") }

        candidates += System.getenv("NEXT_PUBLIC_BACKEND_URL")

        for (candidate in candidates) {
            val value = candidate?.trim()
            if (!value.isNullOrEmpty()) {
                return normalize(value)
            }
        }

        return ""
    }
}
