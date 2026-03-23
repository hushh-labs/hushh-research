import Foundation
import Capacitor

enum HushhProxyError: Error, LocalizedError {
    case missingParameter(String)
    case invalidUrl(String)
    case httpError(status: Int, body: String?)
    case invalidJson

    var errorDescription: String? {
        switch self {
        case .missingParameter(let name):
            return "Missing required parameter: \(name)"
        case .invalidUrl(let url):
            return "Invalid URL: \(url)"
        case .httpError(let status, let body):
            if let body = body, !body.isEmpty {
                return "HTTP Error \(status): \(body)"
            }
            return "HTTP Error \(status)"
        case .invalidJson:
            return "Invalid JSON response"
        }
    }
}

final class HushhProxyClient {
    private static let sharedPluginConfigOrder = [
        "HushhRuntime",
        "HushhVault",
        "HushhConsent",
        "PersonalKnowledgeModel",
        "Kai",
        "HushhNotifications",
        "HushhAccount",
        "HushhSync"
    ]

    private static func firstNonEmpty(_ values: [String?]) -> String? {
        for value in values {
            guard let raw = value?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !raw.isEmpty else {
                continue
            }
            return raw
        }
        return nil
    }

    static func resolveBackendUrl(
        call: CAPPluginCall,
        plugin: CAPPlugin,
        jsName: String
    ) -> String {
        var candidates: [String?] = [
            // 1) Per-call override
            call.getString("backendUrl"),
            // 2) Plugin config: plugins.<jsName>.backendUrl
            plugin.bridge?.config.getPluginConfig(jsName).getString("backendUrl"),
            // 3) Shared plugin config(s): first configured wins
            ProcessInfo.processInfo.environment["NEXT_PUBLIC_BACKEND_URL"]
        ]

        for pluginName in sharedPluginConfigOrder where pluginName != jsName {
            candidates.insert(
                plugin.bridge?.config.getPluginConfig(pluginName).getString("backendUrl"),
                at: candidates.count - 1
            )
        }

        if let url = firstNonEmpty(candidates) {
            return normalizeBackendUrl(url)
        }

        return ""
    }

    private static func normalizeBackendUrl(_ raw: String) -> String {
        var url = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while url.hasSuffix("/") { url.removeLast() }
        return url
    }

    static func requireNonEmptyString(
        _ call: CAPPluginCall,
        _ key: String
    ) throws -> String {
        guard let value = call.getString(key)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty else {
            throw HushhProxyError.missingParameter(key)
        }
        return value
    }

    static func optionalBearerToken(
        _ call: CAPPluginCall,
        keys: [String]
    ) -> String? {
        for k in keys {
            if let raw = call.getString(k)?
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !raw.isEmpty {
                return raw
            }
        }
        return nil
    }

    static func makeJsonRequest(
        method: String,
        urlStr: String,
        bearerToken: String? = nil,
        jsonBody: Any? = nil
    ) throws -> URLRequest {
        guard let url = URL(string: urlStr) else {
            throw HushhProxyError.invalidUrl(urlStr)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let token = bearerToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        if let body = jsonBody {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        return request
    }

    static func executeJson(
        _ session: URLSession,
        request: URLRequest,
        completion: @escaping (Result<Any, Error>) -> Void
    ) {
        session.dataTask(with: request) { data, response, error in
            if let error = error {
                completion(.failure(error))
                return
            }

            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if !(200...299).contains(status) {
                let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) }
                let truncated = bodyStr.map { $0.count > 500 ? String($0.prefix(500)) + "..." : $0 }
                completion(.failure(HushhProxyError.httpError(status: status, body: truncated ?? bodyStr)))
                return
            }

            guard let data = data, !data.isEmpty else {
                completion(.success([String: Any]()))
                return
            }

            do {
                let json = try JSONSerialization.jsonObject(with: data)
                completion(.success(json))
            } catch {
                completion(.failure(error))
            }
        }.resume()
    }

    /// Capacitor cannot resolve a top-level JSON array directly. We standardize on:
    /// - dict → pass through
    /// - array → wrap in `data` (service layer must normalize on web/native)
    static func resolveToCall(_ call: CAPPluginCall, json: Any, arrayKey: String = "data") throws {
        if let dict = json as? [String: Any] {
            call.resolve(dict)
            return
        }
        if let array = json as? [[String: Any]] {
            call.resolve([arrayKey: array])
            return
        }
        if let array = json as? [Any] {
            call.resolve([arrayKey: array])
            return
        }
        throw HushhProxyError.invalidJson
    }
}
