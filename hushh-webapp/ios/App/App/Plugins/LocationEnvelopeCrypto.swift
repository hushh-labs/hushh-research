import Foundation
import CryptoKit

/// Reproduces the JS ECIES envelope (`lib/one-location/encryption.ts`) so the
/// native background publisher can encrypt without any JS runtime.
///
/// Scheme: fresh ephemeral P-256 keypair per publish → ECDH against the
/// recipient's public key → the raw 32-byte shared-secret X-coordinate is used
/// directly as the AES-256-GCM key (NO HKDF, matching Web Crypto's ECDH→AES-GCM
/// derivation) → AES-GCM with a random 12-byte IV → ciphertext is `ct || tag`.
enum LocationEnvelopeCrypto {

    enum CryptoError: Error { case badRecipientKey }

    static func encrypt(
        pointJSON: Data,
        recipientPublicKeyJwk: [String: Any],
        recipientKeyId: String,
        capturedAt: String,
        sourcePlatform: String
    ) throws -> [String: Any] {
        guard
            let xB64 = recipientPublicKeyJwk["x"] as? String,
            let yB64 = recipientPublicKeyJwk["y"] as? String,
            let x = base64urlDecode(xB64),
            let y = base64urlDecode(yB64),
            x.count == 32, y.count == 32
        else { throw CryptoError.badRecipientKey }

        var recipientRaw = Data([0x04]); recipientRaw.append(x); recipientRaw.append(y)
        let recipientPub = try P256.KeyAgreement.PublicKey(x963Representation: recipientRaw)

        let ephemeral = P256.KeyAgreement.PrivateKey()
        let shared = try ephemeral.sharedSecretFromKeyAgreement(with: recipientPub)
        let aesKey = shared.withUnsafeBytes { SymmetricKey(data: Data($0)) }

        let iv = AES.GCM.Nonce() // 12 random bytes
        let sealed = try AES.GCM.seal(pointJSON, using: aesKey, nonce: iv)
        var ctPlusTag = sealed.ciphertext
        ctPlusTag.append(sealed.tag)

        // Ephemeral public key → JWK (x963Representation is 0x04 || x || y).
        let ephemRaw = ephemeral.publicKey.x963Representation
        let ephemX = ephemRaw.subdata(in: 1..<33)
        let ephemY = ephemRaw.subdata(in: 33..<65)
        let ephemJwk: [String: Any] = [
            "kty": "EC", "crv": "P-256",
            "x": base64url(ephemX), "y": base64url(ephemY)
        ]

        return [
            "algorithm": "ECDH-P256-AES256-GCM",
            "recipientKeyId": recipientKeyId,
            "ciphertext": base64url(ctPlusTag),
            "iv": base64url(Data(iv)),
            "senderEphemeralPublicKeyJwk": ephemJwk,
            "capturedAt": capturedAt,
            "sourcePlatform": sourcePlatform,
            "metadata": ["payload": "coordinate_envelope", "plaintext": false]
        ]
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func base64urlDecode(_ s: String) -> Data? {
        var b = s.replacingOccurrences(of: "-", with: "+")
                 .replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b.append("=") }
        return Data(base64Encoded: b)
    }
}
