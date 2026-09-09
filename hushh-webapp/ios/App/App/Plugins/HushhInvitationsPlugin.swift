import Capacitor
import MessageUI
import UIKit

/// One explicit, user-confirmed message. No address book reads or persistence.
@objc(HushhInvitationsPlugin)
public class HushhInvitationsPlugin: CAPPlugin, CAPBridgedPlugin, MFMessageComposeViewControllerDelegate {
    public let identifier = "HushhInvitationsPlugin"
    public let jsName = "HushhInvitations"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "composeSms", returnType: CAPPluginReturnPromise)
    ]
    private var pendingCall: CAPPluginCall?

    @objc func getCapabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["sms": MFMessageComposeViewController.canSendText()]) }
    }

    @objc func composeSms(_ call: CAPPluginCall) {
        guard let recipient = call.getString("recipient"),
              recipient.range(of: "^\\+[1-9][0-9]{6,14}\\z", options: .regularExpression) != nil,
              let body = call.getString("body"), !body.isEmpty, body.utf16.count <= 2000 else {
            call.reject("Invalid invitation.")
            return
        }
        DispatchQueue.main.async {
            guard self.pendingCall == nil else {
                call.reject("A message is already open.")
                return
            }
            guard MFMessageComposeViewController.canSendText(),
                  let presenter = self.bridge?.viewController,
                  presenter.viewIfLoaded?.window != nil,
                  presenter.presentedViewController == nil else {
                call.resolve(["outcome": "unavailable"])
                return
            }
            let composer = MFMessageComposeViewController()
            composer.isModalInPresentation = true
            composer.messageComposeDelegate = self
            composer.recipients = [recipient]
            composer.body = body
            self.pendingCall = call
            presenter.present(composer, animated: true)
        }
    }

    public func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
        guard let pending = pendingCall else { return }
        let outcome: String
        switch result {
        case .sent: outcome = "queued_or_sent"
        case .cancelled: outcome = "cancelled"
        case .failed: outcome = "failed"
        @unknown default: outcome = "failed"
        }
        controller.dismiss(animated: true) {
            guard self.pendingCall === pending else { return }
            self.pendingCall = nil
            pending.resolve(["outcome": outcome])
        }
    }
}
