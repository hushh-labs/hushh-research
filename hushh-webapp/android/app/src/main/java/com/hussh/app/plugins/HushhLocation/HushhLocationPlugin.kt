package com.hussh.app.plugins.HushhLocation

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import okhttp3.HttpUrl.Companion.toHttpUrl
import com.hussh.app.plugins.shared.BackendUrl
import com.google.firebase.auth.FirebaseAuth
import java.lang.ref.WeakReference

/**
 * Foreground capture and explicitly consented native background publishing.
 *
 * Coordinates are returned only to the local web layer. The web layer encrypts
 * before calling the backend.
 */
@CapacitorPlugin(
    name = "HushhLocation",
    permissions = [
        Permission(
            alias = "location",
            strings = [
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
            ]
        ),
        Permission(alias = "backgroundNotifications", strings = [Manifest.permission.POST_NOTIFICATIONS])
    ]
)
class HushhLocationPlugin : Plugin() {

    // Active continuous-tracking watches keyed by the saved callback id returned
    // to JS. Each holds its LocationListener so clearWatch can detach it.
    private val activeWatches = HashMap<String, LocationListener>()
    private val backgroundPermissionRequests = mutableMapOf<String, Pair<Long, String>>()
    override fun load() {
        val plugin = WeakReference(this)
        BackgroundLocationService.onStopped = { plugin.get()?.notifyListeners("backgroundShareStopped", JSObject()) }
    }

    @PluginMethod
    fun getPermissionState(call: PluginCall) {
        call.resolve(permissionPayload())
    }

    @PluginMethod
    fun openLocationSettings(call: PluginCall) {
        try {
            val intent = Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve(
                JSObject()
                    .put("opened", true)
                    .put("sourcePlatform", "android")
            )
        } catch (error: Exception) {
            call.reject("Could not open location settings: ${error.message}")
        }
    }

    @PluginMethod
    fun openAppSettings(call: PluginCall) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            call.resolve(
                JSObject()
                    .put("opened", true)
                    .put("sourcePlatform", "android")
            )
        } catch (error: Exception) {
            call.reject("Could not open app settings: ${error.message}")
        }
    }

    @PluginMethod
    fun requestLocationPermission(call: PluginCall) {
        if (hasLocationPermission()) {
            call.resolve(permissionPayload())
            return
        }
        requestPermissionForAlias("location", call, "locationPermissionStateCallback")
    }

    @PluginMethod
    fun getCurrentPosition(call: PluginCall) {
        if (!hasLocationPermission()) {
            requestPermissionForAlias("location", call, "locationPermissionCallback")
            return
        }
        captureCurrentPosition(call)
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    fun watchPosition(call: PluginCall) {
        if (!hasLocationPermission()) {
            requestPermissionForAlias("location", call, "watchPermissionCallback")
            return
        }
        startWatch(call)
    }

    @PluginMethod
    fun clearWatch(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrEmpty()) {
            call.reject("A watch id is required to clear a location watch.")
            return
        }
        stopWatch(id)
        call.resolve()
    }

    @PluginMethod
    fun requestAlwaysAuthorization(call: PluginCall) {
        // Android 11+ requires the owner to select Always in system settings.
        // Foreground permission must be granted separately first.
        if (hasLocationPermission() && Build.VERSION.SDK_INT >= 29 &&
            !hasAndroidPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION)) {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:${context.packageName}"))
            activity.startActivity(intent)
        }
        call.resolve(permissionPayload())
    }

    @PluginMethod
    fun startBackgroundShare(call: PluginCall) {
        activity.runOnUiThread {
            val ownerUid = FirebaseAuth.getInstance().currentUser?.uid
            val existing = BackgroundLocationService.instance?.takeIf { it.canUpdateForOwner(ownerUid) }
            BackgroundLocationService.clearSession()
            fun unavailable(reason: String) { call.resolve(JSObject().put("started", false).put("reason", reason)) }
            if (!hasLocationPermission() || (Build.VERSION.SDK_INT >= 29 &&
                !hasAndroidPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION))) {
                unavailable("background_permission_required"); return@runOnUiThread
            }
            if (!activity.hasWindowFocus() && existing == null) { unavailable("foreground_required"); return@runOnUiThread }
            if (ownerUid == null) { unavailable("authentication_required"); return@runOnUiThread }
            if (Build.VERSION.SDK_INT >= 33 && !hasAndroidPermission(Manifest.permission.POST_NOTIFICATIONS)) {
                backgroundPermissionRequests[call.callbackId] = BackgroundLocationService.generation to ownerUid
                requestPermissionForAlias("backgroundNotifications", call, "backgroundNotificationCallback")
                return@runOnUiThread
            }
            val session = try {
                val base = requireNotNull(call.getString("backendBaseUrl")).toHttpUrl()
                require(base.isHttps && base.username.isEmpty() && base.password.isEmpty() && base.query == null && base.fragment == null)
                val configured = BackendUrl.resolve(bridge, null, "HushhLocation").toHttpUrl()
                require(base == configured)
                val token = requireNotNull(call.getString("vaultOwnerToken"))
                require(token.isNotBlank())
                val raw = requireNotNull(call.getArray("grants"))
                require(raw.length() in 1..100)
                val grants = (0 until raw.length()).map { index ->
                    val grant = raw.getJSONObject(index)
                    val expiry = if (grant.has("expiresAtMs")) {
                        val value = grant.get("expiresAtMs")
                        require(value is Number)
                        val ms = value.toDouble()
                        require(ms.isFinite() && ms > System.currentTimeMillis() && ms < Long.MAX_VALUE.toDouble())
                        ms.toLong()
                    } else null
                    val id = grant.getString("grantId")
                    val keyId = grant.getString("recipientKeyId")
                    require(id.isNotBlank() && keyId.isNotBlank())
                    BackgroundGrant(id, keyId, LocationEnvelopeCrypto.publicKey(grant.getJSONObject("recipientPublicKeyJwk")), expiry)
                }
                require(grants.map { it.id }.distinct().size == grants.size)
                val move = call.getDouble("minMoveMeters", 10.0) ?: 10.0
                val interval = call.getDouble("minIntervalMs", 15000.0) ?: 15000.0
                require(move.isFinite() && interval.isFinite())
                BackgroundSession(token, base, grants, move.coerceAtLeast(0.0), interval.coerceIn(1000.0, 3600000.0).toLong(), ownerUid)
            } catch (_: Exception) { unavailable("invalid_background_session"); return@runOnUiThread }
            BackgroundLocationService.pending = session
            BackgroundLocationService.acknowledge = { started ->
                call.resolve(JSObject().put("started", started).put("reason", if (started) null else "background_share_stopped"))
            }
            try {
                if (existing != null) existing.applyPendingSession()
                else ContextCompat.startForegroundService(context, Intent(context, BackgroundLocationService::class.java))
            }
            catch (_: Exception) { BackgroundLocationService.clearSession() }
        }
    }

    @PluginMethod
    fun stopBackgroundShare(call: PluginCall) {
        activity.runOnUiThread {
            BackgroundLocationService.clearSession()
            call.resolve()
        }
    }

    @PermissionCallback
    private fun backgroundNotificationCallback(call: PluginCall) {
        val attempt = backgroundPermissionRequests.remove(call.callbackId)
        if (attempt?.first != BackgroundLocationService.generation || attempt.second != FirebaseAuth.getInstance().currentUser?.uid) {
            call.resolve(JSObject().put("started", false).put("reason", "background_share_stopped"))
            return
        }
        if (Build.VERSION.SDK_INT >= 33 && !hasAndroidPermission(Manifest.permission.POST_NOTIFICATIONS)) {
            call.resolve(JSObject().put("started", false).put("reason", "notification_permission_required"))
            return
        }
        startBackgroundShare(call)
    }

    @PermissionCallback
    private fun locationPermissionStateCallback(call: PluginCall) {
        call.resolve(permissionPayload())
    }

    @PermissionCallback
    private fun locationPermissionCallback(call: PluginCall) {
        if (!hasLocationPermission()) {
            call.reject("Location permission was not granted.")
            return
        }
        captureCurrentPosition(call)
    }

    @PermissionCallback
    private fun watchPermissionCallback(call: PluginCall) {
        if (!hasLocationPermission()) {
            call.reject("Location permission was not granted.")
            return
        }
        startWatch(call)
    }

    private fun permissionPayload(): JSObject {
        val fineGranted = hasAndroidPermission(Manifest.permission.ACCESS_FINE_LOCATION)
        val coarseGranted = hasAndroidPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
        val permissionState = getPermissionState("location")
        val locationServicesEnabled = locationServicesEnabled()
        val state = when {
            (fineGranted || coarseGranted) && !locationServicesEnabled -> "unavailable"
            fineGranted || coarseGranted -> "granted"
            permissionState == PermissionState.DENIED -> "denied"
            else -> "prompt"
        }
        return JSObject()
            .put("state", state)
            .put("precise", fineGranted)
            .put("background", if (hasLocationPermission() && (Build.VERSION.SDK_INT < 29 ||
                hasAndroidPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION))) "available" else "foreground-only")
            .put("locationServicesEnabled", locationServicesEnabled)
    }

    private fun hasAndroidPermission(permission: String): Boolean {
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasLocationPermission(): Boolean {
        return hasAndroidPermission(Manifest.permission.ACCESS_FINE_LOCATION) ||
            hasAndroidPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
    }

    private fun locationServicesEnabled(): Boolean {
        val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        return listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .any { provider -> locationManager.isProviderEnabled(provider) }
    }

    @SuppressLint("MissingPermission")
    private fun captureCurrentPosition(call: PluginCall) {
        val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val enableHighAccuracy = call.getBoolean("enableHighAccuracy", true) ?: true
        val timeoutMs = (call.getInt("timeoutMs", 15_000) ?: 15_000)
            .coerceIn(3_000, 30_000)
        val providers = preferredProviders(locationManager, enableHighAccuracy)

        if (providers.isEmpty()) {
            call.reject("Location services are unavailable on this device.")
            return
        }

        val freshLocation = providers
            .mapNotNull { provider ->
                runCatching { locationManager.getLastKnownLocation(provider) }.getOrNull()
            }
            .maxByOrNull { location -> location.time }

        if (freshLocation != null && System.currentTimeMillis() - freshLocation.time <= 30_000) {
            call.resolve(locationPayload(freshLocation))
            return
        }

        val mainHandler = Handler(Looper.getMainLooper())
        var completed = false
        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                if (completed) return
                completed = true
                locationManager.removeUpdates(this)
                call.resolve(locationPayload(location))
            }

            @Deprecated("Deprecated in Android API, still invoked on older devices.")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

            override fun onProviderEnabled(provider: String) = Unit

            override fun onProviderDisabled(provider: String) = Unit
        }

        mainHandler.post {
            var requestedProvider = false
            var lastError: Exception? = null
            for (provider in providers) {
                try {
                    locationManager.requestSingleUpdate(
                        provider,
                        listener,
                        Looper.getMainLooper()
                    )
                    requestedProvider = true
                } catch (error: Exception) {
                    lastError = error
                }
            }
            if (!requestedProvider && !completed) {
                completed = true
                call.reject(
                    "Precise location unavailable: " +
                        (lastError?.message ?: "no permitted provider")
                )
            }
        }
        mainHandler.postDelayed({
            if (!completed) {
                completed = true
                locationManager.removeUpdates(listener)
                call.reject("Precise location unavailable before timeout.")
            }
        }, timeoutMs.toLong())
    }

    @SuppressLint("MissingPermission")
    private fun startWatch(call: PluginCall) {
        val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val enableHighAccuracy = call.getBoolean("enableHighAccuracy", true) ?: true
        val providers = preferredProviders(locationManager, enableHighAccuracy)

        if (providers.isEmpty()) {
            call.reject("Location services are unavailable on this device.")
            return
        }

        // Keep the call alive so the callback channel can fire on every fix. The
        // resolved point becomes the JS callback's first arg; a reject becomes
        // the second (error) arg, matching the web shim's (point, error) shape.
        call.setKeepAlive(true)
        bridge.saveCall(call)
        val watchId = call.callbackId

        val listener = object : LocationListener {
            override fun onLocationChanged(location: Location) {
                val saved = bridge.getSavedCall(watchId) ?: return
                saved.resolve(locationPayload(location))
            }

            @Deprecated("Deprecated in Android API, still invoked on older devices.")
            override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

            override fun onProviderEnabled(provider: String) = Unit

            override fun onProviderDisabled(provider: String) = Unit
        }

        activeWatches[watchId] = listener

        val mainHandler = Handler(Looper.getMainLooper())
        mainHandler.post {
            try {
                for (provider in providers) {
                    locationManager.requestLocationUpdates(
                        provider,
                        2_000L,
                        0f,
                        listener,
                        Looper.getMainLooper()
                    )
                }
            } catch (error: Exception) {
                stopWatch(watchId)
                val saved = bridge.getSavedCall(watchId)
                saved?.reject("Precise location unavailable: ${error.message}")
                bridge.releaseCall(watchId)
            }
        }
    }

    private fun stopWatch(id: String) {
        val listener = activeWatches.remove(id) ?: run {
            // Still release any saved call so we never leak a kept-alive call.
            bridge.releaseCall(id)
            return
        }
        val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        try {
            locationManager.removeUpdates(listener)
        } catch (_: Exception) {
            // Removing an already-detached listener is safe to ignore.
        }
        bridge.releaseCall(id)
    }

    private fun preferredProviders(
        locationManager: LocationManager,
        enableHighAccuracy: Boolean
    ): List<String> {
        val fineGranted = hasAndroidPermission(Manifest.permission.ACCESS_FINE_LOCATION)
        val candidates = if (!fineGranted) {
            // Android's approximate-only grant does not authorize GPS access on
            // every OS/device combination. Network is the truthful coarse lane.
            listOf(LocationManager.NETWORK_PROVIDER)
        } else if (enableHighAccuracy) {
            listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        } else {
            listOf(LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)
        }
        return candidates.filter { provider -> locationManager.isProviderEnabled(provider) }
    }

    private fun locationPayload(location: Location): JSObject {
        val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        formatter.timeZone = TimeZone.getTimeZone("UTC")
        return JSObject()
            .put("latitude", location.latitude)
            .put("longitude", location.longitude)
            .put("accuracyM", if (location.hasAccuracy()) location.accuracy.toDouble() else null)
            .put("capturedAt", formatter.format(Date(location.time)))
            .put("sourcePlatform", "android")
    }
}
