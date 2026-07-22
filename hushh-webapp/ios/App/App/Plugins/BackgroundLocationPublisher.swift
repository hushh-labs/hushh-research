import Foundation
import CoreLocation

struct BackgroundShareGrantNative {
    let grantId: String
    let recipientKeyId: String
    let recipientPublicKeyJwk: [String: Any]
    let precision: String
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
    private var lastTargetsRefreshAt: Date?
    private var lastPoint: CLLocation?
    private var generation = 0
    private var refreshTimer: DispatchSourceTimer?
    private let urlSession = URLSession(configuration: .default)
    private let iso = ISO8601DateFormatter()

    private struct QueuedPost { let grantId: String; let envelope: [String: Any] }
    private var pending: [QueuedPost] = []
    private let maxPending = 50
    private(set) var needsReauth = false
    var onPublishingStopped: (() -> Void)?

    func start(session: BackgroundShareSessionNative) {
        generation += 1
        self.session = session
        self.lastPublishedAt = nil
        self.lastTargetsRefreshAt = nil
        self.lastPoint = nil
        self.needsReauth = false
        self.pending.removeAll()
        scheduleTargetRefresh()
        refreshTargetsIfNeeded(session: session, now: Date())
    }

    func stop() {
        generation += 1
        refreshTimer?.cancel()
        refreshTimer = nil
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
        for grant in session.grants {
            let point = protectedPoint(location: location, precision: grant.precision)
            let pointDict: [String: Any] = [
                "latitude": point.latitude,
                "longitude": point.longitude,
                "accuracyM": point.accuracy,
                "capturedAt": capturedAt,
                "sourcePlatform": "ios"
            ]
            guard let pointJSON = try? JSONSerialization.data(withJSONObject: pointDict) else { continue }
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

    private func protectedPoint(
        location: CLLocation,
        precision: String
    ) -> (latitude: Double, longitude: Double, accuracy: Double) {
        let accuracy = location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : 0
        guard precision == "approximate" else {
            return (location.coordinate.latitude, location.coordinate.longitude, accuracy)
        }
        let gridMeters = 1_000.0
        let metersPerDegree = 111_320.0
        let latitudeStep = gridMeters / metersPerDegree
        let longitudeScale = max(0.2, cos(location.coordinate.latitude * .pi / 180))
        let longitudeStep = gridMeters / (metersPerDegree * longitudeScale)
        return (
            (location.coordinate.latitude / latitudeStep).rounded() * latitudeStep,
            (location.coordinate.longitude / longitudeStep).rounded() * longitudeStep,
            max(accuracy, gridMeters)
        )
    }

    private func post(envelope: [String: Any], grantId: String, session: BackgroundShareSessionNative) {
        let requestGeneration = generation
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
            DispatchQueue.main.async {
                guard self.generation == requestGeneration, self.session != nil else { return }
                if error != nil || status == 0 {
                    self.enqueue(QueuedPost(grantId: grantId, envelope: envelope))
                    return
                }
                if status == 401 {
                    self.needsReauth = true
                    self.stop()
                    self.onPublishingStopped?()
                    return
                }
                if [403, 404, 410].contains(status) {
                    self.removeGrant(grantId)
                    return
                }
                if (200...299).contains(status), let activeSession = self.session {
                    self.drainPending(session: activeSession)
                }
            }
        }.resume()
    }

    private func refreshTargetsIfNeeded(session: BackgroundShareSessionNative, now: Date) {
        if let last = lastTargetsRefreshAt, now.timeIntervalSince(last) < 300 { return }
        lastTargetsRefreshAt = now
        let requestGeneration = generation
        let base = session.backendBaseUrl.hasSuffix("/")
            ? String(session.backendBaseUrl.dropLast())
            : session.backendBaseUrl
        guard let url = URL(string: "\(base)/api/one/location/publish-targets?limit=500") else {
            return
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(session.vaultOwnerToken)", forHTTPHeaderField: "Authorization")
        urlSession.dataTask(with: request) { [weak self] data, response, _ in
            guard let self = self else { return }
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            DispatchQueue.main.async {
                guard self.generation == requestGeneration, self.session != nil else { return }
                if status == 401 {
                    self.needsReauth = true
                    self.stop()
                    self.onPublishingStopped?()
                    return
                }
                guard
                    (200...299).contains(status),
                    let data = data,
                    let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                    let targets = payload["targets"] as? [[String: Any]]
                else { return }
                let grants = targets.compactMap(self.parseTarget)
                self.session = BackgroundShareSessionNative(
                    vaultOwnerToken: session.vaultOwnerToken,
                    backendBaseUrl: session.backendBaseUrl,
                    grants: grants,
                    minMoveMeters: session.minMoveMeters,
                    minIntervalMs: session.minIntervalMs
                )
                if grants.isEmpty {
                    self.stop()
                    self.onPublishingStopped?()
                }
            }
        }.resume()
    }

    private func scheduleTargetRefresh() {
        refreshTimer?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 300, repeating: 300)
        timer.setEventHandler { [weak self] in
            guard let self = self, let activeSession = self.session else { return }
            self.refreshTargetsIfNeeded(session: activeSession, now: Date())
        }
        refreshTimer = timer
        timer.resume()
    }

    private func removeGrant(_ grantId: String) {
        guard let current = session else { return }
        let remaining = current.grants.filter { $0.grantId != grantId }
        guard remaining.count != current.grants.count else { return }
        pending.removeAll { $0.grantId == grantId }
        session = BackgroundShareSessionNative(
            vaultOwnerToken: current.vaultOwnerToken,
            backendBaseUrl: current.backendBaseUrl,
            grants: remaining,
            minMoveMeters: current.minMoveMeters,
            minIntervalMs: current.minIntervalMs
        )
        if remaining.isEmpty {
            stop()
            onPublishingStopped?()
        }
    }

    private func parseTarget(_ target: [String: Any]) -> BackgroundShareGrantNative? {
        guard
            let grant = target["grant"] as? [String: Any],
            let recipient = target["recipient"] as? [String: Any],
            let grantId = grant["id"] as? String,
            let keyId = recipient["keyId"] as? String,
            let jwk = recipient["publicKeyJwk"] as? [String: Any]
        else { return nil }
        return BackgroundShareGrantNative(
            grantId: grantId,
            recipientKeyId: keyId,
            recipientPublicKeyJwk: jwk,
            precision: target["precision"] as? String ?? "precise"
        )
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
