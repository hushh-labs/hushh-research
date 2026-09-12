package com.hussh.app.plugins.HushhInvitations

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** Hands one message to the user's SMS application; never sends in background. */
@CapacitorPlugin(name = "HushhInvitations")
class HushhInvitationsPlugin : Plugin() {
    private var composing = false

    @PluginMethod
    fun getCapabilities(call: PluginCall) {
        val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:"))
        call.resolve(JSObject().put("sms", intent.resolveActivity(context.packageManager) != null))
    }

    @PluginMethod
    fun composeSms(call: PluginCall) {
        val recipient = call.getString("recipient").orEmpty()
        val body = call.getString("body").orEmpty()
        if (!Regex("^\\+[1-9][0-9]{6,14}$").matches(recipient) || body.isEmpty() || body.length > 2000) {
            call.reject("Invalid invitation.")
            return
        }
        activity.runOnUiThread {
            if (composing) {
                call.reject("A message is already open.")
                return@runOnUiThread
            }
            composing = true
            try {
                activity.startActivity(Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:$recipient")).putExtra("sms_body", body))
                // ACTION_SENDTO provides no send/cancel/delivery result.
                call.resolve(JSObject().put("outcome", "opened"))
            } catch (_: ActivityNotFoundException) {
                composing = false
                call.resolve(JSObject().put("outcome", "unavailable"))
            } catch (_: SecurityException) {
                composing = false
                call.resolve(JSObject().put("outcome", "failed"))
            }
        }
    }

    override fun handleOnResume() {
        composing = false
    }
}
