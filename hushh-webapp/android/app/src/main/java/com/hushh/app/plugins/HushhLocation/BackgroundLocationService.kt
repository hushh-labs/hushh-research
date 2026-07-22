package com.hushh.app.plugins.HushhLocation

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.hushh.app.MainActivity
import com.hushh.app.R
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import kotlin.math.cos
import kotlin.math.max
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Foreground service that keeps recipient-specific encrypted location updates
 * flowing while the Capacitor WebView is backgrounded. Session credentials stay
 * in process memory and the service is intentionally START_NOT_STICKY.
 */
class BackgroundLocationService : Service(), LocationListener {
    private data class Grant(
        val id: String,
        val recipientKeyId: String,
        val recipientPublicKeyJwk: JSONObject,
        val precision: String
    )

    private data class Session(
        val vaultOwnerToken: String,
        val backendBaseUrl: String,
        val grants: List<Grant>,
        val minMoveMeters: Double,
        val minIntervalMs: Long
    )

    private val client = OkHttpClient()
    @Volatile
    private var session: Session? = null
    private var lastPublishedAt = 0L
    private var lastTargetsRefreshAt = 0L
    private var lastLocation: Location? = null
    private lateinit var locationManager: LocationManager
    private val mainHandler = Handler(Looper.getMainLooper())
    private val refreshTargetsRunnable = object : Runnable {
        override fun run() {
            val activeSession = session ?: return
            refreshTargetsIfNeeded(activeSession, System.currentTimeMillis())
            if (session != null) {
                mainHandler.postDelayed(this, TARGET_REFRESH_INTERVAL_MS)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        locationManager = getSystemService(LOCATION_SERVICE) as LocationManager
        createNotificationChannel()
        val launchIntent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Friends Map is updating")
            .setContentText("Your encrypted location is visible to connections.")
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            } else {
                0
            }
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopPublishing()
            return START_NOT_STICKY
        }
        val rawSession = takePendingSession()
        if (rawSession.isNullOrBlank()) {
            stopPublishing()
            return START_NOT_STICKY
        }
        session = parseSession(JSONObject(rawSession))
        lastPublishedAt = 0L
        lastTargetsRefreshAt = 0L
        lastLocation = null
        startLocationUpdates()
        mainHandler.removeCallbacks(refreshTargetsRunnable)
        mainHandler.post(refreshTargetsRunnable)
        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        mainHandler.removeCallbacks(refreshTargetsRunnable)
        locationManager.removeUpdates(this)
        session = null
        super.onDestroy()
    }

    override fun onLocationChanged(location: Location) {
        val activeSession = session ?: return
        val now = System.currentTimeMillis()
        val moved = lastLocation?.distanceTo(location)?.toDouble() ?: Double.POSITIVE_INFINITY
        if (moved < activeSession.minMoveMeters && now - lastPublishedAt < activeSession.minIntervalMs) {
            return
        }
        lastLocation = location
        lastPublishedAt = now
        val capturedAt = isoTimestamp(location.time)
        activeSession.grants.forEach { grant ->
            runCatching {
                val point = protectedPoint(location, grant.precision)
                val pointJson = JSONObject()
                    .put("latitude", point.first)
                    .put("longitude", point.second)
                    .put("accuracyM", point.third)
                    .put("capturedAt", capturedAt)
                    .put("sourcePlatform", "android")
                val envelope = LocationEnvelopeCrypto.encrypt(
                    pointJson.toString().toByteArray(Charsets.UTF_8),
                    grant.recipientPublicKeyJwk,
                    grant.recipientKeyId,
                    capturedAt
                )
                postEnvelope(activeSession, grant.id, envelope)
            }
        }
    }

    private fun startLocationUpdates() {
        val fine = ActivityCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val coarse = ActivityCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        if (!fine && !coarse) {
            stopPublishing()
            return
        }
        locationManager.removeUpdates(this)
        val activeSession = session ?: return
        val minTime = activeSession.minIntervalMs.coerceAtLeast(5_000L)
        val minDistance = activeSession.minMoveMeters.toFloat().coerceAtLeast(10f)
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter(locationManager::isProviderEnabled)
        if (providers.isEmpty()) {
            stopPublishing()
            return
        }
        providers.forEach { provider ->
            locationManager.requestLocationUpdates(provider, minTime, minDistance, this)
        }
    }

    private fun postEnvelope(activeSession: Session, grantId: String, envelope: JSONObject) {
        val base = activeSession.backendBaseUrl.trimEnd('/')
        val body = JSONObject().put("envelope", envelope).toString()
            .toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url("$base/api/one/location/grants/$grantId/envelopes")
            .header("Authorization", "Bearer ${activeSession.vaultOwnerToken}")
            .post(body)
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) = Unit

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    when (it.code) {
                        401 -> mainHandler.post { stopPublishing() }
                        403, 404, 410 -> mainHandler.post { removeGrant(grantId) }
                    }
                }
            }
        })
    }

    private fun refreshTargetsIfNeeded(activeSession: Session, now: Long) {
        if (now - lastTargetsRefreshAt < TARGET_REFRESH_INTERVAL_MS) return
        lastTargetsRefreshAt = now
        val base = activeSession.backendBaseUrl.trimEnd('/')
        val request = Request.Builder()
            .url("$base/api/one/location/publish-targets?limit=500")
            .header("Authorization", "Bearer ${activeSession.vaultOwnerToken}")
            .get()
            .build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, error: IOException) = Unit

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (it.code == 401) {
                        mainHandler.post { stopPublishing() }
                        return
                    }
                    if (!it.isSuccessful) return
                    val payload = it.body?.string()?.let(::JSONObject) ?: return
                    val refreshed = parseTargets(payload)
                    mainHandler.post {
                        val current = session ?: return@post
                        if (
                            current.vaultOwnerToken != activeSession.vaultOwnerToken ||
                            current.backendBaseUrl != activeSession.backendBaseUrl
                        ) return@post
                        session = current.copy(grants = refreshed)
                        if (refreshed.isEmpty()) stopPublishing()
                    }
                }
            }
        })
    }

    private fun removeGrant(grantId: String) {
        val current = session ?: return
        val remaining = current.grants.filterNot { it.id == grantId }
        if (remaining.size == current.grants.size) return
        session = current.copy(grants = remaining)
        if (remaining.isEmpty()) stopPublishing()
    }

    private fun parseTargets(payload: JSONObject): List<Grant> {
        val targets = payload.optJSONArray("targets") ?: return emptyList()
        return buildList {
            for (index in 0 until targets.length()) {
                val target = targets.optJSONObject(index) ?: continue
                val grant = target.optJSONObject("grant") ?: continue
                val recipient = target.optJSONObject("recipient") ?: continue
                val grantId = grant.optString("id")
                val keyId = recipient.optString("keyId")
                val jwk = recipient.optJSONObject("publicKeyJwk")
                if (grantId.isBlank() || keyId.isBlank() || jwk == null) continue
                add(
                    Grant(
                        id = grantId,
                        recipientKeyId = keyId,
                        recipientPublicKeyJwk = jwk,
                        precision = target.optString("precision", "precise")
                    )
                )
            }
        }
    }

    private fun parseSession(json: JSONObject): Session {
        val rawGrants = json.getJSONArray("grants")
        val grants = buildList {
            for (index in 0 until rawGrants.length()) {
                val grant = rawGrants.getJSONObject(index)
                add(
                    Grant(
                        id = grant.getString("grantId"),
                        recipientKeyId = grant.getString("recipientKeyId"),
                        recipientPublicKeyJwk = grant.getJSONObject("recipientPublicKeyJwk"),
                        precision = grant.optString("precision", "precise")
                    )
                )
            }
        }
        return Session(
            vaultOwnerToken = json.getString("vaultOwnerToken"),
            backendBaseUrl = json.getString("backendBaseUrl"),
            grants = grants,
            minMoveMeters = json.optDouble("minMoveMeters", 25.0),
            minIntervalMs = json.optLong("minIntervalMs", 8_000L)
        )
    }

    private fun protectedPoint(location: Location, precision: String): Triple<Double, Double, Double> {
        val accuracy = max(0.0, location.accuracy.toDouble())
        if (precision != "approximate") {
            return Triple(location.latitude, location.longitude, accuracy)
        }
        val gridMeters = 1_000.0
        val metersPerDegree = 111_320.0
        val latitudeStep = gridMeters / metersPerDegree
        val longitudeScale = max(0.2, cos(Math.toRadians(location.latitude)))
        val longitudeStep = gridMeters / (metersPerDegree * longitudeScale)
        return Triple(
            Math.round(location.latitude / latitudeStep) * latitudeStep,
            Math.round(location.longitude / longitudeStep) * longitudeStep,
            max(accuracy, gridMeters)
        )
    }

    private fun isoTimestamp(timestampMs: Long): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(Date(timestampMs))

    private fun stopPublishing() {
        mainHandler.removeCallbacks(refreshTargetsRunnable)
        locationManager.removeUpdates(this)
        session = null
        clearPendingSession()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Friends Map location",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Shown while One updates encrypted background location."
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    companion object {
        const val ACTION_START = "com.hushh.app.location.START_BACKGROUND_SHARE"
        const val ACTION_STOP = "com.hushh.app.location.STOP_BACKGROUND_SHARE"
        private const val CHANNEL_ID = "one_location_background"
        private const val NOTIFICATION_ID = 4107
        private const val TARGET_REFRESH_INTERVAL_MS = 5 * 60 * 1000L

        @Volatile
        private var pendingSession: String? = null

        fun prepareSession(rawSession: String) {
            pendingSession = rawSession
        }

        private fun takePendingSession(): String? = pendingSession.also { pendingSession = null }

        fun clearPendingSession() {
            pendingSession = null
        }
    }
}
