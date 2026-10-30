// hushh-webapp/ios/App/App/Plugins/HushhAccountPlugin.swift
import Capacitor

/**
 * HushhAccountPlugin
 * Handles account-level operations like deletion.
 */
@objc(HushhAccountPlugin)
public class HushhAccountPlugin: CAPPlugin, CAPBridgedPlugin {
    
    public let identifier = "HushhAccountPlugin"
    public let jsName = "HushhAccount"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "deleteAccount", returnType: CAPPluginReturnPromise)
    ]
    
    private lazy var urlSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 45 // Longer timeout for deletion
        return URLSession(configuration: config)
    }()

    private let maxErrorPayloadBytes = 16_384
    private let maxErrorPayloadDepth = 6
    private let maxErrorPayloadNodes = 64
    private let maxErrorPayloadEntries = 32
    private let maxErrorCodeLength = 128
    private let maxErrorMessageLength = 512

    private func normalizedMachineCode(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let code = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty, code.count <= maxErrorCodeLength else { return nil }
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")
        return code.unicodeScalars.allSatisfy(allowed.contains) ? code : nil
    }

    private func machineCode(
        in value: Any?,
        depth: Int = 0,
        remainingNodes: inout Int
    ) -> String? {
        guard depth <= maxErrorPayloadDepth, remainingNodes > 0 else {
            return nil
        }
        remainingNodes -= 1

        if let dictionary = value as? [String: Any] {
            for key in ["code", "error_code"] {
                if let code = normalizedMachineCode(dictionary[key]) {
                    return code
                }
            }
            for (_, child) in dictionary.prefix(maxErrorPayloadEntries) {
                if let code = machineCode(
                    in: child,
                    depth: depth + 1,
                    remainingNodes: &remainingNodes
                ) {
                    return code
                }
            }
        } else if let array = value as? [Any] {
            for child in array.prefix(maxErrorPayloadEntries) {
                if let code = machineCode(
                    in: child,
                    depth: depth + 1,
                    remainingNodes: &remainingNodes
                ) {
                    return code
                }
            }
        }
        return nil
    }

    private func errorMessage(from payload: [String: Any]?, fallback: String) -> String {
        let detail = payload?["detail"]
        let detailObject = detail as? [String: Any]
        let candidates: [Any?] = [
            detailObject?["message"],
            detailObject?["error"],
            payload?["message"],
            payload?["error"],
            detail,
        ]
        for candidate in candidates {
            guard let raw = candidate as? String else { continue }
            let message = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if !message.isEmpty {
                return String(message.prefix(maxErrorMessageLength))
            }
        }
        return fallback
    }
    
    @objc func deleteAccount(_ call: CAPPluginCall) {
        // Get auth token passed from JS layer
        guard let authToken = call.getString("authToken") else {
             call.reject("Missing required parameter: authToken")
             return
        }
        let target = call.getString("target") ?? "both"
        
        let backendUrl = HushhProxyClient.resolveBackendUrl(
            call: call,
            plugin: self,
            jsName: jsName
        )
        
        guard let url = URL(string: "\(backendUrl)/api/account/delete") else {
            call.reject("Invalid URL")
            return
        }
        
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(authToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "target": target
        ])
        
        print("🚨 [HushhAccountPlugin] Requesting account deletion for target: \(target)")
        
        let task = urlSession.dataTask(with: request) { data, response, error in
            if let error = error {
                call.reject("Network error: \(error.localizedDescription)")
                return
            }
            
            if let httpResponse = response as? HTTPURLResponse {
                if (200...299).contains(httpResponse.statusCode) {
                    if let data = data,
                       let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                        call.resolve(json)
                    } else {
                        call.resolve(["success": true])
                    }
                } else {
                    let boundedData = data.flatMap {
                        $0.count <= self.maxErrorPayloadBytes ? $0 : nil
                    }
                    let payload = boundedData.flatMap {
                        try? JSONSerialization.jsonObject(with: $0) as? [String: Any]
                    }
                    var remainingNodes = self.maxErrorPayloadNodes
                    let code = self.machineCode(
                        in: payload,
                        remainingNodes: &remainingNodes
                    )
                    let message = self.errorMessage(
                        from: payload,
                        fallback: "Server returned \(httpResponse.statusCode)"
                    )
                    var rejectionData: [String: Any] = [
                        "status": httpResponse.statusCode
                    ]
                    if let payload {
                        rejectionData["payload"] = payload
                    }
                    call.reject(message, code, nil, rejectionData)
                }
            } else {
                call.reject("Invalid response")
            }
        }
        task.resume()
    }
}
