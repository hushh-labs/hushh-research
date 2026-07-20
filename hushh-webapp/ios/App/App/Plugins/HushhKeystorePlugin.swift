import Capacitor
import LocalAuthentication
import Security

/**
 * HushhKeystorePlugin - Secure Storage (Capacitor 8)
 * Port of Android HushhKeystorePlugin.kt
 * 
 * Note: Plugin jsName is "HushhKeychain" for iOS compatibility with TypeScript
 */
@objc(HushhKeystorePlugin)
public class HushhKeystorePlugin: CAPPlugin, CAPBridgedPlugin {
    
    // MARK: - CAPBridgedPlugin Protocol
    public let identifier = "HushhKeystorePlugin"
    public let jsName = "HushhKeychain"  // Match Android's @CapacitorPlugin name
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isBiometricAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBiometric", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBiometric", returnType: CAPPluginReturnPromise)
    ]
    
    private let TAG = "HushhKeystore"
    private let serviceName = "com.hushh.pda.keystore"
    
    // MARK: - Set
    @objc func set(_ call: CAPPluginCall) {
        guard let key = call.getString("key"),
              let value = call.getString("value") else {
            call.reject("Missing required parameters: key, value")
            return
        }
        
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key,
            kSecValueData as String: value.data(using: .utf8)!
        ]
        
        // Delete existing first
        SecItemDelete(query as CFDictionary)
        
        let status = SecItemAdd(query as CFDictionary, nil)
        
        if status == errSecSuccess {
            print("✅ [\(TAG)] Value saved for key: \(key)")
            call.resolve()
        } else {
            print("❌ [\(TAG)] Failed to save: \(status)")
            call.reject("Failed to save to secure storage")
        }
    }
    
    // MARK: - Get
    @objc func get(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing required parameter: key")
            return
        }
        
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        
        if status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) {
            call.resolve(["value": value])
        } else {
            call.resolve(["value": NSNull()])
        }
    }
    
    // MARK: - Delete
    @objc func delete(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing required parameter: key")
            return
        }
        
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: key
        ]
        
        let status = SecItemDelete(query as CFDictionary)
        
        if status == errSecSuccess || status == errSecItemNotFound {
            print("✅ [\(TAG)] Value deleted for key: \(key)")
            call.resolve()
        } else {
            call.reject("Failed to delete from secure storage")
        }
    }
    
    // MARK: - Is Biometric Available
    @objc func isBiometricAvailable(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?
        
        let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        
        var type = "none"
        if available {
            switch context.biometryType {
            case .faceID:
                type = "faceId"
            case .touchID:
                type = "touchId"
            case .opticID:
                type = "opticId"
            default:
                type = "biometric"
            }
        }
        
        call.resolve([
            "available": available,
            "type": type
        ])
    }
    
    // MARK: - Set Biometric
    @objc func setBiometric(_ call: CAPPluginCall) {
        guard let key = call.getString("key"),
              let value = call.getString("value") else {
            call.reject("Missing required parameters: key, value")
            return
        }
        
        // Store with biometric protection. Replacement must first delete by
        // stable item identity only: including the old value or access-control
        // attributes makes SecItemDelete fail to match a prior enrollment.
        let itemIdentity: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: "bio_\(key)"
        ]
        SecItemDelete(itemIdentity as CFDictionary)

        guard let accessControl = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .biometryCurrentSet,
            nil
        ) else {
            call.reject("Biometric protection is unavailable on this device")
            return
        }
        
        var query = itemIdentity
        query[kSecValueData as String] = value.data(using: .utf8)!
        query[kSecAttrAccessControl as String] = accessControl
        
        let status = SecItemAdd(query as CFDictionary, nil)
        
        if status == errSecSuccess {
            print("✅ [\(TAG)] Biometric value saved for key: \(key)")
            call.resolve()
        } else {
            call.reject("Failed to save biometric value: \(status)")
        }
    }
    
    // MARK: - Get Biometric
    @objc func getBiometric(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing required parameter: key")
            return
        }
        
        let promptMessage = call.getString("promptMessage") ?? "Authenticate to access"
        
        let context = LAContext()
        context.localizedReason = promptMessage
        
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: "bio_\(key)",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationContext as String: context
        ]
        
        DispatchQueue.global(qos: .userInitiated).async {
            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            
            DispatchQueue.main.async {
                if status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) {
                    call.resolve(["value": value])
                } else if status == errSecUserCanceled {
                    call.reject("Biometric authentication cancelled", "USER_CANCELLED")
                } else {
                    call.resolve(["value": NSNull()])
                }
            }
        }
    }
}
