import Foundation
import CryptoKit
import Security
import UserNotifications
import Intents

/// Narrow Keychain item shared only with the notification service extension.
/// The key opens bounded previews; it cannot open a vault or message history.
enum ChatPreviewKeys {
    private static let lock = NSLock()
    private static func query() throws -> [String: Any] {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "NotificationKeychainGroup") as? String,
              !group.contains("$("), !group.isEmpty else { throw PreviewError.unavailable }
        return [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "hussh.chat.preview.v1",
                kSecAttrAccount as String: "active",
                kSecAttrAccessGroup as String: group]
    }
    enum PreviewError: Error { case unavailable }
    private static func load() throws -> [String: String]? {
        var item = try query()
        item[kSecReturnData as String] = true
        item[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(item as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data,
              let record = try JSONSerialization.jsonObject(with: data) as? [String: String] else { throw PreviewError.unavailable }
        return record
    }
    static func prepare(userId: String, deviceId: String) throws -> [String: String] {
        lock.lock(); defer { lock.unlock() }
        guard UUID(uuidString: deviceId) != nil else { throw PreviewError.unavailable }
        let owner = encode(Data(SHA256.hash(data: Data(userId.utf8))))
        var record = try load()
        if record?["owner"] != owner || record?["deviceId"] != deviceId {
            clearDelivered(keyId: record?["keyId"])
            let removed = SecItemDelete(try query() as CFDictionary)
            guard removed == errSecSuccess || removed == errSecItemNotFound else { throw PreviewError.unavailable }
            let key = P256.KeyAgreement.PrivateKey()
            record = ["owner": owner, "deviceId": deviceId, "keyId": UUID().uuidString.lowercased(),
                      "private": encode(key.rawRepresentation), "publicKey": encode(key.publicKey.x963Representation)]
            let data = try JSONSerialization.data(withJSONObject: record!)
            let attributes: [String: Any] = [kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
            let identity = try query()
            var status = SecItemUpdate(identity as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                status = SecItemAdd(identity.merging(attributes) { _, new in new } as CFDictionary, nil)
            }
            guard status == errSecSuccess else { throw PreviewError.unavailable }
        }
        guard let current = record, let keyId = current["keyId"], let publicKey = current["publicKey"] else { throw PreviewError.unavailable }
        return ["deviceId": deviceId, "keyId": keyId, "publicKey": publicKey]
    }
    static func clear(userId: String) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        let owner = encode(Data(SHA256.hash(data: Data(userId.utf8))))
        let current = try load()
        if let current = current, current["owner"] != owner { return false }
        let status = SecItemDelete(try query() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw PreviewError.unavailable }
        clearDelivered(keyId: current?["keyId"])
        return true
    }
    static func clearDelivered(keyId: String?) {
        guard let keyId = keyId else { return }
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { notifications in
            let ids = notifications.filter { ($0.request.content.userInfo["recipient_key_id"] as? String) == keyId }.map { $0.request.identifier }
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
        INInteraction.delete(with: keyId, completion: nil)
    }
    static func matches(keyId: String) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return (try? load())?["keyId"] == keyId
    }
    static func open(sealed: String, context: String) -> [String: String]? {
        lock.lock(); defer { lock.unlock() }
        do {
            guard sealed.utf8.count <= 2600, context.utf8.count <= 160,
                  let record = try load(), let raw = record["private"], let keyId = record["keyId"],
                  let envelope = try JSONSerialization.jsonObject(with: Data(sealed.utf8)) as? [String],
                  envelope.count == 4, envelope[0] == keyId else { return nil }
            let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: decode(raw))
            let peer = try P256.KeyAgreement.PublicKey(x963Representation: decode(envelope[1]))
            let secret = try key.sharedSecretFromKeyAgreement(with: peer)
            let derived = secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(),
                sharedInfo: Data("hussh-chat-preview-v1:\(keyId)".utf8), outputByteCount: 32)
            let encrypted = try decode(envelope[3])
            guard encrypted.count >= 16, encrypted.count <= 1816 else { return nil }
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: decode(envelope[2])),
                ciphertext: encrypted.dropLast(16), tag: encrypted.suffix(16))
            let plaintext = try AES.GCM.open(box, using: derived, authenticating: Data("\(keyId):\(context)".utf8))
            return try JSONSerialization.jsonObject(with: plaintext) as? [String: String]
        } catch { return nil }
    }
    private static func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private static func decode(_ string: String) throws -> Data {
        let padded = string.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/") + String(repeating: "=", count: (4 - string.count % 4) % 4)
        guard let data = Data(base64Encoded: padded) else { throw PreviewError.unavailable }
        return data
    }
}
