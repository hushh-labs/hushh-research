import UIKit
import Capacitor
import CryptoKit
import CommonCrypto
import AuthenticationServices

/**
 * HushhVaultPlugin - Native iOS Vault Operations (Capacitor 8)
 *
 * Uses CAPBridgedPlugin protocol with pluginMethods array.
 */
@objc(HushhVaultPlugin)
public class HushhVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    
    // MARK: - CAPBridgedPlugin Protocol
    public let identifier = "HushhVaultPlugin"
    public let jsName = "HushhVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "deriveKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "encryptData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "decryptData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "hasVault", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getVault", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setupVault", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "upsertVaultWrapper", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPrimaryVaultMethod", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isPasskeyAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "registerPasskeyPrf", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "authenticatePasskeyPrf", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getFoodPreferences", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getProfessionalData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storePreferencesToCloud", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storePreference", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPreferences", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deletePreferences", returnType: CAPPluginReturnPromise),
        // Consent methods called by ApiService
        CAPPluginMethod(name: "getPendingConsents", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getActiveConsents", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getConsentHistory", returnType: CAPPluginReturnPromise),
        // Vault status (domain counts) - parity with web proxy /api/vault/status
        CAPPluginMethod(name: "getVaultStatus", returnType: CAPPluginReturnPromise)
    ]
    
    private let TAG = "HushhVault"
    private let defaultClientVersion = "2.0.0"
    private var clientVersionHeaderValue: String {
        if let configuredVersion = Bundle.main.object(forInfoDictionaryKey: "HushhClientVersion") as? String {
            let trimmedVersion = configuredVersion.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmedVersion.isEmpty {
                return trimmedVersion
            }
        }
        return defaultClientVersion
    }

    private func resolvedBackendUrl(_ call: CAPPluginCall) -> String {
        return HushhProxyClient.resolveBackendUrl(
            call: call,
            plugin: self,
            jsName: jsName
        )
    }
    
    // URLSession with 30s timeout (matching Android)
    private lazy var urlSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 30
        return URLSession(configuration: config)
    }()

    // Keep active passkey authorization flows alive until delegate completion.
    private var activePasskeyFlows: [String: NSObject] = [:]
    
    // MARK: - Key Derivation (PBKDF2)
    @objc func deriveKey(_ call: CAPPluginCall) {
        let password = call.getString("passphrase") ?? call.getString("password")
        let salt = call.getString("salt")
        if password == nil {
            call.reject("Missing passphrase")
            return
        }
        
        let iterations = call.getInt("iterations") ?? 100000
        let keyLength = call.getInt("keyLength") ?? 32
        
        DispatchQueue.global(qos: .userInitiated).async {
            let saltValue: String
            if let salt = salt, !salt.isEmpty {
                saltValue = salt
            } else {
                var randomBytes = [UInt8](repeating: 0, count: 32)
                _ = SecRandomCopyBytes(kSecRandomDefault, randomBytes.count, &randomBytes)
                saltValue = randomBytes.map { String(format: "%02x", $0) }.joined()
            }

            guard let saltData = saltValue.data(using: .utf8),
                  let passwordData = password?.data(using: .utf8) else {
                call.reject("Invalid input encoding")
                return
            }
            
            var derivedKey = [UInt8](repeating: 0, count: keyLength)
            let status = passwordData.withUnsafeBytes { passwordBytes in
                saltData.withUnsafeBytes { saltBytes in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        passwordBytes.baseAddress?.assumingMemoryBound(to: Int8.self),
                        passwordData.count,
                        saltBytes.baseAddress?.assumingMemoryBound(to: UInt8.self),
                        saltData.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        UInt32(iterations),
                        &derivedKey,
                        keyLength
                    )
                }
            }
            
            if status == kCCSuccess {
                let hexKey = derivedKey.map { String(format: "%02x", $0) }.joined()
                call.resolve([
                    "keyHex": hexKey,
                    "key": hexKey,
                    "salt": saltValue
                ])
            } else {
                call.reject("Key derivation failed")
            }
        }
    }
    
    // MARK: - Encrypt (AES-GCM)
    @objc func encryptData(_ call: CAPPluginCall) {
        // Accept both "keyHex" (Android/JS) and "key" (legacy) for compatibility
        guard let plaintext = call.getString("plaintext"),
              let keyHex = call.getString("keyHex") ?? call.getString("key") else {
            print("❌ [HushhVault] encryptData: Missing plaintext or keyHex")
            call.reject("Missing plaintext or key")
            return
        }
        
        print("[HushhVault] 🔐 encryptData called, plaintext length: \(plaintext.count)")
        
        guard let keyData = Data(hexString: keyHex),
              let plaintextData = plaintext.data(using: .utf8) else {
            print("❌ [HushhVault] encryptData: Invalid encoding")
            call.reject("Invalid encoding")
            return
        }
        
        do {
            let key = SymmetricKey(data: keyData)
            let sealedBox = try AES.GCM.seal(plaintextData, using: key)
            
            print("✅ [HushhVault] encryptData: Encryption successful")
            call.resolve([
                "ciphertext": sealedBox.ciphertext.base64EncodedString(),
                "iv": sealedBox.nonce.withUnsafeBytes { Data($0).base64EncodedString() },
                "tag": sealedBox.tag.base64EncodedString(),
                "encoding": "base64",
                "algorithm": "aes-256-gcm"
            ])
        } catch {
            print("❌ [HushhVault] encryptData failed: \(error.localizedDescription)")
            call.reject("Encryption failed: \(error.localizedDescription)")
        }
    }
    
    // MARK: - Decrypt (AES-GCM)
    @objc func decryptData(_ call: CAPPluginCall) {
        // Accept "keyHex" (Android/JS) or "key" (legacy) for compatibility
        guard let keyHex = call.getString("keyHex") ?? call.getString("key") else {
            print("❌ [HushhVault] decryptData: Missing keyHex")
            call.reject("Missing required parameters")
            return
        }
        
        // Support both nested payload object (Android/JS) and flat structure (legacy)
        let ciphertext: String?
        let iv: String?
        let tag: String?
        
        if let payload = call.getObject("payload") {
            // Android/JS style: { keyHex, payload: { ciphertext, iv, tag } }
            ciphertext = payload["ciphertext"] as? String
            iv = payload["iv"] as? String
            tag = payload["tag"] as? String
            print("[HushhVault] 🔓 decryptData using nested payload")
        } else {
            // Legacy flat style: { key, ciphertext, iv, tag }
            ciphertext = call.getString("ciphertext")
            iv = call.getString("iv")
            tag = call.getString("tag")
            print("[HushhVault] 🔓 decryptData using flat parameters")
        }
        
        guard let ciphertextStr = ciphertext,
              let ivStr = iv,
              let tagStr = tag else {
            print("❌ [HushhVault] decryptData: Missing ciphertext, iv, or tag")
            call.reject("Missing required parameters")
            return
        }
        
        guard let keyData = Data(hexString: keyHex),
              let ciphertextData = Data(base64Encoded: ciphertextStr),
              let ivData = Data(base64Encoded: ivStr),
              let tagData = Data(base64Encoded: tagStr) else {
            print("❌ [HushhVault] decryptData: Invalid encoding (keyHex len: \(keyHex.count), ciphertext len: \(ciphertextStr.count))")
            call.reject("Invalid encoding")
            return
        }
        
        do {
            let key = SymmetricKey(data: keyData)
            let nonce = try AES.GCM.Nonce(data: ivData)
            let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertextData, tag: tagData)
            let decryptedData = try AES.GCM.open(sealedBox, using: key)
            
            if let plaintext = String(data: decryptedData, encoding: .utf8) {
                print("✅ [HushhVault] decryptData: Success, plaintext length: \(plaintext.count)")
                call.resolve(["plaintext": plaintext])
            } else {
                print("❌ [HushhVault] decryptData: Failed to decode plaintext as UTF-8")
                call.reject("Failed to decode plaintext")
            }
        } catch {
            print("❌ [HushhVault] decryptData failed: \(error.localizedDescription)")
            call.reject("Decryption failed: \(error.localizedDescription)")
        }
    }
    
    // MARK: - Vault Operations
    @objc func hasVault(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId") else {
            call.reject("Missing userId")
            return
        }
        
        let authToken = call.getString("authToken")
        let backendUrl = resolvedBackendUrl(call)
        let urlStr = "\(backendUrl)/db/vault/check"
        
        performRequest(urlStr: urlStr, body: ["userId": userId], authToken: authToken) { json, error in
            if let error = error {
                call.reject("Failed to check vault: \(error)")
                return
            }
            if let json = json, let hasVault = json["hasVault"] as? Bool {
                call.resolve(["exists": hasVault])
            } else {
                call.resolve(["exists": false])
            }
        }
    }
    
    @objc func getVault(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId") else {
            call.reject("Missing userId")
            return
        }
        
        let authToken = call.getString("authToken")
        let backendUrl = resolvedBackendUrl(call)
        let urlStr = "\(backendUrl)/db/vault/get"
        
        performRequest(urlStr: urlStr, body: ["userId": userId], authToken: authToken) { json, error in
            if let json = json {
                var normalized: [String: Any] = [
                    "vaultKeyHash": (json["vaultKeyHash"] as? String) ?? "",
                    "primaryMethod": (json["primaryMethod"] as? String) ?? "passphrase",
                    "primaryWrapperId": (json["primaryWrapperId"] as? String) ?? "default",
                    "recoveryEncryptedVaultKey": (json["recoveryEncryptedVaultKey"] as? String) ?? "",
                    "recoverySalt": (json["recoverySalt"] as? String) ?? "",
                    "recoveryIv": (json["recoveryIv"] as? String) ?? ""
                ]

                let wrappersAny = json["wrappers"]
                let wrappersArray: [[String: Any]]
                if let direct = wrappersAny as? [[String: Any]] {
                    wrappersArray = direct
                } else if let rawArray = wrappersAny as? [Any] {
                    wrappersArray = rawArray.compactMap { $0 as? [String: Any] }
                } else {
                    wrappersArray = []
                }
                let wrappers: [[String: Any]] = wrappersArray.map { raw in
                    var wrapper: [String: Any] = [
                        "method": (raw["method"] as? String) ?? "passphrase",
                        "wrapperId": (raw["wrapperId"] as? String) ?? (raw["wrapper_id"] as? String) ?? "default",
                        "encryptedVaultKey": (raw["encryptedVaultKey"] as? String) ?? (raw["encrypted_vault_key"] as? String) ?? "",
                        "salt": (raw["salt"] as? String) ?? "",
                        "iv": (raw["iv"] as? String) ?? ""
                    ]

                    if let passkeyCredentialId = (raw["passkeyCredentialId"] as? String) ?? (raw["passkey_credential_id"] as? String) {
                        let trimmed = passkeyCredentialId.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty && trimmed.lowercased() != "null" {
                            wrapper["passkeyCredentialId"] = trimmed
                        }
                    }

                    if let passkeyPrfSalt = (raw["passkeyPrfSalt"] as? String) ?? (raw["passkey_prf_salt"] as? String) {
                        let trimmed = passkeyPrfSalt.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty && trimmed.lowercased() != "null" {
                            wrapper["passkeyPrfSalt"] = trimmed
                        }
                    }
                    if let passkeyRpId = (raw["passkeyRpId"] as? String) ?? (raw["passkey_rp_id"] as? String) {
                        let trimmed = passkeyRpId.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty && trimmed.lowercased() != "null" {
                            wrapper["passkeyRpId"] = trimmed
                        }
                    }
                    if let passkeyProvider = (raw["passkeyProvider"] as? String) ?? (raw["passkey_provider"] as? String) {
                        let trimmed = passkeyProvider.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty && trimmed.lowercased() != "null" {
                            wrapper["passkeyProvider"] = trimmed
                        }
                    }
                    if let passkeyDeviceLabel = (raw["passkeyDeviceLabel"] as? String) ?? (raw["passkey_device_label"] as? String) {
                        let trimmed = passkeyDeviceLabel.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty && trimmed.lowercased() != "null" {
                            wrapper["passkeyDeviceLabel"] = trimmed
                        }
                    }
                    if let passkeyLastUsedAt = raw["passkeyLastUsedAt"] as? Int {
                        wrapper["passkeyLastUsedAt"] = passkeyLastUsedAt
                    } else if let passkeyLastUsedAt = raw["passkey_last_used_at"] as? Int {
                        wrapper["passkeyLastUsedAt"] = passkeyLastUsedAt
                    }

                    return wrapper
                }

                normalized["wrappers"] = wrappers
                let methods = wrappers.compactMap { ($0["method"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
                print("[\(self.TAG)] getVault wrappers count: \(wrappers.count), methods: \(methods)")
                call.resolve(normalized)
            } else if let error = error, error.contains("404") {
                call.resolve(["vault": NSNull()])
            } else {
                call.reject(error ?? "Failed to get vault")
            }
        }
    }
    
    @objc func setupVault(_ call: CAPPluginCall) {
        print("[\(TAG)] 🔐 setupVault called")
        let receivedKeys = call.options.keys.compactMap { $0 as? String }.sorted()
        print("[\(TAG)] Received keys: \(receivedKeys)")
        
        guard let userId = call.getString("userId"),
              let vaultKeyHash = call.getString("vaultKeyHash"),
              let primaryMethod = call.getString("primaryMethod"),
              let recoveryEncryptedVaultKey = call.getString("recoveryEncryptedVaultKey"),
              let recoverySalt = call.getString("recoverySalt"),
              let recoveryIv = call.getString("recoveryIv"),
              let wrappersAny = call.options["wrappers"] as? [Any] else {
            print("❌ [\(TAG)] setupVault: Missing required parameters")
            print("   Available keys: \(receivedKeys)")
            call.reject("Missing required parameters for vault setup state")
            return
        }
        
        let authToken = call.getString("authToken")
        let backendUrl = resolvedBackendUrl(call)
        let urlStr = "\(backendUrl)/db/vault/setup"
        let primaryWrapperId = call.getString("primaryWrapperId") ?? "default"
        
        print("[\(TAG)] 🌐 URL: \(urlStr)")
        print("[\(TAG)] userId: \(userId), primaryMethod: \(primaryMethod)")
        
        let normalizedWrappers: [[String: Any]] = wrappersAny.compactMap { item in
            guard let raw = item as? [String: Any] else { return nil }
            let method = (raw["method"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
            let encrypted = ((raw["encryptedVaultKey"] as? String) ?? (raw["encrypted_vault_key"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let salt = ((raw["salt"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let iv = ((raw["iv"] as? String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if encrypted.isEmpty || salt.isEmpty || iv.isEmpty { return nil }

            var wrapper: [String: Any] = [
                "method": (method?.isEmpty == false ? method! : "passphrase"),
                "wrapperId": ((raw["wrapperId"] as? String) ?? (raw["wrapper_id"] as? String) ?? "default"),
                "encryptedVaultKey": encrypted,
                "salt": salt,
                "iv": iv
            ]

            if let passkeyCredentialId = ((raw["passkeyCredentialId"] as? String) ?? (raw["passkey_credential_id"] as? String))?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !passkeyCredentialId.isEmpty,
               passkeyCredentialId.lowercased() != "null" {
                wrapper["passkeyCredentialId"] = passkeyCredentialId
            }
            if let passkeyPrfSalt = ((raw["passkeyPrfSalt"] as? String) ?? (raw["passkey_prf_salt"] as? String))?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !passkeyPrfSalt.isEmpty,
               passkeyPrfSalt.lowercased() != "null" {
                wrapper["passkeyPrfSalt"] = passkeyPrfSalt
            }
            if let passkeyRpId = ((raw["passkeyRpId"] as? String) ?? (raw["passkey_rp_id"] as? String))?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !passkeyRpId.isEmpty,
               passkeyRpId.lowercased() != "null" {
                wrapper["passkeyRpId"] = passkeyRpId
            }
            if let passkeyProvider = ((raw["passkeyProvider"] as? String) ?? (raw["passkey_provider"] as? String))?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !passkeyProvider.isEmpty,
               passkeyProvider.lowercased() != "null" {
                wrapper["passkeyProvider"] = passkeyProvider
            }
            if let passkeyDeviceLabel = ((raw["passkeyDeviceLabel"] as? String) ?? (raw["passkey_device_label"] as? String))?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !passkeyDeviceLabel.isEmpty,
               passkeyDeviceLabel.lowercased() != "null" {
                wrapper["passkeyDeviceLabel"] = passkeyDeviceLabel
            }
            if let passkeyLastUsedAt = (raw["passkeyLastUsedAt"] as? Int) ?? (raw["passkey_last_used_at"] as? Int) {
                wrapper["passkeyLastUsedAt"] = passkeyLastUsedAt
            }
            return wrapper
        }

        let body: [String: Any] = [
            "userId": userId,
            "vaultKeyHash": vaultKeyHash,
            "primaryMethod": primaryMethod,
            "primaryWrapperId": primaryWrapperId,
            "recoveryEncryptedVaultKey": recoveryEncryptedVaultKey,
            "recoverySalt": recoverySalt,
            "recoveryIv": recoveryIv,
            "wrappers": normalizedWrappers
        ]
        
        performRequest(urlStr: urlStr, body: body, authToken: authToken) { json, error in
            if let error = error {
                print("❌ [\(self.TAG)] setupVault failed: \(error)")
                call.reject(error)
                return
            }
            if let success = json?["success"] as? Bool, success {
                print("✅ [\(self.TAG)] setupVault completed successfully")
                call.resolve(["success": true])
                return
            }
            print("❌ [\(self.TAG)] setupVault failed: success response missing/false")
            call.reject("Failed to create vault: invalid success response")
        }
    }

    @objc func upsertVaultWrapper(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"),
              let vaultKeyHash = call.getString("vaultKeyHash"),
              let method = call.getString("method"),
              let encryptedVaultKey = call.getString("encryptedVaultKey"),
              let salt = call.getString("salt"),
              let iv = call.getString("iv") else {
            call.reject("Missing required parameters")
            return
        }

        let authToken = call.getString("authToken")
        let backendUrl = resolvedBackendUrl(call)
        let urlStr = "\(backendUrl)/db/vault/wrapper/upsert"
        let wrapperId = call.getString("wrapperId") ?? "default"

        var body: [String: Any] = [
            "userId": userId,
            "vaultKeyHash": vaultKeyHash,
            "method": method,
            "wrapperId": wrapperId,
            "encryptedVaultKey": encryptedVaultKey,
            "salt": salt,
            "iv": iv
        ]
        if let passkeyCredentialId = call.getString("passkeyCredentialId"), !passkeyCredentialId.isEmpty {
            body["passkeyCredentialId"] = passkeyCredentialId
        }
        if let passkeyPrfSalt = call.getString("passkeyPrfSalt"), !passkeyPrfSalt.isEmpty {
            body["passkeyPrfSalt"] = passkeyPrfSalt
        }
        if let passkeyRpId = call.getString("passkeyRpId"), !passkeyRpId.isEmpty {
            body["passkeyRpId"] = passkeyRpId
        }
        if let passkeyProvider = call.getString("passkeyProvider"), !passkeyProvider.isEmpty {
            body["passkeyProvider"] = passkeyProvider
        }
        if let passkeyDeviceLabel = call.getString("passkeyDeviceLabel"), !passkeyDeviceLabel.isEmpty {
            body["passkeyDeviceLabel"] = passkeyDeviceLabel
        }
        if let passkeyLastUsedAt = call.getInt("passkeyLastUsedAt") {
            body["passkeyLastUsedAt"] = passkeyLastUsedAt
        }

        performRequest(urlStr: urlStr, body: body, authToken: authToken) { json, error in
            if let error = error {
                call.reject(error)
                return
            }
            if let success = json?["success"] as? Bool, success {
                call.resolve(["success": true])
                return
            }
            call.reject("Failed to upsert wrapper: invalid success response")
        }
    }

    @objc func setPrimaryVaultMethod(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"),
              let primaryMethod = call.getString("primaryMethod") else {
            call.reject("Missing required parameters")
            return
        }

        let authToken = call.getString("authToken")
        let backendUrl = resolvedBackendUrl(call)
        let urlStr = "\(backendUrl)/db/vault/primary/set"
        let primaryWrapperId = call.getString("primaryWrapperId") ?? "default"
        let body: [String: Any] = [
            "userId": userId,
            "primaryMethod": primaryMethod,
            "primaryWrapperId": primaryWrapperId
        ]

        performRequest(urlStr: urlStr, body: body, authToken: authToken) { json, error in
            if let error = error {
                call.reject(error)
                return
            }
            if let success = json?["success"] as? Bool, success {
                call.resolve(["success": true])
                return
            }
            call.reject("Failed to set primary method: invalid success response")
        }
    }

    @objc func isPasskeyAvailable(_ call: CAPPluginCall) {
        guard #available(iOS 18.0, *) else {
            call.resolve([
                "available": false,
                "reason": "ios_version_not_supported"
            ])
            return
        }

        let rpId = (call.getString("rpId") ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if rpId.isEmpty {
            call.resolve([
                "available": false,
                "reason": "missing_rp_id"
            ])
            return
        }

        // Instantiation validates API presence; RP domain association is verified by OS at auth time.
        _ = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: rpId)
        call.resolve(["available": true])
    }

    @objc func registerPasskeyPrf(_ call: CAPPluginCall) {
        guard #available(iOS 18.0, *) else {
            call.reject("Native passkey PRF requires iOS 18.0 or newer.")
            return
        }

        guard let userId = call.getString("userId")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !userId.isEmpty else {
            call.reject("Missing userId")
            return
        }
        guard let displayNameRaw = call.getString("displayName")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !displayNameRaw.isEmpty else {
            call.reject("Missing displayName")
            return
        }
        guard let rpIdRaw = call.getString("rpId")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !rpIdRaw.isEmpty else {
            call.reject("Missing rpId")
            return
        }

        let displayName = String(displayNameRaw.prefix(80))
        let operationId = UUID().uuidString
        let coordinator = NativePasskeyFlowCoordinator(
            mode: .register(userId: userId, displayName: displayName, rpId: rpIdRaw),
            plugin: self
        ) { [weak self] result in
            guard let self else { return }
            self.activePasskeyFlows.removeValue(forKey: operationId)
            switch result {
            case .success(let payload):
                call.resolve(payload)
            case .failure(let error):
                call.reject(error.localizedDescription)
            }
        }

        activePasskeyFlows[operationId] = coordinator
        coordinator.start()
    }

    @objc func authenticatePasskeyPrf(_ call: CAPPluginCall) {
        guard #available(iOS 18.0, *) else {
            call.reject("Native passkey PRF requires iOS 18.0 or newer.")
            return
        }

        guard let userId = call.getString("userId")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !userId.isEmpty else {
            call.reject("Missing userId")
            return
        }
        guard let rpIdRaw = call.getString("rpId")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !rpIdRaw.isEmpty else {
            call.reject("Missing rpId")
            return
        }
        guard let prfSaltRaw = call.getString("prfSalt")?.trimmingCharacters(in: .whitespacesAndNewlines),
              let prfSalt = Data(base64Encoded: prfSaltRaw),
              !prfSalt.isEmpty else {
            call.reject("Missing or invalid prfSalt")
            return
        }

        let credentialId = call.getString("credentialId")?.trimmingCharacters(in: .whitespacesAndNewlines)
        let operationId = UUID().uuidString
        let coordinator = NativePasskeyFlowCoordinator(
            mode: .authenticate(
                userId: userId,
                rpId: rpIdRaw,
                credentialId: credentialId,
                prfSalt: prfSalt
            ),
            plugin: self
        ) { [weak self] result in
            guard let self else { return }
            self.activePasskeyFlows.removeValue(forKey: operationId)
            switch result {
            case .success(let payload):
                call.resolve(payload)
            case .failure(let error):
                call.reject(error.localizedDescription)
            }
        }

        activePasskeyFlows[operationId] = coordinator
        coordinator.start()
    }
    
    // MARK: - Domain Data
    @objc func getFoodPreferences(_ call: CAPPluginCall) {
        fetchDomainData(domain: "food", call: call)
    }
    
    @objc func getProfessionalData(_ call: CAPPluginCall) {
        fetchDomainData(domain: "professional", call: call)
    }
    
    private func fetchDomainData(domain: String, call: CAPPluginCall) {
        guard let userId = call.getString("userId"),
              let vaultOwnerToken = call.getString("vaultOwnerToken") else {
            call.reject("Missing userId or vaultOwnerToken")
            return
        }
        
        let authToken = call.getString("authToken")
        let backendUrl = resolvedBackendUrl(call)
        
        // Use new token-enforced endpoint
        let urlStr = "\(backendUrl)/api/\(domain)/preferences"
        
        // Send token in body for validation
        let body: [String: Any] = [
            "userId": userId,
            "consentToken": vaultOwnerToken
        ]
        
        performRequest(urlStr: urlStr, body: body, authToken: authToken) { json, error in
            if let json = json {
                call.resolve(["domain": domain, "preferences": json["preferences"] ?? NSNull()])
            } else {
                call.resolve(["domain": domain, "preferences": NSNull()])
            }
        }
    }
    
    @objc func storePreferencesToCloud(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"),
              let domain = call.getString("domain"),
              let fieldName = call.getString("fieldName"),
              let ciphertext = call.getString("ciphertext"),
              let iv = call.getString("iv"),
              let tag = call.getString("tag") else {
            call.reject("Missing params")
            return
        }
        
        let consentToken = call.getString("consentToken")
        let authToken = call.getString("authToken")
        let backendUrl = resolvedBackendUrl(call)
        
        // Use new token-enforced endpoint
        let urlStr = "\(backendUrl)/api/\(domain)/preferences/store"
        
        var body: [String: Any] = [
            "userId": userId,
            "fieldName": fieldName,
            "ciphertext": ciphertext,
            "iv": iv,
            "tag": tag
        ]
        
        // Include consent token for VAULT_OWNER validation
        if let token = consentToken {
            body["consentToken"] = token
        }
        
        performRequest(urlStr: urlStr, body: body, authToken: authToken) { _, error in
            if error == nil {
                call.resolve(["success": true, "field": fieldName])
            } else {
                call.reject(error ?? "Store failed")
            }
        }
    }
    
    // MARK: - Legacy preference contract (mapped to cloud-backed vault APIs for parity)
    @objc func storePreference(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"),
              let domain = call.getString("domain"),
              let fieldName = call.getString("fieldName") else {
            call.reject("Missing required parameters: userId, domain, fieldName")
            return
        }

        guard let data = call.getObject("data"),
              let ciphertext = data["ciphertext"] as? String,
              let iv = data["iv"] as? String,
              let tag = data["tag"] as? String else {
            call.reject("Missing required encrypted payload")
            return
        }

        let consentTokenId = call.getString("consentTokenId")
        let authToken = call.getString("authToken")
        let backendUrl = resolvedBackendUrl(call)
        let urlStr = "\(backendUrl)/api/vault/\(domain)"
        var body: [String: Any] = [
            "userId": userId,
            "fieldName": fieldName,
            "ciphertext": ciphertext,
            "iv": iv,
            "tag": tag,
        ]
        if let consentTokenId, !consentTokenId.isEmpty {
            body["consentTokenId"] = consentTokenId
        }

        performRequest(urlStr: urlStr, body: body, authToken: authToken) { _, error in
            if let error {
                call.reject(error)
                return
            }
            call.resolve()
        }
    }

    @objc func getPreferences(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"),
              let domain = call.getString("domain") else {
            call.reject("Missing required parameters: userId, domain")
            return
        }

        let authToken = call.getString("authToken")
        let encodedUserId =
            userId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? userId
        let backendUrl = resolvedBackendUrl(call)
        let urlStr = "\(backendUrl)/api/vault/\(domain)?userId=\(encodedUserId)"

        performGetRequest(urlStr: urlStr, bearerToken: authToken) { result, error in
            if let error {
                if error == "HTTP 404" {
                    call.resolve(["preferences": []])
                    return
                }
                call.reject(error)
                return
            }

            let payload = result as? [String: Any]
            let preferences = payload?["preferences"] as? [[String: Any]] ?? []
            call.resolve(["preferences": preferences])
        }
    }

    @objc func deletePreferences(_ call: CAPPluginCall) {
        call.resolve(["success": true])
    }
    
    // MARK: - Consent Integration Methods (Called by ApiService on native)
    
    @objc func getPendingConsents(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId") else {
            call.reject("Missing userId")
            return
        }

        // Consent-gated: must use VAULT_OWNER token
        guard let vaultOwnerToken = call.getString("vaultOwnerToken"), !vaultOwnerToken.isEmpty else {
            call.reject("Missing vaultOwnerToken")
            return
        }

        let backendUrl = resolvedBackendUrl(call)
        let encodedUserId = userId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? userId
        let urlStr = "\(backendUrl)/api/consent/pending?userId=\(encodedUserId)"

        performGetRequest(urlStr: urlStr, bearerToken: vaultOwnerToken) { result, error in
            if let dict = result as? [String: Any], let pending = dict["pending"] as? [[String: Any]] {
                call.resolve(["pending": pending])
            } else if let array = result as? [[String: Any]] {
                call.resolve(["pending": array])
            } else {
                call.resolve(["pending": []])
            }
        }
    }
    
    @objc func getActiveConsents(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId") else {
            call.reject("Missing userId")
            return
        }

        guard let vaultOwnerToken = call.getString("vaultOwnerToken"), !vaultOwnerToken.isEmpty else {
            call.reject("Missing vaultOwnerToken")
            return
        }

        let backendUrl = resolvedBackendUrl(call)
        let encodedUserId = userId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? userId
        let urlStr = "\(backendUrl)/api/consent/active?userId=\(encodedUserId)"

        performGetRequest(urlStr: urlStr, bearerToken: vaultOwnerToken) { result, error in
            if let dict = result as? [String: Any], let active = dict["active"] as? [[String: Any]] {
                call.resolve(["active": active])
            } else if let array = result as? [[String: Any]] {
                call.resolve(["active": array])
            } else {
                call.resolve(["active": []])
            }
        }
    }
    
    @objc func getConsentHistory(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId") else {
            call.reject("Missing userId")
            return
        }

        let page = call.getInt("page") ?? 1
        let limit = call.getInt("limit") ?? 50

        guard let vaultOwnerToken = call.getString("vaultOwnerToken"), !vaultOwnerToken.isEmpty else {
            call.reject("Missing vaultOwnerToken")
            return
        }

        let backendUrl = resolvedBackendUrl(call)
        let encodedUserId = userId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? userId
        let urlStr = "\(backendUrl)/api/consent/history?userId=\(encodedUserId)&page=\(page)&limit=\(limit)"

        performGetRequest(urlStr: urlStr, bearerToken: vaultOwnerToken) { result, error in
            if let dict = result as? [String: Any], let items = dict["items"] as? [[String: Any]] {
                call.resolve(["items": items])
            } else if let array = result as? [[String: Any]] {
                call.resolve(["items": array])
            } else {
                call.resolve(["items": []])
            }
        }
    }

    /**
     * Vault status (domain counts without decrypted data).
     *
     * Backend contract:
     * - Requires Firebase ID token in Authorization header
     * - Requires VAULT_OWNER token in JSON body as `consentToken`
     */
    @objc func getVaultStatus(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId") else {
            call.reject("Missing userId")
            return
        }
        guard let vaultOwnerToken = call.getString("vaultOwnerToken"), !vaultOwnerToken.isEmpty else {
            call.reject("Missing vaultOwnerToken")
            return
        }
        let authToken = call.getString("authToken")
        if authToken == nil || authToken!.isEmpty {
            call.reject("Missing authToken")
            return
        }

        let backendUrl = resolvedBackendUrl(call)
        let urlStr = "\(backendUrl)/db/vault/status"
        let body: [String: Any] = [
            "userId": userId,
            "consentToken": vaultOwnerToken
        ]

        performRequestAny(urlStr: urlStr, body: body, authToken: authToken) { json, error in
            if let error = error {
                call.reject(error)
                return
            }
            if let dict = json as? [String: Any] {
                call.resolve(dict)
                return
            }
            // Fallback: wrap non-dict responses
            call.resolve(["data": json ?? NSNull()])
        }
    }
    
    // GET request helper (for consent endpoints)
    private func performGetRequest(urlStr: String, bearerToken: String?, completion: @escaping (Any?, String?) -> Void) {
        guard let url = URL(string: urlStr) else {
            completion(nil, "Invalid URL")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = bearerToken {
            request.addValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
        urlSession.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(nil, error.localizedDescription)
                return
            }
            
            guard let data = data else {
                completion(nil, "No data")
                return
            }
            
            if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
                completion(nil, "HTTP \(httpResponse.statusCode)")
                return
            }
            
            do {
                let json = try JSONSerialization.jsonObject(with: data)
                completion(json, nil)
            } catch {
                completion(nil, "Parse error")
            }
        }.resume()
    }
    
    // MARK: - HTTP Helper
    private func performRequest(urlStr: String, body: [String: Any], authToken: String?, completion: @escaping ([String: Any]?, String?) -> Void) {
        guard let url = URL(string: urlStr) else {
            completion(nil, "Invalid URL")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.addValue(clientVersionHeaderValue, forHTTPHeaderField: "X-Hushh-Client-Version")
        if let token = authToken {
            request.addValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        } catch {
            completion(nil, "Failed to encode body")
            return
        }
        
        urlSession.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(nil, error.localizedDescription)
                return
            }
            
            guard let data = data else {
                completion(nil, "No data")
                return
            }

            guard let httpResponse = response as? HTTPURLResponse else {
                completion(nil, "Invalid HTTP response")
                return
            }

            let status = httpResponse.statusCode
            var parsedJson: [String: Any]?
            if let jsonObject = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                parsedJson = jsonObject
            }

            if !(200...299).contains(status) {
                let backendDetail =
                    (parsedJson?["detail"] as? String) ??
                    (parsedJson?["error"] as? String) ??
                    String(data: data, encoding: .utf8)
                let trimmedDetail = backendDetail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if trimmedDetail.isEmpty {
                    completion(nil, "HTTP \(status)")
                } else {
                    completion(nil, "HTTP \(status): \(trimmedDetail)")
                }
                return
            }

            if let parsedJson {
                completion(parsedJson, nil)
            } else {
                completion(nil, "Invalid JSON")
            }
        }.resume()
    }
    
    // performRequestAny: returns Any to handle both Array and Dict responses
    private func performRequestAny(urlStr: String, body: [String: Any], authToken: String?, completion: @escaping (Any?, String?) -> Void) {
        guard let url = URL(string: urlStr) else {
            completion(nil, "Invalid URL")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
        request.addValue(clientVersionHeaderValue, forHTTPHeaderField: "X-Hushh-Client-Version")
        if let token = authToken {
            request.addValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        } catch {
            completion(nil, "Failed to encode body")
            return
        }
        
        urlSession.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(nil, error.localizedDescription)
                return
            }
            
            guard let data = data else {
                completion(nil, "No data")
                return
            }
            
            if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
                completion(nil, "HTTP \(httpResponse.statusCode)")
                return
            }
            
            do {
                let json = try JSONSerialization.jsonObject(with: data)
                completion(json, nil)
            } catch {
                completion(nil, "Parse error")
            }
        }.resume()
    }
}

private enum NativePasskeyError: LocalizedError {
    case cancelled
    case missingCredential
    case missingPrfOutput
    case invalidCredentialId
    case internalFailure(String)

    var errorDescription: String? {
        switch self {
        case .cancelled:
            return "Passkey request cancelled."
        case .missingCredential:
            return "Passkey credential missing from authorization response."
        case .missingPrfOutput:
            return "PRF extension output missing. Ensure iCloud Keychain passkeys are enabled."
        case .invalidCredentialId:
            return "Invalid passkey credential ID."
        case .internalFailure(let message):
            return message
        }
    }
}

@available(iOS 18.0, *)
private final class NativePasskeyFlowCoordinator: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    enum Mode {
        case register(userId: String, displayName: String, rpId: String)
        case authenticate(userId: String, rpId: String, credentialId: String?, prfSalt: Data)
    }

    private let mode: Mode
    private weak var plugin: CAPPlugin?
    private let completion: (Result<[String: Any], Error>) -> Void

    init(
        mode: Mode,
        plugin: CAPPlugin,
        completion: @escaping (Result<[String: Any], Error>) -> Void
    ) {
        self.mode = mode
        self.plugin = plugin
        self.completion = completion
        super.init()
    }

    func start() {
        DispatchQueue.main.async {
            let requests: [ASAuthorizationRequest]
            do {
                requests = try self.buildRequests()
            } catch {
                self.completion(.failure(error))
                return
            }

            let controller = ASAuthorizationController(authorizationRequests: requests)
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    private func buildRequests() throws -> [ASAuthorizationRequest] {
        switch mode {
        case let .register(userId, displayName, rpId):
            let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
                relyingPartyIdentifier: rpId
            )
            let challenge = Data.randomBytes(count: 32)
            let request = provider.createCredentialRegistrationRequest(
                challenge: challenge,
                name: displayName,
                userID: Data(userId.utf8)
            )
            request.displayName = displayName
            request.userVerificationPreference = .required

            let prfInput = Data("hushh-vault-prf-\(userId)".utf8)
            let inputValues = ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(
                saltInput1: prfInput
            )
            request.prf = .inputValues(inputValues)
            return [request]

        case let .authenticate(userId, rpId, credentialId, _):
            let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
                relyingPartyIdentifier: rpId
            )
            let challenge = Data.randomBytes(count: 32)
            let request = provider.createCredentialAssertionRequest(challenge: challenge)
            request.userVerificationPreference = .required

            if let credentialId, !credentialId.isEmpty {
                guard let credentialData = Data(base64Encoded: credentialId) else {
                    throw NativePasskeyError.invalidCredentialId
                }
                request.allowedCredentials = [
                    ASAuthorizationPlatformPublicKeyCredentialDescriptor(
                        credentialID: credentialData
                    )
                ]
            }

            let prfInput = Data("hushh-vault-prf-\(userId)".utf8)
            let inputValues = ASAuthorizationPublicKeyCredentialPRFAssertionInput.InputValues(
                saltInput1: prfInput
            )
            request.prf = .inputValues(inputValues)
            return [request]
        }
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        switch mode {
        case .register:
            guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration else {
                completion(.failure(NativePasskeyError.missingCredential))
                return
            }
            guard let prfOutput = credential.prf?.first else {
                completion(.failure(NativePasskeyError.missingPrfOutput))
                return
            }

            do {
                let prfSalt = Data.randomBytes(count: 32)
                let vaultKeyHex = try NativePasskeyFlowCoordinator.deriveVaultKeyHex(
                    prfOutput: prfOutput,
                    prfSalt: prfSalt
                )
                completion(
                    .success([
                        "credentialId": credential.credentialID.base64EncodedString(),
                        "prfSalt": prfSalt.base64EncodedString(),
                        "vaultKeyHex": vaultKeyHex,
                    ])
                )
            } catch {
                completion(.failure(error))
            }

        case let .authenticate(_, _, _, prfSalt):
            guard let credential = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
                completion(.failure(NativePasskeyError.missingCredential))
                return
            }
            guard let prfOutput = credential.prf?.first else {
                completion(.failure(NativePasskeyError.missingPrfOutput))
                return
            }

            do {
                let vaultKeyHex = try NativePasskeyFlowCoordinator.deriveVaultKeyHex(
                    prfOutput: prfOutput,
                    prfSalt: prfSalt
                )
                completion(
                    .success([
                        "credentialId": credential.credentialID.base64EncodedString(),
                        "vaultKeyHex": vaultKeyHex,
                    ])
                )
            } catch {
                completion(.failure(error))
            }
        }
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            completion(.failure(NativePasskeyError.cancelled))
            return
        }
        completion(.failure(NativePasskeyError.internalFailure(error.localizedDescription)))
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        if let window = plugin?.bridge?.viewController?.view.window {
            return window
        }
        if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let window = scene.windows.first {
            return window
        }
        return ASPresentationAnchor()
    }

    private static func deriveVaultKeyHex(prfOutput: SymmetricKey, prfSalt: Data) throws -> String {
        let info = Data("hushh-vault-key-v1".utf8)
        let derived = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: prfOutput,
            salt: prfSalt,
            info: info,
            outputByteCount: 32
        )
        let derivedData = derived.withUnsafeBytes { Data($0) }
        return derivedData.hexString
    }
}

// MARK: - Data Extension for Hex
extension Data {
    static func randomBytes(count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes)
    }

    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }

    init?(hexString: String) {
        var data = Data()
        var hex = hexString
        while hex.count >= 2 {
            let c = String(hex.prefix(2))
            hex = String(hex.dropFirst(2))
            if let byte = UInt8(c, radix: 16) {
                data.append(byte)
            } else {
                return nil
            }
        }
        self = data
    }
}
