import Foundation
import OSLog

// MARK: - Request capture result

@available(iOS 16.0, *)
enum OneRequestCaptureResult: Equatable, Sendable {
    case captured
    case ownerRequired
    case tooLarge
    case alreadyPending
    case failure
}

// MARK: - Request record

@available(iOS 16.0, *)
struct OneSystemRequestRecord: Codable, Equatable, Sendable {
    let id: String
    let text: String
    let ownerID: String
    let createdAt: Date
    let expiresAt: Date
}

// MARK: - Private request store

@available(iOS 16.0, *)
protocol OneSystemRequestStoring: AnyObject {
    func data(for key: String) -> Data?
    func set(_ data: Data, for key: String) -> Bool
    func remove(_ key: String)
}

@available(iOS 16.0, *)
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

@available(iOS 16.0, *)
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
            "Captured request: id=\(record.id, privacy: .public) length=\(trimmed.utf8.count, privacy: .public) owner=\(currentOwner, privacy: .public)"
        )
        OneSystemActionInvocationCoordinator.shared.publishAvailability(state: "request_captured")
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
        OneSystemActionInvocationCoordinator.shared.publishAvailability(state: "request_cancelled")
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
