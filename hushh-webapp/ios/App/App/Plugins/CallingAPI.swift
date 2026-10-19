import Foundation
import FirebaseAuth

private final class CallingNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor
final class CallingAPI {
    let identity: CallingIdentity
    private let origin: URL
    private let user: User
    private let session = URLSession(configuration: .ephemeral, delegate: CallingNoRedirect(), delegateQueue: nil)
    private var closed = false

    /// Read ONLY the shipped configuration; neither pushes nor JS select an origin.
    static func shippedOrigin() throws -> URL {
        guard let file = Bundle.main.url(forResource: "capacitor.config", withExtension: "json"),
              let config = try CallingWire.object(Data(contentsOf: file))["plugins"] as? [String: Any],
              let runtime = config["HushhRuntime"] as? [String: Any], let raw = runtime["backendUrl"] as? String,
              let url = URL(string: raw), url.scheme == "https", url.host != nil,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else { throw CallingError.unavailable }
        return url
    }
    init(user: User, origin: URL) throws {
        self.user = user
        self.origin = origin
        identity = try CallingIdentity(owner: user.uid, origin: origin.absoluteString)
    }
    func check() throws {
        guard !closed, Auth.auth().currentUser === user else { throw CallingError.cancelled }
    }
    func close() { closed = true; session.invalidateAndCancel() }

    func request(_ path: String, body: [String: Any]? = nil, timeout: TimeInterval = 15) async throws -> [String: Any] {
        try check()
        let token = try await user.getIDToken()
        try check()
        var request = URLRequest(url: origin.appendingPathComponent(path), cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { request.httpBody = try CallingWire.bytes(body) }
        let (data, response) = try await session.data(for: request)
        try check()
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
              data.count <= 650_000 else { throw CallingError.unavailable }
        return try CallingWire.object(data)
    }
    func initialize() async throws {
        let capabilities = try await request("api/one/messages/calls/capabilities")
        guard capabilities["available"] as? Bool == true, capabilities["iosAvailable"] as? Bool == true else { throw CallingError.unavailable }
        if identity.deviceId.isEmpty {
            let result = try await request("api/account/trusted-devices/self-enroll", body: [
                "devicePublicKey": identity.signingKey, "deviceName": "iPhone calling", "platform": "ios"])
            try identity.enroll(CallingWire.string(result, "device_id"))
        }
        _ = try await command("register-key", ["keyId": identity.keyId, "publicKey": identity.publicKey])
    }
    func command(_ operation: String, _ payload: [String: Any] = [:], timeout: TimeInterval = 15) async throws -> [String: Any] {
        try await request("api/one/messages/calls/\(operation)", body: ["payload": payload,
            "proof": identity.proof(operation: operation, payload: payload)], timeout: timeout)
    }
    func directory(_ conversation: String) async throws -> [[String: Any]] {
        let result = try await command("directory", ["conversationId": conversation])
        guard let devices = result["items"] as? [[String: Any]], !devices.isEmpty, devices.count <= 40,
              Set(devices.compactMap { $0["deviceId"] as? String }).count == devices.count,
              Set(devices.compactMap { $0["userId"] as? String }).count == 2 else { throw CallingError.invalid }
        for device in devices {
            guard let signed = device["enrollment"] as? [String: Any], let payload = signed["payload"] as? [String: Any],
                  payload["keyId"] as? String == device["keyId"] as? String,
                  payload["publicKey"] as? String == device["publicKey"] as? String else { throw CallingError.invalid }
            try CallingWire.verify(device, operation: "register-key", signed: signed, historical: true)
        }
        guard devices.contains(where: { $0["deviceId"] as? String == identity.deviceId && $0["userId"] as? String == identity.owner
            && $0["keyId"] as? String == identity.keyId && $0["publicKey"] as? String == identity.publicKey
            && $0["signingKey"] as? String == identity.signingKey }) else { throw CallingError.invalid }
        return devices
    }
}
