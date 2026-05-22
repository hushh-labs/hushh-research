import Foundation
import Capacitor
import CoreLocation

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
        CAPPluginMethod(name: "getCurrentPosition", returnType: CAPPluginReturnPromise)
    ]

    private let manager = CLLocationManager()
    private var pendingLocationCall: CAPPluginCall?

    public override func load() {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBest
    }

    @objc func getPermissionState(_ call: CAPPluginCall) {
        call.resolve(permissionPayload())
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
            pendingLocationCall = call
            manager.requestWhenInUseAuthorization()
        case .denied, .restricted:
            call.reject("Location permission was not granted.")
        @unknown default:
            call.reject("Location permission state is unavailable.")
        }
    }

    private func requestOneShotLocation(_ call: CAPPluginCall) {
        pendingLocationCall = call
        manager.requestLocation()
    }

    private func permissionPayload() -> [String: Any] {
        let state: String
        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            state = "granted"
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
            "background": "foreground-only"
        ]
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard let call = pendingLocationCall else { return }

        switch manager.authorizationStatus {
        case .authorizedAlways, .authorizedWhenInUse:
            requestOneShotLocation(call)
        case .denied, .restricted:
            pendingLocationCall = nil
            call.reject("Location permission was not granted.")
        case .notDetermined:
            break
        @unknown default:
            pendingLocationCall = nil
            call.reject("Location permission state is unavailable.")
        }
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let call = pendingLocationCall else { return }
        pendingLocationCall = nil

        guard let location = locations.last else {
            call.reject("Precise location unavailable.")
            return
        }

        call.resolve([
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracyM": location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : NSNull(),
            "capturedAt": ISO8601DateFormatter().string(from: location.timestamp),
            "sourcePlatform": "ios"
        ])
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard let call = pendingLocationCall else { return }
        pendingLocationCall = nil
        call.reject("Precise location unavailable: \(error.localizedDescription)")
    }
}
