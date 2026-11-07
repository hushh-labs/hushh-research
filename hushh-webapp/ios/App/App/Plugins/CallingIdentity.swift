import CryptoKit
import Foundation
import Security

#if targetEnvironment(simulator)
private typealias CallingSigningMaterial = P256.Signing.PrivateKey
private typealias CallingAgreementMaterial = P256.KeyAgreement.PrivateKey
#else
private typealias CallingSigningMaterial = SecureEnclave.P256.Signing.PrivateKey
private typealias CallingAgreementMaterial = SecureEnclave.P256.KeyAgreement.PrivateKey
#endif

/// Separate calling installation, enrolled in the SAME trusted-device registry.
/// Locked-call access never changes vault/PKM key accessibility.
final class CallingIdentity {
    let owner: String
    let keyId: String
    var deviceId: String
    private let signing: CallingSigningMaterial
    private let encryption: CallingAgreementMaterial
    private let account: String
    private var record: [String: Any]
    private static let service = "ai.hushh.native-calling.v1"

    init(owner: String, origin: String) throws {
        self.owner = owner
        account = try CallingWire.hash([origin, owner, "calling-installation-v1"])
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service, kSecAttrAccount as String: account,
            kSecReturnData as String: true]
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecSuccess, let data = value as? Data {
            record = try CallingWire.object(data)
            #if targetEnvironment(simulator)
            signing = try CallingSigningMaterial(rawRepresentation: CallingWire.data(record["signing"]))
            encryption = try CallingAgreementMaterial(rawRepresentation: CallingWire.data(record["encryption"]))
            #else
            signing = try CallingSigningMaterial(dataRepresentation: CallingWire.data(record["signing"]))
            encryption = try CallingAgreementMaterial(dataRepresentation: CallingWire.data(record["encryption"]))
            #endif
        } else if status == errSecItemNotFound {
            #if targetEnvironment(simulator)
            signing = CallingSigningMaterial()
            encryption = CallingAgreementMaterial()
            record = ["signing": signing.rawRepresentation.base64EncodedString(),
                      "encryption": encryption.rawRepresentation.base64EncodedString()]
            #else
            guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                                                              .privateKeyUsage, nil) else { throw CallingError.unavailable }
            signing = try CallingSigningMaterial(accessControl: access)
            encryption = try CallingAgreementMaterial(accessControl: access)
            record = ["signing": signing.dataRepresentation.base64EncodedString(),
                      "encryption": encryption.dataRepresentation.base64EncodedString()]
            #endif
            record["keyId"] = UUID().uuidString.lowercased()
        } else { throw CallingError.unavailable } // Locked before first unlock is not "missing".
        keyId = try CallingWire.string(record, "keyId")
        deviceId = record["deviceId"] as? String ?? ""
        query.removeValue(forKey: kSecReturnData as String)
        try save()
    }

    var publicKey: String { encryption.publicKey.derRepresentation.base64EncodedString() }
    var signingKey: String { signing.publicKey.derRepresentation.base64EncodedString() }

    func enroll(_ id: String) throws {
        guard deviceId.isEmpty || deviceId == id else { throw CallingError.invalid }
        deviceId = id
        record["deviceId"] = id
        try save()
    }
    func proof(operation: String, payload: [String: Any]) throws -> [String: Any] {
        guard !deviceId.isEmpty else { throw CallingError.unavailable }
        var proof: [String: Any] = ["deviceId": deviceId, "nonce": UUID().uuidString.lowercased(),
                                   "expiresAt": Int(Date().timeIntervalSince1970) + 90]
        proof["signature"] = try signing.signature(for: CallingWire.proofBytes(owner: owner,
                        operation: operation, payload: payload, proof: proof)).derRepresentation.base64EncodedString()
        return proof
    }
    func open(envelope: [String: Any], context: Data) throws -> [String: Any] {
        guard envelope["algorithm"] as? String == CallingWire.algorithm,
              envelope["deviceId"] as? String == deviceId, envelope["keyId"] as? String == keyId else { throw CallingError.invalid }
        var recipient = try HPKE.Recipient(privateKey: encryption, ciphersuite: .P256_SHA256_AES_GCM_256,
                             info: context, encapsulatedKey: CallingWire.data(envelope["enc"]))
        return try CallingWire.object(recipient.open(CallingWire.data(envelope["ciphertext"])))
    }
    func isVerified(_ fingerprint: String) -> Bool {
        (record["verified"] as? [String] ?? []).contains(fingerprint)
    }
    func verify(_ fingerprint: String) throws {
        var pins = record["verified"] as? [String] ?? []
        pins.removeAll { $0 == fingerprint }
        record["verified"] = Array((pins + [fingerprint]).suffix(100))
        try save()
    }
    private func save() throws {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service, kSecAttrAccount as String: account]
        let attributes: [String: Any] = [kSecValueData as String: try CallingWire.bytes(record),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess else { throw CallingError.unavailable }
        } else if status != errSecSuccess { throw CallingError.unavailable }
    }
}
