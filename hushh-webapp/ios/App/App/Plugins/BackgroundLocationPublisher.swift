import Foundation
import CoreLocation

struct BackgroundShareGrantNative {
    let grantId: String
    let recipientKeyId: String
    let recipientPublicKeyJwk: [String: Any]
    let expiresAtMs: Double?
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

    // Capacitor calls and URLSession callbacks do not share an executor.
    private let lock = NSRecursiveLock()
    private var generation = UUID()
    private var tasks: [UUID: (grantId: String, task: URLSessionDataTask)] = [:]
    private var refusedGrants = Set<String>()
    private var session: BackgroundShareSessionNative?
    private var lastPublishedAt: Date?
    private var lastPoint: CLLocation?
    private let urlSession: URLSession
    private let onStop: () -> Void

    init(urlSession: URLSession = URLSession(configuration: .ephemeral), onStop: @escaping () -> Void = {}) {
        self.urlSession = urlSession
        self.onStop = onStop
    }
    private let iso = ISO8601DateFormatter()

    private struct QueuedPost { let grantId: String; let envelope: [String: Any] }
    private var pending: [QueuedPost] = []
    private let maxPending = 50
    private let maxInFlight = 4
    private var reauthRequired = false
    var needsReauth: Bool {
        lock.lock(); defer { lock.unlock() }
        return reauthRequired
    }

    func start(session: BackgroundShareSessionNative) {
        lock.lock(); defer { lock.unlock() }
        stop()
        refusedGrants.removeAll()
        self.session = session
        self.lastPublishedAt = nil
        self.lastPoint = nil
        self.reauthRequired = false
        self.pending.removeAll()
    }

    func stop() {
        lock.lock(); defer { lock.unlock() }
        generation = UUID()
        for entry in tasks.values { entry.task.cancel() }
        tasks.removeAll()
        self.session = nil
        self.pending.removeAll()
        onStop()
    }

    var isActive: Bool {
        lock.lock(); defer { lock.unlock() }
        return session != nil
    }

    private func grantIsActive(_ id: String, in session: BackgroundShareSessionNative) -> Bool {
        guard !refusedGrants.contains(id), let grant = session.grants.first(where: { $0.grantId == id }) else { return false }
        return grant.expiresAtMs.map { $0.isFinite && $0 > Date().timeIntervalSince1970 * 1000 } ?? true
    }

    func handle(location: CLLocation) {
        lock.lock(); defer { lock.unlock() }
        guard let session = session else { return }
        guard session.grants.contains(where: { grantIsActive($0.grantId, in: session) }) else {
            stop()
            return
        }

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

        for grant in session.grants where grantIsActive(grant.grantId, in: session) {
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
        guard self.session != nil, grantIsActive(grantId, in: session) else { return }
        guard tasks.count < maxInFlight else {
            enqueue(QueuedPost(grantId: grantId, envelope: envelope))
            return
        }
        let requestGeneration = generation
        let requestId = UUID()
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

        let task = urlSession.dataTask(with: request) { [weak self] _, response, error in
            guard let self = self else { return }
            self.lock.lock(); defer { self.lock.unlock() }
            guard self.generation == requestGeneration, self.session != nil else { return }
            self.tasks.removeValue(forKey: requestId)
            guard self.grantIsActive(grantId, in: session) else { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if error != nil || status == 0 || status == 429 || status >= 500 {
                self.enqueue(QueuedPost(grantId: grantId, envelope: envelope))
                return
            }
            if status == 401 {
                self.stop()
                self.reauthRequired = true
                return
            }
            if status == 403 || status == 404 || status == 410 {
                self.refusedGrants.insert(grantId)
                self.pending.removeAll { $0.grantId == grantId }
                let refusedTasks = self.tasks.filter { $0.value.grantId == grantId }
                for (id, entry) in refusedTasks {
                    entry.task.cancel()
                    self.tasks.removeValue(forKey: id)
                }
                if !session.grants.contains(where: { self.grantIsActive($0.grantId, in: session) }) { self.stop() }
                return
            }
            if (200...299).contains(status) {
                self.drainPending(session: session)
            }
        }
        tasks[requestId] = (grantId, task)
        task.resume()
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
