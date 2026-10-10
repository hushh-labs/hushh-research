import Foundation
import Capacitor
import UserNotifications
import FirebaseMessaging

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
        CAPPluginMethod(name: "deletePushToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "registerPushToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unregisterPushToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareNotificationKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearNotificationKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearChatNotifications", returnType: CAPPluginReturnPromise)
    ]

    private let TAG = "HushhNotifications"

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
                let bodyStr = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
                print("⚠️ [\(self.TAG)] registerPushToken non-OK: \(http.statusCode) body=\(bodyStr)")
                call.resolve(["success": false])
                return
            }

            call.resolve(["success": true])
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
        guard let user = call.getString("userId"), let device = call.getString("deviceId") else { call.reject("Notification identity required"); return }
        do { call.resolve(try ChatPreviewKeys.prepare(userId: user, deviceId: device)) }
        catch { call.reject("Notification keys unavailable") }
    }

    @objc func clearChatNotifications(_ call: CAPPluginCall) {
        guard let thread = call.getString("threadId"), let key = call.getString("keyId") else { call.reject("Notification identity required"); return }
        let sequence = call.getDouble("sequence")
        let before = call.getDouble("before")
        let messageId = call.getString("messageId")
        UNUserNotificationCenter.current().getDeliveredNotifications { notifications in
            guard ChatPreviewKeys.matches(keyId: key) else { call.resolve(); return }
            let ids = notifications.filter { notification in
                let info = notification.request.content.userInfo
                guard (info["recipient_key_id"] as? String) == key,
                      ((info["conversation_id"] as? String) ?? (info["circle_id"] as? String)) == thread else { return false }
                if let messageId = messageId, info["message_id"] as? String == messageId { return true }
                if let sequence = sequence, let raw = info["chat_sequence"] as? String, let number = Double(raw) { return number <= sequence }
                if let before = before, let raw = info["chat_sent_at"] as? String, let number = Double(raw) { return number <= before }
                return false
            }.map { $0.request.identifier }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
            call.resolve()
        }
    }

    @objc func clearNotificationKey(_ call: CAPPluginCall) {
        guard let user = call.getString("userId") else { call.reject("Notification identity required"); return }
        do {
            _ = try ChatPreviewKeys.clear(userId: user)
            call.resolve()
        } catch { call.reject("Notification cleanup unavailable") }
    }
}
