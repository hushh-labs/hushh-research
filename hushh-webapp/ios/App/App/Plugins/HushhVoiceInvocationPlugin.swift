import Capacitor
import Foundation

@objc(HushhVoiceInvocationPlugin)
public final class HushhVoiceInvocationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HushhVoiceInvocationPlugin"
    public let jsName = "HushhVoiceInvocation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPendingInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "claimInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "completeInvocation", returnType: CAPPluginReturnPromise)
    ]

    private var availabilityObserver: NSObjectProtocol?

    public override func load() {
        availabilityObserver = NotificationCenter.default.addObserver(
            forName: .oneVoiceInvocationAvailable,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.emitAvailability()
        }
        OneVoiceInvocationCoordinator.shared.publishAvailability(state: "bridge_ready")
    }

    deinit {
        if let availabilityObserver {
            NotificationCenter.default.removeObserver(availabilityObserver)
        }
    }

    @objc func getPendingInvocation(_ call: CAPPluginCall) {
        guard let invocation = OneVoiceInvocationCoordinator.shared.pending() else {
            // Capacitor promise payloads are objects. The typed adapter maps an
            // empty object to null so web and Android retain the same contract.
            call.resolve([:])
            return
        }
        call.resolve(invocation.bridgePayload)
    }

    @objc func claimInvocation(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A non-empty invocation id is required.")
            return
        }
        call.resolve([
            "claimed": OneVoiceInvocationCoordinator.shared.claim(id: id)
        ])
    }

    @objc func completeInvocation(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A non-empty invocation id is required.")
            return
        }
        guard let outcome = call.getString("outcome"), !outcome.isEmpty else {
            call.reject("A completion outcome is required.")
            return
        }
        OneVoiceInvocationCoordinator.shared.complete(id: id, outcome: outcome)
        call.resolve()
    }

    private func emitAvailability() {
        guard let invocation = OneVoiceInvocationCoordinator.shared.pending() else {
            return
        }
        notifyListeners(
            "voiceInvocationAvailable",
            data: invocation.bridgePayload,
            retainUntilConsumed: true
        )
    }
}
