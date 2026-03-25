import UIKit
import Capacitor
import CommonCrypto
import Foundation

/**
 * HushhConsentPlugin - Token Management + Backend API (Capacitor 8)
 * Port of Android HushhConsentPlugin.kt
 *
 * Token format: HCT:base64(userId|agentId|scope|issuedAt|expiresAt).hmac_sha256_signature
 */
@objc(HushhConsentPlugin)
public class HushhConsentPlugin: CAPPlugin, CAPBridgedPlugin {
    
    // MARK: - CAPBridgedPlugin Protocol
    public let identifier = "HushhConsentPlugin"
    public let jsName = "HushhConsent"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "issueToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "validateToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "revokeToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "revokeConsent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isTokenRevoked", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "createTrustLink", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verifyTrustLink", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "issueVaultOwnerToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getActive", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getHistory", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "approve", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deny", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    
    private let TAG = "HushhConsent"
    private let CONSENT_TOKEN_PREFIX = "HCT"
    private let TRUST_LINK_PREFIX = "HTL"
    private let DEFAULT_CONSENT_TOKEN_EXPIRY_MS: Int64 = 1000 * 60 * 60 * 24 * 7  // 7 days
    private let DEFAULT_TRUST_LINK_EXPIRY_MS: Int64 = 1000 * 60 * 60 * 24 * 30    // 30 days
    
    private static var revokedTokens = Set<String>()
    
    private var secretKey: String {
        ProcessInfo.processInfo.environment["SECRET_KEY"] ?? "development_secret_key_32_chars!"
    }
    
    private lazy var urlSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 30
        return URLSession(configuration: config)
    }()

    private func resolvedBackendUrl(_ call: CAPPluginCall) -> String {
        return HushhProxyClient.resolveBackendUrl(
            call: call,
            plugin: self,
            jsName: jsName
        )
    }
    
    // MARK: - Issue Token
    @objc func issueToken(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"),
              let agentId = call.getString("agentId"),
              let scope = call.getString("scope") else {
            call.reject("Missing required parameters: userId, agentId, scope")
            return
        }
        
        let expiresInMs = Int64(call.getInt("expiresInMs") ?? Int(DEFAULT_CONSENT_TOKEN_EXPIRY_MS))
        let issuedAt = Int64(Date().timeIntervalSince1970 * 1000)
        let expiresAt = issuedAt + expiresInMs
        
        let raw = "\(userId)|\(agentId)|\(scope)|\(issuedAt)|\(expiresAt)"
        let signature = sign(raw)
        let encoded = Data(raw.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        
        let token = "\(CONSENT_TOKEN_PREFIX):\(encoded).\(signature)"
        let tokenId = String(token.prefix(32))
        
        print("✅ [\(TAG)] Token issued for \(userId), scope: \(scope)")
        
        call.resolve([
            "token": token,
            "tokenId": tokenId,
            "expiresAt": expiresAt
        ])
    }
    
    // MARK: - Validate Token
    @objc func validateToken(_ call: CAPPluginCall) {
        guard let tokenStr = call.getString("token") else {
            call.reject("Missing required parameter: token")
            return
        }
        
        let expectedScope = call.getString("expectedScope")
        
        if Self.revokedTokens.contains(tokenStr) {
            call.resolve(["valid": false, "reason": "Token has been revoked"])
            return
        }
        
        do {
            let result = try parseAndValidateToken(tokenStr, expectedScope: expectedScope)
            call.resolve(result)
        } catch {
            call.resolve(["valid": false, "reason": error.localizedDescription])
        }
    }
    
    // MARK: - Revoke Token
    @objc func revokeToken(_ call: CAPPluginCall) {
        guard let token = call.getString("token") else {
            call.reject("Missing required parameter: token")
            return
        }
        
        Self.revokedTokens.insert(token)
        print("🔒 [\(TAG)] Token revoked")
        call.resolve()
    }
    
    // MARK: - Revoke Consent (Backend Call)
    @objc func revokeConsent(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"),
              let scope = call.getString("scope") else {
            call.reject("Missing required parameters: userId and scope")
            return
        }

        // Consent-gated: requires VAULT_OWNER token only
        guard let vaultOwnerToken = call.getString("vaultOwnerToken"), !vaultOwnerToken.isEmpty else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = resolvedBackendUrl(call)
        
        let body: [String: Any] = ["userId": userId, "scope": scope]
        
        print("🔒 [\(TAG)] Revoking consent for scope: \(scope)")
        
        performRequest(
            url: "\(backendUrl)/api/consent/revoke",
            body: body,
            authToken: vaultOwnerToken
        ) { result, error in
            if let error = error {
                call.reject("Backend rejected revoke: \(error)")
            } else {
                // Extract lockVault flag from backend response
                let lockVault = (result as? [String: Any])?["lockVault"] as? Bool ?? false
                
                print("🔒 [\(self.TAG)] Revoke success, lockVault: \(lockVault)")
                
                call.resolve([
                    "success": true,
                    "lockVault": lockVault
                ])
            }
        }
    }
    
    // MARK: - Is Token Revoked
    @objc func isTokenRevoked(_ call: CAPPluginCall) {
        guard let token = call.getString("token") else {
            call.reject("Missing required parameter: token")
            return
        }
        
        call.resolve(["revoked": Self.revokedTokens.contains(token)])
    }
    
    // MARK: - Create Trust Link
    @objc func createTrustLink(_ call: CAPPluginCall) {
        guard let fromAgent = call.getString("fromAgent"),
              let toAgent = call.getString("toAgent"),
              let scope = call.getString("scope"),
              let signedByUser = call.getString("signedByUser") else {
            call.reject("Missing required parameters")
            return
        }
        
        let expiresInMs = Int64(call.getInt("expiresInMs") ?? Int(DEFAULT_TRUST_LINK_EXPIRY_MS))
        let createdAt = Int64(Date().timeIntervalSince1970 * 1000)
        let expiresAt = createdAt + expiresInMs
        
        let raw = "\(fromAgent)|\(toAgent)|\(scope)|\(createdAt)|\(expiresAt)|\(signedByUser)"
        let signature = sign(raw)
        
        print("✅ [\(TAG)] TrustLink created from \(fromAgent) to \(toAgent)")
        
        call.resolve([
            "fromAgent": fromAgent,
            "toAgent": toAgent,
            "scope": scope,
            "createdAt": createdAt,
            "expiresAt": expiresAt,
            "signedByUser": signedByUser,
            "signature": signature
        ])
    }
    
    // MARK: - Verify Trust Link
    @objc func verifyTrustLink(_ call: CAPPluginCall) {
        guard let link = call.getObject("link"),
              let fromAgent = link["fromAgent"] as? String,
              let toAgent = link["toAgent"] as? String,
              let scope = link["scope"] as? String,
              let createdAt = link["createdAt"] as? NSNumber,
              let expiresAt = link["expiresAt"] as? NSNumber,
              let signedByUser = link["signedByUser"] as? String,
              let signature = link["signature"] as? String else {
            call.reject("Invalid link object")
            return
        }
        
        let createdAtVal = createdAt.int64Value
        let expiresAtVal = expiresAt.int64Value
        
        let requiredScope = call.getString("requiredScope")
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        
        if now > expiresAtVal {
            call.resolve(["valid": false, "reason": "Trust link expired"])
            return
        }
        
        if let req = requiredScope, scope != req {
            call.resolve(["valid": false, "reason": "Scope mismatch"])
            return
        }
        
        let raw = "\(fromAgent)|\(toAgent)|\(scope)|\(createdAtVal)|\(expiresAtVal)|\(signedByUser)"
        let expectedSig = sign(raw)
        
        if signature != expectedSig {
            call.resolve(["valid": false, "reason": "Invalid signature"])
            return
        }
        
        call.resolve(["valid": true])
    }
    
    // MARK: - Backend API Methods
    
    /**
     * Issue VAULT_OWNER consent token.
     * 
     * Called after vault unlock. Sends Firebase ID token to backend
     * which verifies it and issues the master VAULT_OWNER scope token.
     */
    @objc func issueVaultOwnerToken(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"),
              let authToken = call.getString("authToken") else {
            call.reject("Missing required parameters: userId and authToken")
            return
        }

        // Bootstrap-only: Firebase ID token required
        let backendUrl = resolvedBackendUrl(call)
        let body: [String: Any] = ["userId": userId]
        
        print("[\(TAG)] Requesting VAULT_OWNER token for user: \(userId)")
        
        performRequest(url: "\(backendUrl)/api/consent/vault-owner-token", body: body, authToken: authToken) { result, error in
            if let error = error {
                let errorMsg = "Failed to issue VAULT_OWNER token: \(error) | backendUrl: \(backendUrl)"
                print("❌ [\(self.TAG)] VAULT_OWNER token request failed: \(errorMsg)")
                call.reject(errorMsg)
                return
            }
            
            guard let json = result as? [String: Any],
                  let token = json["token"] as? String,
                  let expiresAt = json["expiresAt"] as? NSNumber,
                  let scope = json["scope"] as? String else {
                print("❌ [\(self.TAG)] Invalid response from backend")
                call.reject("Invalid response from backend")
                return
            }
            
            print("✅ [\(self.TAG)] VAULT_OWNER token issued successfully")
            
            call.resolve([
                "token": token,
                "expiresAt": expiresAt.int64Value,
                "scope": scope
            ])
        }
    }
    
    @objc func getPending(_ call: CAPPluginCall) {
        performConsentListRequest(call: call, endpoint: "pending")
    }
    
    @objc func getActive(_ call: CAPPluginCall) {
        performConsentListRequest(call: call, endpoint: "active")
    }
    
    @objc func getHistory(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId") else {
            call.reject("Missing required parameter: userId")
            return
        }
        
        let page = call.getInt("page") ?? 1
        let limit = call.getInt("limit") ?? 20

        // Consent-gated: requires VAULT_OWNER token only
        guard let vaultOwnerToken = call.getString("vaultOwnerToken"), !vaultOwnerToken.isEmpty else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }

        let backendUrl = resolvedBackendUrl(call)
        let encodedUserId = userId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? userId
        let urlStr = "\(backendUrl)/api/consent/history?userId=\(encodedUserId)&page=\(page)&limit=\(limit)"

        performGet(urlStr: urlStr, authToken: vaultOwnerToken) { result, error in
            if let error = error {
                call.reject(error)
                return
            }
            if let dict = result as? [String: Any] {
                call.resolve(dict)
                return
            }
            if let array = result as? [[String: Any]] {
                // Normalize for JS call sites that expect an object
                call.resolve(["items": array])
                return
            }
            call.resolve(["items": []])
        }
    }
    
    @objc func approve(_ call: CAPPluginCall) {
        guard let requestId = call.getString("requestId") else {
            call.reject("Missing required parameter: requestId")
            return
        }
        
        // Optional params
        let encryptedData = call.getString("encryptedData")
        let encryptedIv = call.getString("encryptedIv")
        let encryptedTag = call.getString("encryptedTag")
        let wrappedExportKey = call.getString("wrappedExportKey")
        let wrappedKeyIv = call.getString("wrappedKeyIv")
        let wrappedKeyTag = call.getString("wrappedKeyTag")
        let senderPublicKey = call.getString("senderPublicKey")
        let wrappingAlg = call.getString("wrappingAlg")
        let connectorKeyId = call.getString("connectorKeyId")
        let sourceContentRevision = call.getInt("sourceContentRevision")
        let sourceManifestRevision = call.getInt("sourceManifestRevision")
        let durationHours = call.getInt("durationHours")
        let userId = call.getString("userId")
        
        guard let vaultOwnerToken = call.getString("vaultOwnerToken"), !vaultOwnerToken.isEmpty else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = resolvedBackendUrl(call)
        
        var body: [String: Any] = ["requestId": requestId]
        if let v = userId { body["userId"] = v }
        if let v = encryptedData { body["encryptedData"] = v }
        if let v = encryptedIv { body["encryptedIv"] = v }
        if let v = encryptedTag { body["encryptedTag"] = v }
        if let v = wrappedExportKey { body["wrappedExportKey"] = v }
        if let v = wrappedKeyIv { body["wrappedKeyIv"] = v }
        if let v = wrappedKeyTag { body["wrappedKeyTag"] = v }
        if let v = senderPublicKey { body["senderPublicKey"] = v }
        if let v = wrappingAlg { body["wrappingAlg"] = v }
        if let v = connectorKeyId { body["connectorKeyId"] = v }
        if let v = sourceContentRevision { body["sourceContentRevision"] = v }
        if let v = sourceManifestRevision { body["sourceManifestRevision"] = v }
        if let v = durationHours { body["durationHours"] = v }
        
        performRequest(url: "\(backendUrl)/api/consent/pending/approve", body: body, authToken: vaultOwnerToken) { result, error in
            if let error = error {
                call.reject(error)
            } else {
                call.resolve(["success": true])
            }
        }
    }
    
    @objc func deny(_ call: CAPPluginCall) {
        performActionRequest(call: call, endpoint: "deny")
    }
    
    @objc func cancel(_ call: CAPPluginCall) {
        performActionRequest(call: call, endpoint: "cancel")
    }
    
    // MARK: - Helpers
    private func performActionRequest(call: CAPPluginCall, endpoint: String) {
        guard let requestId = call.getString("requestId") else {
            call.reject("Missing required parameter: requestId")
            return
        }
        
        let userId = call.getString("userId")
        guard let vaultOwnerToken = call.getString("vaultOwnerToken"), !vaultOwnerToken.isEmpty else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = resolvedBackendUrl(call)
        
        if endpoint == "deny" {
            // deny endpoint expects userId and requestId as query parameters
            guard let uid = userId else {
                call.reject("Missing required parameter: userId")
                return
            }
            let url = "\(backendUrl)/api/consent/pending/deny?userId=\(uid)&requestId=\(requestId)"
            performRequest(url: url, body: [:], authToken: vaultOwnerToken) { result, error in
                call.resolve(["success": error == nil])
            }
        } else {
            // cancel uses body
            let path = "/api/consent/cancel"
            var body: [String: Any] = ["requestId": requestId]
            if let uid = userId { body["userId"] = uid }
            
            performRequest(url: "\(backendUrl)\(path)", body: body, authToken: vaultOwnerToken) { result, error in
                call.resolve(["success": error == nil])
            }
        }
    }

    // MARK: - Consent list (GET semantics)
    private func performConsentListRequest(call: CAPPluginCall, endpoint: String) {
        guard let userId = call.getString("userId") else {
            call.reject("Missing required parameter: userId")
            return
        }

        guard let vaultOwnerToken = call.getString("vaultOwnerToken"), !vaultOwnerToken.isEmpty else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }

        let backendUrl = resolvedBackendUrl(call)
        let encodedUserId = userId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? userId
        let urlStr = "\(backendUrl)/api/consent/\(endpoint)?userId=\(encodedUserId)"

        performGet(urlStr: urlStr, authToken: vaultOwnerToken) { result, error in
            if let error = error {
                call.reject(error)
                return
            }

            // Backend may return array directly; normalize into { consents: [...] }
            if let array = result as? [[String: Any]] {
                call.resolve(["consents": array])
                return
            }
            if let dict = result as? [String: Any] {
                if let consents = dict["consents"] as? [[String: Any]] {
                    call.resolve(["consents": consents])
                    return
                }
                if let pending = dict["pending"] as? [[String: Any]] {
                    call.resolve(["consents": pending])
                    return
                }
                if let active = dict["active"] as? [[String: Any]] {
                    call.resolve(["consents": active])
                    return
                }
            }
            call.resolve(["consents": []])
        }
    }

    private func performGet(urlStr: String, authToken: String, completion: @escaping (Any?, String?) -> Void) {
        do {
            let request = try HushhProxyClient.makeJsonRequest(
                method: "GET",
                urlStr: urlStr,
                bearerToken: authToken,
                jsonBody: nil
            )
            HushhProxyClient.executeJson(urlSession, request: request) { result in
                switch result {
                case .success(let json):
                    completion(json, nil)
                case .failure(let error):
                    completion(nil, error.localizedDescription)
                }
            }
        } catch {
            completion(nil, error.localizedDescription)
        }
    }
    
    private func performRequest(url: String, body: [String: Any], authToken: String?, completion: @escaping (Any?, String?) -> Void) {
        guard let requestUrl = URL(string: url) else {
            completion(nil, "Invalid URL")
            return
        }
        
        var request = URLRequest(url: requestUrl)
        request.httpMethod = "POST"
        request.addValue("application/json", forHTTPHeaderField: "Content-Type")
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
                let errorMsg = "\(error.localizedDescription) | backendUrl: \(url)"
                completion(nil, errorMsg)
                return
            }
            
            if let httpResponse = response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
                var errorMsg = "HTTP Error: \(httpResponse.statusCode)"
                if let data = data, let bodyStr = String(data: data, encoding: .utf8) {
                    let truncatedBody = bodyStr.count > 200 ? String(bodyStr.prefix(200)) + "..." : bodyStr
                    errorMsg += " | body: \(truncatedBody)"
                }
                errorMsg += " | backendUrl: \(url)"
                print("❌ [HushhConsent] Request failed: \(errorMsg)")
                completion(nil, errorMsg)
                return
            }
            
            guard let data = data else {
                completion(nil, "No data")
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
    
    private func sign(_ input: String) -> String {
        let key = secretKey.data(using: .utf8)!
        let data = input.data(using: .utf8)!
        var hmac = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        
        key.withUnsafeBytes { keyBytes in
            data.withUnsafeBytes { dataBytes in
                CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), keyBytes.baseAddress, key.count, dataBytes.baseAddress, data.count, &hmac)
            }
        }
        
        return hmac.map { String(format: "%02x", $0) }.joined()
    }
    
    private func parseAndValidateToken(_ tokenStr: String, expectedScope: String?) throws -> [String: Any] {
        let parts = tokenStr.split(separator: ":", maxSplits: 1).map(String.init)
        guard parts.count == 2, parts[0] == CONSENT_TOKEN_PREFIX else {
            throw NSError(domain: "Token", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid token format"])
        }
        
        let signedParts = parts[1].split(separator: ".", maxSplits: 1).map(String.init)
        guard signedParts.count == 2 else {
            throw NSError(domain: "Token", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid token format"])
        }
        
        let encoded = signedParts[0]
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padded = encoded + String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        
        guard let decodedData = Data(base64Encoded: padded),
              let decoded = String(data: decodedData, encoding: .utf8) else {
            throw NSError(domain: "Token", code: 3, userInfo: [NSLocalizedDescriptionKey: "Failed to decode token"])
        }
        
        let components = decoded.split(separator: "|").map(String.init)
        guard components.count == 5,
              let issuedAt = Int64(components[3]),
              let expiresAt = Int64(components[4]) else {
            throw NSError(domain: "Token", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid token payload"])
        }
        
        let raw = "\(components[0])|\(components[1])|\(components[2])|\(issuedAt)|\(expiresAt)"
        if signedParts[1] != sign(raw) {
            throw NSError(domain: "Token", code: 5, userInfo: [NSLocalizedDescriptionKey: "Invalid signature"])
        }
        
        if let expected = expectedScope, components[2] != expected {
            throw NSError(domain: "Token", code: 6, userInfo: [NSLocalizedDescriptionKey: "Scope mismatch"])
        }
        
        if Int64(Date().timeIntervalSince1970 * 1000) > expiresAt {
            throw NSError(domain: "Token", code: 7, userInfo: [NSLocalizedDescriptionKey: "Token expired"])
        }
        
        return ["valid": true, "userId": components[0], "agentId": components[1], "scope": components[2]]
    }
}
