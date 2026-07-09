import Foundation
import CoreLocation

struct BackgroundShareGrantNative {
    let grantId: String
    let recipientKeyId: String
    let recipientPublicKeyJwk: [String: Any]
}

struct BackgroundShareSessionNative {
    let vaultOwnerToken: String
    let backendBaseUrl: String
    let grants: [BackgroundShareGrantNative]
    let minMoveMeters: Double
    let minIntervalMs: Double
}

/// Owns background publishing: on each CLLocation fix it throttles, encrypts an
/// ECIES envelope per active grant, and POSTs ciphertext to the backend. Runs
/// with no JS alive. A bounded in-memory queue absorbs transient POST failures.
final class BackgroundLocationPublisher {

    private var session: BackgroundShareSessionNative?
    private var lastPublishedAt: Date?
    private var lastPoint: CLLocation?
    private let urlSession = URLSession(configuration: .default)
    private let iso = ISO8601DateFormatter()

    private struct QueuedPost { let grantId: String; let envelope: [String: Any] }
    private var pending: [QueuedPost] = []
    private let maxPending = 50
    private(set) var needsReauth = false

    func start(session: BackgroundShareSessionNative) {
        self.session = session
        self.lastPublishedAt = nil
        self.lastPoint = nil
        self.needsReauth = false
        self.pending.removeAll()
    }

    func stop() {
        self.session = nil
        self.pending.removeAll()
    }

    var isActive: Bool { session != nil }

    func handle(location: CLLocation) {
        guard let session = session, !session.grants.isEmpty else { return }

        let now = Date()
        if let last = lastPoint {
            let moved = location.distance(from: last)
            let sinceMs = now.timeIntervalSince(lastPublishedAt ?? .distantPast) * 1000
            if moved < session.minMoveMeters && sinceMs < session.minIntervalMs {
                return
            }
        }
        lastPoint = location
        lastPublishedAt = now

        let capturedAt = iso.string(from: location.timestamp)
        let pointDict: [String: Any] = [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracyM": location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : NSNull(),
            "capturedAt": capturedAt,
            "sourcePlatform": "ios"
        ]
        guard let pointJSON = try? JSONSerialization.data(withJSONObject: pointDict) else { return }

        for grant in session.grants {
            guard let envelope = try? LocationEnvelopeCrypto.encrypt(
                pointJSON: pointJSON,
                recipientPublicKeyJwk: grant.recipientPublicKeyJwk,
                recipientKeyId: grant.recipientKeyId,
                capturedAt: capturedAt,
                sourcePlatform: "ios"
            ) else { continue }
            post(envelope: envelope, grantId: grant.grantId, session: session)
        }
    }

    private func post(envelope: [String: Any], grantId: String, session: BackgroundShareSessionNative) {
        let base = session.backendBaseUrl.hasSuffix("/")
            ? String(session.backendBaseUrl.dropLast())
            : session.backendBaseUrl
        guard
            let encodedGrant = grantId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed),
            let url = URL(string: "\(base)/api/one/location/grants/\(encodedGrant)/envelopes"),
            let body = try? JSONSerialization.data(withJSONObject: ["envelope": envelope])
        else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(session.vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        urlSession.dataTask(with: request) { [weak self] _, response, error in
            guard let self = self else { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if error != nil || status == 0 {
                self.enqueue(QueuedPost(grantId: grantId, envelope: envelope))
                return
            }
            if status == 401 {
                self.needsReauth = true
                return
            }
            if (200...299).contains(status) {
                self.drainPending(session: session)
            }
        }.resume()
    }

    private func enqueue(_ item: QueuedPost) {
        pending.append(item)
        if pending.count > maxPending {
            let dropped = pending.count - maxPending
            pending.removeFirst(dropped)
            NSLog("[BackgroundLocationPublisher] dropped %d queued fixes (cap %d)", dropped, maxPending)
        }
    }

    private func drainPending(session: BackgroundShareSessionNative) {
        guard !pending.isEmpty else { return }
        let items = pending
        pending.removeAll()
        for item in items { post(envelope: item.envelope, grantId: item.grantId, session: session) }
    }
}
