import Foundation
import CoreLocation
import CryptoKit

// Execute the real publisher with a synthetic network; no credentials or cloud.
final class StubProtocol: URLProtocol {
    static let lock = NSLock()
    static var responses: [Int] = []
    static var requestCount = 0
    static let delivered = DispatchSemaphore(value: 0)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        Self.requestCount += 1
        let status = Self.responses.isEmpty ? 200 : Self.responses.removeFirst()
        Self.lock.unlock()
        if status == -1 { Self.delivered.signal(); return }
        if status == 0 {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
        } else {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocolDidFinishLoading(self)
        }
        Self.delivered.signal()
    }
    override func stopLoading() {}
    static func count() -> Int {
        lock.lock(); defer { lock.unlock() }
        return requestCount
    }
}

func require(_ value: @autoclosure () -> Bool, _ message: String) {
    if !value() { fatalError(message) }
}
func settle(_ condition: () -> Bool) {
    let deadline = Date().addingTimeInterval(3)
    while !condition() && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
    require(condition(), "publisher callback did not settle")
}
let key = P256.KeyAgreement.PrivateKey().publicKey.x963Representation
let jwk: [String: Any] = ["kty": "EC", "crv": "P-256",
    "x": LocationEnvelopeCrypto.base64url(key.subdata(in: 1..<33)),
    "y": LocationEnvelopeCrypto.base64url(key.subdata(in: 33..<65))]
func session(expiresAtMs: Double? = nil) -> BackgroundShareSessionNative {
    BackgroundShareSessionNative(vaultOwnerToken: "synthetic-test-token", backendBaseUrl: "https://fixture.invalid", grants: [
        BackgroundShareGrantNative(grantId: "synthetic-grant", recipientKeyId: "synthetic-key", recipientPublicKeyJwk: jwk, expiresAtMs: expiresAtMs)
    ], minMoveMeters: 0, minIntervalMs: 0)
}
let config = URLSessionConfiguration.ephemeral
config.protocolClasses = [StubProtocol.self]
let publisher = BackgroundLocationPublisher(urlSession: URLSession(configuration: config))
let point = CLLocation(latitude: 0, longitude: 0)

// Expiration is enforced natively even if JavaScript is suspended.
publisher.start(session: session(expiresAtMs: 1))
publisher.handle(location: point)
Thread.sleep(forTimeInterval: 0.05)
require(StubProtocol.count() == 0, "expired grant reached transport")

// Revocation refuses subsequent fixes for that grant.
StubProtocol.responses = [403]
publisher.start(session: session())
publisher.handle(location: point)
require(StubProtocol.delivered.wait(timeout: .now() + 3) == .success, "request missing")
Thread.sleep(forTimeInterval: 0.05)
publisher.handle(location: point)
Thread.sleep(forTimeInterval: 0.05)
require(StubProtocol.count() == 1, "revoked grant reached transport again")

// Expired owner authority stops the entire session.
StubProtocol.responses = [401]
publisher.start(session: session())
publisher.handle(location: point)
settle { publisher.needsReauth }
require(!publisher.isActive, "unauthorized session stayed active")
publisher.handle(location: point)
Thread.sleep(forTimeInterval: 0.05)
require(StubProtocol.count() == 2, "unauthorized session sent another fix")

// Stop clears offline work; a new owner session cannot drain the old queue.
StubProtocol.responses = [0]
publisher.start(session: session())
publisher.handle(location: point)
settle { StubProtocol.count() == 3 }
Thread.sleep(forTimeInterval: 0.05)
publisher.stop()
publisher.start(session: session())
publisher.handle(location: point)
settle { StubProtocol.count() == 4 }
Thread.sleep(forTimeInterval: 0.1)
require(StubProtocol.count() == 4, "new session drained a retired session's queue")
publisher.stop()
// A stalled provider cannot grow an unbounded set of in-flight requests.
StubProtocol.responses = [-1, -1, -1, -1]
publisher.start(session: session())
for _ in 0..<54 { publisher.handle(location: point) }
settle { StubProtocol.count() == 8 }
Thread.sleep(forTimeInterval: 0.1)
require(StubProtocol.count() == 8, "in-flight budget exceeded")
publisher.stop()
print("Background publisher: expiry, revocation, authority loss and session isolation passed")
