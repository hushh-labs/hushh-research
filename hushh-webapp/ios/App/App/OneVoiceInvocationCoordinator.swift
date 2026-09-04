import Foundation
import OSLog

struct PendingOneVoiceInvocation: Codable, Equatable, Sendable {
    static let supportedKind = "start_one_voice"
    static let supportedSource = "siri_app_shortcut"

    let id: String
    let kind: String
    let source: String
    let createdAt: Date
    let expiresAt: Date

    init(id: String = UUID().uuidString, createdAt: Date, expiresAt: Date) {
        self.id = id
        self.kind = Self.supportedKind
        self.source = Self.supportedSource
        self.createdAt = createdAt
        self.expiresAt = expiresAt
    }

    var bridgePayload: [String: Any] {
        [
            "id": id,
            "kind": kind,
            "source": source,
            "createdAt": Int64(createdAt.timeIntervalSince1970 * 1_000),
            "expiresAt": Int64(expiresAt.timeIntervalSince1970 * 1_000)
        ]
    }
}

extension Notification.Name {
    static let oneVoiceInvocationAvailable = Notification.Name(
        "ai.hushh.one.voice-invocation-available"
    )
}

/// The only persisted Siri state. The Codable envelope is deliberately closed:
/// no initializer accepts a prompt, route, account identifier, or credential.
final class OneVoiceInvocationCoordinator: @unchecked Sendable {
    static let shared = OneVoiceInvocationCoordinator()
    static let ttl: TimeInterval = 5 * 60

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "ai.hushh.one",
        category: "SiriOneVoice"
    )

    private let defaults: UserDefaults
    private let storageKey: String
    private let now: () -> Date
    private let lock = NSLock()
    private var claimedInvocations: [String: PendingOneVoiceInvocation] = [:]

    init(
        defaults: UserDefaults = .standard,
        storageKey: String = "one.voice.pending-system-invocation.v1",
        now: @escaping () -> Date = Date.init
    ) {
        self.defaults = defaults
        self.storageKey = storageKey
        self.now = now
    }

    @discardableResult
    func enqueue() -> PendingOneVoiceInvocation {
        let createdAt = now()
        let invocation = PendingOneVoiceInvocation(
            createdAt: createdAt,
            expiresAt: createdAt.addingTimeInterval(Self.ttl)
        )

        lock.lock()
        let replaced = readLocked()
        writeLocked(invocation)
        lock.unlock()

        if let replaced {
            Self.log(
                state: "cancelled",
                invocation: replaced,
                outcome: "replaced"
            )
        }
        publishAvailability(state: "requested")
        return invocation
    }

    func pending() -> PendingOneVoiceInvocation? {
        lock.lock()
        guard let invocation = readLocked() else {
            lock.unlock()
            return nil
        }
        if invocation.expiresAt <= now() {
            defaults.removeObject(forKey: storageKey)
            lock.unlock()
            Self.log(state: "expired", invocation: invocation, outcome: "expired")
            return nil
        }
        lock.unlock()
        return invocation
    }

    /// Claims and removes atomically. Once JavaScript receives `claimed=true`,
    /// duplicate lifecycle/plugin events cannot dispatch the same microphone start.
    func claim(id: String) -> Bool {
        lock.lock()
        guard let invocation = readLocked(), invocation.id == id else {
            lock.unlock()
            return false
        }
        if invocation.expiresAt <= now() {
            defaults.removeObject(forKey: storageKey)
            lock.unlock()
            Self.log(state: "expired", invocation: invocation, outcome: "expired")
            return false
        }
        defaults.removeObject(forKey: storageKey)
        claimedInvocations[id] = invocation
        lock.unlock()
        Self.log(state: "dispatched", invocation: invocation, outcome: "claimed")
        return true
    }

    func complete(id: String, outcome: String) {
        lock.lock()
        let pendingInvocation = readLocked()
        let claimedInvocation = claimedInvocations.removeValue(forKey: id)
        if pendingInvocation?.id == id {
            defaults.removeObject(forKey: storageKey)
        }
        lock.unlock()

        let safeOutcome = Self.allowedOutcomes.contains(outcome) ? outcome : "failed"
        let invocation = claimedInvocation ?? pendingInvocation
        if let invocation, invocation.id == id {
            Self.log(state: safeOutcome, invocation: invocation, outcome: safeOutcome)
        } else {
            Self.logger.info(
                "state=\(safeOutcome, privacy: .public) request_id=\(id, privacy: .public) source=\(PendingOneVoiceInvocation.supportedSource, privacy: .public)"
            )
        }
    }

    func cancelPending(outcome: String = "cancelled") {
        lock.lock()
        let invocation = readLocked()
        let claimed = Array(claimedInvocations.values)
        defaults.removeObject(forKey: storageKey)
        claimedInvocations.removeAll()
        lock.unlock()
        if let invocation {
            Self.log(state: "cancelled", invocation: invocation, outcome: outcome)
        }
        for invocation in claimed {
            Self.log(state: "cancelled", invocation: invocation, outcome: outcome)
        }
    }

    func publishAvailability(state: String) {
        guard let invocation = pending() else { return }
        Self.log(state: state, invocation: invocation)
        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: .oneVoiceInvocationAvailable,
                object: self
            )
        }
    }

    private func readLocked() -> PendingOneVoiceInvocation? {
        guard let data = defaults.data(forKey: storageKey) else { return nil }
        guard let invocation = try? JSONDecoder().decode(
            PendingOneVoiceInvocation.self,
            from: data
        ) else {
            defaults.removeObject(forKey: storageKey)
            return nil
        }
        guard
            invocation.kind == PendingOneVoiceInvocation.supportedKind,
            invocation.source == PendingOneVoiceInvocation.supportedSource
        else {
            defaults.removeObject(forKey: storageKey)
            return nil
        }
        return invocation
    }

    private func writeLocked(_ invocation: PendingOneVoiceInvocation) {
        guard let data = try? JSONEncoder().encode(invocation) else { return }
        defaults.set(data, forKey: storageKey)
    }

    private static let allowedOutcomes: Set<String> = [
        "accepted", "failed", "expired", "cancelled", "fallback_shown"
    ]

    private static func log(
        state: String,
        invocation: PendingOneVoiceInvocation,
        outcome: String? = nil
    ) {
        let durationMs = max(
            0,
            Int(Date().timeIntervalSince(invocation.createdAt) * 1_000)
        )
        logger.info(
            "state=\(state, privacy: .public) request_id=\(invocation.id, privacy: .public) source=\(invocation.source, privacy: .public) outcome=\(outcome ?? "none", privacy: .public) duration_ms=\(durationMs, privacy: .public)"
        )
    }
}
