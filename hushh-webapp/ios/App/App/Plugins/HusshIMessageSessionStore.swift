import Foundation
import LocalAuthentication
import Security

/// Process-local publication authority, independent of Keychain I/O.
struct HusshIMessagePublicationGeneration {
    private(set) var generation = 0

    mutating func invalidate() -> Int {
        generation += 1
        return generation
    }

    func accepts(_ candidate: Int) -> Bool {
        candidate > 0 && candidate == generation
    }
}

/// Publishes the authenticated Hussh session for the iMessage extension.
///
/// This store is intentionally native and UI-free: the main app remains the
/// session authority, while the iMessage extension only reads the shared
/// Keychain values when it is installed and opened.
final class HusshIMessageSessionStore {
    static let shared = HusshIMessageSessionStore()

    private let service = "com.hushh.app.imessage.auth"
    private let userIDAccount = "hussh.user-id"
    private let displayNameAccount = "hussh.display-name"
    private let emailAccount = "hussh.email"
    private let avatarURLAccount = "hussh.avatar-url"
    private let firebaseIDTokenAccount = "hussh.firebase-id-token"
    private let firebaseIDTokenExpiresAtAccount = "hussh.firebase-id-token-expires-at"
    private let vaultOwnerTokenAccount = "hussh.vault-owner-token"
    private let vaultOwnerTokenExpiresAtAccount = "hussh.vault-owner-token-expires-at"
    private let vaultStateAccount = "hussh.vault-state"
    private let vaultKeyAccount = "hussh.vault-key"
    private let accessTokenAccount = "hussh.access-token"
    private let expiresAtAccount = "hussh.access-token-expires-at"
    private let tokenKindAccount = "hussh.token-kind"
    private let publicationLock = NSRecursiveLock()
    private var publicationGeneration = HusshIMessagePublicationGeneration()

    private init() {}

    func publishIdentity(
        userID: String,
        displayName: String?,
        email: String?,
        avatarURL: String?,
        firebaseIDToken: String,
        firebaseIDTokenExpiresAt: Int64?
    ) throws {
        try save(userID, account: userIDAccount)
        try saveOptional(displayName, account: displayNameAccount)
        try saveOptional(email, account: emailAccount)
        try saveOptional(avatarURL, account: avatarURLAccount)
        try save(firebaseIDToken, account: firebaseIDTokenAccount)
        try saveOptional(firebaseIDTokenExpiresAt.map(String.init), account: firebaseIDTokenExpiresAtAccount)
    }

    func publishVault(
        userID: String,
        vaultOwnerToken: String,
        expiresAt: Int64,
        vaultState: String = "unlocked",
        vaultKey: String? = nil
    ) throws {
        try save(userID, account: userIDAccount)
        try save(vaultOwnerToken, account: vaultOwnerTokenAccount)
        try save(String(expiresAt), account: vaultOwnerTokenExpiresAtAccount)
        try save(vaultState, account: vaultStateAccount)
        if let vaultKey, !vaultKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            try saveProtected(vaultKey, account: vaultKeyAccount)
        }
        try clearLegacyGenericSession()
    }

    /// Lock and publication share one native generation, including callbacks
    /// that arrive after a document reload or a Firebase sign-out.
    func publishIfCurrent(generation: Int, _ publication: () throws -> Void) rethrows -> Bool {
        publicationLock.lock()
        defer { publicationLock.unlock() }
        guard publicationGeneration.accepts(generation) else { return false }
        try publication()
        return true
    }

    @discardableResult
    func clear() throws -> Int {
        publicationLock.lock()
        defer { publicationLock.unlock() }
        // Advance even if deletion fails: failed cleanup cannot authorize an
        // older pending publisher to restore the session.
        let sessionGeneration = publicationGeneration.invalidate()
        try delete(account: userIDAccount)
        try delete(account: displayNameAccount)
        try delete(account: emailAccount)
        try delete(account: avatarURLAccount)
        try delete(account: firebaseIDTokenAccount)
        try delete(account: firebaseIDTokenExpiresAtAccount)
        try delete(account: vaultOwnerTokenAccount)
        try delete(account: vaultOwnerTokenExpiresAtAccount)
        try delete(account: vaultStateAccount)
        try delete(account: vaultKeyAccount)
        try clearLegacyGenericSession()
        return sessionGeneration
    }

    private func clearLegacyGenericSession() throws {
        try delete(account: accessTokenAccount)
        try delete(account: expiresAtAccount)
        try delete(account: tokenKindAccount)
    }

    func publishIdentitySilently(
        userID: String,
        displayName: String?,
        email: String?,
        avatarURL: String?,
        firebaseIDToken: String,
        firebaseIDTokenExpiresAt: Int64?
    ) {
        do {
            try publishIdentity(
                userID: userID,
                displayName: displayName,
                email: email,
                avatarURL: avatarURL,
                firebaseIDToken: firebaseIDToken,
                firebaseIDTokenExpiresAt: firebaseIDTokenExpiresAt
            )
            print("✅ [HusshIMessageSessionStore] Published shared iMessage identity")
        } catch {
            print("⚠️ [HusshIMessageSessionStore] Could not publish shared iMessage identity: \(error)")
        }
    }

    func publishVaultSilently(
        userID: String,
        vaultOwnerToken: String,
        expiresAt: Int64,
        vaultState: String = "unlocked",
        vaultKey: String? = nil
    ) {
        do {
            try publishVault(
                userID: userID,
                vaultOwnerToken: vaultOwnerToken,
                expiresAt: expiresAt,
                vaultState: vaultState,
                vaultKey: vaultKey
            )
            print("✅ [HusshIMessageSessionStore] Published shared iMessage vault session")
        } catch {
            print("⚠️ [HusshIMessageSessionStore] Could not publish shared iMessage vault session: \(error)")
        }
    }

    func clearSilently() {
        do {
            try clear()
            print("✅ [HusshIMessageSessionStore] Cleared shared iMessage session")
        } catch {
            print("⚠️ [HusshIMessageSessionStore] Could not clear shared iMessage session: \(error)")
        }
    }

    private func query(account: String) -> [String: Any] {
        var attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        if let accessGroup = resolvedAccessGroup() {
            attributes[kSecAttrAccessGroup as String] = accessGroup
        }
        return attributes
    }

    private func resolvedAccessGroup() -> String? {
        guard let raw = Bundle.main.object(
            forInfoDictionaryKey: "HusshIMessageKeychainAccessGroup"
        ) as? String else {
            return nil
        }

        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private func save(_ value: String, account: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw SessionStoreError.invalidValue(account)
        }

        var attributes = query(account: account)
        SecItemDelete(attributes as CFDictionary)

        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw SessionStoreError.keychainStatus(status)
        }
    }

    private func saveProtected(_ value: String, account: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw SessionStoreError.invalidValue(account)
        }

        var attributes = query(account: account)
        SecItemDelete(attributes as CFDictionary)

        var accessControlError: Unmanaged<CFError>?
        guard let accessControl = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.userPresence],
            &accessControlError
        ) else {
            throw SessionStoreError.accessControl(accessControlError?.takeRetainedValue())
        }

        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessControl as String] = accessControl

        let context = LAContext()
        context.localizedReason = "Unlock Hussh One to share your approved private context in Messages."
        attributes[kSecUseAuthenticationContext as String] = context

        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw SessionStoreError.keychainStatus(status)
        }
    }

    private func saveOptional(_ value: String?, account: String) throws {
        let cleaned = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let cleaned, !cleaned.isEmpty {
            try save(cleaned, account: account)
        } else {
            try delete(account: account)
        }
    }

    private func delete(account: String) throws {
        let status = SecItemDelete(query(account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SessionStoreError.keychainStatus(status)
        }
    }

    private enum SessionStoreError: Error {
        case invalidValue(String)
        case accessControl(CFError?)
        case keychainStatus(OSStatus)
    }
}
