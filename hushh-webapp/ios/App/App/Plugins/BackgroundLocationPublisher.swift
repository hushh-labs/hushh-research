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

    private struct QueuedPost {
        let grantId: String
        let envelope: [String: Any]
        let generation: Int
    }
    private var pending: [QueuedPost] = []
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

    func handle(location: CLLocation) {
        guard let session, !session.grants.isEmpty else { return }

        let now = Date()
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

            if let last = lastPrecisePoint {
                let moved = location.distance(from: last)
                let sinceMs = now.timeIntervalSince(lastPrecisePublishedAt ?? .distantPast) * 1000
                guard moved >= session.minMoveMeters, sinceMs >= session.minIntervalMs else {
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
        let sourceAccuracy = location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : 0
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

        urlSession.dataTask(with: request) { [weak self] _, response, error in
            DispatchQueue.main.async {
                guard let self, self.generation == generation, self.session != nil else { return }
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if error != nil || status == 0 {
                    self.enqueue(QueuedPost(
                        grantId: grantId,
                        envelope: envelope,
                        generation: generation
                    ))
                    return
                }
                if status == 401 {
                    self.needsReauth = true
                    return
                }
                if (200...299).contains(status) {
                    self.drainPending(session: session, generation: generation)
                }
            }
        }.resume()
    }

    private func enqueue(_ item: QueuedPost) {
        guard item.generation == generation else { return }
        pending.append(item)
        if pending.count > maxPending {
            let dropped = pending.count - maxPending
            pending.removeFirst(dropped)
            NSLog("[BackgroundLocationPublisher] dropped %d queued fixes (cap %d)", dropped, maxPending)
        }
    }

    private func drainPending(session: BackgroundShareSessionNative, generation: Int) {
        guard generation == self.generation, !pending.isEmpty else { return }
        let items = pending.filter { $0.generation == generation }
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
}
