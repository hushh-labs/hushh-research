import XCTest
import CryptoKit
@testable import App

final class LocationEnvelopeCryptoTests: XCTestCase {

    // Fixed recipient keypair shared with the JS parity test (Task 6).
    let recipientJwk: [String: Any] = [
        "kty": "EC", "crv": "P-256",
        "x": "bYSlqg5_E4ruu5r3PRtBxjAM4a_DqCJwaLIXYu2Sats",
        "y": "uLLY49pNxir21iuk3Wy0N852NvxZYTGFtEUotBQ8ZNM"
    ]
    // Matching private scalar d (base64url) for in-test decryption.
    let recipientD = "0QSES3IFfQY4dKAIft3Kz5aVbxxIGWuiCd84LdYBjcs"

    func testEncryptProducesDecryptableEnvelope() throws {
        let point = #"{"latitude":12.9716,"longitude":77.5946,"capturedAt":"2026-07-09T00:00:00.000Z","sourcePlatform":"ios"}"#
        let envelope = try LocationEnvelopeCrypto.encrypt(
            pointJSON: Data(point.utf8),
            recipientPublicKeyJwk: recipientJwk,
            recipientKeyId: "k1",
            capturedAt: "2026-07-09T00:00:00.000Z",
            sourcePlatform: "ios"
        )

        // Reconstruct the recipient private key and derive the same AES key from
        // the sender's ephemeral public key to prove the envelope decrypts.
        let ephem = envelope["senderEphemeralPublicKeyJwk"] as! [String: Any]
        let ex = LocationEnvelopeCrypto.base64urlDecode(ephem["x"] as! String)!
        let ey = LocationEnvelopeCrypto.base64urlDecode(ephem["y"] as! String)!
        var ephemRaw = Data([0x04]); ephemRaw.append(ex); ephemRaw.append(ey)
        let ephemPub = try P256.KeyAgreement.PublicKey(x963Representation: ephemRaw)

        let d = LocationEnvelopeCrypto.base64urlDecode(recipientD)!
        let recipientPriv = try P256.KeyAgreement.PrivateKey(rawRepresentation: d)
        let shared = try recipientPriv.sharedSecretFromKeyAgreement(with: ephemPub)
        let aesKey = shared.withUnsafeBytes { SymmetricKey(data: Data($0)) }

        let iv = LocationEnvelopeCrypto.base64urlDecode(envelope["iv"] as! String)!
        let ctPlusTag = LocationEnvelopeCrypto.base64urlDecode(envelope["ciphertext"] as! String)!
        let ct = ctPlusTag.prefix(ctPlusTag.count - 16)
        let tag = ctPlusTag.suffix(16)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: ct, tag: tag)
        let plaintext = try AES.GCM.open(box, using: aesKey)

        XCTAssertEqual(String(decoding: plaintext, as: UTF8.self), point)
        XCTAssertEqual(envelope["algorithm"] as? String, "ECDH-P256-AES256-GCM")
    }

    func testPrintGoldenEnvelopeForJS() throws {
        let point = #"{"latitude":12.9716,"longitude":77.5946,"capturedAt":"2026-07-09T00:00:00.000Z","sourcePlatform":"ios"}"#
        let envelope = try LocationEnvelopeCrypto.encrypt(
            pointJSON: Data(point.utf8),
            recipientPublicKeyJwk: recipientJwk,
            recipientKeyId: "k1",
            capturedAt: "2026-07-09T00:00:00.000Z",
            sourcePlatform: "ios"
        )
        let json = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
        print("GOLDEN_ENVELOPE_BEGIN" + String(decoding: json, as: UTF8.self) + "GOLDEN_ENVELOPE_END")
    }
}
