import CryptoKit
import Foundation

/// Synthetic, ephemeral cross-language fixtures only. Never app credentials.
@main struct CallingWireInterop {
    static func main() throws {
        let input = try CallingWire.object(Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        let device = input["device"] as! [String: Any]
        let context = try CallingWire.data(input["context"])
        let description = input["description"] as! [String: Any]
        let signed = input["signed"] as! [String: Any]
        try CallingWire.verify(device, operation: "register-key", signed: signed)
        let encryption = try P256.KeyAgreement.PrivateKey(rawRepresentation: CallingWire.data(input["encryptionScalar"]))
        let envelope = input["envelope"] as! [String: Any]
        var recipient = try HPKE.Recipient(privateKey: encryption, ciphersuite: .P256_SHA256_AES_GCM_256,
                           info: context, encapsulatedKey: CallingWire.data(envelope["enc"]))
        let opened = try CallingWire.object(recipient.open(CallingWire.data(envelope["ciphertext"])))
        guard try CallingWire.bytes(opened) == CallingWire.bytes(description) else { throw CallingError.invalid }
        _ = try CallingWire.validateDescription(opened, kind: "offer")
        let signing = try P256.Signing.PrivateKey(rawRepresentation: CallingWire.data(input["signingScalar"]))
        let payload = signed["payload"] as! [String: Any]
        var proof = signed["proof"] as! [String: Any]
        proof["nonce"] = UUID().uuidString.lowercased()
        proof["signature"] = try signing.signature(for: CallingWire.proofBytes(owner: CallingWire.string(device, "userId"),
                   operation: "register-key", payload: payload, proof: proof)).derRepresentation.base64EncodedString()
        let result: [String: Any] = ["envelope": try CallingWire.seal(device: device, context: context, description: description),
                "signed": ["payload": payload, "proof": proof], "fingerprint": try CallingWire.hash([device["publicKey"]!, "α/🗝", 42])]
        try CallingWire.bytes(result).write(to: URL(fileURLWithPath: CommandLine.arguments[2]), options: .atomic)
        do {
            var wrong = try HPKE.Recipient(privateKey: encryption, ciphersuite: .P256_SHA256_AES_GCM_256,
                        info: Data("wrong-call".utf8), encapsulatedKey: CallingWire.data(envelope["enc"]))
            _ = try wrong.open(CallingWire.data(envelope["ciphertext"]))
        } catch { return }
        throw CallingError.invalid
    }
}
