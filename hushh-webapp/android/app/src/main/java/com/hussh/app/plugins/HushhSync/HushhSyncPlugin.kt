package com.hussh.app.plugins.HushhSync

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Hushh Sync Plugin - Cloud Synchronization
 *
 * Remote sync is intentionally disabled in this release.
 */
@CapacitorPlugin(name = "HushhSync")
class HushhSyncPlugin : Plugin() {

    @PluginMethod
    fun sync(call: PluginCall) {
        call.getString("authToken")
        call.resolve(
            JSObject().apply {
                put("success", false)
                put("error_code", "SYNC_DISABLED")
                put("message", "Remote sync is disabled in this release.")
                put("pushedRecords", 0)
                put("pulledRecords", 0)
                put("conflicts", 0)
                put("timestamp", System.currentTimeMillis())
            },
        )
    }

    @PluginMethod
    fun push(call: PluginCall) {
        call.getString("authToken")
        call.resolve(
            JSObject().apply {
                put("success", false)
                put("error_code", "SYNC_DISABLED")
                put("message", "Remote sync is disabled in this release.")
                put("pushedRecords", 0)
            },
        )
    }

    @PluginMethod
    fun pull(call: PluginCall) {
        call.getString("authToken")
        call.resolve(
            JSObject().apply {
                put("success", false)
                put("error_code", "SYNC_DISABLED")
                put("message", "Remote sync is disabled in this release.")
                put("pulledRecords", 0)
            },
        )
    }

    @PluginMethod
    fun syncVault(call: PluginCall) {
        if (call.getString("userId") == null) {
            call.reject("Missing required parameter: userId")
            return
        }

        call.resolve(
            JSObject().apply {
                put("success", false)
                put("error_code", "SYNC_DISABLED")
                put("message", "Remote sync is disabled in this release.")
            },
        )
    }

    @PluginMethod
    fun getSyncStatus(call: PluginCall) {
        call.resolve(
            JSObject().apply {
                put("pendingCount", 0)
                put("lastSyncTimestamp", 0)
                put("hasPendingChanges", false)
            },
        )
    }
}
