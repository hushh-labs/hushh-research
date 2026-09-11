import Foundation
import OSLog

// Deliberately not @available(iOS 16.0, *).
//
// Every type here was annotated iOS 16+, but this file imports only Foundation
// and OSLog and uses no iOS 16 API -- the annotation came along from the App
// Intents code that calls into it. The app deploys to iOS 17, but keeping this
// coordinator Foundation-only avoids unnecessarily coupling each unguarded
// call site (AppDelegate, HushhAuthPlugin,
// HushhVoiceInvocationPlugin) a compile error. Its sibling,
// OneSystemActionInvocationCoordinator, does the same Keychain and
// NotificationCenter work with no annotation at all.

extension Notification.Name {
    static let oneSystemRequestInvocationAvailable = Notification.Name(
        "ai.hushh.one.system-request-invocation-available"
    )
}

// MARK: - Request capture result

enum OneRequestCaptureResult: Equatable, Sendable {
    case captured
    case ownerRequired
    case tooLarge
    case alreadyPending
    case failure
}

// MARK: - Request record

struct OneSystemRequestRecord: Codable, Equatable, Sendable {
    static let bridgeKind = "interpret_one_request"
    static let bridgeSource = "siri_app_shortcut"
    static let protocolVersion = "one.request.v1"
    static let handoffDeadline: TimeInterval = 25

    let id: String
    let text: String
    let ownerID: String
    let createdAt: Date
    let expiresAt: Date

    var handoffDeadlineAt: Date {
        min(expiresAt, createdAt.addingTimeInterval(Self.handoffDeadline))
    }

    /// The discovery envelope handed to the webapp is metadata-only. `text`
    /// is returned only by a successful, owner-bound one-time claim; it never
    /// appears in discovery, availability, or completion payloads. The keys
    /// and their spelling are the contract `isPendingRequestInvocation`
    /// validates in lib/capacitor/one-system-request-invocation.ts.
    var bridgePayload: [String: Any] {
        [
            "id": id,
            "kind": Self.bridgeKind,
            "source": Self.bridgeSource,
            "createdAt": Int64(createdAt.timeIntervalSince1970 * 1_000),
            "expiresAt": Int64(expiresAt.timeIntervalSince1970 * 1_000),
            "handoffDeadlineAt": Int64(handoffDeadlineAt.timeIntervalSince1970 * 1_000),
            "claimedAt": NSNull(),
            "appOwnedAt": NSNull(),
            "detached": false,
            "outcome": NSNull(),
            "protocolVersion": Self.protocolVersion,
            "ownerBinding": ownerID
        ]
    }
}

// MARK: - Private request store

protocol OneSystemRequestStoring: AnyObject {
    func data(for key: String) -> Data?
    func set(_ data: Data, for key: String) -> Bool
    func remove(_ key: String)
}

final class OneSystemRequestKeychainStore: OneSystemRequestStoring {
    private let service: String

    init(service: String = "com.hushh.app.one-requests") {
        self.service = service
    }

    func data(for key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess else {
            return nil
        }
        return item as? Data
    }

    @discardableResult
    func set(_ data: Data, for key: String) -> Bool {
        let identity: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(identity as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return true }
        guard status == errSecItemNotFound else { return false }
        var insert = identity
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        insert[kSecValueData as String] = data
        return SecItemAdd(insert as CFDictionary, nil) == errSecSuccess
    }

    func remove(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
        SecItemDelete(query as CFDictionary)
    }
}

// MARK: - Request coordinator

final class OneSystemRequestInvocationCoordinator: @unchecked Sendable {
    static let shared = OneSystemRequestInvocationCoordinator()
    static let maxRequestLength = 4 * 1024
    static let ttl: TimeInterval = 5 * 60

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "ai.hushh.one",
        category: "SiriOneRequest"
    )

    private let store: OneSystemRequestStoring
    private let pendingKey: String
    private let now: () -> Date
    private let currentUserID: () -> String?
    private let lock = NSLock()
    private struct ClaimedRecordState {
        let record: OneSystemRequestRecord
        let claimedAt: Date
        var appOwnedAt: Date?
        var detached: Bool
        var outcome: String?
    }

    private var claimedRecords: [String: ClaimedRecordState] = [:]

    init(
        store: OneSystemRequestStoring = OneSystemRequestKeychainStore(),
        keyPrefix: String = "one.system-request.v1",
        now: @escaping () -> Date = Date.init,
        currentUserID: @escaping () -> String? = OneSystemActionInvocationCoordinator.shared.currentRequestOwner
    ) {
        self.store = store
        self.pendingKey = "\(keyPrefix).pending"
        self.now = now
        self.currentUserID = currentUserID
    }

    @discardableResult
    func captureRequest(_ text: String) -> OneRequestCaptureResult {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return .failure }

        guard trimmed.utf8.count <= Self.maxRequestLength else {
            Self.logger.warning("Request exceeds maximum length limit")
            return .tooLarge
        }

        let ownerID = currentUserID()
        guard let currentOwner = ownerID, !currentOwner.isEmpty else {
            return .ownerRequired
        }

        lock.lock()
        purgeExpiredClaimedRecords(now: now())
        if readValidatedPending() != nil || !claimedRecords.isEmpty {
            lock.unlock()
            return .alreadyPending
        }

        let now = now()
        let record = OneSystemRequestRecord(
            id: UUID().uuidString,
            text: trimmed,
            ownerID: currentOwner,
            createdAt: now,
            expiresAt: now.addingTimeInterval(Self.ttl)
        )

        guard let encoded = try? JSONEncoder().encode(record),
              store.set(encoded, for: pendingKey) else {
            lock.unlock()
            return .failure
        }

        lock.unlock()
        Self.logger.info(
            "Captured request: id=\(record.id, privacy: .public) length=\(trimmed.utf8.count, privacy: .public)"
        )
        publishAvailability(state: "request_captured")
        return .captured
    }

    func claimRequest() -> OneSystemRequestRecord? {
        lock.lock()
        guard let record = readValidatedPending() else {
            lock.unlock()
            return nil
        }
        let currentTime = now()
        guard record.expiresAt > currentTime,
              record.handoffDeadlineAt > currentTime else {
            store.remove(pendingKey)
            lock.unlock()
            Self.logger.info("Request handoff expired: id=\(record.id, privacy: .public)")
            return nil
        }

        store.remove(pendingKey)
        claimedRecords[record.id] = ClaimedRecordState(
            record: record,
            claimedAt: now(),
            appOwnedAt: nil,
            detached: false,
            outcome: nil
        )
        lock.unlock()

        OneSystemActionInvocationCoordinator.shared.bindRequestOwner(record.ownerID)
        Self.logger.info("Claimed request: id=\(record.id, privacy: .public)")
        return record
    }

    func currentRequest() -> OneSystemRequestRecord? {
        lock.lock()
        let record = readValidatedPending()
        lock.unlock()
        return record
    }

    func cancelRequest(id: String? = nil) {
        lock.lock()
        let pending = readPending()
        let shouldCancelPending = id == nil || pending?.id == id
        if shouldCancelPending, let record = pending {
            Self.logger.info("Cancelling request: id=\(record.id, privacy: .public)")
            store.remove(pendingKey)
        }
        let removedClaim: Bool
        if let id {
            removedClaim = claimedRecords.removeValue(forKey: id) != nil
        } else {
            removedClaim = !claimedRecords.isEmpty
            claimedRecords.removeAll()
        }
        lock.unlock()
        if shouldCancelPending || removedClaim {
            publishAvailability(state: "request_cancelled")
        }
    }

    // MARK: - Bridge surface
    //
    // HushhVoiceInvocationPlugin and AppDelegate call these. They were written
    // against the shape of OneSystemActionInvocationCoordinator but never
    // implemented here, so every call site was a compile error -- masked until
    // now by an availability error that stopped the compiler first.

    /// The pending request, if one is live and belongs to the current owner.
    func pending() -> OneSystemRequestRecord? {
        currentRequest()
    }

    /// Claim a specific request by id. Unlike `claimRequest()`, this refuses
    /// when the id does not match what is actually pending, so a stale bridge
    /// call cannot consume a newer request.
    @discardableResult
    func claim(id: String) -> Bool {
        claimRecord(id: id) != nil
    }

    /// Claims and returns the private request text exactly once. The text is
    /// returned only across the already-authenticated in-process bridge after
    /// the native owner/id/expiry checks pass. Discovery and availability
    /// payloads remain metadata-only.
    func claimRecord(id: String) -> OneSystemRequestRecord? {
        lock.lock()
        guard let record = readValidatedPending(), record.id == id else {
            lock.unlock()
            return nil
        }
        let currentTime = now()
        guard record.expiresAt > currentTime,
              record.handoffDeadlineAt > currentTime else {
            store.remove(pendingKey)
            lock.unlock()
            Self.logger.info("Request handoff expired: id=\(record.id, privacy: .public)")
            return nil
        }
        store.remove(pendingKey)
        claimedRecords[record.id] = ClaimedRecordState(
            record: record,
            claimedAt: now(),
            appOwnedAt: nil,
            detached: false,
            outcome: nil
        )
        lock.unlock()

        OneSystemActionInvocationCoordinator.shared.bindRequestOwner(record.ownerID)
        Self.logger.info("Claimed request: id=\(record.id, privacy: .public)")
        return record
    }

    /// Acknowledge progress on a request. Returns whether the id is the one
    /// actually pending; the state string is never logged with its content.
    @discardableResult
    func reportProgress(id: String, state: String) -> Bool {
        lock.lock()
        if var claimed = claimedRecords[id] {
            guard currentUserID() == claimed.record.ownerID else {
                claimedRecords.removeValue(forKey: id)
                lock.unlock()
                Self.logger.warning("Request owner changed during progress")
                return false
            }
            if state == "app_owned" && now() > claimed.record.handoffDeadlineAt {
                claimedRecords.removeValue(forKey: id)
                lock.unlock()
                Self.logger.info(
                    "Request app ownership deadline expired: id=\(id, privacy: .public)"
                )
                return false
            }
            switch state {
            case "app_owned":
                claimed.appOwnedAt = now()
            case "detached":
                claimed.detached = true
                // A Siri detachment before app ownership is a cancelled
                // handoff. Remove the claim so no later completion can make it
                // look accepted or permit a stale request to run.
                if claimed.appOwnedAt == nil {
                    claimedRecords.removeValue(forKey: id)
                    lock.unlock()
                    Self.logger.info(
                        "Detached before app ownership: id=\(id, privacy: .public)"
                    )
                    publishAvailability(state: "request_detached")
                    return true
                }
            default:
                break
            }
            claimedRecords[id] = claimed
            lock.unlock()
            Self.logger.info(
                "Request progress: id=\(claimed.record.id, privacy: .public) state=\(state, privacy: .public)"
            )
            return true
        }
        let record = readValidatedPending()
        lock.unlock()
        guard let record, record.id == id else { return false }
        Self.logger.info(
            "Request progress: id=\(record.id, privacy: .public) state=\(state, privacy: .public)"
        )
        return true
    }

    /// Finish a request only after a successful claim. A late completion cannot
    /// discard a newer pending request or complete an invocation after its
    /// owner has signed out.
    func complete(id: String, outcome: String, summary: String) {
        lock.lock()
        guard let claimed = claimedRecords[id],
              currentUserID() == claimed.record.ownerID else {
            lock.unlock()
            return
        }
        claimedRecords.removeValue(forKey: id)
        lock.unlock()
        // `summary` is user-facing copy that can quote the request, so it is
        // deliberately not logged.
        let safeOutcome = Self.allowedOutcomes.contains(outcome) ? outcome : "failed"
        Self.logger.info(
            "Completed request: id=\(id, privacy: .public) outcome=\(safeOutcome, privacy: .public)"
        )
        publishAvailability(state: "request_completed")
    }

    /// Wake the bridge. Posts unconditionally rather than only when something
    /// is pending, so the webapp can also learn that a request has gone away.
    func publishAvailability(state: String) {
        Self.logger.info("Request availability: state=\(state, privacy: .public)")
        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: .oneSystemRequestInvocationAvailable,
                object: self
            )
        }
    }

    private static let allowedOutcomes: Set<String> = [
        "completed", "accepted", "failed", "expired", "cancelled",
        "clarification_required", "handoff_timeout", "owner_mismatch",
        "runtime_unavailable", "provider_unavailable", "ambiguous",
        "voice_disabled", "fallback_shown"
    ]

    // MARK: - Private helpers

    private func readPending() -> OneSystemRequestRecord? {
        guard let data = store.data(for: pendingKey) else { return nil }
        return try? JSONDecoder().decode(OneSystemRequestRecord.self, from: data)
    }

    private func readValidatedPending() -> OneSystemRequestRecord? {
        guard let record = readPending() else { return nil }
        guard let currentOwner = currentUserID(),
              record.ownerID == currentOwner else {
            Self.logger.warning("Request owner mismatch during validation")
            // An owner change invalidates the pending handoff. Remove it here
            // so the next signed-in owner cannot be blocked by stale state.
            store.remove(pendingKey)
            return nil
        }
        return record
    }

    private func purgeExpiredClaimedRecords(now: Date) {
        claimedRecords = claimedRecords.filter { _, state in
            state.record.expiresAt > now
        }
    }
}
