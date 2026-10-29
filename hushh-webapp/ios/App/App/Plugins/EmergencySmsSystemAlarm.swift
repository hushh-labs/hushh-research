import Foundation
import CryptoKit
import Security
import AlarmKit
import AppIntents
import SwiftUI

/// Shared with the notification extension through the existing notification
/// keychain group. Contains grant identities only, never a message or position.
enum SmsAlarmLedger {
    private static func query(account: String? = nil) throws -> [String: Any] {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "NotificationKeychainGroup") as? String,
              !group.isEmpty, !group.contains("$(") else { throw LedgerError.unavailable }
        var item: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "hussh.sms.alarms.v1", kSecAttrAccessGroup as String: group]
        if let account { item[kSecAttrAccount as String] = account }
        return item
    }
    enum LedgerError: Error { case unavailable, ended }
    static func id(user: String, grant: String) -> UUID {
        let bytes = Array(SHA256.hash(data: Data("\(user)\u{0}\(grant)".utf8)).prefix(16))
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                          bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }
    private static func add(account: String, data: Data) throws {
        var item = try query(account: account)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess || status == errSecDuplicateItem else { throw LedgerError.unavailable }
    }
    static func acknowledged(user: String, grant: String) -> Bool {
        guard let item = try? query(account: "\(id(user: user, grant: grant)).ack") else { return false }
        return SecItemCopyMatching(item as CFDictionary, nil) == errSecSuccess
    }
    static func acknowledge(user: String, grant: String) throws {
        // Separate monotonic tombstone; a racing app/extension admission cannot overwrite it.
        try add(account: "\(id(user: user, grant: grant)).ack", data: Data([1]))
        NotificationCenter.default.post(name: Notification.Name("HushhSmsAlarmAcknowledged"), object: nil,
            userInfo: ["userId": user, "grantId": grant])
    }
    static func remember(user: String, grant: String) throws {
        guard try firstEvent(user: user, grant: grant, claiming: "admitted") == "admitted" else { throw LedgerError.ended }
        let data = try JSONSerialization.data(withJSONObject: ["userId": user, "grantId": grant])
        try add(account: "\(id(user: user, grant: grant)).pending", data: data)
    }
    static func markEnded(user: String, grant: String) throws {
        _ = try firstEvent(user: user, grant: grant, claiming: "ended")
    }
    static func endedBeforeAdmission(user: String, grant: String) -> Bool {
        guard var item = try? query(account: "\(id(user: user, grant: grant)).first") else { return true }
        item[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(item as CFDictionary, &result)
        if status == errSecItemNotFound { return false }
        guard status == errSecSuccess, let data = result as? Data else { return true }
        return String(data: data, encoding: .utf8) == "ended"
    }
    private static func firstEvent(user: String, grant: String, claiming value: String) throws -> String {
        let account = "\(id(user: user, grant: grant)).first"
        // SecItemAdd is atomic across app and extension processes. The first
        // admission/terminal event wins; a later pending write cannot reverse it.
        try add(account: account, data: Data(value.utf8))
        var item = try query(account: account)
        item[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data, let stored = String(data: data, encoding: .utf8) else { throw LedgerError.unavailable }
        return stored
    }
    private static func records() -> [[String: String]] {
        guard var item = try? query() else { return [] }
        item[kSecMatchLimit as String] = kSecMatchLimitAll
        item[kSecReturnAttributes as String] = true
        item[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(item as CFDictionary, &result) == errSecSuccess,
              let rows = result as? [[String: Any]] else { return [] }
        return rows.compactMap { row in
            guard (row[kSecAttrAccount as String] as? String)?.hasSuffix(".pending") == true,
                  let data = row[kSecValueData as String] as? Data,
                  let receipt = try? JSONSerialization.jsonObject(with: data) as? [String: String] else { return nil }
            return receipt
        }
    }
    static func owners() -> [String] { Array(Set(records().compactMap { $0["userId"] })) }
    static func pending(user: String, includeAcknowledged: Bool = false) -> [String] {
        records().compactMap { receipt in
            guard receipt["userId"] == user, let grant = receipt["grantId"],
                  includeAcknowledged || !acknowledged(user: user, grant: grant) else { return nil }
            return grant
        }
    }
}

@available(iOS 26.0, *)
struct SmsAlarmMetadata: AlarmMetadata { let receiptId: String }

@available(iOS 26.0, *)
struct DismissSmsAlarmIntent: LiveActivityIntent {
    static var title: LocalizedStringResource = "Dismiss SMS alarm"
    static var openAppWhenRun = false
    static var isDiscoverable = false
    @Parameter(title: "Owner") var userId: String
    @Parameter(title: "Alert") var grantId: String
    init() { userId = ""; grantId = "" }
    init(userId: String, grantId: String) { self.userId = userId; self.grantId = grantId }
    func perform() async throws -> some IntentResult {
        guard !userId.isEmpty, !grantId.isEmpty else { return .result() }
        // System Stop may already have removed the alarm. Receipt comes first.
        try SmsAlarmLedger.acknowledge(user: userId, grant: grantId)
        try? AlarmManager.shared.cancel(id: SmsAlarmLedger.id(user: userId, grant: grantId))
        return .result()
    }
}

@available(iOS 26.0, *)
@MainActor
enum EmergencySmsSystemAlarm {
    static var authorized: Bool { AlarmManager.shared.authorizationState == .authorized }
    static func requestAuthorization() async -> Bool {
        do { return try await AlarmManager.shared.requestAuthorization() == .authorized }
        catch { return false }
    }
    static func schedule(user: String, grant: String) async -> Bool {
        guard !Task.isCancelled, authorized, !SmsAlarmLedger.acknowledged(user: user, grant: grant),
              !SmsAlarmLedger.endedBeforeAdmission(user: user, grant: grant),
              let key = ChatPreviewKeys.recipientKey(["user_id": user]) else { return false }
        let id = SmsAlarmLedger.id(user: user, grant: grant)
        do {
            if try AlarmManager.shared.alarms.contains(where: { $0.id == id }) {
                guard !Task.isCancelled, ChatPreviewKeys.recipientKey(["user_id": user]) == key,
                      !SmsAlarmLedger.acknowledged(user: user, grant: grant) else {
                    try? AlarmManager.shared.cancel(id: id); return false
                }
                return true
            }
            try SmsAlarmLedger.remember(user: user, grant: grant)
            let alert: AlarmPresentation.Alert
            if #available(iOS 26.1, *) { alert = .init(title: "Emergency SMS alert") }
            else { alert = .init(title: "Emergency SMS alert",
                stopButton: AlarmButton(text: "Dismiss alarm", textColor: .white, systemImageName: "stop.circle")) }
            let attributes = AlarmAttributes(presentation: AlarmPresentation(alert: alert),
                metadata: SmsAlarmMetadata(receiptId: id.uuidString), tintColor: Color.red)
            let configuration = AlarmManager.AlarmConfiguration<SmsAlarmMetadata>.alarm(
                schedule: .fixed(Date().addingTimeInterval(1)), attributes: attributes,
                stopIntent: DismissSmsAlarmIntent(userId: user, grantId: grant), sound: .default)
            _ = try await AlarmManager.shared.schedule(id: id, configuration: configuration)
            // Key disposal and acknowledgement can win while scheduling awaits.
            guard !Task.isCancelled, ChatPreviewKeys.recipientKey(["user_id": user]) == key,
                  !SmsAlarmLedger.acknowledged(user: user, grant: grant) else {
                try? AlarmManager.shared.cancel(id: id)
                return false
            }
            return true
        } catch {
            guard !Task.isCancelled, ChatPreviewKeys.recipientKey(["user_id": user]) == key,
                  !SmsAlarmLedger.acknowledged(user: user, grant: grant) else {
                try? AlarmManager.shared.cancel(id: id)
                return false
            }
            return (try? AlarmManager.shared.alarms.contains(where: { $0.id == id })) ?? false
        }
    }
    static func cancel(user: String, grant: String) {
        try? AlarmManager.shared.cancel(id: SmsAlarmLedger.id(user: user, grant: grant))
    }
    static func cancelOwner(_ user: String) {
        for grant in SmsAlarmLedger.pending(user: user, includeAcknowledged: true) { cancel(user: user, grant: grant) }
    }
}
