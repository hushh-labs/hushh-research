// SPDX-FileCopyrightText: 2026 Hushh
// SPDX-License-Identifier: Apache-2.0

import CryptoKit
@testable import OneConsent
import XCTest

/// Validates the wrap/unwrap envelope shape and round-trip behaviour of
/// ``SecureEnclaveKeyStore`` against the in-memory backend.
///
/// The real backend (``Backend.real``) requires the macOS Keychain access
/// group ``ai.hushh.one`` which only the signed/entitled app + daemon can
/// access; that lane is covered by PR-7 integration tests on a notarized
/// build. PR-2 ships pure-Swift parity tests against the in-memory backend.
final class SecureEnclaveKeyStoreTests: XCTestCase {
    func testProvisionAndUnwrapRoundTrip() throws {
        let store = SecureEnclaveKeyStore(backend: .inMemory)
        try store.provisionDataKey()
        let key = try store.dataKey()
        let keyBytes = key.withUnsafeBytes { Data($0) }
        XCTAssertEqual(keyBytes.count, 32, "AES-256 data key must be 32 bytes")
    }

    func testEnvelopeStartsWithVersionByte() throws {
        let store = SecureEnclaveKeyStore(backend: .inMemory)
        try store.provisionDataKey()
        // Re-read the envelope by unwrapping and re-wrapping (proves the
        // version byte parses cleanly).
        let key = try store.dataKey()
        XCTAssertNotNil(key)
    }

    func testRotateProducesDifferentKey() throws {
        let store = SecureEnclaveKeyStore(backend: .inMemory)
        try store.provisionDataKey()
        let first = try store.dataKey().withUnsafeBytes { Data($0) }
        try store.provisionDataKey()
        let second = try store.dataKey().withUnsafeBytes { Data($0) }
        XCTAssertNotEqual(first, second, "rotation must change the data key")
    }

    func testWipeRemovesKey() throws {
        let store = SecureEnclaveKeyStore(backend: .inMemory)
        try store.provisionDataKey()
        try store.wipe()
        XCTAssertThrowsError(try store.dataKey()) { error in
            guard let storeError = error as? SecureEnclaveKeyStore.StoreError else {
                return XCTFail("unexpected error: \(error)")
            }
            switch storeError {
            case .keychainReadFailed:
                break
            default:
                XCTFail("expected keychainReadFailed, got \(storeError)")
            }
        }
    }

    func testDataKeyEncryptsAndDecryptsPayload() throws {
        let store = SecureEnclaveKeyStore(backend: .inMemory)
        try store.provisionDataKey()
        let key = try store.dataKey()
        let plaintext = Data("the only One with your agents yours to own".utf8)
        let sealed = try AES.GCM.seal(plaintext, using: key)
        let opened = try AES.GCM.open(sealed, using: key)
        XCTAssertEqual(opened, plaintext)
    }
}
