package com.hussh.app.plugins.HushhLocation

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.hussh.app.R
import com.google.firebase.auth.FirebaseAuth

/** Explicit opt-in foreground service. No token in Intents, preferences, backups or restart state. */
class BackgroundLocationService : Service(), LocationListener {
    companion object {
        private const val STOP = "com.hussh.app.STOP_LOCATION_SHARE"
        // Accessed only on the main looper by the plugin and service.
        internal var pending: BackgroundSession? = null
        internal var acknowledge: ((Boolean) -> Unit)? = null
        internal var instance: BackgroundLocationService? = null
        internal var generation = 0L
            private set
        internal var onStopped: (() -> Unit)? = null
        internal fun clearSession(notify: Boolean = false) {
            generation++
            pending = null
            acknowledge?.invoke(false)
            acknowledge = null
            instance?.publisher?.stop(false)
            instance?.handler?.post { instance?.stopIfIdle() }
            if (notify) onStopped?.invoke()
        }
    }
    private val handler = Handler(Looper.getMainLooper())
    private var ownerUid: String? = null
    private val authListener = FirebaseAuth.AuthStateListener { auth ->
        if (ownerUid != null && auth.currentUser?.uid != ownerUid) clearSession(true)
    }
    private val manager by lazy { getSystemService(LOCATION_SERVICE) as LocationManager }
    private val publisher: BackgroundLocationPublisher = BackgroundLocationPublisher { handler.post {
        if (!publisherActive() && pending == null) { onStopped?.invoke(); stopIfIdle() }
    } }
    private fun publisherActive(): Boolean = publisher.isActive()
    internal fun canUpdateForOwner(uid: String?) = uid != null && uid == ownerUid && publisher.isActive()
    private fun stopIfIdle() { if (!publisher.isActive() && pending == null) stopSelf() }
    private val permissionCheck = object : Runnable {
        override fun run() {
            if (!hasPermission()) { publisher.stop(); return }
            publisher.tick()
            handler.postDelayed(this, 1000)
        }
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() { super.onCreate(); instance = this; FirebaseAuth.getInstance().addAuthStateListener(authListener) }
    private fun hasPermission(): Boolean {
        val foreground = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
            .any { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }
        return foreground && (Build.VERSION.SDK_INT < 29 || ContextCompat.checkSelfPermission(this,
            Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED)
    }
    @SuppressLint("MissingPermission")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == STOP) { clearSession(true); stopSelf(); return START_NOT_STICKY }
        return applyPendingSession()
    }
    /** Main-looper update of an already authorized service; no new background start. */
    @SuppressLint("MissingPermission")
    internal fun applyPendingSession(): Int {
        val session = pending
        val callback = acknowledge
        pending = null
        acknowledge = null
        if (session == null) { if (!publisher.isActive()) stopSelf(); return START_NOT_STICKY }
        if (!hasPermission() || FirebaseAuth.getInstance().currentUser?.uid != session.ownerUid) {
            callback?.invoke(false); clearSession(); stopSelf(); return START_NOT_STICKY
        }
        try {
            val notifications = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
            if (Build.VERSION.SDK_INT >= 26) notifications.createNotificationChannel(NotificationChannel(
                "location-sharing", "Location sharing", NotificationManager.IMPORTANCE_LOW))
            val stop = PendingIntent.getService(this, 0, Intent(this, BackgroundLocationService::class.java).setAction(STOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            val notification = NotificationCompat.Builder(this, "location-sharing")
                .setSmallIcon(R.drawable.ic_stat_location_share).setContentTitle("Location sharing is on")
                .setContentText("Sharing encrypted location with your approved recipients.")
                .setOngoing(true).addAction(0, "Stop sharing", stop).build()
            startForeground(4207, notification)
            manager.removeUpdates(this)
            publisher.start(session)
            ownerUid = session.ownerUid
            val precise = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            val providers = (if (precise) listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
                else listOf(LocationManager.NETWORK_PROVIDER)).filter { manager.isProviderEnabled(it) }
            check(providers.isNotEmpty())
            providers.forEach { manager.requestLocationUpdates(it, 2000, 0f, this, Looper.getMainLooper()) }
            handler.removeCallbacks(permissionCheck)
            handler.post(permissionCheck)
            callback?.invoke(true)
        } catch (_: Exception) { publisher.stop(); callback?.invoke(false); stopSelf() }
        return START_NOT_STICKY
    }
    override fun onLocationChanged(location: Location) { if (hasPermission()) publisher.handle(location) else publisher.stop() }
    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        FirebaseAuth.getInstance().removeAuthStateListener(authListener)
        publisher.stop(false)
        manager.removeUpdates(this)
        if (instance === this) instance = null
        super.onDestroy()
    }
}
