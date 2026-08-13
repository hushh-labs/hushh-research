import Foundation
import Capacitor
import CoreLocation
import UIKit

/**
 * HushhLocationPlugin - foreground-only one-shot location capture.
 *
 * One Location Agent v1 does not request background location. Coordinates are
 * returned only to the local web layer so it can encrypt before persistence.
 */
@objc(HushhLocationPlugin)
public class HushhLocationPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {

    public let identifier = "HushhLocationPlugin"
    public let jsName = "HushhLocation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPermissionState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestLocationPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openLocationSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentPosition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "watchPosition", returnType: CAPPluginReturnCallback),
        CAPPluginMethod(name: "clearWatch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAlwaysAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startBackgroundShare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopBackgroundShare", returnType: CAPPluginReturnPromise)
    ]

    private let manager = CLLocationManager()
    private var pendingPermissionCall: CAPPluginCall?
    private var pendingLocationCall: CAPPluginCall?
    private var pendingLocationTimeout: DispatchWorkItem?
    // Active continuous-tracking watches keyed by the id returned to JS. The
    // CLLocationManager is shared, so a single startUpdatingLocation stream
    // fans out to every saved callback call below. Foreground-only.
    private var watchCalls: [String: CAPPluginCall] = [:]
    private var pendingWatchStartCall: CAPPluginCall?
    private let backgroundPublisher = BackgroundLocationPublisher()

    public override func load() {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.allowsBackgroundLocationUpdates = true
        manager.pausesLocationUpdatesAutomatically = false
    }

    @objc func getPermissionState(_ call: CAPPluginCall) {
        call.resolve(permissionPayload())
    }

    @objc func requestLocationPermission(_ call: CAPPluginCall) {
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse, .denied, .restricted:
            call.resolve(permissionPayload())
        case .notDetermined:
            pendingPermissionCall = call
            DispatchQueue.main.async {
                self.manager.requestWhenInUseAuthorization()
            }
        @unknown default:
            call.resolve(permissionPayload())
        }
    }

    @objc func requestAlwaysAuthorization(_ call: CAPPluginCall) {
        switch manager.authorizationStatus {
        case .authorizedAlways, .denied, .restricted:
            call.resolve(permissionPayload())
        case .authorizedWhenInUse, .notDetermined:
            // iOS shows the "Always Allow" upgrade prompt only from a
            // WhenInUse-or-notDetermined state. Resolve with the current payload
            // once auth settles; JS re-reads state via getPermissionState.
            pendingPermissionCall = call
            DispatchQueue.main.async { self.manager.requestAlwaysAuthorization() }
        @unknown default:
            call.resolve(permissionPayload())
        }
    }

    @objc func openAppSettings(_ call: CAPPluginCall) {
        openAppSettingsPage(call)
    }

    @objc func openLocationSettings(_ call: CAPPluginCall) {
        openAppSettingsPage(call)
    }

    private func openAppSettingsPage(_ call: CAPPluginCall) {
        guard let settingsUrl = URL(string: UIApplication.openSettingsURLString) else {
            call.reject("Location settings are unavailable on this device.")
            return
        }

        DispatchQueue.main.async {
            UIApplication.shared.open(settingsUrl, options: [:]) { opened in
                call.resolve([
                    "opened": opened,
                    "sourcePlatform": "ios"
                ])
            }
        }
    }

    @objc func getCurrentPosition(_ call: CAPPluginCall) {
        guard CLLocationManager.locationServicesEnabled() else {
            call.reject("Location services are unavailable on this device.")
            return
        }

        manager.desiredAccuracy = (call.getBool("enableHighAccuracy") ?? true)
            ? kCLLocationAccuracyBest
            : kCLLocationAccuracyHundredMeters

        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            requestOneShotLocation(call)
        case .notDetermined:
            if
                let existing = pendingLocationCall,
                existing.callbackId != call.callbackId
            {
                clearPendingLocationCall()?.reject(
                    "A newer location request replaced this request."
                )
            }
            pendingLocationCall = call
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            call.reject("Location permission was not granted.")
        @unknown default:
            call.reject("Location permission state is unavailable.")
        }
    }

    /// How old a cached fix may be before we insist on a fresh one. Matches the
    /// Android plugin's `getLastKnownLocation` window and the web plugin's
    /// last-resort reader exactly, and stays well under the 60s the backend
    /// allows between capture and confirmation — so a fix accepted here still
    /// passes the server's freshness check and still says where the user is.
    private static let cachedFixMaxAgeSeconds: TimeInterval = 30

    private func requestOneShotLocation(_ call: CAPPluginCall) {
        if
            let existing = pendingLocationCall,
            existing.callbackId != call.callbackId
        {
            clearPendingLocationCall()?.reject(
                "A newer location request replaced this request."
            )
        }

        // iOS was the only platform that always waited for a NEW fix. Android
        // and web both resolve from a recent cached one first, and CoreLocation
        // is already holding a good position whenever a watch is running or the
        // app was recently foregrounded -- so `requestLocation()` spent one to
        // three seconds rediscovering a coordinate we had the whole time.
        if
            let cached = manager.location,
            cached.horizontalAccuracy >= 0,
            abs(cached.timestamp.timeIntervalSinceNow) <= Self.cachedFixMaxAgeSeconds
        {
            pendingLocationTimeout?.cancel()
            pendingLocationTimeout = nil
            pendingLocationCall = nil
            call.resolve(locationPayload(cached))
            return
        }

        pendingLocationTimeout?.cancel()
        pendingLocationCall = call
        let timeoutMs = max(3_000, min(call.getInt("timeoutMs") ?? 15_000, 30_000))
        let callbackId = call.callbackId
        let timeout = DispatchWorkItem { [weak self] in
            guard
                let self,
                let pending = self.pendingLocationCall,
                pending.callbackId == callbackId
            else { return }
            self.pendingLocationCall = nil
            self.pendingLocationTimeout = nil
            pending.reject("Precise location unavailable before timeout.")
        }
        pendingLocationTimeout = timeout
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(timeoutMs),
            execute: timeout
        )
        manager.requestLocation()
    }

    /// The single shape a CLLocation is handed to JS in. Shared by the cached
    /// fast path, the one-shot delegate callback, and every active watch, so
    /// they can never drift apart.
    private func locationPayload(_ location: CLLocation) -> [String: Any] {
        [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracyM": location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : NSNull(),
            "capturedAt": ISO8601DateFormatter().string(from: location.timestamp),
            "sourcePlatform": "ios"
        ]
    }

    private func clearPendingLocationCall() -> CAPPluginCall? {
        pendingLocationTimeout?.cancel()
        pendingLocationTimeout = nil
        let call = pendingLocationCall
        pendingLocationCall = nil
        return call
    }

    @objc func watchPosition(_ call: CAPPluginCall) {
        guard CLLocationManager.locationServicesEnabled() else {
            call.reject("Location services are unavailable on this device.")
            return
        }

        manager.desiredAccuracy = (call.getBool("enableHighAccuracy") ?? true)
            ? kCLLocationAccuracyBest
            : kCLLocationAccuracyHundredMeters

        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            startWatch(call)
        case .notDetermined:
            pendingWatchStartCall = call
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            call.reject("Location permission was not granted.")
        @unknown default:
            call.reject("Location permission state is unavailable.")
        }
    }

    @objc func clearWatch(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A watch id is required to clear a location watch.")
            return
        }
        if let watchCall = watchCalls.removeValue(forKey: id) {
            bridge?.releaseCall(watchCall)
        }
        if watchCalls.isEmpty {
            DispatchQueue.main.async { self.manager.stopUpdatingLocation() }
        }
        call.resolve()
    }

    @objc func startBackgroundShare(_ call: CAPPluginCall) {
        guard manager.authorizationStatus == .authorizedAlways else {
            call.resolve(["started": false, "reason": "always-permission-required"])
            return
        }
        guard
            let token = call.getString("vaultOwnerToken"),
            let base = call.getString("backendBaseUrl"),
            let rawGrants = call.getArray("grants") as? [[String: Any]]
        else {
            call.resolve(["started": false, "reason": "invalid-session"])
            return
        }
        let grants: [BackgroundShareGrantNative] = rawGrants.compactMap { g in
            guard
                let grantId = g["grantId"] as? String,
                let keyId = g["recipientKeyId"] as? String,
                let jwk = g["recipientPublicKeyJwk"] as? [String: Any]
            else { return nil }
            return BackgroundShareGrantNative(grantId: grantId, recipientKeyId: keyId, recipientPublicKeyJwk: jwk)
        }
        guard !grants.isEmpty else {
            call.resolve(["started": false, "reason": "no-grants"])
            return
        }
        let session = BackgroundShareSessionNative(
            vaultOwnerToken: token,
            backendBaseUrl: base,
            grants: grants,
            minMoveMeters: call.getDouble("minMoveMeters") ?? 25,
            minIntervalMs: call.getDouble("minIntervalMs") ?? 8000
        )
        backgroundPublisher.start(session: session)
        DispatchQueue.main.async { self.manager.startUpdatingLocation() }
        call.resolve(["started": true])
    }

    @objc func stopBackgroundShare(_ call: CAPPluginCall) {
        backgroundPublisher.stop()
        if watchCalls.isEmpty {
            DispatchQueue.main.async { self.manager.stopUpdatingLocation() }
        }
        call.resolve()
    }

    private func startWatch(_ call: CAPPluginCall) {
        // Keep the call alive so the callback channel can fire on every fix. The
        // resolved point becomes the JS callback's first arg; a reject becomes
        // the second (error) arg, matching the web shim's (point, error) shape.
        call.keepAlive = true
        bridge?.saveCall(call)
        watchCalls[call.callbackId] = call
        DispatchQueue.main.async { self.manager.startUpdatingLocation() }
    }

    private func notifyWatchesSuccess(_ point: [String: Any]) {
        for watchCall in watchCalls.values {
            watchCall.resolve(point)
        }
    }

    private func failWatches(_ message: String) {
        guard !watchCalls.isEmpty else { return }
        // A fatal location error ends every active watch; JS receives it as the
        // callback's error arg and can decide whether to restart tracking.
        for (id, watchCall) in watchCalls {
            watchCall.reject(message)
            bridge?.releaseCall(watchCall)
            watchCalls.removeValue(forKey: id)
        }
        DispatchQueue.main.async { self.manager.stopUpdatingLocation() }
    }

    private func permissionPayload() -> [String: Any] {
        let locationServicesEnabled = CLLocationManager.locationServicesEnabled()
        let state: String
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            state = locationServicesEnabled ? "granted" : "unavailable"
        case .notDetermined:
            state = "prompt"
        case .denied:
            state = "denied"
        case .restricted:
            state = "restricted"
        @unknown default:
            state = "unavailable"
        }

        let precise: Bool?
        if #available(iOS 14.0, *) {
            precise = manager.accuracyAuthorization == .fullAccuracy
        } else {
            precise = true
        }

        return [
            "state": state,
            "precise": precise as Any,
            "background": backgroundStatus(),
            "locationServicesEnabled": locationServicesEnabled
        ]
    }

    private func backgroundStatus() -> String {
        switch manager.authorizationStatus {
        case .authorizedAlways:
            return "available"
        case .authorizedWhenInUse:
            return "foreground-only"
        case .restricted:
            return "restricted"
        default:
            return "unavailable"
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        if let permissionCall = pendingPermissionCall {
            pendingPermissionCall = nil
            permissionCall.resolve(permissionPayload())
            return
        }

        if let watchStartCall = pendingWatchStartCall {
            switch manager.authorizationStatus {
            case .authorizedAlways, .authorizedWhenInUse:
                pendingWatchStartCall = nil
                startWatch(watchStartCall)
                return
            case .denied, .restricted:
                pendingWatchStartCall = nil
                watchStartCall.reject("Location permission was not granted.")
                return
            case .notDetermined:
                return
            @unknown default:
                pendingWatchStartCall = nil
                watchStartCall.reject("Location permission state is unavailable.")
                return
            }
        }

        guard let call = pendingLocationCall else { return }

        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            requestOneShotLocation(call)
        case .denied, .restricted:
            clearPendingLocationCall()?.reject(
                "Location permission was not granted."
            )
        case .notDetermined:
            break
        @unknown default:
            clearPendingLocationCall()?.reject(
                "Location permission state is unavailable."
            )
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else {
            if pendingLocationCall != nil {
                clearPendingLocationCall()?.reject(
                    "Precise location unavailable."
                )
            }
            return
        }

        let payload = locationPayload(location)

        // One-shot getCurrentPosition resolves and clears its single call.
        if let call = clearPendingLocationCall() {
            call.resolve(payload)
        }

        // Continuous watches keep firing on every subsequent fix.
        notifyWatchesSuccess(payload)

        // Background publisher (if active) encrypts + POSTs each fix natively.
        if backgroundPublisher.isActive {
            backgroundPublisher.handle(location: location)
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        let message = "Precise location unavailable: \(error.localizedDescription)"
        if let call = clearPendingLocationCall() {
            call.reject(message)
        }
        failWatches(message)
    }
}
