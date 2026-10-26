import Foundation
import CoreLocation
import CryptoKit

// Execute the real publisher with a synthetic network; no credentials or cloud.
final class StubProtocol: URLProtocol {
    static let lock = NSLock()
    static var responses: [Int] = []
    static var requestCount = 0
    static var envelopes: [[String: Any]] = []
    static let delivered = DispatchSemaphore(value: 0)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        Self.requestCount += 1
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 4096)
            var collected = Data()
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }
                collected.append(bytes, count: count)
            }
            body = collected
        }
        if let body = body,
           let decoded = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
           let envelope = decoded["envelope"] as? [String: Any] { Self.envelopes.append(envelope) }
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
let privateKey = P256.KeyAgreement.PrivateKey()
let key = privateKey.publicKey.x963Representation
let jwk: [String: Any] = ["kty": "EC", "crv": "P-256",
    "x": LocationEnvelopeCrypto.base64url(key.subdata(in: 1..<33)),
    "y": LocationEnvelopeCrypto.base64url(key.subdata(in: 33..<65))]
func session(expiresAtMs: Double? = nil, precision: BackgroundLocationPrecision = .precise) -> BackgroundShareSessionNative {
    BackgroundShareSessionNative(vaultOwnerToken: "synthetic-test-token", backendBaseUrl: "https://fixture.invalid", grants: [
        BackgroundShareGrantNative(grantId: "synthetic-grant", recipientKeyId: "synthetic-key", recipientPublicKeyJwk: jwk, expiresAtMs: expiresAtMs, precision: precision)
    ], minMoveMeters: 0, minIntervalMs: 0)
}
let config = URLSessionConfiguration.ephemeral
config.protocolClasses = [StubProtocol.self]
let publisher = BackgroundLocationPublisher(urlSession: URLSession(configuration: config))
let point = CLLocation(latitude: 0, longitude: 0)

// Decrypt the actual transport envelope, proving coarsening precedes encryption.
for precision in [BackgroundLocationPrecision.approximate, .precise] {
    publisher.start(session: session(precision: precision))
    publisher.handle(location: CLLocation(coordinate: CLLocationCoordinate2D(latitude: 12.34456, longitude: -12.345), altitude: 0, horizontalAccuracy: 8, verticalAccuracy: 0, timestamp: Date()))
    require(StubProtocol.delivered.wait(timeout: .now() + 3) == .success, "precision envelope missing")
    settle { !StubProtocol.envelopes.isEmpty }
    StubProtocol.lock.lock()
    let envelope = StubProtocol.envelopes.last!
    StubProtocol.lock.unlock()
    require(envelope["publicationContext"] as? String == "private_background", "background context missing")
    require((envelope["metadata"] as? [String: Any])?["precision"] as? String == precision.rawValue, "precision metadata missing")
    let sender = envelope["senderEphemeralPublicKeyJwk"] as! [String: String]
    var raw = Data([0x04]); raw.append(LocationEnvelopeCrypto.base64urlDecode(sender["x"]!)!); raw.append(LocationEnvelopeCrypto.base64urlDecode(sender["y"]!)!)
    let shared = try privateKey.sharedSecretFromKeyAgreement(with: P256.KeyAgreement.PublicKey(x963Representation: raw))
    let aes = shared.withUnsafeBytes { SymmetricKey(data: Data($0)) }
    let ct = LocationEnvelopeCrypto.base64urlDecode(envelope["ciphertext"] as! String)!
    let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: LocationEnvelopeCrypto.base64urlDecode(envelope["iv"] as! String)!), ciphertext: ct.dropLast(16), tag: ct.suffix(16))
    let decoded = try JSONSerialization.jsonObject(with: AES.GCM.open(box, using: aes)) as! [String: Any]
    require(decoded["precision"] as? String == precision.rawValue, "encrypted precision missing")
    require(decoded["latitude"] as? Double == (precision == .approximate ? 12.34 : 12.34456), "latitude not coarsened before encryption")
    require(decoded["longitude"] as? Double == (precision == .approximate ? -12.34 : -12.345), "negative boundary disagrees with JS")
    require(decoded["accuracyM"] as? Double == (precision == .approximate ? 1000 : 8), "accuracy floor wrong")
    publisher.stop()
}
Thread.sleep(forTimeInterval: 0.05)
StubProtocol.lock.lock(); StubProtocol.requestCount = 0; StubProtocol.envelopes = []; StubProtocol.lock.unlock()

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
