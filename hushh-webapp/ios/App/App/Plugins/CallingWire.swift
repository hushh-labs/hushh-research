import CryptoKit
import Foundation

enum CallingError: Error { case unavailable, invalid, cancelled, verificationRequired, microphoneBusy }

/// Wire primitives shared with the existing browser protocol. No vault material.
enum CallingWire {
    static let algorithm = "HPKE-P256-SHA256-AES256GCM-v1"
    static func bytes(_ value: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    }
    static func hash(_ value: Any) throws -> String {
        SHA256.hash(data: try bytes(value)).map { String(format: "%02x", $0) }.joined()
    }
    static func object(_ data: Data) throws -> [String: Any] {
        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw CallingError.invalid }
        return value
    }
    static func data(_ encoded: Any?) throws -> Data {
        guard let encoded = encoded as? String, let data = Data(base64Encoded: encoded) else { throw CallingError.invalid }
        return data
    }
    static func string(_ value: [String: Any], _ key: String) throws -> String {
        guard let result = value[key] as? String, !result.isEmpty else { throw CallingError.invalid }
        return result
    }
    static func proofBytes(owner: String, operation: String, payload: [String: Any], proof: [String: Any]) throws -> Data {
        guard let expiry = proof["expiresAt"] as? Int else { throw CallingError.invalid }
        return try bytes(["hussh-communications-command-v1", owner, operation,
                          string(proof, "deviceId"), string(proof, "nonce"), expiry, hash(payload)] as [Any])
    }
    static func verify(_ device: [String: Any], operation: String, signed: [String: Any], historical: Bool = false) throws {
        guard let payload = signed["payload"] as? [String: Any], let proof = signed["proof"] as? [String: Any],
              proof["deviceId"] as? String == device["deviceId"] as? String,
              let expiry = proof["expiresAt"] as? Int,
              historical || expiry > Int(Date().timeIntervalSince1970) else { throw CallingError.invalid }
        let key = try P256.Signing.PublicKey(derRepresentation: data(device["signingKey"]))
        let signature = try P256.Signing.ECDSASignature(derRepresentation: data(proof["signature"]))
        guard try key.isValidSignature(signature, for: proofBytes(owner: string(device, "userId"),
                     operation: operation, payload: payload, proof: proof)) else { throw CallingError.invalid }
    }
    static func context(call: [String: Any], from: String, to: String, kind: String, sequence: Int) throws -> Data {
        try bytes(["hussh-call-signal-v1", string(call, "id"), string(call, "conversationId"), from, to, kind, sequence] as [Any])
    }
    static func seal(device: [String: Any], context: Data, description: [String: Any]) throws -> [String: Any] {
        let key = try P256.KeyAgreement.PublicKey(derRepresentation: data(device["publicKey"]))
        var sender = try HPKE.Sender(recipientKey: key, ciphersuite: .P256_SHA256_AES_GCM_256, info: context)
        return ["algorithm": algorithm, "deviceId": try string(device, "deviceId"), "keyId": try string(device, "keyId"),
                "enc": sender.encapsulatedKey.base64EncodedString(),
                "ciphertext": try sender.seal(bytes(description)).base64EncodedString()]
    }
    static func validateDescription(_ description: [String: Any], kind: String) throws -> String {
        guard description["type"] as? String == kind, let sdp = description["sdp"] as? String,
              sdp.utf8.count <= 60_000,
              sdp.range(of: "(?im)^a=fingerprint:sha-256 (?:[0-9A-F]{2}:){31}[0-9A-F]{2}\\r?$", options: .regularExpression) != nil,
              sdp.range(of: "(?im)^a=candidate:.* typ (?:host|srflx|prflx)(?: |\\r?$)", options: .regularExpression) == nil
        else { throw CallingError.invalid }
        return sdp
    }
    static func pairFingerprint(_ local: [String: Any], _ peer: [String: Any]) throws -> String {
        let pair = try [local, peer].map { device -> [String: String] in
            var result: [String: String] = [:]
            for key in ["userId", "deviceId", "keyId", "publicKey", "signingKey"] { result[key] = try string(device, key) }
            return result
        }.sorted { $0["deviceId"]! < $1["deviceId"]! }
        return try hash(pair)
    }
}
