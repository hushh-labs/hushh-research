package com.hushh.app.plugins.shared

import android.os.Build
import com.getcapacitor.Bridge
import com.getcapacitor.PluginCall

/**
 * BackendUrl
 *
 * Shared backend URL normalization:
 * - Android emulator cannot reach host loopback, so localhost maps to 10.0.2.2.
 * - Physical Android devices can use adb reverse, so localhost stays localhost.
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

    private fun isProbablyEmulator(): Boolean {
        val fingerprint = Build.FINGERPRINT.lowercase()
        val model = Build.MODEL.lowercase()
        val manufacturer = Build.MANUFACTURER.lowercase()
        val brand = Build.BRAND.lowercase()
        val device = Build.DEVICE.lowercase()
        val product = Build.PRODUCT.lowercase()

        return fingerprint.startsWith("generic") ||
            fingerprint.contains("emulator") ||
            fingerprint.contains("sdk_gphone") ||
            model.contains("emulator") ||
            model.contains("android sdk built for") ||
            manufacturer.contains("genymotion") ||
            brand.startsWith("generic") ||
            device.startsWith("generic") ||
            product.contains("sdk")
    }

    fun normalize(raw: String): String {
        val useEmulatorHost = isProbablyEmulator()
        return when {
            useEmulatorHost && raw.contains("localhost") -> raw.replace("localhost", "10.0.2.2")
            useEmulatorHost && raw.contains("127.0.0.1") -> raw.replace("127.0.0.1", "10.0.2.2")
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
