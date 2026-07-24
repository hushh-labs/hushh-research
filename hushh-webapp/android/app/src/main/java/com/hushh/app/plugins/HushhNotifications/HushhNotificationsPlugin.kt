package com.hushh.app.plugins.HushhNotifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.graphics.Color
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.hushh.app.R
import com.hushh.app.plugins.shared.BackendUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * HushhNotificationsPlugin - Push token registration (Capacitor 8)
 *
 * Next.js source of truth:
 * - POST   /api/notifications/register
 * - DELETE /api/notifications/unregister
 *
 * Backend expects Firebase ID token in Authorization: Bearer <idToken>
 * Body:
 * - register: { user_id, token, platform }
 * - unregister: { user_id, platform? }
 */
@CapacitorPlugin(name = "HushhNotifications")
class HushhNotificationsPlugin : Plugin() {

    private val TAG = "HushhNotifications"

    override fun load() {
        super.load()
        ensureEmergencySmsChannel(context)
    }

    private fun ensureEmergencySmsChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager =
            context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
                ?: return
        if (manager.getNotificationChannel(EMERGENCY_SMS_CHANNEL_ID) != null) return

        val alarmSound =
            RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
        val audioAttributes =
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build()
        val channel =
            NotificationChannel(
                EMERGENCY_SMS_CHANNEL_ID,
                context.getString(R.string.sms_emergency_channel_name),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.sms_emergency_channel_description)
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 240, 120, 240, 120, 520)
                enableLights(true)
                lightColor = Color.RED
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                setBypassDnd(false)
                setSound(alarmSound, audioAttributes)
            }
        manager.createNotificationChannel(channel)
        Log.i(TAG, "Emergency SMS notification channel ready")
    }

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    companion object {
        const val EMERGENCY_SMS_CHANNEL_ID = "one_location_sms_emergency_v1"
    }

    private fun getBackendUrl(call: PluginCall? = null): String {
        return BackendUrl.resolve(bridge, call, "HushhNotifications")
    }

    @PluginMethod
    fun registerPushToken(call: PluginCall) {
        val userId = call.getString("userId")
        val token = call.getString("token")
        val platform = call.getString("platform")
        val idToken = call.getString("idToken")

        if (userId.isNullOrBlank() || token.isNullOrBlank() || platform.isNullOrBlank() || idToken.isNullOrBlank()) {
            call.reject("Missing required parameters: userId, token, platform, idToken")
            return
        }

        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/notifications/register"

        Thread {
            try {
                val bodyJson = JSONObject()
                    .put("user_id", userId)
                    .put("token", token)
                    .put("platform", platform)
                    .toString()

                val request = Request.Builder()
                    .url(url)
                    .post(bodyJson.toRequestBody("application/json".toMediaType()))
                    .addHeader("Content-Type", "application/json")
                    .addHeader("Authorization", "Bearer $idToken")
                    .build()

                val response = httpClient.newCall(request).execute()
                val responseBody = response.body?.string() ?: "{}"

                if (!response.isSuccessful) {
                    Log.w(TAG, "registerPushToken non-OK: ${response.code} body=$responseBody")
                    activity.runOnUiThread {
                        call.resolve(JSObject().put("success", false))
                    }
                    return@Thread
                }

                activity.runOnUiThread {
                    call.resolve(JSObject().put("success", true))
                }
            } catch (e: Exception) {
                Log.e(TAG, "registerPushToken error", e)
                activity.runOnUiThread {
                    call.reject("Network error: ${e.message}")
                }
            }
        }.start()
    }

    @PluginMethod
    fun unregisterPushToken(call: PluginCall) {
        val userId = call.getString("userId")
        val idToken = call.getString("idToken")
        val platform = call.getString("platform")

        if (userId.isNullOrBlank() || idToken.isNullOrBlank()) {
            call.reject("Missing required parameters: userId, idToken")
            return
        }

        val backendUrl = getBackendUrl(call)
        val url = "$backendUrl/api/notifications/unregister"

        Thread {
            try {
                val bodyObj = JSONObject().put("user_id", userId)
                if (!platform.isNullOrBlank()) bodyObj.put("platform", platform)

                val request = Request.Builder()
                    .url(url)
                    .delete(bodyObj.toString().toRequestBody("application/json".toMediaType()))
                    .addHeader("Content-Type", "application/json")
                    .addHeader("Authorization", "Bearer $idToken")
                    .build()

                val response = httpClient.newCall(request).execute()
                val responseBody = response.body?.string() ?: "{}"

                if (!response.isSuccessful) {
                    Log.w(TAG, "unregisterPushToken non-OK: ${response.code} body=$responseBody")
                    activity.runOnUiThread {
                        call.resolve(JSObject().put("success", false))
                    }
                    return@Thread
                }

                activity.runOnUiThread {
                    call.resolve(JSObject().put("success", true))
                }
            } catch (e: Exception) {
                Log.e(TAG, "unregisterPushToken error", e)
                activity.runOnUiThread {
                    call.reject("Network error: ${e.message}")
                }
            }
        }.start()
    }
}
