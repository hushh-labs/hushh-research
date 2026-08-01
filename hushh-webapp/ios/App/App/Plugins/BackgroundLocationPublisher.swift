import Foundation
import CoreLocation

struct BackgroundShareGrantNative {
    let grantId: String
    let recipientKeyId: String
    let recipientPublicKeyJwk: [String: Any]
    let locationMode: String
    let approximateRadiusM: Double?
    let lastPublishedAt: Date?
}

struct BackgroundShareSessionNative {
    let vaultOwnerToken: String
    let backendBaseUrl: String
    let grants: [BackgroundShareGrantNative]
    let minMoveMeters: Double
    let minIntervalMs: Double
    let approximateIntervalMs: Double
}

/// Owns background publishing while JavaScript is suspended. Precise grants
/// retain the live movement cadence; approximate grants are quantized before
/// encryption and update at most once every five minutes. A session generation
/// prevents callbacks from a stopped session from re-queuing an old envelope.
final class BackgroundLocationPublisher {

    private var session: BackgroundShareSessionNative?
    private var generation = 0
    private var lastPrecisePublishedAt: Date?
    private var lastPrecisePoint: CLLocation?
    private var lastApproximatePublishedAt: [String: Date] = [:]
    private let urlSession = URLSession(configuration: .default)
    private let iso = ISO8601DateFormatter()
    var onBecameInactive: (() -> Void)?
    var onSessionChanged: (() -> Void)?

    private struct QueuedPost {
        let grantId: String
        let envelope: [String: Any]
        let generation: Int
    }
    private var pending: [String: QueuedPost] = [:]
    private let maxPending = 50
    private(set) var needsReauth = false

    func start(session: BackgroundShareSessionNative) {
        generation += 1
        self.session = session
        lastPrecisePublishedAt = nil
        lastPrecisePoint = nil
        lastApproximatePublishedAt = Dictionary(
            uniqueKeysWithValues: session.grants.compactMap { grant -> (String, Date)? in
                guard
                    grant.locationMode == "approximate",
                    let lastPublishedAt = grant.lastPublishedAt
                else { return nil }
                return (grant.grantId, lastPublishedAt)
            }
        )
        needsReauth = false
        pending.removeAll()
    }

    func stop() {
        generation += 1
        session = nil
        lastPrecisePublishedAt = nil
        lastPrecisePoint = nil
        lastApproximatePublishedAt.removeAll()
        needsReauth = false
        pending.removeAll()
    }

    var isActive: Bool { session != nil }
    var requiresPrecise: Bool {
        session?.grants.contains(where: { $0.locationMode == "precise" }) ?? false
    }

    /// Drop only grants that can no longer satisfy their reviewed precision.
    /// Approximate grants remain safe under Reduced Accuracy and must keep
    /// publishing instead of being stopped with the Live grants.
    @discardableResult
    func suspendPreciseGrants() -> Bool {
        guard let current = session else { return false }
        let remaining = current.grants.filter { $0.locationMode != "precise" }
        guard remaining.count != current.grants.count else { return false }
        lastPrecisePublishedAt = nil
        lastPrecisePoint = nil
        if remaining.isEmpty {
            terminate()
            return true
        }
        session = BackgroundShareSessionNative(
            vaultOwnerToken: current.vaultOwnerToken,
            backendBaseUrl: current.backendBaseUrl,
            grants: remaining,
            minMoveMeters: current.minMoveMeters,
            minIntervalMs: current.minIntervalMs,
            approximateIntervalMs: current.approximateIntervalMs
        )
        onSessionChanged?()
        return true
    }

    func handle(location: CLLocation, allowPrecise: Bool) {
        guard let session, !session.grants.isEmpty else { return }

        let now = Date()
        let captureAge = now.timeIntervalSince(location.timestamp)
        guard
            location.horizontalAccuracy >= 0,
            captureAge >= -30,
            captureAge <= 120
        else { return }
        let currentGeneration = generation
        var publishedPrecise = false

        for grant in session.grants {
            if grant.locationMode == "approximate" {
                let sinceMs = now.timeIntervalSince(
                    lastApproximatePublishedAt[grant.grantId] ?? .distantPast
                ) * 1000
                guard sinceMs >= session.approximateIntervalMs else { continue }
                guard let point = approximatePoint(location: location, grant: grant) else {
                    // Fail closed when current device uncertainty no longer fits
                    // inside the radius consented at grant creation.
                    continue
                }
                publish(point: point, grant: grant, session: session, generation: currentGeneration)
                lastApproximatePublishedAt[grant.grantId] = now
                continue
            }

            // iOS may downgrade Full Accuracy while a background session is
            // already active. Never encrypt a reduced-accuracy fix under a
            // precise grant; approximate grants above may continue safely.
            guard allowPrecise else { continue }

            if let last = lastPrecisePoint {
                let moved = location.distance(from: last)
                let sinceMs = now.timeIntervalSince(lastPrecisePublishedAt ?? .distantPast) * 1000
                let movementDue = moved >= session.minMoveMeters && sinceMs >= session.minIntervalMs
                // Keep a stationary Live location fresh without turning every
                // GPS jitter fix into a network publish.
                let heartbeatDue = sinceMs >= max(session.minIntervalMs, 45_000)
                guard movementDue || heartbeatDue else {
                    continue
                }
            }
            publish(
                point: precisePoint(location: location),
                grant: grant,
                session: session,
                generation: currentGeneration
            )
            publishedPrecise = true
        }

        if publishedPrecise {
            lastPrecisePoint = location
            lastPrecisePublishedAt = now
        }
    }

    private func precisePoint(location: CLLocation) -> [String: Any] {
        [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracyM": location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : NSNull(),
            "capturedAt": iso.string(from: location.timestamp),
            "sourcePlatform": "ios",
            "locationMode": "precise",
            "approximateRadiusM": NSNull()
        ]
    }

    private func approximatePoint(
        location: CLLocation,
        grant: BackgroundShareGrantNative
    ) -> [String: Any]? {
        guard let radius = grant.approximateRadiusM else { return nil }
        let sourceAccuracy = location.horizontalAccuracy
        let required = max(1000, ceil((sourceAccuracy + sqrt(2) * 500) / 250) * 250)
        guard radius >= required, radius <= 20_000 else { return nil }

        let earthRadius = 6_378_137.0
        let maxLatitude = 85.05112878
        let worldWidth = 2 * Double.pi * earthRadius
        let latitude = min(max(location.coordinate.latitude, -maxLatitude), maxLatitude)
        let longitude = normalizeLongitude(location.coordinate.longitude)
        let latitudeRadians = latitude * Double.pi / 180
        let x = earthRadius * longitude * Double.pi / 180
        let y = earthRadius * log(tan(Double.pi / 4 + latitudeRadians / 2))
        let centerX = floor((x + worldWidth / 2) / 1000) * 1000 + 500 - worldWidth / 2
        let centerY = floor((y + worldWidth / 2) / 1000) * 1000 + 500 - worldWidth / 2
        let centerLongitude = normalizeLongitude(centerX / earthRadius * 180 / Double.pi)
        let unboundedCenterLatitude = (2 * atan(exp(centerY / earthRadius)) - Double.pi / 2) * 180 / Double.pi
        let centerLatitude = min(max(unboundedCenterLatitude, -maxLatitude), maxLatitude)

        return [
            "latitude": centerLatitude,
            "longitude": centerLongitude,
            "accuracyM": radius,
            "capturedAt": iso.string(from: location.timestamp),
            "sourcePlatform": "ios",
            "locationMode": "approximate",
            "approximateRadiusM": radius
        ]
    }

    private func normalizeLongitude(_ longitude: Double) -> Double {
        let wrapped = (longitude + 180).truncatingRemainder(dividingBy: 360)
        let positive = (wrapped + 360).truncatingRemainder(dividingBy: 360) - 180
        return positive == -180 && longitude > 0 ? 180 : positive
    }

    private func publish(
        point: [String: Any],
        grant: BackgroundShareGrantNative,
        session: BackgroundShareSessionNative,
        generation: Int
    ) {
        guard let pointJSON = try? JSONSerialization.data(withJSONObject: point) else { return }
        let capturedAt = point["capturedAt"] as? String ?? iso.string(from: Date())
        guard let envelope = try? LocationEnvelopeCrypto.encrypt(
            pointJSON: pointJSON,
            recipientPublicKeyJwk: grant.recipientPublicKeyJwk,
            recipientKeyId: grant.recipientKeyId,
            capturedAt: capturedAt,
            sourcePlatform: "ios",
            locationMode: grant.locationMode,
            approximateRadiusM: grant.approximateRadiusM
        ) else { return }
        post(
            envelope: envelope,
            grantId: grant.grantId,
            session: session,
            generation: generation
        )
    }

    private func post(
        envelope: [String: Any],
        grantId: String,
        session: BackgroundShareSessionNative,
        generation: Int
    ) {
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

        urlSession.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self, self.generation == generation, self.session != nil else { return }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if error != nil || status == 0 || status >= 500 {
                    self.enqueue(QueuedPost(
                        grantId: grantId,
                        envelope: envelope,
                        generation: generation
                    ))
                    return
                }
                if status == 401 {
                    self.terminate(needsReauth: true)
                    return
                }
                let errorCode = self.responseErrorCode(data)
                if status == 404 || status == 410 || [
                    "LOCATION_GRANT_NOT_FOUND",
                    "LOCATION_GRANT_NOT_ACTIVE",
                    "LOCATION_GRANT_EXPIRED"
                ].contains(errorCode) {
                    self.removeGrant(grantId, generation: generation)
                    return
                }
                if (200...299).contains(status) {
                    // A newer successful fix supersedes any older offline point
                    // queued for the same grant.
                    self.pending.removeValue(forKey: grantId)
                    self.drainPending(session: session, generation: generation)
                }
            }
        }.resume()
    }

    private func removeGrant(_ grantId: String, generation: Int) {
        guard self.generation == generation, let current = self.session else { return }
        let remaining = current.grants.filter { $0.grantId != grantId }
        self.pending.removeValue(forKey: grantId)
        self.lastApproximatePublishedAt.removeValue(forKey: grantId)
        if remaining.isEmpty {
            terminate()
            return
        }
        self.session = BackgroundShareSessionNative(
            vaultOwnerToken: current.vaultOwnerToken,
            backendBaseUrl: current.backendBaseUrl,
            grants: remaining,
            minMoveMeters: current.minMoveMeters,
            minIntervalMs: current.minIntervalMs,
            approximateIntervalMs: current.approximateIntervalMs
        )
        onSessionChanged?()
    }

    private func enqueue(_ item: QueuedPost) {
        guard item.generation == generation else { return }
        pending[item.grantId] = item
        if pending.count > maxPending {
            let dropped = pending.count - maxPending
            for key in pending.keys.sorted().prefix(dropped) {
                pending.removeValue(forKey: key)
            }
            NSLog("[BackgroundLocationPublisher] dropped %d queued fixes (cap %d)", dropped, maxPending)
        }
    }

    private func drainPending(session: BackgroundShareSessionNative, generation: Int) {
        guard generation == self.generation, !pending.isEmpty else { return }
        let items = pending.values.filter { $0.generation == generation }
        pending.removeAll()
        for item in items {
            post(
                envelope: item.envelope,
                grantId: item.grantId,
                session: session,
                generation: generation
            )
        }
    }

    private func responseErrorCode(_ data: Data?) -> String {
        guard
            let data,
            let decoded = try? JSONSerialization.jsonObject(with: data),
            let object = decoded as? [String: Any]
        else { return "" }
        if let detail = object["detail"] as? [String: Any] {
            return detail["code"] as? String ?? ""
        }
        return object["code"] as? String ?? ""
    }

    private func terminate(needsReauth: Bool = false) {
        generation += 1
        session = nil
        lastPrecisePublishedAt = nil
        lastPrecisePoint = nil
        lastApproximatePublishedAt.removeAll()
        self.needsReauth = needsReauth
        pending.removeAll()
        onBecameInactive?()
    }
}
