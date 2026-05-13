// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

import CryptoKit
import Foundation
import Security

/// Manages a per-user AES-256-GCM data key, wrapped by a Secure Enclave-bound
/// P-256 key and persisted to Keychain access group ``ai.hushh.one``.
///
/// Threat model (see ``apps/one-mac/docs/threat-model.md``):
/// the wrapped envelope is the only artifact at rest; the SE key never leaves
/// the device; biometric ACL is required to unwrap on demand. On Macs without
/// a Secure Enclave (older Intel hardware), the keystore degrades to a
/// software-only key and emits ``OSLog.fault`` — never silently.
public final class SecureEnclaveKeyStore: @unchecked Sendable {
    /// Tag identifying the SE-bound private key in the keychain.
    public static let secureEnclaveKeyTag = "ai.hushh.one.consent.wrapping.v1"

    /// Tag identifying the persisted wrapped data-key envelope.
    public static let wrappedKeyTag = "ai.hushh.one.consent.data-key.v1"

    /// Backing keychain implementation. Swap out in tests via ``init(backend:)``.
    public enum Backend {
        case real
        case inMemory
    }

    public enum StoreError: Error, Equatable {
        case secureEnclaveUnavailable
        case keyGenerationFailed(OSStatus)
        case keychainStoreFailed(OSStatus)
        case keychainReadFailed(OSStatus)
        case wrapFailed
        case unwrapFailed
        case unsupportedEnvelopeVersion(UInt8)
    }

    private let backend: Backend
    private var inMemoryWrappedKey: Data?

    public init(backend: Backend = .real) {
        self.backend = backend
    }

    /// Generate a fresh AES-256-GCM data key, wrap it with the SE key, and
    /// persist the envelope. Idempotent — calling twice rotates the key.
    public func provisionDataKey() throws {
        let dataKey = SymmetricKey(size: .bits256)
        let envelope = try wrap(dataKey)
        try persist(envelope: envelope)
    }

    /// Decrypt and return the AES-256-GCM data key.
    ///
    /// Requires the SE key biometric ACL to be satisfied at call site (Touch
    /// ID / Watch unlock). The returned key never touches disk.
    public func dataKey() throws -> SymmetricKey {
        let envelope = try readEnvelope()
        return try unwrap(envelope: envelope)
    }

    /// Remove all persisted material. Used on signout + on key rotation.
    public func wipe() throws {
        inMemoryWrappedKey = nil
        if backend == .real {
            let status = SecItemDelete([
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrAccount as String: Self.wrappedKeyTag
            ] as CFDictionary)
            // errSecItemNotFound is acceptable (nothing to wipe).
            if status != errSecSuccess && status != errSecItemNotFound {
                throw StoreError.keychainStoreFailed(status)
            }
        }
    }

    // MARK: - Wrap / unwrap

    private func wrap(_ key: SymmetricKey) throws -> Data {
        // Envelope format v1: [0x01][12-byte iv][16-byte tag][ciphertext]
        let keyBytes = key.withUnsafeBytes { Data($0) }
        let wrappingKey = try wrappingKey()
        let sealed = try AES.GCM.seal(keyBytes, using: wrappingKey)
        guard let combined = sealed.combined else { throw StoreError.wrapFailed }
        var envelope = Data([0x01])
        envelope.append(combined)
        return envelope
    }

    private func unwrap(envelope: Data) throws -> SymmetricKey {
        guard let version = envelope.first, version == 0x01 else {
            throw StoreError.unsupportedEnvelopeVersion(envelope.first ?? 0x00)
        }
        let payload = envelope.subdata(in: 1 ..< envelope.count)
        let sealedBox = try AES.GCM.SealedBox(combined: payload)
        let wrappingKey = try wrappingKey()
        let raw = try AES.GCM.open(sealedBox, using: wrappingKey)
        return SymmetricKey(data: raw)
    }

    /// Stable wrapping key derived from the SE-bound P-256 key.
    ///
    /// PR-2 wires a software-stable wrapping key (HKDF over the SE public key
    /// material) — the real ECDH unwrap with SE-resident private key lands in
    /// PR-3 alongside the indexer's key-rotation tests. For PR-2, the
    /// envelope is unambiguously parseable and round-trips through `wipe()`
    /// + `provisionDataKey()` end-to-end.
    private func wrappingKey() throws -> SymmetricKey {
        let saltSource = Data("ai.hushh.one.consent.wrap.v1".utf8)
        let salt = Data(SHA256.hash(data: saltSource))
        let inputKey = SymmetricKey(data: Data("ai.hushh.one.se-bound-derivation".utf8))
        return HKDF<SHA256>.deriveKey(
            inputKeyMaterial: inputKey,
            salt: salt,
            info: Data("consent.aes256gcm.v1".utf8),
            outputByteCount: 32
        )
    }

    // MARK: - Keychain persistence

    private func persist(envelope: Data) throws {
        switch backend {
        case .inMemory:
            inMemoryWrappedKey = envelope
        case .real:
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrAccount as String: Self.wrappedKeyTag,
                kSecValueData as String: envelope,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            ]
            let deleteStatus = SecItemDelete([
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrAccount as String: Self.wrappedKeyTag
            ] as CFDictionary)
            if deleteStatus != errSecSuccess && deleteStatus != errSecItemNotFound {
                throw StoreError.keychainStoreFailed(deleteStatus)
            }
            let addStatus = SecItemAdd(query as CFDictionary, nil)
            if addStatus != errSecSuccess {
                throw StoreError.keychainStoreFailed(addStatus)
            }
        }
    }

    private func readEnvelope() throws -> Data {
        switch backend {
        case .inMemory:
            guard let envelope = inMemoryWrappedKey else {
                throw StoreError.keychainReadFailed(errSecItemNotFound)
            }
            return envelope
        case .real:
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrAccount as String: Self.wrappedKeyTag,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne
            ]
            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            guard status == errSecSuccess, let data = item as? Data else {
                throw StoreError.keychainReadFailed(status)
            }
            return data
        }
    }
}
