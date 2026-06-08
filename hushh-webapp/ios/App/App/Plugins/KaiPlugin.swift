import UIKit
import Capacitor

/**
 * Kai Plugin - iOS Implementation
 * 
 * Native plugin for Agent Kai stock analysis.
 * Makes HTTP calls to backend from native code.
 * 
 * Authentication:
 * - All consent-gated operations use VAULT_OWNER token
 * - Token proves both identity (user_id) and consent (vault unlocked)
 * - Firebase is only used for bootstrap (issuing VAULT_OWNER token)
 * 
 * Aligned with Android KaiPlugin implementation for consistent behavior.
 */

@objc(KaiPlugin)
public class KaiPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDataDelegate {
    
    private let TAG = "KaiPlugin"
    
    // MARK: - CAPBridgedPlugin Protocol (MUST be declared before any other properties)
    public let identifier = "KaiPlugin"
    public let jsName = "Kai"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "grantConsent", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "analyze", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "importPortfolio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "analyzePortfolioLosers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "streamPortfolioImport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "streamPortfolioImportRun", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "streamPortfolioAnalyzeLosers", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "streamKaiAnalysis", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "chat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getInitialChatState", returnType: CAPPluginReturnPromise)
    ]
    
    // URLSession with timeouts matching Android (Kai analysis can take 2+ minutes)
    private lazy var urlSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 150  // Match Android readTimeout
        config.timeoutIntervalForResource = 170 // Match Android callTimeout
        return URLSession(configuration: config)
    }()
    
    // Streaming: session with delegate to receive incremental SSE data (WKWebView buffers fetch otherwise)
    private var streamSession: URLSession?
    private var streamCall: CAPPluginCall?
    private var streamBuffer = ""
    private var streamTask: URLSessionDataTask?
    private var activeStreamKind: String = "portfolio"
    
    // MARK: - Configuration
    
    private func getBackendUrl(_ call: CAPPluginCall) -> String {
        let url = HushhProxyClient.resolveBackendUrl(
            call: call,
            plugin: self,
            jsName: jsName
        )
        print("[\(TAG)] 🌐 Resolved backendUrl: \(url)")
        return url
    }
    
    // MARK: - Plugin Methods
    
    @objc func grantConsent(_ call: CAPPluginCall) {
        print("[\(TAG)] 🔍 grantConsent called")
        guard let userId = call.getString("userId"),
              let scopes = call.getArray("scopes", String.self) else {
            print("[\(TAG)] ❌ Missing required parameters: userId, scopes")
            call.reject("Missing required parameters: userId, scopes")
            return
        }

        // Bootstrap route: backend requires Firebase ID token (NOT VAULT_OWNER).
        guard let authToken = call.getString("authToken"), !authToken.isEmpty else {
            call.reject("Missing authToken (Firebase ID token) for grantConsent")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/kai/consent/grant"
        print("[\(TAG)] 🌐 URL: \(urlStr)")
        
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        
        let body: [String: Any] = [
            "user_id": userId,
            "scopes": scopes
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        
        urlSession.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }
            
            if let error = error {
                let errorMsg = "Network error: \(error.localizedDescription) | backendUrl: \(backendUrl)"
                print("[\(self.TAG)] ❌ \(errorMsg)")
                call.reject(errorMsg)
                return
            }
            
            if let httpResponse = response as? HTTPURLResponse {
                print("[\(self.TAG)] 📡 Response status: \(httpResponse.statusCode)")
                if !(200...299).contains(httpResponse.statusCode) {
                    let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "no body"
                    let truncatedBody = bodyStr.count > 200 ? String(bodyStr.prefix(200)) + "..." : bodyStr
                    let errorMsg = "HTTP Error \(httpResponse.statusCode) | backendUrl: \(backendUrl) | body: \(truncatedBody)"
                    print("[\(self.TAG)] ❌ \(errorMsg)")
                    call.reject(errorMsg)
                    return
                }
            }
            
            guard let data = data else {
                print("[\(self.TAG)] ❌ No data received")
                call.reject("No data received")
                return
            }
            
            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    // Normalize response shape to match TS contract:
                    // Promise<{ token: string; expires_at: string }>
                    if let tokens = json["tokens"] as? [String: Any] {
                        let token =
                            (tokens["agent.kai.analyze"] as? String) ??
                            (tokens.values.first as? String) ??
                            ""
                        let expiresAt = (json["expires_at"] as? String) ?? ""
                        call.resolve(["token": token, "expires_at": expiresAt])
                    } else if let token = json["token"] as? String, let expiresAt = json["expires_at"] as? String {
                        call.resolve(["token": token, "expires_at": expiresAt])
                    } else {
                        print("[\(self.TAG)] ✅ grantConsent success (unrecognized shape): \(json.keys)")
                        call.resolve(json)
                    }
                } else if let array = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
                    print("[\(self.TAG)] ✅ grantConsent success (Array)")
                    call.resolve(["data": array])
                } else {
                    print("[\(self.TAG)] ❌ Invalid response format")
                    call.reject("Invalid response format")
                }
            } catch {
                print("[\(self.TAG)] ❌ JSON parsing error: \(error.localizedDescription)")
                call.reject("JSON parsing error: \(error.localizedDescription)")
            }
        }.resume()
    }
    
    @objc func analyze(_ call: CAPPluginCall) {
        print("[\(TAG)] 🔍 analyze called")
        guard let userId = call.getString("userId"),
              let ticker = call.getString("ticker"),
              let consentToken = call.getString("consentToken"),
              let riskProfile = call.getString("riskProfile"),
              let processingMode = call.getString("processingMode") else {
            print("[\(TAG)] ❌ Missing required parameters")
            call.reject("Missing required parameters")
            return
        }
        
        // Consent-gated: requires VAULT_OWNER token
        guard let vaultOwnerToken = call.getString("vaultOwnerToken"), !vaultOwnerToken.isEmpty else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/kai/analyze"
        print("[\(TAG)] 🌐 URL: \(urlStr)")
        
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
            "ticker": ticker,
            "consent_token": consentToken,
            "risk_profile": riskProfile,
            "processing_mode": processingMode
        ]
        
        // Include context if provided
        if let context = call.getObject("context") {
            body["context"] = context
        }
        
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        
        urlSession.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }
            
            if let error = error {
                let errorMsg = "Network error: \(error.localizedDescription) | backendUrl: \(backendUrl)"
                print("[\(self.TAG)] ❌ \(errorMsg)")
                call.reject(errorMsg)
                return
            }
            
            if let httpResponse = response as? HTTPURLResponse {
                print("[\(self.TAG)] 📡 Response status: \(httpResponse.statusCode)")
                if !(200...299).contains(httpResponse.statusCode) {
                    let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "no body"
                    let truncatedBody = bodyStr.count > 200 ? String(bodyStr.prefix(200)) + "..." : bodyStr
                    let errorMsg = "HTTP Error \(httpResponse.statusCode) | backendUrl: \(backendUrl) | body: \(truncatedBody)"
                    print("[\(self.TAG)] ❌ \(errorMsg)")
                    call.reject(errorMsg)
                    return
                }
            }
            
            guard let data = data else {
                print("[\(self.TAG)] ❌ No data received")
                call.reject("No data received")
                return
            }
            
            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    print("[\(self.TAG)] ✅ analyze success")
                    // Aligned with Android: return flat JSON directly
                    call.resolve(json)
                } else {
                    print("[\(self.TAG)] ❌ Invalid response format")
                    call.reject("Invalid response format")
                }
            } catch {
                print("[\(self.TAG)] ❌ JSON parsing error: \(error.localizedDescription)")
                call.reject("JSON parsing error: \(error.localizedDescription)")
            }
        }.resume()
    }
    
    // MARK: - Portfolio Import
    
    @objc func importPortfolio(_ call: CAPPluginCall) {
        print("[\(TAG)] 🔍 importPortfolio called")
        
        guard let userId = call.getString("userId"),
              let fileName = call.getString("fileName"),
              let mimeType = call.getString("mimeType"),
              let vaultOwnerToken = call.getString("vaultOwnerToken"),
              let fileBase64 = call.getString("fileBase64") else {
            print("[\(TAG)] ❌ Missing required parameters: userId, fileName, mimeType, vaultOwnerToken, fileBase64")
            call.reject("Missing required parameters: userId, fileName, mimeType, vaultOwnerToken, fileBase64")
            return
        }
        
        // Decode base64 file content
        guard let fileData = Data(base64Encoded: fileBase64) else {
            print("[\(TAG)] ❌ Invalid base64 file content")
            call.reject("Invalid base64 file content")
            return
        }
        
        // Check file size (max 25MB)
        if fileData.count > 25 * 1024 * 1024 {
            print("[\(TAG)] ❌ File too large")
            call.reject("File too large. Maximum size is 25MB.")
            return
        }
        
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/kai/portfolio/import"
        print("[\(TAG)] 🌐 URL: \(urlStr)")
        print("[\(TAG)] 📁 File: \(fileName) (\(fileData.count) bytes)")
        
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }
        
        // Create multipart form data request
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        // Use VAULT_OWNER token for consent-gated access
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        
        // Build multipart body
        var body = Data()
        
        // Add user_id field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"user_id\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(userId)\r\n".data(using: .utf8)!)
        
        // Add file field
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n".data(using: .utf8)!)
        
        // Close boundary
        body.append("--\(boundary)--\r\n".data(using: .utf8)!)
        
        request.httpBody = body
        
        urlSession.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }
            
            if let error = error {
                let errorMsg = "Network error: \(error.localizedDescription) | backendUrl: \(backendUrl)"
                print("[\(self.TAG)] ❌ \(errorMsg)")
                call.reject(errorMsg)
                return
            }
            
            if let httpResponse = response as? HTTPURLResponse {
                print("[\(self.TAG)] 📡 Response status: \(httpResponse.statusCode)")
                if !(200...299).contains(httpResponse.statusCode) {
                    let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "no body"
                    let truncatedBody = bodyStr.count > 500 ? String(bodyStr.prefix(500)) + "..." : bodyStr
                    let errorMsg = "HTTP Error \(httpResponse.statusCode) | backendUrl: \(backendUrl) | body: \(truncatedBody)"
                    print("[\(self.TAG)] ❌ \(errorMsg)")
                    call.reject(errorMsg)
                    return
                }
            }
            
            guard let data = data else {
                print("[\(self.TAG)] ❌ No data received")
                call.reject("No data received")
                return
            }
            
            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    print("[\(self.TAG)] ✅ importPortfolio success: holdings=\(json["holdings_count"] ?? "?")")
                    call.resolve(json)
                } else {
                    print("[\(self.TAG)] ❌ Invalid response format")
                    call.reject("Invalid response format")
                }
            } catch {
                print("[\(self.TAG)] ❌ JSON parsing error: \(error.localizedDescription)")
                call.reject("JSON parsing error: \(error.localizedDescription)")
            }
        }.resume()
    }

    // MARK: - Losers Analysis

    @objc func analyzePortfolioLosers(_ call: CAPPluginCall) {
        print("[\(TAG)] 🔍 analyzePortfolioLosers called")

        guard let userId = call.getString("userId"),
              let losers = call.getArray("losers", JSObject.self),
              let vaultOwnerToken = call.getString("vaultOwnerToken") else {
            print("[\(TAG)] ❌ Missing required parameters: userId, losers, vaultOwnerToken")
            call.reject("Missing required parameters: userId, losers, vaultOwnerToken")
            return
        }

        let thresholdPct = call.getDouble("thresholdPct") ?? -5.0
        let maxPositions = call.getInt("maxPositions") ?? 10

        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/kai/portfolio/analyze-losers"
        print("[\(TAG)] 🌐 URL: \(urlStr)")

        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")

        let body: [String: Any] = [
            "user_id": userId,
            "losers": losers,
            "threshold_pct": thresholdPct,
            "max_positions": maxPositions
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        urlSession.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }

            if let error = error {
                let errorMsg = "Network error: \(error.localizedDescription) | backendUrl: \(backendUrl)"
                print("[\(self.TAG)] ❌ \(errorMsg)")
                call.reject(errorMsg)
                return
            }

            if let httpResponse = response as? HTTPURLResponse {
                print("[\(self.TAG)] 📡 Response status: \(httpResponse.statusCode)")
                if !(200...299).contains(httpResponse.statusCode) {
                    let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "no body"
                    let truncatedBody = bodyStr.count > 500 ? String(bodyStr.prefix(500)) + "..." : bodyStr
                    let errorMsg = "HTTP Error \(httpResponse.statusCode) | backendUrl: \(backendUrl) | body: \(truncatedBody)"
                    print("[\(self.TAG)] ❌ \(errorMsg)")
                    call.reject(errorMsg)
                    return
                }
            }

            guard let data = data else {
                print("[\(self.TAG)] ❌ No data received")
                call.reject("No data received")
                return
            }

            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    print("[\(self.TAG)] ✅ analyzePortfolioLosers success")
                    call.resolve(json)
                } else {
                    print("[\(self.TAG)] ❌ Invalid response format")
                    call.reject("Invalid response format")
                }
            } catch {
                print("[\(self.TAG)] ❌ JSON parsing error: \(error.localizedDescription)")
                call.reject("JSON parsing error: \(error.localizedDescription)")
            }
        }.resume()
    }
    
    // MARK: - Streaming (real-time SSE on iOS; avoids WKWebView fetch buffering)
    
    private static let kPortfolioStreamEvent = "portfolioStreamEvent"
    private static let kKaiStreamEvent = "kaiStreamEvent"
    
    private func makeStreamSession() -> URLSession {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 180
        config.timeoutIntervalForResource = 3600
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }
    
    private func emitPortfolioEvent(_ data: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners(KaiPlugin.kPortfolioStreamEvent, data: data)
        }
    }

    private func emitKaiEvent(_ data: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners(KaiPlugin.kKaiStreamEvent, data: data)
        }
    }
    
    private func parseJSONObject(_ rawData: String) -> [String: Any]? {
        guard let data = rawData.data(using: .utf8) else { return nil }
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return object
        }
        if let jsonValue = try? JSONSerialization.jsonObject(with: data) as? String,
           let nested = jsonValue.data(using: .utf8),
           let nestedObject = try? JSONSerialization.jsonObject(with: nested) as? [String: Any] {
            return nestedObject
        }
        return nil
    }

    private func parseSSEBlock(_ block: String) -> (eventName: String?, eventId: String?, payload: [String: Any]?) {
        var eventName: String?
        var eventId: String?
        var dataLines: [String] = []

        for raw in block.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw).trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("event:") {
                eventName = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("id:") {
                eventId = line.dropFirst(3).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                dataLines.append(line.dropFirst(5).trimmingCharacters(in: .whitespaces))
            }
        }

        let dataText = dataLines.joined(separator: "\n")
        guard !dataText.isEmpty else { return (eventName, eventId, nil) }
        return (eventName, eventId, parseJSONObject(dataText))
    }

    private func parseSSEBlocksAndEmit(isKai: Bool) {
        while let range = streamBuffer.range(of: "\n\n") {
            let block = String(streamBuffer[..<range.lowerBound])
            streamBuffer = String(streamBuffer[range.upperBound...])
            let parsed = parseSSEBlock(block)
            guard let payload = parsed.payload else { continue }
            let eventType = parsed.eventName ?? "message"

            if isKai {
                emitKaiEvent([
                    "event": eventType,
                    "data": payload,
                    "id": parsed.eventId ?? "",
                ])
            } else {
                emitPortfolioEvent([
                    "event": eventType,
                    "data": payload,
                    "id": parsed.eventId ?? "",
                ])
            }
        }
    }
    
    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if let str = String(data: data, encoding: .utf8) {
            streamBuffer += str.replacingOccurrences(of: "\r\n", with: "\n")
            // The active stream decides which parser to use.
            if activeStreamKind == "kai" {
                parseSSEBlocksAndEmit(isKai: true)
            } else {
                parseSSEBlocksAndEmit(isKai: false)
            }
        }
    }
    
    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let call = streamCall
        streamCall = nil
        streamTask = nil
        
        // Process any remaining buffer before clearing
        if !streamBuffer.isEmpty {
            streamBuffer += "\n\n"
            if activeStreamKind == "kai" {
                parseSSEBlocksAndEmit(isKai: true)
            } else {
                parseSSEBlocksAndEmit(isKai: false)
            }
        }
        streamBuffer = ""
        
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if let error = error {
                call?.reject("Stream error: \(error.localizedDescription)")
                return
            }
            if let httpResponse = task.response as? HTTPURLResponse, !(200...299).contains(httpResponse.statusCode) {
                call?.reject("HTTP \(httpResponse.statusCode)")
                return
            }
            call?.resolve(["success": true])
        }
    }
    
    @objc func streamPortfolioImport(_ call: CAPPluginCall) {
        activeStreamKind = "portfolio"
        guard let userId = call.getString("userId"),
              let fileName = call.getString("fileName"),
              let mimeType = call.getString("mimeType"),
              let vaultOwnerToken = call.getString("vaultOwnerToken"),
              let fileBase64 = call.getString("fileBase64") else {
            call.reject("Missing required parameters: userId, fileName, mimeType, vaultOwnerToken, fileBase64")
            return
        }
        guard let fileData = Data(base64Encoded: fileBase64) else {
            call.reject("Invalid base64 file content")
            return
        }
        if fileData.count > 25 * 1024 * 1024 {
            call.reject("File too large. Maximum size is 25MB.")
            return
        }
        if streamCall != nil {
            call.reject("A stream is already in progress")
            return
        }
        
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/kai/portfolio/import/stream"
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }
        
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"user_id\"\r\n\r\n".data(using: .utf8)!)
        body.append("\(userId)\r\n".data(using: .utf8)!)
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        request.httpBody = body
        
        streamCall = call
        streamBuffer = ""
        streamSession = makeStreamSession()
        streamTask = streamSession?.dataTask(with: request)
        streamTask?.resume()
    }

    @objc func streamPortfolioImportRun(_ call: CAPPluginCall) {
        activeStreamKind = "portfolio"
        guard let runId = call.getString("runId"),
              let userId = call.getString("userId"),
              let vaultOwnerToken = call.getString("vaultOwnerToken") else {
            call.reject("Missing required parameters: runId, userId, vaultOwnerToken")
            return
        }
        let cursor = max(0, call.getInt("cursor") ?? 0)
        if streamCall != nil {
            call.reject("A stream is already in progress")
            return
        }

        let backendUrl = getBackendUrl(call)
        let encodedRunId = runId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? runId
        guard var components = URLComponents(string: "\(backendUrl)/api/kai/portfolio/import/run/\(encodedRunId)/stream") else {
            call.reject("Invalid URL components for streamPortfolioImportRun")
            return
        }
        components.queryItems = [
            URLQueryItem(name: "user_id", value: userId),
            URLQueryItem(name: "cursor", value: String(cursor)),
        ]
        guard let url = components.url else {
            call.reject("Invalid URL for streamPortfolioImportRun")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

        streamCall = call
        streamBuffer = ""
        streamSession = makeStreamSession()
        streamTask = streamSession?.dataTask(with: request)
        streamTask?.resume()
    }

    @objc func streamKaiAnalysis(_ call: CAPPluginCall) {
        guard let vaultOwnerToken = call.getString("vaultOwnerToken") else {
            call.reject("Missing vaultOwnerToken")
            return
        }
        guard let body = call.getObject("body") else {
            call.reject("Missing body")
            return
        }
        if streamCall != nil {
            call.reject("A stream is already in progress")
            return
        }

        activeStreamKind = "kai"
        let backendUrl = getBackendUrl(call)
        let runId = (body["run_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let request: URLRequest

        if !runId.isEmpty {
            guard let userId = (body["user_id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !userId.isEmpty else {
                call.reject("Missing user_id for run stream")
                return
            }
            let cursor =
                (body["resume_cursor"] as? Int) ??
                (body["resume_cursor"] as? NSNumber)?.intValue ??
                0
            let encodedRunId = runId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? runId
            guard var components = URLComponents(string: "\(backendUrl)/api/kai/analyze/run/\(encodedRunId)/stream") else {
                call.reject("Invalid URL components for streamKaiAnalysis run")
                return
            }
            components.queryItems = [
                URLQueryItem(name: "user_id", value: userId),
                URLQueryItem(name: "cursor", value: String(max(0, cursor))),
            ]
            guard let url = components.url else {
                call.reject("Invalid URL for streamKaiAnalysis run")
                return
            }
            var runRequest = URLRequest(url: url)
            runRequest.httpMethod = "GET"
            runRequest.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
            runRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request = runRequest
        } else {
            let urlStr = "\(backendUrl)/api/kai/analyze/stream"
            guard let url = URL(string: urlStr) else {
                call.reject("Invalid URL: \(urlStr)")
                return
            }

            var analysisRequest = URLRequest(url: url)
            analysisRequest.httpMethod = "POST"
            analysisRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            analysisRequest.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
            analysisRequest.httpBody = try? JSONSerialization.data(withJSONObject: body)
            request = analysisRequest
        }

        streamCall = call
        streamBuffer = ""
        streamSession = makeStreamSession()
        streamTask = streamSession?.dataTask(with: request)
        streamTask?.resume()
    }
    
    @objc func streamPortfolioAnalyzeLosers(_ call: CAPPluginCall) {
        guard let bodyJson = call.getObject("body"),
              let vaultOwnerToken = call.getString("vaultOwnerToken") else {
            call.reject("Missing required parameters: body, vaultOwnerToken")
            return
        }
        if streamCall != nil {
            call.reject("A stream is already in progress")
            return
        }
        activeStreamKind = "portfolio"
        
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/kai/portfolio/analyze-losers/stream"
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }
        
        guard let bodyData = try? JSONSerialization.data(withJSONObject: bodyJson) else {
            call.reject("Invalid body JSON")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = bodyData
        
        streamCall = call
        streamBuffer = ""
        streamSession = makeStreamSession()
        streamTask = streamSession?.dataTask(with: request)
        streamTask?.resume()
    }
    
    // MARK: - Chat Methods
    
    @objc func chat(_ call: CAPPluginCall) {
        print("[\(TAG)] 🔍 chat called")
        
        guard let userId = call.getString("userId"),
              let message = call.getString("message"),
              let vaultOwnerToken = call.getString("vaultOwnerToken") else {
            print("[\(TAG)] ❌ Missing required parameters: userId, message, vaultOwnerToken")
            call.reject("Missing required parameters: userId, message, vaultOwnerToken")
            return
        }
        
        let conversationId = call.getString("conversationId")
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/kai/chat"
        print("[\(TAG)] 🌐 URL: \(urlStr)")
        
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Use VAULT_OWNER token for consent-gated access
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        
        var body: [String: Any] = [
            "user_id": userId,
            "message": message
        ]
        
        if let convId = conversationId {
            body["conversation_id"] = convId
        }
        
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        
        urlSession.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }
            
            if let error = error {
                let errorMsg = "Network error: \(error.localizedDescription) | backendUrl: \(backendUrl)"
                print("[\(self.TAG)] ❌ \(errorMsg)")
                call.reject(errorMsg)
                return
            }
            
            if let httpResponse = response as? HTTPURLResponse {
                print("[\(self.TAG)] 📡 Response status: \(httpResponse.statusCode)")
                if !(200...299).contains(httpResponse.statusCode) {
                    let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "no body"
                    let truncatedBody = bodyStr.count > 200 ? String(bodyStr.prefix(200)) + "..." : bodyStr
                    let errorMsg = "HTTP Error \(httpResponse.statusCode) | backendUrl: \(backendUrl) | body: \(truncatedBody)"
                    print("[\(self.TAG)] ❌ \(errorMsg)")
                    call.reject(errorMsg)
                    return
                }
            }
            
            guard let data = data else {
                print("[\(self.TAG)] ❌ No data received")
                call.reject("No data received")
                return
            }
            
            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    print("[\(self.TAG)] ✅ chat success")
                    call.resolve(json)
                } else {
                    print("[\(self.TAG)] ❌ Invalid response format")
                    call.reject("Invalid response format")
                }
            } catch {
                print("[\(self.TAG)] ❌ JSON parsing error: \(error.localizedDescription)")
                call.reject("JSON parsing error: \(error.localizedDescription)")
            }
        }.resume()
    }
    
    @objc func getInitialChatState(_ call: CAPPluginCall) {
        print("[\(TAG)] 🔍 getInitialChatState called")
        
        guard let userId = call.getString("userId") else {
            print("[\(TAG)] ❌ Missing required parameter: userId")
            call.reject("Missing required parameter: userId")
            return
        }
        
        // Consent-gated: requires VAULT_OWNER token
        guard let vaultOwnerToken = call.getString("vaultOwnerToken"), !vaultOwnerToken.isEmpty else {
            call.reject("Missing required parameter: vaultOwnerToken")
            return
        }
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/kai/chat/initial-state/\(userId)"
        print("[\(TAG)] 🌐 URL: \(urlStr)")
        
        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL: \(urlStr)")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        
        urlSession.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }
            
            if let error = error {
                let errorMsg = "Network error: \(error.localizedDescription) | backendUrl: \(backendUrl)"
                print("[\(self.TAG)] ❌ \(errorMsg)")
                call.reject(errorMsg)
                return
            }
            
            if let httpResponse = response as? HTTPURLResponse {
                print("[\(self.TAG)] 📡 Response status: \(httpResponse.statusCode)")
                if !(200...299).contains(httpResponse.statusCode) {
                    let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "no body"
                    let truncatedBody = bodyStr.count > 200 ? String(bodyStr.prefix(200)) + "..." : bodyStr
                    let errorMsg = "HTTP Error \(httpResponse.statusCode) | backendUrl: \(backendUrl) | body: \(truncatedBody)"
                    print("[\(self.TAG)] ❌ \(errorMsg)")
                    call.reject(errorMsg)
                    return
                }
            }
            
            guard let data = data else {
                print("[\(self.TAG)] ❌ No data received")
                call.reject("No data received")
                return
            }
            
            do {
                if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    print("[\(self.TAG)] ✅ getInitialChatState success")
                    call.resolve(json)
                } else {
                    print("[\(self.TAG)] ❌ Invalid response format")
                    call.reject("Invalid response format")
                }
            } catch {
                print("[\(self.TAG)] ❌ JSON parsing error: \(error.localizedDescription)")
                call.reject("JSON parsing error: \(error.localizedDescription)")
            }
        }.resume()
    }
}
