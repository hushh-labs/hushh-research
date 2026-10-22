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
        call.resolve(JSObject().put("sms", intent.resolveActivity(context.packageManager) != null).put("maxSmsRecipients", 15))
    }

    @PluginMethod
    fun composeSms(call: PluginCall) {
        compose(call, listOf(call.getString("recipient").orEmpty()))
    }

    @PluginMethod
    fun composeSmsBatch(call: PluginCall) {
        val raw = call.getArray("recipients")
        if (raw == null || raw.length() !in 1..15) {
            call.reject("Invalid invitation.")
            return
        }
        val recipients = (0 until raw.length()).map { raw.opt(it) }
        if (recipients.any { it !is String }) {
            call.reject("Invalid invitation.")
            return
        }
        compose(call, recipients.filterIsInstance<String>())
    }

    private fun compose(call: PluginCall, recipients: List<String>) {
        val body = call.getString("body").orEmpty()
        if (recipients.size !in 1..15 || recipients.toSet().size != recipients.size ||
            recipients.any { !Regex("^\\+[1-9][0-9]{6,14}$").matches(it) } || body.isEmpty() || body.length > 2000) {
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
                // Comma-separated recipients are understood by the AOSP SMS URI parser.
                // The user's messaging app owns group/carrier behavior and final Send.
                val address = recipients.joinToString(",")
                activity.startActivity(Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:$address")).putExtra("sms_body", body))
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
