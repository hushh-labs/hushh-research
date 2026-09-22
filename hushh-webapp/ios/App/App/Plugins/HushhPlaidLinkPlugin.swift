import Capacitor
import Foundation
import LinkKit

/// Plaid Link through Plaid's own iOS SDK. The web Link SDK inside the
/// WebView cannot finish an OAuth bank (Chase, and every app-to-app
/// institution): its OAuth leg leaves the app for Safari and the redirect
/// chain ends there, in a browser with no session (measured on the iPhone:
/// link token minted, no exchange ever arrived). LinkKit owns that leg and
/// the return into the app.
///
/// `open({ token })` resolves once with `{ publicToken, metadata }` on
/// success, or `{ exit: true, error?, metadata }` when the person leaves
/// Link; events stream as `plaidLinkEvent`. The public token goes straight
/// back to the page, which exchanges it with the backend as it does on the
/// web; nothing is stored here.
@objc(HushhPlaidLinkPlugin)
public class HushhPlaidLinkPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HushhPlaidLinkPlugin"
    public let jsName = "HushhPlaidLink"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
    ]

    private var session: PlaidLinkSession?
    private var pendingCall: CAPPluginCall?

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": true])
    }

    @objc func open(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), !token.isEmpty else {
            call.reject("A Plaid link token is required.", "MISSING_TOKEN")
            return
        }
        if pendingCall != nil {
            call.reject("Plaid Link is already open.", "ALREADY_OPEN")
            return
        }
        pendingCall = call
        call.keepAlive = true

        let configuration = LinkTokenConfiguration(
            token: token,
            onSuccess: { [weak self] success in
                self?.finish([
                    "publicToken": success.publicToken,
                    "metadata": Self.json(success.metadata.metadataJSON),
                ])
            },
            onExit: { [weak self] exit in
                var payload: [String: Any] = [
                    "exit": true,
                    "metadata": Self.json(exit.metadata.metadataJSON),
                ]
                if let error = exit.error {
                    payload["error"] = [
                        "code": String(describing: error.errorCode),
                        "message": error.errorMessage,
                        "displayMessage": error.displayMessage ?? "",
                    ]
                }
                self?.finish(payload)
            },
            onEvent: { [weak self] event in
                self?.notifyListeners("plaidLinkEvent", data: [
                    "eventName": String(describing: event.eventName),
                    "metadata": Self.json(event.metadata.metadataJSON),
                ])
            },
            onLoad: nil
        )

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            do {
                let session = try Plaid.createPlaidLinkSession(configuration: configuration)
                self.session = session
                guard let presenter = self.bridge?.viewController else {
                    self.fail("No presenter for Plaid Link.", "NO_PRESENTER")
                    return
                }
                session.open(using: .viewController(presenter))
            } catch {
                self.fail(error.localizedDescription, "CREATE_FAILED")
            }
        }
    }

    private func finish(_ payload: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let call = self.pendingCall else { return }
            self.pendingCall = nil
            self.session = nil
            call.resolve(payload)
            self.bridge?.releaseCall(call)
        }
    }

    private func fail(_ message: String, _ code: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let call = self.pendingCall else { return }
            self.pendingCall = nil
            self.session = nil
            call.reject(message, code)
            self.bridge?.releaseCall(call)
        }
    }

    /// LinkKit hands metadata as a JSON string; the page wants the object.
    private static func json(_ raw: String?) -> Any {
        guard let raw, let data = raw.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data) else {
            return [:]
        }
        return parsed
    }
}
