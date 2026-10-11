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
        if var identity = try? frontierQuery(keyId) {
            _ = SecItemDelete(identity as CFDictionary)
            identity[kSecAttrService as String] = "hussh.chat.badge.v1"
            _ = SecItemDelete(identity as CFDictionary)
        }
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
    private static func resolvedKey(_ info: [AnyHashable: Any], record: [String: String]) -> String? {
        if let key = info["recipient_key_id"] as? String { return key == record["keyId"] ? key : nil }
        if let user = info["user_id"] as? String,
           encode(Data(SHA256.hash(data: Data(user.utf8)))) == record["owner"] { return record["keyId"] }
        if let hash = info["chat_owner"] as? String, let owner = record["owner"], let bytes = try? decode(owner),
           bytes.map({ String(format: "%02x", $0) }).joined() == hash { return record["keyId"] }
        return nil
    }
    static func recipientKey(_ info: [AnyHashable: Any]) -> String? {
        lock.lock(); defer { lock.unlock() }
        guard let record = try? load() else { return nil }
        return resolvedKey(info, record: record)
    }
    /// Versions order asynchronous badge cleanup against newer incoming alerts.
    static func applyBadge(keyId: String, version: Double?, action: () -> Void) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard (try? load())?["keyId"] == keyId else { return false }
        if let version = version, version.isFinite, version > 0 {
            guard var identity = try? frontierQuery(keyId) else { return false }
            identity[kSecAttrService as String] = "hussh.chat.badge.v1"
            var lookup = identity; lookup[kSecReturnData as String] = true
            var result: CFTypeRef?
            _ = SecItemCopyMatching(lookup as CFDictionary, &result)
            let previous = (result as? Data).flatMap { String(data: $0, encoding: .utf8) }.flatMap(Double.init) ?? 0
            if version < previous { return false }
            let attributes: [String: Any] = [kSecValueData as String: Data(String(version).utf8), kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
            if SecItemUpdate(identity as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
                _ = SecItemAdd(identity.merging(attributes) { _, new in new } as CFDictionary, nil)
            }
        }
        action()
        return true
    }
    private struct Frontier: Codable {
        var sequence: Double = 0
        var before: Double = 0
        var messages: [String] = []
    }
    private static func frontierQuery(_ key: String) throws -> [String: Any] {
        var item = try query()
        item[kSecAttrService as String] = "hussh.chat.read.v1"
        item[kSecAttrAccount as String] = key
        return item
    }
    private static func frontiers(_ key: String) -> [String: Frontier] {
        guard var item = try? frontierQuery(key) else { return [:] }
        item[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return [:] }
        return (try? JSONDecoder().decode([String: Frontier].self, from: data)) ?? [:]
    }
    static func recordRead(keyId: String, thread: String, sequence: Double?, before: Double?, messageId: String?) {
        lock.lock(); defer { lock.unlock() }
        guard (try? load())?["keyId"] == keyId, let identity = try? frontierQuery(keyId) else { return }
        let threadKey = encode(Data(SHA256.hash(data: Data(thread.utf8))))
        var ledger = frontiers(keyId)
        var frontier = ledger[threadKey] ?? Frontier()
        if let sequence = sequence, sequence.isFinite { frontier.sequence = max(frontier.sequence, sequence) }
        if let before = before, before.isFinite { frontier.before = max(frontier.before, before) }
        if let message = messageId, !frontier.messages.contains(message) { frontier.messages = Array((frontier.messages + [message]).suffix(200)) }
        ledger[threadKey] = frontier
        guard let data = try? JSONEncoder().encode(ledger) else { return }
        let attributes: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        if SecItemUpdate(identity as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
            _ = SecItemAdd(identity.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
    }
    static func isRead(_ info: [AnyHashable: Any]) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let record = try? load(), let key = resolvedKey(info, record: record),
              let thread = (info["circle_id"] as? String) ?? (info["conversation_id"] as? String) else { return false }
        let threadKey = encode(Data(SHA256.hash(data: Data(thread.utf8))))
        guard let frontier = frontiers(key)[threadKey] else { return false }
        if let message = info["message_id"] as? String, frontier.messages.contains(message) { return true }
        if let sequence = info["chat_sequence"] as? String, let number = Double(sequence) { return number > 0 && number <= frontier.sequence }
        if let time = info["chat_sent_at"] as? String, let number = Double(time) { return number > 0 && number <= frontier.before }
        return false
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
