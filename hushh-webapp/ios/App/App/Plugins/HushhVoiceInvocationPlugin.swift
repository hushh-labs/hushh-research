import Capacitor
import Foundation

@objc(HushhVoiceInvocationPlugin)
public final class HushhVoiceInvocationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HushhVoiceInvocationPlugin"
    public let jsName = "HushhVoiceInvocation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPendingInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "claimInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "completeInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPendingActionInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "claimActionInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "completeActionInvocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reportActionInvocationProgress", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateActionEntityIndex", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearActionState", returnType: CAPPluginReturnPromise)
    ]

    private var availabilityObserver: NSObjectProtocol?
    private var actionAvailabilityObserver: NSObjectProtocol?

    public override func load() {
        availabilityObserver = NotificationCenter.default.addObserver(
            forName: .oneVoiceInvocationAvailable,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.emitAvailability()
        }
        actionAvailabilityObserver = NotificationCenter.default.addObserver(
            forName: .oneSystemActionInvocationAvailable,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.emitActionAvailability()
        }
        OneVoiceInvocationCoordinator.shared.publishAvailability(state: "bridge_ready")
        OneSystemActionInvocationCoordinator.shared.publishAvailability(state: "bridge_ready")
    }

    deinit {
        if let availabilityObserver {
            NotificationCenter.default.removeObserver(availabilityObserver)
        }
        if let actionAvailabilityObserver {
            NotificationCenter.default.removeObserver(actionAvailabilityObserver)
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

    @objc func getPendingActionInvocation(_ call: CAPPluginCall) {
        guard let invocation = OneSystemActionInvocationCoordinator.shared.pending() else {
            call.resolve([:])
            return
        }
        call.resolve(invocation.bridgePayload)
    }

    @objc func claimActionInvocation(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A non-empty action invocation id is required.")
            return
        }
        call.resolve([
            "claimed": OneSystemActionInvocationCoordinator.shared.claim(id: id)
        ])
    }

    @objc func completeActionInvocation(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A non-empty action invocation id is required.")
            return
        }
        guard let outcome = call.getString("outcome"), !outcome.isEmpty else {
            call.reject("An action completion outcome is required.")
            return
        }
        let summary = call.getString("summary") ?? "HUSSH could not finish that action."
        OneSystemActionInvocationCoordinator.shared.complete(
            id: id,
            outcome: outcome,
            summary: summary
        )
        call.resolve()
    }

    @objc func reportActionInvocationProgress(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("A non-empty action invocation id is required.")
            return
        }
        guard
            let rawState = call.getString("state"),
            let state = OneSystemActionProgressState(rawValue: rawState)
        else {
            call.reject("A supported action invocation progress state is required.")
            return
        }
        call.resolve([
            "reported": OneSystemActionInvocationCoordinator.shared.reportProgress(
                id: id,
                state: state
            )
        ])
    }

    @objc func updateActionEntityIndex(_ call: CAPPluginCall) {
        guard let ownerID = call.getString("ownerId"), !ownerID.isEmpty else {
            call.reject("A non-empty owner id is required.")
            return
        }
        let contacts = Self.parseEntities(call.getArray("contacts", JSObject.self) ?? [])
        let circles = Self.parseEntities(call.getArray("circles", JSObject.self) ?? [])
        guard OneSystemActionInvocationCoordinator.shared.updateEntityIndex(
            ownerID: ownerID,
            contacts: contacts,
            circles: circles
        ) else {
            call.reject("The HUSSH action entity index could not be updated.")
            return
        }
        call.resolve(["updated": true])
    }

    @objc func clearActionState(_ call: CAPPluginCall) {
        OneSystemActionInvocationCoordinator.shared.cancelAll(
            outcome: call.getString("outcome") ?? "cancelled",
            clearEntityIndex: call.getBool("clearEntityIndex") ?? false
        )
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

    private func emitActionAvailability() {
        guard let invocation = OneSystemActionInvocationCoordinator.shared.pending() else {
            return
        }
        notifyListeners(
            "systemActionInvocationAvailable",
            data: invocation.bridgePayload,
            retainUntilConsumed: true
        )
    }

    private static func parseEntities(_ values: [JSObject]) -> [OneSystemEntityIndexEntry] {
        values.compactMap { value in
            guard
                let id = value["id"] as? String,
                let name = value["name"] as? String
            else { return nil }
            return OneSystemEntityIndexEntry(id: id, name: name)
        }
    }
}
