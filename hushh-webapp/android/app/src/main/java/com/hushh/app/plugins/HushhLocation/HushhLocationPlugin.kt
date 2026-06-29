package com.hushh.app.plugins.HushhLocation

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

/**
 * Foreground-only location capture for One Location Agent.
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
        )
    ]
)
class HushhLocationPlugin : Plugin() {

    // Active continuous-tracking watches keyed by the saved callback id returned
    // to JS. Each holds its LocationListener so clearWatch can detach it.
    private val activeWatches = HashMap<String, LocationListener>()

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
        if (getPermissionState("location") == PermissionState.GRANTED) {
            call.resolve(permissionPayload())
            return
        }
        requestPermissionForAlias("location", call, "locationPermissionStateCallback")
    }

    @PluginMethod
    fun getCurrentPosition(call: PluginCall) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            requestPermissionForAlias("location", call, "locationPermissionCallback")
            return
        }
        captureCurrentPosition(call)
    }

    @PluginMethod(returnType = PluginMethod.RETURN_CALLBACK)
    fun watchPosition(call: PluginCall) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
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

    @PermissionCallback
    private fun locationPermissionStateCallback(call: PluginCall) {
        call.resolve(permissionPayload())
    }

    @PermissionCallback
    private fun locationPermissionStateCallback(call: PluginCall) {
        call.resolve(permissionPayload())
    }

    @PermissionCallback
    private fun locationPermissionCallback(call: PluginCall) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
            call.reject("Location permission was not granted.")
            return
        }
        captureCurrentPosition(call)
    }

    @PermissionCallback
    private fun watchPermissionCallback(call: PluginCall) {
        if (getPermissionState("location") != PermissionState.GRANTED) {
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
            .put("background", "foreground-only")
            .put("locationServicesEnabled", locationServicesEnabled)
    }

    private fun hasAndroidPermission(permission: String): Boolean {
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
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
        val timeoutMs = call.getInt("timeoutMs", 15_000) ?: 15_000
        val providers = preferredProviders(locationManager, enableHighAccuracy)

        if (providers.isEmpty()) {
            call.reject("Location services are unavailable on this device.")
            return
        }

        val freshLocation = providers
            .mapNotNull { provider -> locationManager.getLastKnownLocation(provider) }
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

        val provider = providers.first()
        mainHandler.post {
            try {
                locationManager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
            } catch (error: Exception) {
                if (!completed) {
                    completed = true
                    call.reject("Precise location unavailable: ${error.message}")
                }
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
        val candidates = if (enableHighAccuracy) {
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
