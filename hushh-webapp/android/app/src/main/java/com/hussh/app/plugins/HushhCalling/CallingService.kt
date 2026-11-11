package com.hussh.app.plugins.HushhCalling

import android.Manifest
import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.IBinder
import android.telecom.DisconnectCause
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.messaging.RemoteMessage
import com.hussh.app.R
import com.hussh.app.MainActivity
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.UUID

internal object CallingRuntime {
    data class View(val owner: String, val value: JSONObject)
    data class Pending(val client: CallingClient, val id: String, val outgoing: JSONObject?,
        val incoming: JSONObject?, val activity: WeakReference<Activity>? = null,
        val result: CompletableDeferred<Unit>? = null)

    val view = MutableStateFlow<View?>(null)
    val cleanup = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    var pending: Pending? = null
    var service: CallingService? = null

    fun reserve(context: Context, value: Pending) {
        check(pending == null && service == null)
        pending = value
        try {
            ContextCompat.startForegroundService(context, Intent(context, CallingService::class.java).putExtra("callId", value.id))
        } catch (error: Exception) {
            pending = null
            throw error
        }
    }

    fun microphoneGranted(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    fun callId(value: String?): String? = value?.takeIf {
        runCatching { UUID.fromString(it).toString() == it }.getOrDefault(false)
    }
}

/** Owns exactly one Telecom call and its private foreground notification. */
@RequiresApi(26)
internal class CallingService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var session: CallingSession? = null
    private var microphone = false
    private var ringing = false
    private var answering = false
    private var label = "Hussh voice call"
    private val auth = FirebaseAuth.AuthStateListener {
        session?.let { current ->
            if (!current.isCurrent()) scope.launch { current.finish(DisconnectCause.LOCAL) }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        FirebaseAuth.getInstance().addAuthStateListener(auth)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = CallingRuntime.callId(intent?.getStringExtra("callId"))
        val action = intent?.action
        if (action == DECLINE || action == END) {
            session?.takeIf { it.id == id }?.let { live ->
                scope.launch { live.finish(if (action == DECLINE) DisconnectCause.REJECTED else DisconnectCause.LOCAL) }
            }
            return START_NOT_STICKY
        }
        if (session != null) return START_NOT_STICKY
        val pending = CallingRuntime.pending?.takeIf { it.id == id }
        CallingRuntime.pending = null
        if (pending == null) { stopSelf(); return START_NOT_STICKY }
        CallingRuntime.service = this
        if (pending.outgoing?.has("smsIncidentId") == true || pending.incoming?.optBoolean("isSmsEscalation") == true) {
            label = "SMS – Save my Soul"
        }
        val live = CallingSession(this, scope, pending.client, pending.id, label,
            canRecord = { microphone && CallingRuntime.microphoneGranted(this) },
            canStart = { pending.activity?.get()?.hasWindowFocus() == true },
            publish = {
                if (CallingRuntime.service === this) CallingRuntime.view.value = CallingRuntime.View(pending.client.identity.ownerId, it)
            },
            notification = { isRinging -> ringing = isRinging; promote(notification(pending.id, isRinging), microphone) },
            closed = { stopSelf() })
        session = live
        scope.launch {
            try {
                promote(preparingNotification(), false)
                if (pending.outgoing != null) {
                    check(pending.activity?.get()?.hasWindowFocus() == true)
                    enableMicrophone()
                }
                live.start(pending.outgoing, pending.incoming)
                pending.result?.complete(Unit)
            } catch (settled: SmsCallSettled) {
                live.finish(DisconnectCause.CANCELED, notifyServer = false)
                pending.result?.complete(Unit)
            } catch (error: Exception) {
                pending.result?.completeExceptionally(error)
                live.finish(DisconnectCause.ERROR)
            }
        }
        return START_NOT_STICKY
    }

    fun owned(owner: String, id: String): CallingSession =
        checkNotNull(session?.takeIf { it.ownerId == owner && it.id == id && it.isCurrent() })

    suspend fun answer(id: String) {
        val live = checkNotNull(session?.takeIf { it.id == id && it.isCurrent() })
        if (answering || !ringing) return
        answering = true
        try {
            enableMicrophone()
            live.answerFromApp()
        }
        catch (error: Exception) { live.finish(DisconnectCause.ERROR); throw error }
        finally { answering = false }
    }

    private fun enableMicrophone() {
        check(CallingRuntime.microphoneGranted(this))
        promote(session?.let { notification(it.id, ringing) } ?: preparingNotification(), true)
        microphone = true
    }

    private fun promote(notice: Notification, withMicrophone: Boolean) {
        val type = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL or
            if (withMicrophone) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notice, type)
    }

    private fun preparingNotification(): Notification = builder(PREPARING)
        .setContentText("Connecting call").setSilent(true).build()

    private fun builder(channel: String): NotificationCompat.Builder {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(RING, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
            setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build())
        })
        manager.createNotificationChannel(NotificationChannel(PREPARING, "Active calls", NotificationManager.IMPORTANCE_LOW))
        return NotificationCompat.Builder(this, channel).setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(label).setCategory(NotificationCompat.CATEGORY_CALL)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setOngoing(true)
    }

    private fun notification(id: String, ringing: Boolean): Notification {
        val generic = Person.Builder().setName(label).build()
        val builder = builder(if (ringing) RING else PREPARING).setOnlyAlertOnce(true)
            .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE))
        if (ringing) {
            val answer = PendingIntent.getActivity(this, 0,
                Intent(this, CallingAnswerActivity::class.java).setData(Uri.fromParts("hussh-call", id, null))
                    .putExtra("callId", id), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            builder.setStyle(NotificationCompat.CallStyle.forIncomingCall(generic, control(DECLINE, id), answer))
        } else builder.setStyle(NotificationCompat.CallStyle.forOngoingCall(generic, control(END, id)))
        return builder.build()
    }

    private fun control(action: String, id: String): PendingIntent =
        PendingIntent.getService(this, 0, Intent(this, CallingService::class.java).setAction(action)
            .setData(Uri.fromParts("hussh-call", id, null)).putExtra("callId", id),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

    override fun onDestroy() {
        FirebaseAuth.getInstance().removeAuthStateListener(auth)
        session?.end(DisconnectCause(DisconnectCause.LOCAL))
        session = null
        if (CallingRuntime.service === this) CallingRuntime.service = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val RING = "hushh_incoming_calls_v1"
        private const val PREPARING = "hushh_active_calls_v1"
        private const val DECLINE = "com.hussh.calling.DECLINE"
        private const val END = "com.hussh.calling.END"
        private const val NOTIFICATION_ID = 8704

        fun receive(context: Context, message: RemoteMessage) {
            if (message.priority != RemoteMessage.PRIORITY_HIGH) return
            val id = CallingRuntime.callId(message.data["callId"]) ?: return
            val expiry = message.data["expiresAt"]?.toLongOrNull() ?: return
            if (expiry <= System.currentTimeMillis() / 1000) return
            runBlocking {
                runCatching {
                    withTimeout(4_500) {
                        val client = CallingClient.admitted(context, allowEnrollment = false)
                        require(client.identity.deviceId == message.data["deviceId"] && client.identity.keyId == message.data["keyId"])
                        val call = client.command("read", JSONObject().put("callId", id).put("after", 0))
                        require(call.getString("state") == "ringing" && !call.getBoolean("isCaller") &&
                            call.isNull("calleeDeviceId") && call.getLong("expiresAt") == expiry)
                        withContext(Dispatchers.Main.immediate) {
                            CallingRuntime.reserve(context, CallingRuntime.Pending(client, id, null, call))
                        }
                    }
                }
            }
        }
    }
}
