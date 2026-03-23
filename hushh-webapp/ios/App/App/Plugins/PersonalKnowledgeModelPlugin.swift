import UIKit
import Capacitor
import Foundation

/**
 * PersonalKnowledgeModel Plugin - iOS Implementation
 * 
 * Native plugin for PKM operations.
 * Provides access to user's PKM data for native platforms.
 * 
 * Methods:
 * - getMetadata: Get user's PKM metadata (domains, attribute counts)
 * - getAttributes: Get attributes for a specific domain
 * - storeAttribute: Store an encrypted attribute
 * - getInitialChatState: Get initial chat state for proactive welcome
 * - importPortfolio: Import portfolio from file
 */

@objc(PersonalKnowledgeModelPlugin)
public class PersonalKnowledgeModelPlugin: CAPPlugin, CAPBridgedPlugin {
    
    private let TAG = "PersonalKnowledgeModelPlugin"
    
    // MARK: - CAPBridgedPlugin Protocol
    public let identifier = "PersonalKnowledgeModelPlugin"
    public let jsName = "PersonalKnowledgeModel"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getMetadata", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getIndex", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAttributes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storeAttribute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteAttribute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getInitialChatState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importPortfolio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listDomains", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getUserDomains", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAvailableScopes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPortfolio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listPortfolios", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getEncryptedData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storeDomainData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDomainData", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearDomain", returnType: CAPPluginReturnPromise)
    ]
    
    // URLSession with reasonable timeouts
    private lazy var urlSession: URLSession = {
        let config = URLSessionConfiguration.default
        // Financial-domain blob payloads can be large on mobile.
        // Keep request/resource windows long enough to avoid false timeouts
        // while still bounded for reliability.
        config.timeoutIntervalForRequest = 90
        config.timeoutIntervalForResource = 180
        return URLSession(configuration: config)
    }()
    
    // MARK: - Configuration
    
    private func getBackendUrl(_ call: CAPPluginCall) -> String {
        return HushhProxyClient.resolveBackendUrl(
            call: call,
            plugin: self,
            jsName: jsName
        )
    }

    // Consent-first: PKM operations are consent-gated and must use VAULT_OWNER token.
    private func getVaultOwnerToken(_ call: CAPPluginCall) -> String? {
        let raw = call.getString("vaultOwnerToken")
        guard let token = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
            return nil
        }
        return token
    }
    
    // MARK: - Plugin Methods
    
    /**
     * Get user's PKM metadata.
     * 
     * Parameters:
     * - userId: User's Firebase UID
     * - authToken: Firebase ID token for authentication
     * 
     * Returns:
     * - domains: Array of domain summaries with attribute counts
     * - total_attributes: Total number of attributes
     * - available_domains: List of domain keys
     */
    @objc func getMetadata(_ call: CAPPluginCall) {
        print("[\(TAG)] getMetadata called")
        guard let userId = call.getString("userId") else {
            call.reject("Missing required parameter: userId")
            return
        }
        
        // Metadata is currently treated as low-sensitivity and may be public on backend;
        // if a VAULT_OWNER token is available, we still forward it.
        let vaultOwnerToken = getVaultOwnerToken(call)
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/pkm/metadata/\(userId)"
        
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        if let token = vaultOwnerToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        
        executeRequest(request, call: call, backendUrl: backendUrl)
    }
    
    /**
     * Get attributes for a specific domain.
     * 
     * Parameters:
     * - userId: User's Firebase UID
     * - domain: Domain key (e.g., "financial", "food")
     * - authToken: Firebase ID token for authentication
     * 
     * Returns:
     * - attributes: Array of encrypted attributes
     */
    @objc func getAttributes(_ call: CAPPluginCall) {
        print("[\(TAG)] getAttributes called")
        guard let userId = call.getString("userId") else {
            call.reject("Missing required parameter: userId")
            return
        }

        let domain = call.getString("domain")
        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)

        let urlStr: String
        if let domain = domain, !domain.isEmpty {
            urlStr = "\(backendUrl)/api/pkm/attributes/\(userId)?domain=\(domain)"
        } else {
            urlStr = "\(backendUrl)/api/pkm/attributes/\(userId)"
        }
        
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        
        executeRequest(request, call: call, backendUrl: backendUrl)
    }
    
    /**
     * Store an encrypted attribute.
     * 
     * Parameters:
     * - userId: User's Firebase UID
     * - domain: Domain key
     * - attributeKey: Attribute key
     * - ciphertext: Encrypted value
     * - iv: Initialization vector
     * - tag: Authentication tag
     * - authToken: Firebase ID token for authentication
     * 
     * Returns:
     * - success: Boolean indicating success
     * - scope: Generated consent scope (e.g., "attr.financial.risk_profile")
     */
    @objc func storeAttribute(_ call: CAPPluginCall) {
        print("[\(TAG)] storeAttribute called")
        guard let userId = call.getString("userId"),
              let attributeKey = call.getString("attributeKey"),
              let ciphertext = call.getString("ciphertext"),
              let iv = call.getString("iv"),
              let tag = call.getString("tag") else {
            call.reject("Missing required parameters")
            return
        }

        let domain = call.getString("domain")
        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/pkm/attributes"
        
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        
        var body: [String: Any] = [
            "user_id": userId,
            "attribute_key": attributeKey,
            "ciphertext": ciphertext,
            "iv": iv,
            "tag": tag
        ]

        if let domain = domain, !domain.isEmpty {
            body["domain"] = domain
        }
        
        // Optional fields
        if let source = call.getString("source") {
            body["source"] = source
        }
        if let confidence = call.getFloat("confidence") {
            body["confidence"] = confidence
        }
        if let displayName = call.getString("displayName") {
            body["display_name"] = displayName
        }
        if let dataType = call.getString("dataType") {
            body["data_type"] = dataType
        }
        
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        
        executeRequest(request, call: call, backendUrl: backendUrl)
    }

    /**
     * Get user's PKM index.
     */
    @objc func getIndex(_ call: CAPPluginCall) {
        print("[\(TAG)] getIndex called")
        guard let userId = call.getString("userId") else {
            call.reject("Missing required parameter: userId")
            return
        }

        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/pkm/index/\(userId)"

        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")

        executeRequest(request, call: call, backendUrl: backendUrl)
    }

    /**
     * Delete a specific attribute.
     */
    @objc func deleteAttribute(_ call: CAPPluginCall) {
        print("[\(TAG)] deleteAttribute called")
        guard let userId = call.getString("userId"),
              let domain = call.getString("domain"),
              let attributeKey = call.getString("attributeKey") else {
            call.reject("Missing required parameters: userId, domain, attributeKey")
            return
        }

        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/pkm/attributes/\(userId)/\(domain)/\(attributeKey)"

        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")

        executeRequest(request, call: call, backendUrl: backendUrl)
    }

    /**
     * Store encrypted domain blob.
     */
    @objc func storeDomainData(_ call: CAPPluginCall) {
        print("[\(TAG)] storeDomainData called")
        guard let userId = call.getString("userId"),
              let domain = call.getString("domain"),
              let encryptedBlob = call.getObject("encryptedBlob"),
              let ciphertext = encryptedBlob["ciphertext"] as? String,
              let iv = encryptedBlob["iv"] as? String,
              let tag = encryptedBlob["tag"] as? String,
              let summary = call.getObject("summary") else {
            call.reject("Missing required parameters")
            return
        }

        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/pkm/store-domain"

        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")

        var blob: [String: Any] = [
            "ciphertext": ciphertext,
            "iv": iv,
            "tag": tag
        ]
        if let algorithm = encryptedBlob["algorithm"] as? String {
            blob["algorithm"] = algorithm
        }

        let body: [String: Any] = [
            "user_id": userId,
            "domain": domain,
            "encrypted_blob": blob,
            "summary": summary
        ]

        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        executeRequest(request, call: call, backendUrl: backendUrl)
    }

    /**
     * Get encrypted domain blob.
     */
    @objc func getDomainData(_ call: CAPPluginCall) {
        print("[\(TAG)] getDomainData called")
        guard let userId = call.getString("userId"),
              let domain = call.getString("domain") else {
            call.reject("Missing required parameters: userId, domain")
            return
        }

        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/pkm/domain-data/\(userId)/\(domain)"

        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")

        executeRequest(request, call: call, backendUrl: backendUrl)
    }

    /**
     * Get full encrypted PKM blob for a user.
     */
    @objc func getEncryptedData(_ call: CAPPluginCall) {
        print("[\(TAG)] getEncryptedData called")
        guard let userId = call.getString("userId") else {
            call.reject("Missing required parameter: userId")
            return
        }

        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/pkm/data/\(userId)"

        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")

        executeRequest(request, call: call, backendUrl: backendUrl)
    }

    /**
     * Clear a domain blob.
     */
    @objc func clearDomain(_ call: CAPPluginCall) {
        print("[\(TAG)] clearDomain called")
        guard let userId = call.getString("userId"),
              let domain = call.getString("domain") else {
            call.reject("Missing required parameters: userId, domain")
            return
        }

        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/pkm/domain-data/\(userId)/\(domain)"

        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")

        executeRequest(request, call: call, backendUrl: backendUrl)
    }
    
    /**
     * Get initial chat state for proactive welcome.
     * 
     * Parameters:
     * - userId: User's Firebase UID
     * - authToken: Firebase ID token for authentication
     * 
     * Returns:
     * - is_new_user: Boolean indicating if user is new
     * - has_portfolio: Boolean indicating if user has portfolio
     * - has_financial_data: Boolean indicating if user has financial data
     * - welcome_type: "new", "returning_no_portfolio", or "returning"
     * - total_attributes: Total number of attributes
     * - available_domains: List of domain keys
     */
    @objc func getInitialChatState(_ call: CAPPluginCall) {
        print("[\(TAG)] getInitialChatState called")
        guard let userId = call.getString("userId") else {
            call.reject("Missing required parameter: userId")
            return
        }
        
        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/kai/chat/initial-state/\(userId)"
        
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        
        executeRequest(request, call: call, backendUrl: backendUrl)
    }
    
    /**
     * List all registered domains.
     * 
     * Parameters:
     * - includeEmpty: Include domains with no attributes (default: false)
     * - authToken: Firebase ID token for authentication
     * 
     * Returns:
     * - domains: Array of domain metadata objects
     */
    @objc func listDomains(_ call: CAPPluginCall) {
        print("[\(TAG)] listDomains called")
        
        let includeEmpty = call.getBool("includeEmpty") ?? false
        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/pkm/domains?include_empty=\(includeEmpty)"
        
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        
        executeRequest(request, call: call, backendUrl: backendUrl)
    }
    
    /**
     * Get domains for a specific user (only domains with data).
     * 
     * Parameters:
     * - userId: User's Firebase UID
     * - authToken: Firebase ID token for authentication
     * 
     * Returns:
     * - domains: Array of domain metadata objects with user-specific counts
     */
    @objc func getUserDomains(_ call: CAPPluginCall) {
        print("[\(TAG)] getUserDomains called")
        guard let userId = call.getString("userId") else {
            call.reject("Missing required parameter: userId")
            return
        }
        
        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/pkm/domains/\(userId)"
        
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        
        executeRequest(request, call: call, backendUrl: backendUrl)
    }
    
    /**
     * Get available consent scopes for a user.
     * 
     * Parameters:
     * - userId: User's Firebase UID
     * - authToken: Firebase ID token for authentication
     * 
     * Returns:
     * - scopes: Array of available scopes with display information
     * - wildcards: Array of wildcard scopes (e.g., "attr.financial.*")
     */
    @objc func getAvailableScopes(_ call: CAPPluginCall) {
        print("[\(TAG)] getAvailableScopes called")
        guard let userId = call.getString("userId") else {
            call.reject("Missing required parameter: userId")
            return
        }
        
        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/pkm/scopes/\(userId)"
        
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        
        executeRequest(request, call: call, backendUrl: backendUrl)
    }

    /**
     * Get user's portfolio data.
     */
    @objc func getPortfolio(_ call: CAPPluginCall) {
        print("[\(TAG)] getPortfolio called")
        guard let userId = call.getString("userId") else {
            call.reject("Missing required parameter: userId")
            return
        }

        let portfolioName = call.getString("portfolioName") ?? "Main Portfolio"
        let encodedName = portfolioName.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? portfolioName
        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/pkm/portfolio/\(userId)?portfolio_name=\(encodedName)"

        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")

        executeRequest(request, call: call, backendUrl: backendUrl)
    }

    /**
     * List all portfolios for a user.
     */
    @objc func listPortfolios(_ call: CAPPluginCall) {
        print("[\(TAG)] listPortfolios called")
        guard let userId = call.getString("userId") else {
            call.reject("Missing required parameter: userId")
            return
        }

        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/pkm/portfolios/\(userId)"

        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")

        executeRequest(request, call: call, backendUrl: backendUrl)
    }
    
    /**
     * Import portfolio from file.
     * 
     * Note: This method requires file picker integration.
     * The file should be passed as base64 encoded data.
     * 
     * Parameters:
     * - userId: User's Firebase UID
     * - fileData: Base64 encoded file data
     * - fileName: Original file name
     * - fileType: MIME type (e.g., "text/csv", "application/pdf")
     * - authToken: Firebase ID token for authentication
     * 
     * Returns:
     * - success: Boolean indicating success
     * - holdings_count: Number of holdings imported
     * - total_value: Total portfolio value
     */
    @objc func importPortfolio(_ call: CAPPluginCall) {
        print("[\(TAG)] importPortfolio called")
        guard let userId = call.getString("userId"),
              let fileData = call.getString("fileData"),
              let fileName = call.getString("fileName") else {
            call.reject("Missing required parameters: userId, fileData, fileName")
            return
        }
        
        let fileType = call.getString("fileType") ?? "text/csv"
        guard let vaultOwnerToken = getVaultOwnerToken(call) else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/kai/portfolio/import"
        
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }
        
        // Create multipart form data
        let boundary = UUID().uuidString
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        
        var body = Data()
        
        // Add user_id field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"user_id\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(userId)\r\n".data(using: .utf8)!)
        
        // Add file field
        if let fileDataDecoded = Data(base64Encoded: fileData) {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
            body.append("Content-Type: \(fileType)\r\n\r\n".data(using: .utf8)!)
            body.append(fileDataDecoded)
            body.append("\r\n".data(using: .utf8)!)
        }
        
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body
        
        // Use longer timeout for file upload
        let uploadSession = URLSession(configuration: {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 120
            config.timeoutIntervalForResource = 180
            return config
        }())
        
        uploadSession.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }
            
            if let error = error {
                print("[\(self.TAG)] Network error: \(error.localizedDescription)")
                call.reject("Network error: \(error.localizedDescription)")
                return
            }
            
            if let httpResponse = response as? HTTPURLResponse {
                if !(200...299).contains(httpResponse.statusCode) {
                    let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "no body"
                    call.reject("HTTP Error \(httpResponse.statusCode): \(bodyStr)")
                    return
                }
            }
            
            guard let data = data else {
                call.reject("No data received")
                return
            }
            
            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    call.resolve(json)
                } else {
                    call.reject("Invalid response format")
                }
            } catch {
                call.reject("JSON parsing error: \(error.localizedDescription)")
            }
        }.resume()
    }
    
    // MARK: - Helper Methods
    
    private func executeRequest(_ request: URLRequest, call: CAPPluginCall, backendUrl: String) {
        urlSession.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }
            
            if let error = error {
                let errorMsg = "Network error: \(error.localizedDescription)"
                print("[\(self.TAG)] \(errorMsg)")
                call.reject(errorMsg)
                return
            }
            
            if let httpResponse = response as? HTTPURLResponse {
                print("[\(self.TAG)] Response status: \(httpResponse.statusCode)")
                if !(200...299).contains(httpResponse.statusCode) {
                    let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "no body"
                    let truncatedBody = bodyStr.count > 200 ? String(bodyStr.prefix(200)) + "..." : bodyStr
                    let errorMsg = "HTTP Error \(httpResponse.statusCode): \(truncatedBody)"
                    print("[\(self.TAG)] \(errorMsg)")
                    call.reject(errorMsg)
                    return
                }
            }
            
            guard let data = data else {
                print("[\(self.TAG)] No data received")
                call.reject("No data received")
                return
            }
            
            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    print("[\(self.TAG)] Success")
                    call.resolve(json)
                } else if let array = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                    print("[\(self.TAG)] Success (Array)")
                    call.resolve(["data": array])
                } else {
                    print("[\(self.TAG)] Invalid response format")
                    call.reject("Invalid response format")
                }
            } catch {
                print("[\(self.TAG)] JSON parsing error: \(error.localizedDescription)")
                call.reject("JSON parsing error: \(error.localizedDescription)")
            }
        }.resume()
    }
}
