import Capacitor
import FirebaseAuth
import Foundation

@objc(HushhCallingPlugin)
public final class HushhCallingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HushhCallingPlugin"
    public let jsName = "HushhCalling"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "answer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "verify", returnType: CAPPluginReturnPromise)
    ]
    private var owner: String?
    public override func load() {
        Task { @MainActor [weak self] in
            CallingCoordinator.shared.observer = { [weak self] state in
                guard let self, self.owner == Auth.auth().currentUser?.uid else { return }
                self.notifyListeners("callState", data: state)
            }
        }
    }
    @objc func initialize(_ call: CAPPluginCall) {
        guard let owner = call.getString("ownerId") else { call.reject("Missing owner."); return }
        Task { @MainActor in
            do {
                try await CallingCoordinator.shared.enable(owner: owner)
                self.owner = owner
                call.resolve(["available": true])
                CallingCoordinator.shared.publish()
            } catch { call.resolve(["available": false]) }
        }
    }
    private func perform(_ call: CAPPluginCall, action: @escaping @MainActor (CallingCoordinator) async throws -> Void) {
        Task { @MainActor in
            guard let owner = self.owner, owner == Auth.auth().currentUser?.uid,
                  CallingCoordinator.shared.api?.identity.owner == owner else { call.reject("Call owner changed."); return }
            do { try await action(CallingCoordinator.shared); call.resolve() }
            catch { call.reject("Calling is unavailable or requires device verification.") }
        }
    }
    @objc func start(_ call: CAPPluginCall) {
        perform(call) { engine in try await engine.start(conversation: call.getString("conversationId"), person: call.getString("personRef")) }
    }
    @objc func answer(_ call: CAPPluginCall) {
        perform(call) { engine in
            guard let id = engine.call?["id"] as? String, let uuid = UUID(uuidString: id) else { throw CallingError.invalid }
            try await engine.system.requestAnswer(uuid)
        }
    }
    @objc func end(_ call: CAPPluginCall) { perform(call) { $0.end(userInitiated: true, decline: call.getBool("decline") ?? false) } }
    @objc func mute(_ call: CAPPluginCall) { perform(call) { $0.setMuted(!$0.muted) } }
    @objc func verify(_ call: CAPPluginCall) {
        perform(call) { engine in
            guard let fingerprint = call.getString("fingerprint"), let accepted = call.getBool("accepted") else { throw CallingError.invalid }
            try engine.confirm(fingerprint: fingerprint, accepted: accepted)
        }
    }
}
