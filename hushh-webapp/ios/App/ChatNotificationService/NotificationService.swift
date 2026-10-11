import UserNotifications
import Intents
import UIKit

final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var best: UNNotificationContent?
    private var expectedKey: String?
    private let completionLock = NSLock()

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        completionLock.lock()
        handler = contentHandler
        best = request.content
        expectedKey = ChatPreviewKeys.recipientKey(request.content.userInfo)
        completionLock.unlock()
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else { finish(); return }
        let info = content.userInfo
        if let key = ChatPreviewKeys.recipientKey(info) {
            let version = (info["chat_badge_version"] as? String).flatMap(Double.init)
            if !ChatPreviewKeys.applyBadge(keyId: key, version: version, action: {}) { content.badge = nil }
        }
        completionLock.lock(); best = content; completionLock.unlock()
        if ChatPreviewKeys.isRead(info) {
            // iOS requires the filtering entitlement to discard an accepted push.
            // Keep completion exactly once, without replaying sound or unread badge.
            content.title = "Messages read"; content.body = ""; content.sound = nil; content.badge = nil
            completionLock.lock(); best = content; completionLock.unlock(); finish(); return
        }
        guard let context = info["preview_context"] as? String else { finish(); return }
        let preview = (info["chat_preview"] as? String).flatMap { ChatPreviewKeys.open(sealed: $0, context: context) }
        let identity = (info["chat_identity"] as? String).flatMap { ChatPreviewKeys.open(sealed: $0, context: context) }
        let trusted = identity ?? ((info["type"] as? String) == "direct_message" ? preview : nil)
        guard let senderValue = trusted?["sender"], !senderValue.isEmpty else { finish(); return }
        let messageValue = preview?["text"] ?? "You have a new message"
        if let expiry = info["chat_expires_at"] as? String, let seconds = TimeInterval(expiry), seconds < Date().timeIntervalSince1970 { finish(); return }
        let sender = String(senderValue.prefix(80))
        let group = (trusted?["group"]).flatMap { $0.isEmpty ? nil : $0 }.map { String($0.prefix(80)) }
        content.title = group ?? sender
        content.body = group == nil ? String(messageValue.prefix(160)) : "\(sender): \(String(messageValue.prefix(160)))"
        content.threadIdentifier = (info["conversation_id"] as? String) ?? (info["circle_id"] as? String) ?? request.identifier
        let image = avatar(trusted?["avatar"], name: sender)
        let senderRef = trusted?["senderRef"] ?? sender
        let person = INPerson(personHandle: INPersonHandle(value: senderRef, type: .unknown), nameComponents: nil,
                              displayName: sender, image: INImage(imageData: image), contactIdentifier: nil, customIdentifier: senderRef)
        let intent = INSendMessageIntent(recipients: nil, outgoingMessageType: .outgoingMessageText,
            content: String(messageValue.prefix(160)), speakableGroupName: group.map { INSpeakableString(spokenPhrase: $0) },
            conversationIdentifier: content.threadIdentifier, serviceName: "Hussh", sender: person, attachments: nil)
        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        interaction.groupIdentifier = expectedKey
        interaction.identifier = (info["event_id"] as? String) ?? request.identifier
        // Donation never gates rendering: the extension must finish exactly once.
        completionLock.lock()
        guard handler != nil, let key = expectedKey, ChatPreviewKeys.matches(keyId: key) else {
            completionLock.unlock(); finish(); return
        }
        best = content
        // Expiry cannot consume the completion handler while donation starts.
        interaction.donate { [weak self] _ in
            if !ChatPreviewKeys.matches(keyId: key) { ChatPreviewKeys.clearDelivered(keyId: key) }
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.completionLock.lock()
                guard self.handler != nil else { self.completionLock.unlock(); return }
                self.best = (try? content.updating(from: intent)) ?? content
                self.completionLock.unlock()
                self.finish()
            }
        }
        completionLock.unlock()
    }
    private func avatar(_ source: String?, name: String) -> Data {
        if let source = source, source.hasPrefix("data:image/jpeg;base64,"), source.count <= 1023,
           let bytes = Data(base64Encoded: String(source.dropFirst("data:image/jpeg;base64,".count))),
           let image = UIImage(data: bytes), image.size.width <= 64, image.size.height <= 64 { return bytes }
        return UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).image { context in
            UIColor(red: 0.25, green: 0.33, blue: 0.41, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
            let initial = String(name.prefix(1)).uppercased() as NSString
            initial.draw(at: CGPoint(x: 19, y: 13), withAttributes: [.font: UIFont.systemFont(ofSize: 30), .foregroundColor: UIColor.white])
        }.pngData() ?? Data()
    }
    private func finish() {
        completionLock.lock()
        guard let callback = handler, let current = best else { completionLock.unlock(); return }
        var content = current
        if (expectedKey == nil || expectedKey.map({ ChatPreviewKeys.matches(keyId: $0) }) == false),
           let sanitized = current.mutableCopy() as? UNMutableNotificationContent {
            sanitized.title = "New message"; sanitized.body = "Open Hussh to view your messages"
            sanitized.sound = nil; sanitized.badge = nil
            content = sanitized
        }
        if let key = expectedKey, let sanitized = content.mutableCopy() as? UNMutableNotificationContent {
            let version = (content.userInfo["chat_badge_version"] as? String).flatMap(Double.init)
            if !ChatPreviewKeys.applyBadge(keyId: key, version: version, action: {}) { sanitized.badge = nil }
            if ChatPreviewKeys.isRead(content.userInfo) {
                sanitized.title = "Messages read"; sanitized.body = ""; sanitized.sound = nil; sanitized.badge = nil
            }
            content = sanitized
        }
        handler = nil
        best = nil
        completionLock.unlock()
        callback(content)
    }
    override func serviceExtensionTimeWillExpire() { finish() }
}
