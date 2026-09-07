import Foundation
import OSLog

// Deliberately not @available(iOS 16.0, *).
//
// Every type here was annotated iOS 16+, but this file imports only Foundation
// and OSLog and uses no iOS 16 API -- the annotation came along from the App
// Intents code that calls into it. The app deploys to iOS 15, so the marking
// made each unguarded call site (AppDelegate, HushhAuthPlugin,
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

    let id: String
    let text: String
    let ownerID: String
    let createdAt: Date
    let expiresAt: Date

    /// The envelope handed to the webapp. `text` is deliberately absent: the
    /// captured request never crosses the bridge, and this coordinator is the
    /// only layer that ever holds it. The keys and their spelling are the
    /// contract `isPendingRequestInvocation` validates in
    /// lib/capacitor/one-system-request-invocation.ts.
    var bridgePayload: [String: Any] {
        [
            "id": id,
            "kind": Self.bridgeKind,
            "source": Self.bridgeSource,
            "createdAt": Int64(createdAt.timeIntervalSince1970 * 1_000),
            "expiresAt": Int64(expiresAt.timeIntervalSince1970 * 1_000),
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
        if readPending() != nil {
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
        guard record.expiresAt > now() else {
            store.remove(pendingKey)
            lock.unlock()
            Self.logger.info("Expired request claimed: id=\(record.id, privacy: .public)")
            return nil
        }

        store.remove(pendingKey)
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

    func cancelRequest() {
        lock.lock()
        if let record = readPending() {
            Self.logger.info("Cancelling request: id=\(record.id, privacy: .public)")
        }
        store.remove(pendingKey)
        lock.unlock()
        publishAvailability(state: "request_cancelled")
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
        lock.lock()
        guard let record = readValidatedPending(), record.id == id else {
            lock.unlock()
            return false
        }
        guard record.expiresAt > now() else {
            store.remove(pendingKey)
            lock.unlock()
            Self.logger.info("Expired request claimed: id=\(record.id, privacy: .public)")
            return false
        }
        store.remove(pendingKey)
        lock.unlock()

        OneSystemActionInvocationCoordinator.shared.bindRequestOwner(record.ownerID)
        Self.logger.info("Claimed request: id=\(record.id, privacy: .public)")
        return true
    }

    /// Acknowledge progress on a request. Returns whether the id is the one
    /// actually pending; the state string is never logged with its content.
    @discardableResult
    func reportProgress(id: String, state: String) -> Bool {
        lock.lock()
        let record = readValidatedPending()
        lock.unlock()
        guard let record, record.id == id else { return false }
        Self.logger.info(
            "Request progress: id=\(record.id, privacy: .public) state=\(state, privacy: .public)"
        )
        return true
    }

    /// Finish a request. Clears the pending record only when the id matches, so
    /// a late completion cannot discard a request captured after it.
    func complete(id: String, outcome: String, summary: String) {
        lock.lock()
        let matched = readPending()?.id == id
        if matched {
            store.remove(pendingKey)
        }
        lock.unlock()
        guard matched else { return }
        // `summary` is user-facing copy that can quote the request, so it is
        // deliberately not logged.
        Self.logger.info(
            "Completed request: id=\(id, privacy: .public) outcome=\(outcome, privacy: .public)"
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
            return nil
        }
        return record
    }
}
