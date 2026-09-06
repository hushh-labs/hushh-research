import Foundation
import OSLog
import Security

enum OneSystemActionID: String, Codable, CaseIterable, Sendable {
    case openLocation = "location.open_now"
    case openLocationMap = "location.open_map"
    case openActiveShares = "location.open_active_shares"
    case openSharedWithMe = "location.open_shared_with_me"
    case openRequestsToReview = "location.open_needs_review"
    case openLocationSettings = "location.open_settings"
    case openTemporaryLink = "location.open_temporary_link"
    case openCheckIn = "location.open_check_in"
    case openEmergencySOS = "location.open_sos"
    case openSMSContacts = "location.open_sms_contacts"
    case shareLocation = "location.share_selected"
    case askForLocation = "location.send_request"
    case stopShare = "location.stop_share"
    case pauseLocation = "location.pause_updates"
    case resumeLocation = "location.resume_updates"
    case createCircle = "location.create_circle"
    case renameCircle = "location.rename_circle"

    static let vaultRequiredActionIDs: Set<OneSystemActionID> = [
        .shareLocation,
        .askForLocation,
        .stopShare,
        .pauseLocation,
        .resumeLocation,
        .createCircle,
        .renameCircle
    ]

    static let systemConfirmationRequiredActionIDs: Set<OneSystemActionID> = [
        .shareLocation,
        .askForLocation,
        .stopShare,
        .resumeLocation,
        .createCircle,
        .renameCircle
    ]

    var requiresVault: Bool {
        Self.vaultRequiredActionIDs.contains(self)
    }

    var requiresSystemConfirmation: Bool {
        Self.systemConfirmationRequiredActionIDs.contains(self)
    }

    var allowedSlotNames: Set<String> {
        switch self {
        case .shareLocation, .askForLocation:
            return ["person", "resolvedRecipientId", "duration_hours"]
        case .stopShare:
            return ["person", "resolvedRecipientId"]
        case .createCircle:
            return ["name", "kind"]
        case .renameCircle:
            return ["circle", "resolvedCircleId", "name"]
        case .pauseLocation, .resumeLocation, .openLocation, .openLocationMap,
             .openActiveShares, .openSharedWithMe, .openRequestsToReview,
             .openLocationSettings, .openTemporaryLink, .openCheckIn,
             .openEmergencySOS, .openSMSContacts:
            return []
        }
    }
}

struct PendingOneSystemActionInvocation: Codable, Equatable, Sendable {
    static let supportedKind = "execute_one_action"
    static let supportedSource = "siri_app_intent"

    let id: String
    let kind: String
    let source: String
    let actionID: OneSystemActionID
    let slots: [String: String]
    let requiresVault: Bool
    let confirmedBySystem: Bool
    let createdAt: Date
    let expiresAt: Date
    let generation: Int
    var state: String

    init(
        id: String = UUID().uuidString,
        actionID: OneSystemActionID,
        slots: [String: String] = [:],
        confirmedBySystem: Bool = false,
        createdAt: Date? = nil,
        expiresAt: Date? = nil,
        generation: Int = 0,
        state: String = "pending"
    ) {
        self.id = id
        self.kind = Self.supportedKind
        self.source = Self.supportedSource
        self.actionID = actionID
        self.slots = slots
        self.requiresVault = actionID.requiresVault
        self.confirmedBySystem = confirmedBySystem
        self.createdAt = createdAt ?? Date()
        self.expiresAt = expiresAt ?? self.createdAt.addingTimeInterval(OneSystemActionInvocationCoordinator.ttl)
        self.generation = generation
        self.state = state
    }

    var bridgePayload: [String: Any] {
        [
            "id": id,
            "kind": kind,
            "source": source,
            "actionId": actionID.rawValue,
            "slots": slots,
            "requiresVault": requiresVault,
            "confirmedBySystem": confirmedBySystem,
            "createdAt": Int64(createdAt.timeIntervalSince1970 * 1_000),
            "expiresAt": Int64(expiresAt.timeIntervalSince1970 * 1_000),
            "generation": generation,
            "state": state
        ]
    }
}

struct OneSystemActionCompletion: Codable, Equatable, Sendable {
    let id: String
    let generation: Int
    let outcome: String
    let summary: String
    let finishedAt: Date
}

struct OneSystemActionClaimRecord: Codable, Equatable, Sendable {
    let invocation: PendingOneSystemActionInvocation
    let claimedAt: Date
}

enum OneSystemActionProgressState: Codable, Equatable, Sendable {
    case waitingForVault = "waiting_for_vault"
}

struct OneSystemActionProgress: Codable, Equatable, Sendable {
    let id: String
    let state: OneSystemActionProgressState
    let updatedAt: Date
}

enum OneSystemActionWaitResult: Equatable, Sendable {
    case completion(OneSystemActionCompletion)
    case progress(OneSystemActionProgress)
}

struct OneSystemEntityIndexEntry: Codable, Equatable, Sendable {
    let id: String
    let name: String
}

struct OneSystemEntityIndex: Codable, Equatable, Sendable {
    let ownerID: String
    let contacts: [OneSystemEntityIndexEntry]
    let circles: [OneSystemEntityIndexEntry]
    let updatedAt: Date
}

extension Notification.Name {
    static let oneSystemActionInvocationAvailable = Notification.Name(
        "ai.hushh.one.system-action-invocation-available"
    )
}

protocol OneSystemSecureStoring: AnyObject {
    func data(for key: String) -> Data?
    func set(_ data: Data, for key: String) -> Bool
    func remove(_ key: String)
}

final class OneSystemKeychainStore: OneSystemSecureStoring {
    private let service: String

    init(service: String = "com.hushh.app.system-actions") {
        self.service = service
    }

    func data(for key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
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
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
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

/// Secure, latest-wins handoff between App Intents and the existing web action
/// runtime. This object stores no credentials, coordinates, routes, or speech.
/// Parameter values are bounded and live in this-device-only Keychain records.
final class OneSystemActionInvocationCoordinator: @unchecked Sendable {
    static let shared = OneSystemActionInvocationCoordinator()
    static let ttl: TimeInterval = 5 * 60

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "ai.hushh.one",
        category: "SiriOneAction"
    )
    private static let allowedOutcomes: Set<String> = [
        "succeeded", "started", "blocked", "failed", "expired", "cancelled"
    ]
    private static let maxSlotLength = 160
    private static let maxEntityCount = 500

    private let store: OneSystemSecureStoring
    private let pendingKey: String
    private let claimedKey: String
    private let completionKey: String
    private let progressKey: String
    private let entityIndexKey: String
    private let requestOwnerKey: String
    private let now: () -> Date
    private let currentUserID: () -> String?
    private let lock = NSLock()

    init(
        store: OneSystemSecureStoring = OneSystemKeychainStore(),
        keyPrefix: String = "one.system-action.v1",
        now: @escaping () -> Date = Date.init,
        currentUserID: @escaping () -> String? = OneSystemActionInvocationCoordinator.persistedAuthUserID
    ) {
        self.store = store
        self.pendingKey = "\(keyPrefix).pending"
        self.claimedKey = "\(keyPrefix).claimed"
        self.completionKey = "\(keyPrefix).completion"
        self.progressKey = "\(keyPrefix).progress"
        self.entityIndexKey = "\(keyPrefix).entities"
        self.requestOwnerKey = "\(keyPrefix).request_owner"
        self.now = now
        self.currentUserID = currentUserID
    }

    // MARK: - Request ownership

    func currentRequestOwner() -> String? {
        lock.lock()
        defer { lock.unlock() }
        guard let data = store.data(for: requestOwnerKey) else { return nil }
        guard let value = String(data: data, encoding: .utf8), !value.isEmpty else { return nil }
        return value
    }

    func bindRequestOwner(_ ownerID: String?) {
        let safe = Self.sanitizeIdentifier(ownerID ?? "")
        lock.lock()
        if safe.isEmpty {
            store.remove(requestOwnerKey)
        } else {
            _ = store.set(Data(safe.utf8), for: requestOwnerKey)
        }
        lock.unlock()
    }

    // MARK: - Enqueue

    @discardableResult
    func enqueue(
        actionID: OneSystemActionID,
        slots: [String: String] = [:],
        confirmedBySystem: Bool = false
    ) -> PendingOneSystemActionInvocation? {
        guard let safeSlots = sanitizedSlots(slots, for: actionID) else {
            return nil
        }
        let createdAt = now()
        let invocation = PendingOneSystemActionInvocation(
            actionID: actionID,
            slots: safeSlots,
            confirmedBySystem: confirmedBySystem,
            createdAt: createdAt,
            expiresAt: createdAt.addingTimeInterval(Self.ttl),
            generation: 0,
            state: "pending"
        )

        lock.lock()
        let replaced = read(PendingOneSystemActionInvocation.self, key: pendingKey)
        store.remove(claimedKey)
        store.remove(completionKey)
        store.remove(progressKey)
        let stored = write(invocation, key: pendingKey)
        lock.unlock()
        guard stored else { return nil }

        if let replaced {
            Self.log(state: "cancelled", invocation: replaced, outcome: "replaced")
        }
        publishAvailability(state: "requested")
        return invocation
    }

    // MARK: - Pending

    func pending() -> PendingOneSystemActionInvocation? {
        lock.lock()
        guard let invocation = readValidatedPending(key: pendingKey) else {
            lock.unlock()
            return nil
        }
        if invocation.expiresAt <= now() {
            store.remove(pendingKey)
            store.remove(progressKey)
            lock.unlock()
            Self.log(state: "expired", invocation: invocation, outcome: "expired")
            return nil
        }
        lock.unlock()
        return invocation
    }

    // MARK: - Claim (atomic ownership transfer)

    @discardableResult
    func claim(id: String) -> Bool {
        lock.lock()
        guard let invocation = readValidatedPending(key: pendingKey), invocation.id == id else {
            lock.unlock()
            return false
        }
        if invocation.expiresAt <= now() {
            store.remove(pendingKey)
            lock.unlock()
            Self.log(state: "expired", invocation: invocation, outcome: "expired")
            return false
        }

        let nextGeneration = invocation.generation + 1
        let claimed = PendingOneSystemActionInvocation(
            id: invocation.id,
            actionID: invocation.actionID,
            slots: invocation.slots,
            confirmedBySystem: invocation.confirmedBySystem,
            createdAt: invocation.createdAt,
            expiresAt: invocation.expiresAt,
            generation: nextGeneration,
            state: "claimed"
        )

        let claimRecord = OneSystemActionClaimRecord(
            invocation: claimed,
            claimedAt: now()
        )

        let wroteClaim = write(claimRecord, key: claimedKey)
        guard wroteClaim else {
            lock.unlock()
            return false
        }
        store.remove(pendingKey)
        store.remove(progressKey)
        lock.unlock()
        Self.log(state: "dispatched", invocation: claimed, outcome: "claimed")
        return true
    }

    func claimedRecord() -> OneSystemActionClaimRecord? {
        lock.lock()
        guard let record = read(OneSystemActionClaimRecord.self, key: claimedKey) else {
            lock.unlock()
            return nil
        }
        guard record.invocation.expiresAt > now() else {
            store.remove(claimedKey)
            lock.unlock()
            return nil
        }
        lock.unlock()
        return record
    }

    // MARK: - Completion

    func complete(id: String, generation: Int, outcome: String, summary: String) {
        let safeOutcome = Self.allowedOutcomes.contains(outcome) ? outcome : "failed"
        let safeSummary = Self.sanitizeDisplayText(summary, maxLength: 240)
        lock.lock()
        let claimed = readClaimRecord(key: claimedKey)
        let pending = readValidatedPending(key: pendingKey)
        let targetInvocation: PendingOneSystemActionInvocation?
        if let claimed, claimed.invocation.id == id, claimed.invocation.generation == generation {
            targetInvocation = claimed.invocation
        } else if let pending, pending.id == id, pending.generation == generation {
            targetInvocation = pending
        } else {
            targetInvocation = nil
        }
        guard let invocation = targetInvocation else {
            lock.unlock()
            return
        }
        store.remove(pendingKey)
        store.remove(claimedKey)
        store.remove(progressKey)
        _ = write(
            OneSystemActionCompletion(
                id: id,
                generation: generation,
                outcome: safeOutcome,
                summary: safeSummary.isEmpty ? "Agent One could not finish that action." : safeSummary,
                finishedAt: now()
            ),
            key: completionKey
        )
        lock.unlock()
        Self.log(state: safeOutcome, invocation: invocation, outcome: safeOutcome)
    }

    func completion(id: String, generation: Int) -> OneSystemActionCompletion? {
        lock.lock()
        let value = read(OneSystemActionCompletion.self, key: completionKey)
        lock.unlock()
        guard let value, value.id == id, value.generation == generation else { return nil }
        return value
    }

    // MARK: - Progress

    @discardableResult
    func reportProgress(id: String, state: OneSystemActionProgressState) -> Bool {
        lock.lock()
        guard
            let invocation = readValidatedPending(key: pendingKey),
            invocation.id == id,
            invocation.requiresVault,
            invocation.expiresAt > now()
        else {
            lock.unlock()
            return false
        }
        let reported = write(
            OneSystemActionProgress(id: id, state: state, updatedAt: now()),
            key: progressKey
        )
        lock.unlock()
        if reported {
            Self.log(state: state.rawValue, invocation: invocation)
        }
        return reported
    }

    func progress(id: String) -> OneSystemActionProgress? {
        lock.lock()
        let value = read(OneSystemActionProgress.self, key: progressKey)
        lock.unlock()
        return value?.id == id ? value : nil
    }

    // MARK: - Cancel

    func cancel(outcome: String = "cancelled") {
        lock.lock()
        let pending = readValidatedPending(key: pendingKey)
        let claimed = readClaimRecord(key: claimedKey)
        store.remove(pendingKey)
        store.remove(claimedKey)
        store.remove(completionKey)
        store.remove(progressKey)
        lock.unlock()
        if let pending { Self.log(state: "cancelled", invocation: pending, outcome: outcome) }
        if let claimed { Self.log(state: "cancelled", invocation: claimed.invocation, outcome: outcome) }
    }

    @discardableResult
    func cancelAll(outcome: String = "cancelled", clearEntityIndex: Bool = false) -> Bool {
        lock.lock()
        let pending = readValidatedPending(key: pendingKey)
        let claimed = readClaimRecord(key: claimedKey)
        store.remove(pendingKey)
        store.remove(claimedKey)
        store.remove(completionKey)
        store.remove(progressKey)
        if clearEntityIndex { store.remove(entityIndexKey) }
        lock.unlock()
        if let pending { Self.log(state: "cancelled", invocation: pending, outcome: outcome) }
        if let claimed { Self.log(state: "cancelled", invocation: claimed.invocation, outcome: outcome) }
        return true
    }

    // MARK: - Availability

    func publishAvailability(state: String) {
        guard let invocation = pending() else { return }
        Self.log(state: state, invocation: invocation)
        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: .oneSystemActionInvocationAvailable,
                object: self
            )
        }
    }

    // MARK: - Entity index

    @discardableResult
    func updateEntityIndex(
        ownerID: String,
        contacts: [OneSystemEntityIndexEntry],
        circles: [OneSystemEntityIndexEntry]
    ) -> Bool {
        let safeOwnerID = Self.sanitizeIdentifier(ownerID)
        guard !safeOwnerID.isEmpty else { return false }
        let index = OneSystemEntityIndex(
            ownerID: safeOwnerID,
            contacts: Self.sanitizeEntities(contacts),
            circles: Self.sanitizeEntities(circles),
            updatedAt: now()
        )
        lock.lock()
        let result = write(index, key: entityIndexKey)
        lock.unlock()
        #if canImport(AppIntents)
        if result, #available(iOS 16.0, *) {
            Task { @MainActor in
                HusshOneAppShortcuts.updateAppShortcutParameters()
            }
        }
        #endif
        return result
    }

    func contacts(matching query: String? = nil) -> [OneSystemEntityIndexEntry] {
        filteredEntities(keyPath: \OneSystemEntityIndex.contacts, matching: query)
    }

    func circles(matching query: String? = nil) -> [OneSystemEntityIndexEntry] {
        filteredEntities(keyPath: \OneSystemEntityIndex.circles, matching: query)
    }

    // MARK: - Private helpers

    private func readClaimRecord(key: String) -> OneSystemActionClaimRecord? {
        guard let value = read(OneSystemActionClaimRecord.self, key: key) else { return nil }
        guard value.invocation.state == "claimed",
              value.invocation.expiresAt > now() else {
            store.remove(key)
            return nil
        }
        return value
    }

    private func readValidatedPending(key: String) -> PendingOneSystemActionInvocation? {
        guard let value = read(PendingOneSystemActionInvocation.self, key: key) else { return nil }
        guard
            value.kind == PendingOneSystemActionInvocation.supportedKind,
            value.source == PendingOneSystemActionInvocation.supportedSource,
            value.requiresVault == value.actionID.requiresVault,
            sanitizedSlots(value.slots, for: value.actionID) == value.slots,
            ["pending", "claimed"].contains(value.state)
        else {
            store.remove(key)
            return nil
        }
        return value
    }

    private func read<T: Decodable>(_ type: T.Type, key: String) -> T? {
        guard let data = store.data(for: key) else { return nil }
        guard let value = try? JSONDecoder().decode(type, from: data) else {
            store.remove(key)
            return nil
        }
        return value
    }

    @discardableResult
    private func write<T: Encodable>(_ value: T, key: String) -> Bool {
        guard let data = try? JSONEncoder().encode(value) else { return false }
        return store.set(data, for: key)
    }

    private func filteredEntities(
        keyPath: KeyPath<OneSystemEntityIndex, [OneSystemEntityIndexEntry]>,
        matching query: String?
    ) -> [OneSystemEntityIndexEntry] {
        lock.lock()
        let index = read(OneSystemEntityIndex.self, key: entityIndexKey)
        lock.unlock()
        guard let index, index.ownerID == currentUserID() else { return [] }
        let entities = index[keyPath: keyPath]
        let target = Self.normalizedName(query ?? "")
        guard !target.isEmpty else { return entities }
        return entities
            .map { ($0, Self.normalizedName($0.name)) }
            .filter { $0.1 == target || $0.1.hasPrefix(target) || $0.1.contains(target) }
            .sorted { left, right in
                let leftExact = left.1 == target
                let rightExact = right.1 == target
                if leftExact != rightExact { return leftExact }
                return left.0.name.localizedCaseInsensitiveCompare(right.0.name) == .orderedAscending
            }
            .map(\.0)
    }

    private func sanitizedSlots(
        _ slots: [String: String],
        for actionID: OneSystemActionID
    ) -> [String: String]? {
        guard Set(slots.keys).isSubset(of: actionID.allowedSlotNames) else { return nil }
        var result: [String: String] = [:]
        for (key, value) in slots {
            guard value.count <= Self.maxSlotLength else { return nil }
            let safe = Self.sanitizeDisplayText(value, maxLength: Self.maxSlotLength)
            guard !safe.isEmpty else { continue }
            result[key] = safe
        }
        return result
    }

    private static func sanitizeEntities(
        _ entries: [OneSystemEntityIndexEntry]
    ) -> [OneSystemEntityIndexEntry] {
        var seen = Set<String>()
        return entries.prefix(maxEntityCount).compactMap { entry in
            let id = sanitizeIdentifier(entry.id)
            let name = sanitizeDisplayText(entry.name, maxLength: 96)
            guard !id.isEmpty, !name.isEmpty, seen.insert(id).inserted else { return nil }
            return OneSystemEntityIndexEntry(id: id, name: name)
        }
    }

    private static func sanitizeIdentifier(_ value: String) -> String {
        let safe = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard safe.count <= 160 else { return "" }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_:.") )
        return safe.unicodeScalars.allSatisfy { allowed.contains($0) } ? safe : ""
    }

    private static func sanitizeDisplayText(_ value: String, maxLength: Int) -> String {
        let collapsed = value
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        return String(collapsed.prefix(maxLength))
    }

    private static func normalizedName(_ value: String) -> String {
        sanitizeDisplayText(
            value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current),
            maxLength: 160
        ).lowercased()
    }

    private static func persistedAuthUserID() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.hushh.pda.auth",
            kSecAttrAccount as String: "hushh_user_id",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard
            SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
            let data = item as? Data,
            let value = String(data: data, encoding: .utf8),
            !value.isEmpty
        else { return nil }
        return value
    }

    private static func log(
        state: String,
        invocation: PendingOneSystemActionInvocation,
        outcome: String? = nil
    ) {
        let durationMs = max(0, Int(Date().timeIntervalSince(invocation.createdAt) * 1_000))
        let safeOutcome = outcome ?? "none"
        logger.info(
            "state=\(state, privacy: .public) request_id=\(invocation.id, privacy: .public) source=\(invocation.source, privacy: .public) action_id=\(invocation.actionID.rawValue, privacy: .public) outcome=\(safeOutcome, privacy: .public) duration_ms=\(durationMs, privacy: .public) generation=\(invocation.generation, privacy: .public)"
        )
    }
}
