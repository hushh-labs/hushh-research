package com.hussh.app.plugins.HushhNotifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.auth.FirebaseAuth
import com.hussh.app.MainActivity
import com.hussh.app.R
import java.security.MessageDigest

/** One audible owner for all admitted, unacknowledged SMS grants, including Home/lock. */
class EmergencySmsAlarmService : Service() {
    private val grants = linkedSetOf<String>()
    private var owner: String? = null
    private var firebaseUid: String? = null
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private val authListener = FirebaseAuth.AuthStateListener {
        if (owner != null && it.currentUser?.uid != firebaseUid) dispose()
    }

    override fun onCreate() {
        super.onCreate()
        running = this
        FirebaseAuth.getInstance().addAuthStateListener(authListener)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val user = intent?.getStringExtra("userId")
        val grant = intent?.getStringExtra("grantId")
        if (intent?.action == ACKNOWLEDGE) {
            if (user != null && grant != null && ChatPreviewKeys.legacyKey(this, user) != null) {
                HushhNotificationsPlugin.emergencyAcknowledged(user, grant)
                stop(this, user, grant)
            }
            if (grants.isEmpty()) dispose()
            return START_NOT_STICKY
        }
        // Admission expiry fences a delayed bridge call, never a running alarm.
        val deadline = intent?.getLongExtra("deadline", 0) ?: 0
        val uid = FirebaseAuth.getInstance().currentUser?.uid
        if (user.isNullOrBlank() || grant.isNullOrBlank() || uid == null ||
            ChatPreviewKeys.legacyKey(this, user).isNullOrBlank() ||
            acknowledged(this, user, grant) || endedBeforeAdmission(this, user, grant)) {
            if (grants.isEmpty()) dispose()
            return START_NOT_STICKY
        }
        if (deadline <= System.currentTimeMillis() || deadline > System.currentTimeMillis() + 2000) {
            // A busy cold start can outlive the bridge admission window. Keep
            // the admitted push visible rather than silently losing data-only SMS.
            if (deadline > 0 && claimAdmission(this, user, grant)) showFallback(this, user, grant)
            if (grants.isEmpty()) dispose()
            return START_NOT_STICKY
        }
        if (owner != null && owner != user) { releaseAudio(); grants.clear() }
        owner = user
        firebaseUid = uid
        if (!claimAdmission(this, user, grant)) {
            if (grants.isEmpty()) dispose()
            return START_NOT_STICKY
        }
        grants.add(grant)
        try {
            present()
            if (player == null) {
                val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
                val audio = MediaPlayer()
                player = audio // Dispose even if prepare/start fails.
                audio.apply {
                    setWakeMode(applicationContext, PowerManager.PARTIAL_WAKE_LOCK)
                    setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    setDataSource(this@EmergencySmsAlarmService, uri)
                    isLooping = true
                    prepare()
                    start()
                }
                vibrator = getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
                val pattern = longArrayOf(0, 240, 120, 240, 120, 520)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
                } else {
                    @Suppress("DEPRECATION")
                    vibrator?.vibrate(pattern, 0)
                }
            }
            for (pendingGrant in grants) cancelFallback(this, user, pendingGrant)
        } catch (_: Exception) {
            for (pendingGrant in grants) showFallback(this, user, pendingGrant)
            dispose()
        }
        // OS force-stop is authoritative. Never resurrect an alarm under a new owner.
        return START_NOT_STICKY
    }

    private fun present() {
        val grant = grants.first()
        val user = owner ?: return
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Active SMS alarms", NotificationManager.IMPORTANCE_LOW).apply {
                setSound(null, null)
            })
        }
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("google.message_id", "sms-alarm:$grant")
            putExtra("type", "location_share_created")
            putExtra("share_kind", "sos")
            putExtra("user_id", user)
            putExtra("grant_id", grant)
        }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val dismiss = PendingIntent.getService(this, 1, Intent(this, EmergencySmsAlarmService::class.java).apply {
            action = ACKNOWLEDGE
            putExtra("userId", user)
            putExtra("grantId", grant)
        }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_stat_message)
            .setContentTitle("Emergency SMS alert")
            .setContentText(if (grants.size == 1) "Tap to view the alert or dismiss its alarm" else "${grants.size} SMS alerts need acknowledgement")
            .setContentIntent(open).setOngoing(true).setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .addAction(0, "Dismiss alarm", dismiss).build()
        startForeground(NOTIFICATION_ID, notification)
    }

    private fun acknowledge(grant: String) {
        val user = owner ?: return
        val store = getSharedPreferences(ACK_STORE, Context.MODE_PRIVATE)
        val values = store.getStringSet(user, emptySet()).orEmpty().toMutableSet()
        values.add(grant)
        store.edit().putStringSet(user, values).apply()
        cancelFallback(this, user, grant)
        grants.remove(grant)
        if (grants.isEmpty()) dispose() else present()
    }

    private fun releaseAudio() {
        player?.release(); player = null
        vibrator?.cancel(); vibrator = null
    }
    private fun dispose() {
        releaseAudio()
        grants.clear()
        owner = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }
    override fun onDestroy() {
        FirebaseAuth.getInstance().removeAuthStateListener(authListener)
        releaseAudio()
        if (running === this) running = null
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val CHANNEL = "one_location_sms_active_v1"
        private const val ACK_STORE = "one_location_sms_ack_v1"
        private const val ACKNOWLEDGE = "com.hussh.app.SMS_ACKNOWLEDGE"
        private const val NOTIFICATION_ID = 24091
        private var running: EmergencySmsAlarmService? = null
        private fun deletionKey(user: String) = "deleted:" + MessageDigest.getInstance("SHA-256")
            .digest(user.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        private fun deleted(context: Context, user: String) =
            context.getSharedPreferences(ACK_STORE, Context.MODE_PRIVATE).getBoolean(deletionKey(user), false)
        private fun fallbackTag(user: String, grant: String) = "sms-alarm:$user:$grant"
        private fun cancelFallback(context: Context, user: String, grant: String) {
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(fallbackTag(user, grant), 24092)
        }

        fun showFallback(context: Context, user: String, grant: String) {
            if (FirebaseAuth.getInstance().currentUser == null || ChatPreviewKeys.legacyKey(context, user).isNullOrBlank() ||
                !NotificationManagerCompat.from(context).areNotificationsEnabled()) return
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val channelId = HushhNotificationsPlugin.EMERGENCY_SMS_CHANNEL_ID
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (manager.getNotificationChannel(channelId) == null) {
                    manager.createNotificationChannel(NotificationChannel(channelId, "Emergency SMS alerts", NotificationManager.IMPORTANCE_HIGH))
                }
                if (manager.getNotificationChannel(channelId)?.importance == NotificationManager.IMPORTANCE_NONE) return
            }
            if (!claimAdmission(context, user, grant)) return
            val open = PendingIntent.getActivity(context, grant.hashCode(), Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                data = android.net.Uri.parse("hussh-sms://alarm/${android.net.Uri.encode(grant)}")
                putExtra("google.message_id", "sms-alarm:$grant")
                putExtra("type", "location_share_created"); putExtra("share_kind", "sos")
                putExtra("user_id", user); putExtra("grant_id", grant)
            }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val dismiss = PendingIntent.getService(context, grant.hashCode(), Intent(context, EmergencySmsAlarmService::class.java).apply {
                action = ACKNOWLEDGE
                data = android.net.Uri.parse("hussh-sms://dismiss/${android.net.Uri.encode(grant)}")
                putExtra("userId", user); putExtra("grantId", grant)
            }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            try {
                manager.notify(fallbackTag(user, grant), 24092, NotificationCompat.Builder(context, channelId)
                    .setSmallIcon(R.drawable.ic_stat_message).setContentTitle("Emergency SMS alert")
                    .setContentText("Open Hussh to review this alert").setContentIntent(open).setDeleteIntent(dismiss)
                    .setAutoCancel(true).setCategory(NotificationCompat.CATEGORY_ALARM).setPriority(NotificationCompat.PRIORITY_HIGH)
                    .addAction(0, "Dismiss alarm", dismiss).build())
                // Acknowledgement/key disposal can beat this queued post.
                if (acknowledged(context, user, grant) || ChatPreviewKeys.legacyKey(context, user).isNullOrBlank()) cancelFallback(context, user, grant)
            } catch (_: SecurityException) { /* Notification permission remains authoritative. */ }
        }

        fun acknowledged(context: Context, user: String, grant: String): Boolean =
            context.getSharedPreferences(ACK_STORE, Context.MODE_PRIVATE).getStringSet(user, emptySet()).orEmpty().contains(grant)

        fun pending(context: Context, user: String): List<String> =
            context.getSharedPreferences(ACK_STORE, Context.MODE_PRIVATE).getStringSet("pending:$user", emptySet()).orEmpty()
                .filter { !acknowledged(context, user, it) }

        @Synchronized fun markEnded(context: Context, user: String, grant: String) {
            if (deleted(context, user)) return
            val store = context.getSharedPreferences(ACK_STORE, Context.MODE_PRIVATE)
            val ended = store.getStringSet("ended:$user", emptySet()).orEmpty().toMutableSet()
            ended.add(grant)
            store.edit().putStringSet("ended:$user", ended).apply()
            // An existing pending alarm still requires recipient acknowledgement.
        }

        private fun endedBeforeAdmission(context: Context, user: String, grant: String): Boolean =
            context.getSharedPreferences(ACK_STORE, Context.MODE_PRIVATE).getStringSet("ended:$user", emptySet()).orEmpty().contains(grant) &&
                !pending(context, user).contains(grant)

        @Synchronized private fun claimAdmission(context: Context, user: String, grant: String): Boolean {
            if (deleted(context, user) || ChatPreviewKeys.legacyKey(context, user).isNullOrBlank() ||
                acknowledged(context, user, grant) || endedBeforeAdmission(context, user, grant)) return false
            val store = context.getSharedPreferences(ACK_STORE, Context.MODE_PRIVATE)
            val pending = store.getStringSet("pending:$user", emptySet()).orEmpty().toMutableSet()
            pending.add(grant)
            store.edit().putStringSet("pending:$user", pending).apply()
            return true
        }

        fun start(context: Context, user: String, grant: String, deadline: Long): Boolean {
            if (acknowledged(context, user, grant) || endedBeforeAdmission(context, user, grant)) return false
            if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                val channel = manager.getNotificationChannel(HushhNotificationsPlugin.EMERGENCY_SMS_CHANNEL_ID) ?: return false
                if (channel.importance < NotificationManager.IMPORTANCE_DEFAULT || channel.sound == null) return false
            }
            val intent = Intent(context, EmergencySmsAlarmService::class.java)
                .putExtra("userId", user).putExtra("grantId", grant).putExtra("deadline", deadline)
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
                true
            } catch (_: Exception) { false }
        }

        @Synchronized fun stop(context: Context, user: String?, grant: String? = null) {
            // Persist before consulting the service: acknowledgement can beat
            // a queued startForegroundService/onCreate on the main looper.
            if (user != null && grant != null && !deleted(context, user) && !ChatPreviewKeys.legacyKey(context, user).isNullOrBlank()) {
                val store = context.getSharedPreferences(ACK_STORE, Context.MODE_PRIVATE)
                val values = store.getStringSet(user, emptySet()).orEmpty().toMutableSet()
                values.add(grant)
                store.edit().putStringSet(user, values).apply()
                cancelFallback(context, user, grant)
            }
            if (user != null && grant == null) for (pendingGrant in pending(context, user)) cancelFallback(context, user, pendingGrant)
            val service = running ?: return
            if (user != null && service.owner != user) return
            if (grant == null) service.dispose() else service.acknowledge(grant)
        }

        @Synchronized fun forget(context: Context, user: String) {
            stop(context, user)
            context.getSharedPreferences(ACK_STORE, Context.MODE_PRIVATE).edit()
                .putBoolean(deletionKey(user), true).remove(user).remove("pending:$user").remove("ended:$user").commit()
        }
    }
}
