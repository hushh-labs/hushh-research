import Capacitor
import UIKit
import CoreFoundation

/// Bounded, best-effort feedback admission. It never queues or retries a cue.
struct HushhAppHapticFeedbackState {
    private var consumed = [String]()
    mutating func consume(_ id: String, issuedAt: Double, now: Double) -> Bool {
        guard !id.isEmpty, id.count <= 128, issuedAt.isFinite, now.isFinite,
              now - issuedAt >= -50, now - issuedAt <= 250,
              !consumed.contains(id) else { return false }
        consumed.append(id)
        if consumed.count > 256 { consumed.removeFirst() }
        return true
    }
}

/// One existing device preference; no account information or second store.
enum HushhAppHaptics {
    static func enabled(in defaults: UserDefaults = .standard) -> Bool {
        if !defaults.bool(forKey: "hapticFeedbackMigrated.v1") {
            let native = strictBool(defaults.object(forKey: "hapticFeedback"))
            let legacy = defaults.string(forKey: "CapacitorStorage.hushh_settings")
                .flatMap { $0.data(using: .utf8) }
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
                .flatMap { strictBool($0["hapticFeedback"]) }
            defaults.set(native != false && legacy != false, forKey: "hapticFeedback")
            defaults.set(true, forKey: "hapticFeedbackMigrated.v1")
        }
        return strictBool(defaults.object(forKey: "hapticFeedback")) ?? true
    }
    private static func strictBool(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return nil }
        return number.boolValue
    }
    static func play(_ kind: String) {
        guard enabled() else { return }
        if kind == "selection" { UISelectionFeedbackGenerator().selectionChanged() }
        else if kind == "light" { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    }
}

/**
 * HushhSettingsPlugin - App Settings Management (Capacitor 8)
 * Port of Android HushhSettingsPlugin.kt
 */
@objc(HushhSettingsPlugin)
public class HushhSettingsPlugin: CAPPlugin, CAPBridgedPlugin {
    
    // MARK: - CAPBridgedPlugin Protocol
    public let identifier = "HushhSettingsPlugin"
    public let jsName = "HushhSettings"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shouldUseLocalAgents", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shouldSyncToCloud", returnType: CAPPluginReturnPromise)
    ]
    
    private let TAG = "HushhSettings"
    private let defaults = UserDefaults.standard
    
    // Default settings (regulated cutover defaults to local-only sync)
    private let defaultSettings: [String: Any] = [
        "useRemoteSync": false,
        "syncOnWifiOnly": false,
        "useRemoteLLM": true,
        "preferredLLMProvider": "google",
        "requireBiometricUnlock": false,
        "theme": "system",
        "hapticFeedback": true,
        "showDebugInfo": false,
        "verboseLogging": false
    ]
    
    // MARK: - Get Settings
    @objc func getSettings(_ call: CAPPluginCall) {
        call.resolve([
            "useRemoteSync": defaults.object(forKey: "useRemoteSync") as? Bool ?? defaultSettings["useRemoteSync"] as! Bool,
            "syncOnWifiOnly": defaults.object(forKey: "syncOnWifiOnly") as? Bool ?? defaultSettings["syncOnWifiOnly"] as! Bool,
            "useRemoteLLM": defaults.object(forKey: "useRemoteLLM") as? Bool ?? defaultSettings["useRemoteLLM"] as! Bool,
            "preferredLLMProvider": defaults.string(forKey: "preferredLLMProvider") ?? defaultSettings["preferredLLMProvider"] as! String,
            "requireBiometricUnlock": defaults.object(forKey: "requireBiometricUnlock") as? Bool ?? defaultSettings["requireBiometricUnlock"] as! Bool,
            "theme": defaults.string(forKey: "theme") ?? defaultSettings["theme"] as! String,
            "hapticFeedback": HushhAppHaptics.enabled(in: defaults),
            "showDebugInfo": defaults.object(forKey: "showDebugInfo") as? Bool ?? defaultSettings["showDebugInfo"] as! Bool,
            "verboseLogging": defaults.object(forKey: "verboseLogging") as? Bool ?? defaultSettings["verboseLogging"] as! Bool
        ])
    }
    
    // MARK: - Update Settings
    @objc func updateSettings(_ call: CAPPluginCall) {
        if let value = call.getBool("useRemoteSync") {
            defaults.set(value, forKey: "useRemoteSync")
        }
        if let value = call.getBool("syncOnWifiOnly") {
            defaults.set(value, forKey: "syncOnWifiOnly")
        }
        if let value = call.getBool("useRemoteLLM") {
            defaults.set(value, forKey: "useRemoteLLM")
        }
        if let value = call.getString("preferredLLMProvider") {
            defaults.set(value, forKey: "preferredLLMProvider")
        }
        if let value = call.getBool("requireBiometricUnlock") {
            defaults.set(value, forKey: "requireBiometricUnlock")
        }
        if let value = call.getString("theme") {
            defaults.set(value, forKey: "theme")
        }
        if let value = call.getBool("hapticFeedback") {
            _ = HushhAppHaptics.enabled(in: defaults)
            defaults.set(value, forKey: "hapticFeedback")
        }
        if let value = call.getBool("showDebugInfo") {
            defaults.set(value, forKey: "showDebugInfo")
        }
        if let value = call.getBool("verboseLogging") {
            defaults.set(value, forKey: "verboseLogging")
        }
        
        print("✅ [\(TAG)] Settings updated")
        call.resolve(["success": true])
    }
    
    // MARK: - Reset Settings
    @objc func resetSettings(_ call: CAPPluginCall) {
        for key in defaultSettings.keys {
            defaults.removeObject(forKey: key)
        }
        print("✅ [\(TAG)] Settings reset to defaults")
        call.resolve(["success": true])
    }
    
    // MARK: - Convenience Methods
    @objc func shouldUseLocalAgents(_ call: CAPPluginCall) {
        let useRemoteLLM = defaults.object(forKey: "useRemoteLLM") as? Bool ?? true
        call.resolve(["value": !useRemoteLLM])
    }
    
    @objc func shouldSyncToCloud(_ call: CAPPluginCall) {
        let useRemoteSync = defaults.object(forKey: "useRemoteSync") as? Bool ?? false
        call.resolve(["value": useRemoteSync])
    }
}
