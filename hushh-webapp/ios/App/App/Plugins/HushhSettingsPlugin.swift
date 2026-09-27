import Capacitor

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
            "hapticFeedback": defaults.object(forKey: "hapticFeedback") as? Bool ?? defaultSettings["hapticFeedback"] as! Bool,
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
