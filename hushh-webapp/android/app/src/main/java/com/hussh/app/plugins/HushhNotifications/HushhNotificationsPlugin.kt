package com.hussh.app.plugins.HushhNotifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import androidx.core.app.NotificationManagerCompat
import android.content.Context
import android.graphics.Color
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.messaging.FirebaseMessaging
import com.getcapacitor.JSObject
import com.getcapacitor.JSArray
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.hussh.app.R
import com.hussh.app.plugins.shared.BackendUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.lang.ref.WeakReference

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
    @PluginMethod
    fun requestEmergencySmsAlarmPermission(call: PluginCall) {
        // Android uses the admitted foreground service and notification permission.
        call.resolve(JSObject().put("supported", false).put("authorized", false))
    }
    @PluginMethod
    fun getPendingEmergencySmsAlarms(call: PluginCall) {
        val user = call.getString("userId")
        if (user.isNullOrBlank() || FirebaseAuth.getInstance().currentUser == null || ChatPreviewKeys.legacyKey(context, user).isNullOrBlank()) {
            call.resolve(JSObject().put("grantIds", JSArray()).put("acknowledgedGrantIds", JSArray()))
            return
        }
        val requested = call.getArray("grantIds") ?: JSArray()
        val acknowledged = JSArray()
        for (index in 0 until minOf(requested.length(), 512)) {
            val grant = requested.optString(index)
            if (EmergencySmsAlarmService.acknowledged(context, user, grant)) acknowledged.put(grant)
        }
        call.resolve(JSObject().put("grantIds", JSArray(EmergencySmsAlarmService.pending(context, user)))
            .put("acknowledgedGrantIds", acknowledged))
    }
    @PluginMethod
    fun getNotificationSettings(call: PluginCall) {
        ChatMessagingService.ensureChannel(context)
        val allowed = NotificationManagerCompat.from(context).areNotificationsEnabled()
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        fun audible(channelId: String): Boolean {
            if (!allowed) return false
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
            val channel = manager?.getNotificationChannel(channelId) ?: return false
            return channel.importance >= NotificationManager.IMPORTANCE_DEFAULT && channel.sound != null
        }
        val alerts = allowed && (Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            (manager?.getNotificationChannel(ACTIVITY_CHANNEL_ID)?.importance ?: 0) > NotificationManager.IMPORTANCE_NONE)
        call.resolve(JSObject().put("alertsEnabled", alerts)
            .put("soundsEnabled", audible(ACTIVITY_CHANNEL_ID))
            .put("chatAlertsEnabled", allowed && (Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
                (manager?.getNotificationChannel(ChatMessagingService.CHANNEL)?.importance ?: 0) > NotificationManager.IMPORTANCE_NONE))
            .put("chatSoundsEnabled", audible(ChatMessagingService.CHANNEL))
            .put("emergencySoundEnabled", audible(EMERGENCY_SMS_CHANNEL_ID)))
    }
    private val emergencyHandler = Handler(Looper.getMainLooper())
    override fun handleOnDestroy() {
        // Activity recreation must not acknowledge an admitted alarm. The service
        // owns Home/lock; auth/key disposal owns account teardown.
        if (emergencyPlugin?.get() === this) emergencyPlugin = null
        super.handleOnDestroy()
    }

    @PluginMethod
    fun stopEmergencySmsCue(call: PluginCall) {
        emergencyHandler.post {
            EmergencySmsAlarmService.stop(context, call.getString("userId"), call.getString("grantId"))
            call.resolve()
        }
    }

    @PluginMethod
    fun playEmergencySmsCue(call: PluginCall) {
        emergencyHandler.post {
            val now = System.currentTimeMillis().toDouble()
            val userId = call.getString("userId")
            val grantId = call.getString("grantId")
            val deadline = call.getDouble("expiresAt")
            if (userId.isNullOrBlank() || grantId.isNullOrBlank() ||
                FirebaseAuth.getInstance().currentUser == null ||
                ChatPreviewKeys.legacyKey(context, userId).isNullOrBlank() ||
                deadline == null || !deadline.isFinite() || deadline <= now || deadline > now + 2000) {
                call.resolve(JSObject().put("played", false))
                return@post
            }
            if (EmergencySmsAlarmService.acknowledged(context, userId, grantId)) {
                call.resolve(JSObject().put("played", false).put("acknowledged", true))
                return@post
            }
            val started = EmergencySmsAlarmService.start(context, userId, grantId, deadline.toLong())
            if (!started) EmergencySmsAlarmService.showFallback(context, userId, grantId)
            call.resolve(JSObject().put("played", started))
        }
    }

    @PluginMethod
    fun deletePushToken(call: PluginCall) {
        FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener { task ->
            if (task.isSuccessful) call.resolve()
            else call.reject("Push token deletion failed")
        }
    }

    override fun load() {
        super.load()
        emergencyPlugin = WeakReference(this)
        ensureActivityChannel(context)
        ensureEmergencySmsChannel(context)
        ChatMessagingService.ensureChannel(context)
    }

    private fun ensureActivityChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        // Channel choices belong to the person. Never recreate/reset a muted channel.
        if (manager.getNotificationChannel(ACTIVITY_CHANNEL_ID) != null) return
        val channel = NotificationChannel(ACTIVITY_CHANNEL_ID,
            context.getString(R.string.activity_channel_name), NotificationManager.IMPORTANCE_HIGH).apply {
            description = context.getString(R.string.activity_channel_description)
            enableVibration(true)
            setBypassDnd(false)
            setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
        }
        manager.createNotificationChannel(channel)
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
        private var emergencyPlugin: WeakReference<HushhNotificationsPlugin>? = null
        fun emergencyAcknowledged(user: String, grant: String) {
            emergencyPlugin?.get()?.let { plugin ->
                plugin.emergencyHandler.post {
                    plugin.notifyListeners("emergencySmsAcknowledged", JSObject().put("userId", user).put("grantId", grant))
                }
            }
        }
        const val ACTIVITY_CHANNEL_ID = "hushh_activity_alerts_v1"
        const val EMERGENCY_SMS_CHANNEL_ID = "one_location_sms_emergency_v1"
        @Volatile var activityActive = false
        @Volatile var activeChatTag = ""
        @Volatile var activeChatKey = ""
    }

    @PluginMethod
    fun setActiveChat(call: PluginCall) {
        val key = call.getString("keyId") ?: ""
        if (!ChatPreviewKeys.matches(context, key)) { call.resolve(); return }
        activeChatKey = key
        activeChatTag = call.getString("tag") ?: ""
        call.resolve()
    }

    private fun getBackendUrl(call: PluginCall? = null): String {
        return BackendUrl.resolve(bridge, call, "HushhNotifications")
    }

    @PluginMethod
    fun prepareNotificationKey(call: PluginCall) {
        val userId = call.getString("userId")
        val deviceId = call.getString("deviceId")
        if (userId.isNullOrBlank() || deviceId.isNullOrBlank()) { call.reject("Notification identity required"); return }
        try { call.resolve(ChatPreviewKeys.prepare(context, userId, deviceId)) }
        catch (_: Exception) { call.reject("Notification keys unavailable") }
    }

    @PluginMethod
    fun clearNotificationKey(call: PluginCall) {
        val user = call.getString("userId") ?: run { call.reject("Notification identity required"); return }
        emergencyHandler.post {
            try {
                EmergencySmsAlarmService.stop(context, user)
                ChatPreviewKeys.clear(context, user)
                if (call.getBoolean("deleteAlarmReceipts", false) == true) EmergencySmsAlarmService.forget(context, user)
                activeChatTag = ""; activeChatKey = ""; call.resolve()
            }
            catch (_: Exception) { call.reject("Notification cleanup unavailable") }
        }
    }

    @PluginMethod
    fun clearChatNotifications(call: PluginCall) {
        val thread = call.getString("threadId")
        val key = call.getString("keyId")
        if (thread.isNullOrBlank() || key.isNullOrBlank()) { call.reject("Notification identity required"); return }
        ChatMessagingService.clearRead(context, thread, key, call.getDouble("sequence")?.toLong(), call.getDouble("before")?.toLong(), call.getString("messageId"))
        call.resolve()
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
                    .put("device_id", call.getString("deviceId"))
                    .put("preview_key_id", call.getString("previewKeyId"))
                    .put("sms_alarm_version", if (call.getString("previewKeyId").isNullOrBlank()) 0 else 1)
                    .put("preview_public_key", call.getString("previewPublicKey"))
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
                    Log.w(TAG, "registerPushToken non-OK: ${response.code}")
                    activity.runOnUiThread {
                        call.resolve(JSObject().put("success", false))
                    }
                    return@Thread
                }

                val payload = JSONObject(responseBody)
                val registered = payload.optBoolean("registered", true)
                val degraded = payload.optBoolean("degraded", false)
                activity.runOnUiThread {
                    call.resolve(JSObject().put("success", registered && !degraded)
                        .put("registered", registered).put("degraded", degraded))
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
                call.getString("deviceId")?.let { bodyObj.put("device_id", it) }
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
