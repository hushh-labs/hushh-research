import Foundation
import Capacitor
import UserNotifications
import FirebaseMessaging
import FirebaseAuth
import FirebaseCore
import UIKit
import AVFoundation
import AudioToolbox

/**
 * HushhNotificationsPlugin - Push token registration (Capacitor 8)
 *
 * Next.js source of truth:
 * - POST   /api/notifications/register
 * - DELETE /api/notifications/unregister
 *
 * Backend expects Firebase ID token in Authorization: Bearer <idToken>
 * Body:
 * - register: { user_id, token, platform }
 * - unregister: { user_id, platform? }
 */
@objc(HushhNotificationsPlugin)
public class HushhNotificationsPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "HushhNotificationsPlugin"
    public let jsName = "HushhNotifications"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getNotificationSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestEmergencySmsAlarmPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingEmergencySmsAlarms", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playEmergencySmsCue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopEmergencySmsCue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deletePushToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "registerPushToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unregisterPushToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareNotificationKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearNotificationKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearChatNotifications", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setActiveChat", returnType: CAPPluginReturnPromise)
    ]

    private let TAG = "HushhNotifications"
    @objc func getNotificationSettings(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            Task { @MainActor in
              var result: [String: Any] = [
                "alertsEnabled": settings.alertSetting == .enabled,
                "soundsEnabled": settings.soundSetting == .enabled,
                "emergencySoundEnabled": settings.soundSetting == .enabled
              ]
              if #available(iOS 26.0, *) {
                  result["emergencyAlarmSupported"] = true
                  result["emergencyAlarmAuthorized"] = EmergencySmsSystemAlarm.authorized
              }
              call.resolve(result)
            }
        }
    }
    @objc func requestEmergencySmsAlarmPermission(_ call: CAPPluginCall) {
        Task { @MainActor in
            guard #available(iOS 26.0, *) else { call.resolve(["supported": false, "authorized": false]); return }
            let authorized = await EmergencySmsSystemAlarm.requestAuthorization()
            call.resolve(["supported": true, "authorized": authorized])
        }
    }
    @objc func getPendingEmergencySmsAlarms(_ call: CAPPluginCall) {
        guard let user = call.getString("userId"), FirebaseApp.app() != nil,
              Auth.auth().currentUser != nil, ChatPreviewKeys.recipientKey(["user_id": user]) != nil
        else { call.resolve(["grantIds": [], "acknowledgedGrantIds": []]); return }
        let requested = Array((call.getArray("grantIds", String.self) ?? []).prefix(512))
        call.resolve(["grantIds": SmsAlarmLedger.pending(user: user),
            "acknowledgedGrantIds": requested.filter { SmsAlarmLedger.acknowledged(user: user, grant: $0) }])
    }
    private var chatHandler: ChatNotificationHandler?
    private let chatLock = NSLock()
    private var activeChatTag = ""
    private var activeChatKey = ""
    private var emergencyPlayer: AVAudioPlayer?
    private var emergencyGrantId: String?
    private var emergencyGrants = Set<String>()
    private var emergencyOwner: String?
    private var emergencyFirebaseUid: String?
    private var emergencyInterrupted = false
    private var emergencyAuthObserver: AuthStateDidChangeListenerHandle?
    private var emergencyGeneration = 0
    private var emergencyPulse: Timer?
    private var systemAlarmOwners: [String: String] = [:]
    private var emergencyObservers: [NSObjectProtocol] = []

    override public func load() {
        super.load()
        installChatHandler()
        emergencyObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name("HushhSmsAlarmAcknowledged"), object: nil, queue: .main
        ) { [weak self] notification in
            guard let self, let user = notification.userInfo?["userId"] as? String,
                  let grant = notification.userInfo?["grantId"] as? String,
                  ChatPreviewKeys.recipientKey(["user_id": user]) != nil else { return }
            if user == self.emergencyOwner { self.stopEmergencyCue(grantId: grant) }
            self.notifyListeners("emergencySmsAcknowledged", data: ["userId": user, "grantId": grant])
        })
        emergencyObservers.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard let self,
                  let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            self.emergencyInterrupted = type == .began
            if self.emergencyInterrupted { self.emergencyPlayer?.pause() }
            else { self.resumeEmergencyCue() }
        })
        emergencyObservers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in self?.resumeEmergencyCue() })
        if FirebaseApp.app() != nil {
            emergencyAuthObserver = Auth.auth().addStateDidChangeListener { [weak self] _, user in
                Task { @MainActor in
                    guard let self else { return }
                    if #available(iOS 26.0, *) {
                        for owner in SmsAlarmLedger.owners() {
                            if user == nil || ChatPreviewKeys.recipientKey(["user_id": owner]) == nil ||
                                self.systemAlarmOwners[owner].map({ $0 != user?.uid }) == true {
                                EmergencySmsSystemAlarm.cancelOwner(owner)
                                self.systemAlarmOwners.removeValue(forKey: owner)
                            }
                        }
                    }
                    if let owner = self.emergencyOwner,
                       user?.uid != self.emergencyFirebaseUid || ChatPreviewKeys.recipientKey(["user_id": owner]) == nil {
                        self.stopEmergencyCue()
                    }
                }
            }
        }
    }

    deinit {
        emergencyObservers.forEach { NotificationCenter.default.removeObserver($0) }
        if let observer = emergencyAuthObserver, FirebaseApp.app() != nil {
            Auth.auth().removeStateDidChangeListener(observer)
        }
        emergencyPlayer?.stop()
        emergencyPulse?.invalidate()
    }

    private func stopEmergencyCue(grantId: String? = nil) {
        if let grantId {
            emergencyGrants.remove(grantId)
            if !emergencyGrants.isEmpty { return }
        }
        emergencyGeneration += 1
        emergencyPulse?.invalidate()
        emergencyPulse = nil
        emergencyPlayer?.stop()
        emergencyPlayer = nil
        emergencyGrantId = nil
        emergencyGrants.removeAll()
        emergencyOwner = nil
        emergencyFirebaseUid = nil
        // One Voice shares the audio session. Never deactivate or restore a
        // stale category over another feature's current ownership.
    }

    private func resumeEmergencyCue() {
        guard !emergencyInterrupted, !emergencyGrants.isEmpty,
              FirebaseApp.app() != nil,
              Auth.auth().currentUser?.uid == emergencyFirebaseUid,
              let owner = emergencyOwner,
              ChatPreviewKeys.recipientKey(["user_id": owner]) != nil else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            if session.category == .record {
                try session.setCategory(.playAndRecord, mode: session.mode, options: session.categoryOptions.union(.defaultToSpeaker))
            } else if session.category != .playAndRecord {
                try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            }
            try session.setActive(true)
            emergencyPlayer?.play()
        } catch { /* Retain pending alerts through system audio interruptions. */ }
    }

    @objc func stopEmergencySmsCue(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            guard let self else { call.resolve(); return }
            let user = call.getString("userId") ?? self.emergencyOwner
            if let user, let grant = call.getString("grantId"), !grant.isEmpty {
                try? SmsAlarmLedger.acknowledge(user: user, grant: grant)
                // Cancellation is always retryable, even after the ACK exists.
                if #available(iOS 26.0, *) { EmergencySmsSystemAlarm.cancel(user: user, grant: grant) }
                if user == self.emergencyOwner { self.stopEmergencyCue(grantId: grant) }
            } else if let user {
                if #available(iOS 26.0, *) { EmergencySmsSystemAlarm.cancelOwner(user) }
                self.systemAlarmOwners.removeValue(forKey: user)
                if user == self.emergencyOwner { self.stopEmergencyCue() }
            }
            call.resolve()
        }
    }

    @objc func playEmergencySmsCue(_ call: CAPPluginCall) {
        Task { @MainActor [weak self] in
            let now = Date().timeIntervalSince1970 * 1000
            guard let self, FirebaseApp.app() != nil,
                  let uid = Auth.auth().currentUser?.uid,
                  let user = call.getString("userId"), let grant = call.getString("grantId"),
                  let key = ChatPreviewKeys.recipientKey(["user_id": user]),
                  let deadline = call.getDouble("expiresAt"), deadline.isFinite,
                  deadline > now, deadline <= now + 2000 else { call.resolve(["played": false]); return }
            if SmsAlarmLedger.acknowledged(user: user, grant: grant) {
                call.resolve(["played": false, "acknowledged": true]); return
            }
            if SmsAlarmLedger.endedBeforeAdmission(user: user, grant: grant) { call.resolve(["played": false]); return }
            if #available(iOS 26.0, *), EmergencySmsSystemAlarm.authorized {
                let scheduled = await EmergencySmsSystemAlarm.schedule(user: user, grant: grant)
                guard Auth.auth().currentUser?.uid == uid,
                      ChatPreviewKeys.recipientKey(["user_id": user]) == key else {
                    EmergencySmsSystemAlarm.cancel(user: user, grant: grant)
                    call.resolve(["played": false]); return
                }
                if scheduled { self.systemAlarmOwners[user] = uid; call.resolve(["played": true]); return }
            }
            self.playForegroundEmergencySmsCue(call)
        }
    }

    private func playForegroundEmergencySmsCue(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  FirebaseApp.app() != nil,
                  let firebaseUid = Auth.auth().currentUser?.uid,
                  let userId = call.getString("userId"), !userId.isEmpty,
                  ChatPreviewKeys.recipientKey(["user_id": userId]) != nil,
                  let grantId = call.getString("grantId"), !grantId.isEmpty,
                  let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first
            else { call.resolve(["played": false]); return }
            if SmsAlarmLedger.acknowledged(user: userId, grant: grantId) {
                call.resolve(["played": false, "acknowledged": true]); return
            }
            if self.emergencyOwner != nil && self.emergencyOwner != userId { self.stopEmergencyCue() }
            self.emergencyOwner = userId
            self.emergencyFirebaseUid = firebaseUid
            do { try SmsAlarmLedger.remember(user: userId, grant: grantId) }
            catch { call.resolve(["played": false]); return }
            self.emergencyGrants.insert(grantId)
            if self.emergencyPlayer != nil {
                call.resolve(["played": self.emergencyPlayer?.isPlaying ?? false]); return
            }
            do {
                // AppDelegate prepares this same sound for background APNs alerts.
                let url = library.appendingPathComponent("Sounds/one_location_sms_alarm.wav")
                let player = try AVAudioPlayer(contentsOf: url)
                player.numberOfLoops = -1
                player.prepareToPlay()
                self.emergencyPlayer = player
                self.emergencyGrantId = grantId
                self.resumeEmergencyCue()
                AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
                let generation = self.emergencyGeneration
                let pulse = Timer(timeInterval: 1.5, repeats: true) { [weak self] timer in
                    guard let self else { timer.invalidate(); return }
                    guard self.emergencyGeneration == generation else { timer.invalidate(); return }
                    guard Auth.auth().currentUser?.uid == firebaseUid,
                          ChatPreviewKeys.recipientKey(["user_id": userId]) != nil
                    else { self.stopEmergencyCue(); return }
                    if !self.emergencyInterrupted {
                        if self.emergencyPlayer?.isPlaying != true { self.resumeEmergencyCue() }
                        AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
                    }
                }
                self.emergencyPulse = pulse
                RunLoop.main.add(pulse, forMode: .common)
                call.resolve(["played": self.emergencyPlayer?.isPlaying ?? false])
            } catch {
                call.resolve(["played": false])
            }
        }
    }

    private func installChatHandler() {
        guard let router = bridge?.notificationRouter, let previous = router.pushNotificationHandler,
              !(previous is ChatNotificationHandler) else { return }
        let handler = ChatNotificationHandler(forwarded: previous, owner: self)
        chatHandler = handler
        router.pushNotificationHandler = handler
    }

    @objc func setActiveChat(_ call: CAPPluginCall) {
        guard let key = call.getString("keyId"), ChatPreviewKeys.matches(keyId: key) else { call.resolve(); return }
        chatLock.lock(); activeChatTag = call.getString("tag") ?? ""; activeChatKey = key; chatLock.unlock()
        call.resolve()
    }

    fileprivate func acceptsChat(_ info: [AnyHashable: Any]) -> Bool {
        if let key = info["recipient_key_id"] as? String {
            if !ChatPreviewKeys.matches(keyId: key) { return false }
        } else {
            guard FirebaseApp.app() != nil, let user = Auth.auth().currentUser?.uid,
                  info["user_id"] as? String == user else { return false }
        }
        if ChatPreviewKeys.isRead(info) { return false }
        if let raw = info["chat_expires_at"] as? String, let expiry = Double(raw), expiry < Date().timeIntervalSince1970 { return false }
        return true
    }

    fileprivate func quietChat(_ info: [AnyHashable: Any]) -> Bool {
        let tag = info["type"] as? String == "location_circle_message"
            ? "circle-chat:\(info["circle_id"] as? String ?? "")" : "direct-chat:\(info["conversation_id"] as? String ?? "")"
        chatLock.lock(); let active = activeChatTag; let key = activeChatKey; chatLock.unlock()
        return UIApplication.shared.applicationState == .active && active == tag && ChatPreviewKeys.matches(keyId: key)
    }

    private func getBackendUrl(_ call: CAPPluginCall) -> String {
        return HushhProxyClient.resolveBackendUrl(
            call: call,
            plugin: self,
            jsName: jsName
        )
    }

    private lazy var urlSession: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 30
        return URLSession(configuration: config)
    }()

    @objc func deletePushToken(_ call: CAPPluginCall) {
        Messaging.messaging().deleteToken { error in
            if error != nil { call.reject("Push token deletion failed") }
            else { call.resolve() }
        }
    }

    @objc func registerPushToken(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"),
              let token = call.getString("token"),
              let platform = call.getString("platform"),
              let idToken = call.getString("idToken") else {
            call.reject("Missing required parameters: userId, token, platform, idToken")
            return
        }

        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/notifications/register"

        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")

        var body: [String: Any] = [
            "user_id": userId,
            "token": token,
            "platform": platform
        ]
        body["device_id"] = call.getString("deviceId")
        body["preview_key_id"] = call.getString("previewKeyId")
        body["preview_public_key"] = call.getString("previewPublicKey")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        urlSession.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }

            if let error = error {
                print("❌ [\(self.TAG)] registerPushToken network error: \(error.localizedDescription)")
                call.reject("Network error: \(error.localizedDescription)")
                return
            }

            guard let http = response as? HTTPURLResponse else {
                call.reject("Invalid response")
                return
            }

            if !(200...299).contains(http.statusCode) {
                print("⚠️ [\(self.TAG)] registerPushToken non-OK: \(http.statusCode)")
                call.resolve(["success": false])
                return
            }

            let payload = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let registered = payload?["registered"] as? Bool ?? true
            let degraded = payload?["degraded"] as? Bool ?? false
            call.resolve(["success": registered && !degraded, "registered": registered, "degraded": degraded])
        }.resume()
    }

    @objc func unregisterPushToken(_ call: CAPPluginCall) {
        guard let userId = call.getString("userId"),
              let idToken = call.getString("idToken") else {
            call.reject("Missing required parameters: userId, idToken")
            return
        }

        let platform = call.getString("platform")
        let backendUrl = getBackendUrl(call)
        let urlStr = "\(backendUrl)/api/notifications/unregister"

        guard let url = URL(string: urlStr) else {
            call.reject("Invalid URL")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(idToken)", forHTTPHeaderField: "Authorization")

        var body: [String: Any] = ["user_id": userId]
        body["device_id"] = call.getString("deviceId")
        if let platform = platform, !platform.isEmpty {
            body["platform"] = platform
        }
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        urlSession.dataTask(with: request) { [weak self] data, response, error in
            guard let self = self else { return }

            if let error = error {
                print("❌ [\(self.TAG)] unregisterPushToken network error: \(error.localizedDescription)")
                call.reject("Network error: \(error.localizedDescription)")
                return
            }

            guard let http = response as? HTTPURLResponse else {
                call.reject("Invalid response")
                return
            }

            if !(200...299).contains(http.statusCode) {
                let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                print("⚠️ [\(self.TAG)] unregisterPushToken non-OK: \(http.statusCode) body=\(bodyStr)")
                call.resolve(["success": false])
                return
            }

            call.resolve(["success": true])
        }.resume()
    }

    @objc func prepareNotificationKey(_ call: CAPPluginCall) {
        installChatHandler()
        guard let user = call.getString("userId"), let device = call.getString("deviceId") else { call.reject("Notification identity required"); return }
        do { call.resolve(try ChatPreviewKeys.prepare(userId: user, deviceId: device)) }
        catch { call.reject("Notification keys unavailable") }
    }

    @objc func clearChatNotifications(_ call: CAPPluginCall) {
        guard let thread = call.getString("threadId"), let key = call.getString("keyId") else { call.reject("Notification identity required"); return }
        let sequence = call.getDouble("sequence")
        let before = call.getDouble("before")
        let messageId = call.getString("messageId")
        Self.clearRead(thread: thread, key: key, sequence: sequence, before: before, messageId: messageId, badgeCount: call.getInt("badgeCount"), badgeVersion: call.getDouble("badgeVersion")) { call.resolve() }
    }

    static func handleReadSync(_ info: [AnyHashable: Any], completion: @escaping () -> Void) -> Bool {
        guard let kind = info["type"] as? String, ["direct_message_read", "location_circle_chat_read"].contains(kind) else { return false }
        guard let key = ChatPreviewKeys.recipientKey(info),
              let thread = (info["circle_id"] as? String) ?? (info["conversation_id"] as? String) else { completion(); return true }
        func number(_ field: String) -> Double? { (info[field] as? String).flatMap(Double.init) }
        clearRead(thread: thread, key: key, sequence: number("chat_sequence"), before: number("chat_read_before"),
                  messageId: info["chat_read_message_id"] as? String, badgeCount: (info["chat_badge_count"] as? String).flatMap(Int.init), badgeVersion: number("chat_badge_version"), completion: completion)
        return true
    }

    private static func clearRead(thread: String, key: String, sequence: Double?, before: Double?, messageId: String?, badgeCount: Int?, badgeVersion: Double?, completion: @escaping () -> Void) {
        ChatPreviewKeys.recordRead(keyId: key, thread: thread, sequence: sequence, before: before, messageId: messageId)
        UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
            guard ChatPreviewKeys.matches(keyId: key) else { completion(); return }
            let ids = notifications.filter { notification in
                let info = notification.request.content.userInfo
                guard ChatPreviewKeys.recipientKey(info) == key,
                      ((info["conversation_id"] as? String) ?? (info["circle_id"] as? String)) == thread else { return false }
                if let messageId = messageId, info["message_id"] as? String == messageId { return true }
                if let sequence = sequence, let raw = info["chat_sequence"] as? String, let number = Double(raw) { return number > 0 && number <= sequence }
                if let before = before, let raw = info["chat_sent_at"] as? String, let number = Double(raw) { return number > 0 && number <= before }
                return false
            }.map { $0.request.identifier }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
            if let count = badgeCount {
                let applied = ChatPreviewKeys.applyBadge(keyId: key, version: badgeVersion) {
                    UNUserNotificationCenter.current().setBadgeCount(max(0, min(9999, count))) { _ in completion() }
                }
                if !applied { completion() }
            } else { completion() }
        }
    }

    @objc func clearNotificationKey(_ call: CAPPluginCall) {
        guard let user = call.getString("userId") else { call.reject("Notification identity required"); return }
        do {
            if try ChatPreviewKeys.clear(userId: user) {
                Task { @MainActor [weak self] in
                    if #available(iOS 26.0, *) { EmergencySmsSystemAlarm.cancelOwner(user) }
                    guard let self, self.emergencyOwner == user else { return }
                    self.stopEmergencyCue()
                }
            }
            chatLock.lock(); activeChatTag = ""; activeChatKey = ""; chatLock.unlock()
            call.resolve()
        } catch { call.reject("Notification cleanup unavailable") }
    }
}

private final class ChatNotificationHandler: NSObject, NotificationHandlerProtocol {
    let forwarded: NotificationHandlerProtocol
    weak var owner: HushhNotificationsPlugin?
    init(forwarded: NotificationHandlerProtocol, owner: HushhNotificationsPlugin) {
        self.forwarded = forwarded; self.owner = owner; super.init()
    }
    func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions {
        let inherited = forwarded.willPresent(notification: notification)
        let info = notification.request.content.userInfo
        guard let kind = info["type"] as? String, ["direct_message", "location_circle_message"].contains(kind) else { return inherited }
        guard let owner = owner, owner.acceptsChat(info) else { return [] }
        if owner.quietChat(info) { return inherited.subtracting([.alert, .banner, .list, .sound]) }
        return inherited.union([.banner, .list, .sound])
    }
    func didReceive(response: UNNotificationResponse) {
        let info = response.notification.request.content.userInfo
        if info["type"] as? String == "location_share_created",
           info["share_kind"] as? String == "sos",
           response.actionIdentifier != UNNotificationDismissActionIdentifier,
           let user = info["user_id"] as? String, let grant = info["grant_id"] as? String,
           ChatPreviewKeys.recipientKey(info) != nil {
            try? SmsAlarmLedger.acknowledge(user: user, grant: grant)
            if #available(iOS 26.0, *) {
                Task { @MainActor in EmergencySmsSystemAlarm.cancel(user: user, grant: grant) }
            }
        }
        forwarded.didReceive(response: response)
    }
}
