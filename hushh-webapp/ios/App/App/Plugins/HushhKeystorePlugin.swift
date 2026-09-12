import Capacitor
import LocalAuthentication
import Security

/**
 * Retains the exact LAContext that owns a pending Keychain authentication.
 * The operation is deliberately held until the Security callback (or a small
 * bounded cancellation fallback) completes, so a fresh request cannot race a
 * Face ID sheet that is still dismissing.
 */
private final class NativeBiometricAuthenticationOperation {
    let requestId: String?
    let context: LAContext
    let call: CAPPluginCall
    var cancellationRequested = false
    var cancellationFallback: DispatchWorkItem?

    init(requestId: String?, context: LAContext, call: CAPPluginCall) {
        self.requestId = requestId
        self.context = context
        self.call = call
    }
}

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
        CAPPluginMethod(name: "deleteBiometric", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getBiometric", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelBiometricAuthentication", returnType: CAPPluginReturnPromise)
    ]
    
    private let TAG = "HushhKeystore"
    private let serviceName = "com.hushh.pda.keystore"
    private let biometricOperationLock = NSLock()
    private var activeBiometricOperation: NativeBiometricAuthenticationOperation?
    private let biometricCancellationSettleTimeout: TimeInterval = 2
    
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
            print("✅ [\(TAG)] Value saved")
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
            print("✅ [\(TAG)] Value deleted")
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
            print("✅ [\(TAG)] Biometric value saved")
            call.resolve()
        } else {
            call.reject("Failed to save biometric value: \(status)")
        }
    }

    // MARK: - Delete Biometric
    @objc func deleteBiometric(_ call: CAPPluginCall) {
        guard let key = call.getString("key") else {
            call.reject("Missing required parameter: key")
            return
        }

        // Biometric values are deliberately stored under a distinct account.
        // Calling the normal `delete` method must never be mistaken for
        // protected-value cleanup.
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: "bio_\(key)"
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status == errSecSuccess || status == errSecItemNotFound {
            call.resolve()
        } else {
            call.reject("Failed to delete biometric value")
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
        let requestId = call.getString("requestId")?.trimmingCharacters(in: .whitespacesAndNewlines)
        let operation = NativeBiometricAuthenticationOperation(
            requestId: requestId?.isEmpty == false ? requestId : nil,
            context: context,
            call: call
        )

        biometricOperationLock.lock()
        if activeBiometricOperation != nil {
            biometricOperationLock.unlock()
            call.reject("A biometric authentication is already in progress.", "BIOMETRIC_AUTH_IN_PROGRESS")
            return
        }
        activeBiometricOperation = operation
        biometricOperationLock.unlock()
        
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serviceName,
            kSecAttrAccount as String: "bio_\(key)",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecUseAuthenticationContext as String: context
        ]
        
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            
            DispatchQueue.main.async {
                self?.completeBiometricOperation(operation, status: status, item: item)
            }
        }
    }

    // MARK: - Cancel Biometric
    @objc func cancelBiometricAuthentication(_ call: CAPPluginCall) {
        let requestedId = call.getString("requestId")?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedRequestedId = requestedId?.isEmpty == false ? requestedId : nil

        biometricOperationLock.lock()
        guard let operation = activeBiometricOperation,
              !operation.cancellationRequested,
              normalizedRequestedId == nil || normalizedRequestedId == operation.requestId else {
            biometricOperationLock.unlock()
            call.resolve(["cancelled": false])
            return
        }
        operation.cancellationRequested = true
        biometricOperationLock.unlock()

        // This dismisses a currently visible Face ID/Touch ID sheet. Do not
        // clear the active operation here; SecItemCopyMatching still owns the
        // original callback and must settle before a fresh prompt may start.
        operation.context.invalidate()
        scheduleBiometricCancellationFallback(for: operation)
        call.resolve(["cancelled": true])
    }

    private func scheduleBiometricCancellationFallback(
        for operation: NativeBiometricAuthenticationOperation
    ) {
        let workItem = DispatchWorkItem { [weak self, weak operation] in
            guard let self, let operation else { return }
            self.completeBiometricOperation(operation, status: errSecUserCanceled, item: nil)
        }

        biometricOperationLock.lock()
        guard activeBiometricOperation === operation,
              operation.cancellationRequested,
              operation.cancellationFallback == nil else {
            biometricOperationLock.unlock()
            return
        }
        operation.cancellationFallback = workItem
        biometricOperationLock.unlock()

        DispatchQueue.main.asyncAfter(
            deadline: .now() + biometricCancellationSettleTimeout,
            execute: workItem
        )
    }

    private func completeBiometricOperation(
        _ operation: NativeBiometricAuthenticationOperation,
        status: OSStatus,
        item: CFTypeRef?
    ) {
        biometricOperationLock.lock()
        guard activeBiometricOperation === operation else {
            biometricOperationLock.unlock()
            return
        }
        activeBiometricOperation = nil
        let cancellationRequested = operation.cancellationRequested
        let fallback = operation.cancellationFallback
        operation.cancellationFallback = nil
        biometricOperationLock.unlock()
        fallback?.cancel()

        if cancellationRequested || status == errSecUserCanceled {
            operation.call.reject("Biometric authentication cancelled", "USER_CANCELLED")
        } else if status == errSecSuccess,
                  let data = item as? Data,
                  let value = String(data: data, encoding: .utf8) {
            operation.call.resolve(["value": value])
        } else {
            operation.call.resolve(["value": NSNull()])
        }
    }
}
