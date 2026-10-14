import Capacitor
import UIKit

enum NativeDrawerQualificationPolicy {
    static func admits(_ idiom: UIUserInterfaceIdiom, enabled: Bool, coherentShell: Bool) -> Bool {
        switch idiom {
        case .phone: return enabled
        case .pad: return coherentShell
        default: return false
        }
    }
    static var deviceEligible: Bool {
        guard #available(iOS 26.0, *) else { return false }
        return admits(UIDevice.current.userInterfaceIdiom, enabled: enabled, coherentShell: coherentShell)
    }
    static var coherentShell: Bool {
        #if HUSHH_NATIVE_SHELL_QUALIFICATION
        // Explicit qualification binaries keep the selected renderer across
        // manual launches. This does not enable ordinary Debug/Release builds.
        return true
        #elseif DEBUG
        return ProcessInfo.processInfo.arguments.contains("--hushh-native-shell-qualification")
        #else
        return false
        #endif
    }
    static var enabled: Bool {
        #if DEBUG
        return coherentShell || ProcessInfo.processInfo.arguments.contains("--hushh-native-product-drawers-qualification")
        #else
        return coherentShell
        #endif
    }
}

/// Volatile private projections and confirmed choices only. This plugin never
/// performs navigation, persistence, cryptography or provider/network operations.
@objc(HushhNativeDrawersPlugin)
final class HushhNativeDrawersPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "HushhNativeDrawersPlugin"
    let jsName = "HushhNativeDrawers"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "apply", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmChoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleChoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retire", returnType: CAPPluginReturnPromise),
    ]
    private var leases = [String: NativeDrawerLease]()
    private var controllers = [String: NativeDrawerPresentationController]()
    private var retiringControllers = [ObjectIdentifier: NativeDrawerPresentationController]()
    private var sessionFence = NativeDrawerSessionFence()
    private var privacyObserver: NSObjectProtocol?
    private var isolationObserver: NSObjectProtocol?
    private var container: NativePresentationContainer? { bridge?.viewController?.view as? NativePresentationContainer }
    private var supported: Bool {
        if #available(iOS 26.0, *) {
            return NativeDrawerQualificationPolicy.deviceEligible && container?.wholeNativeDrawers == true
        }
        return false
    }
    override func load() {
        DispatchQueue.main.async { [weak self] in
            self?.privacyObserver = NotificationCenter.default.addObserver(
                forName: HushhSessionPrivacyShield.presentationDidChange, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    if HushhSessionPrivacyShield.shared.snapshot().shielded { self?.retireAll() }
                }
            }
            self?.isolationObserver = NotificationCenter.default.addObserver(
                forName: NativePresentationContainer.isolationDidChange, object: nil, queue: .main
            ) { [weak self] note in
                guard let self, let container = note.object as? NativePresentationContainer, container === self.container else { return }
                self.notifyListeners("isolationChanged", data: ["generation": container.isolationGeneration,
                    "isolated": container.interactionIsolated], retainUntilConsumed: false)
            }
        }
    }
    deinit {
        if let privacyObserver { NotificationCenter.default.removeObserver(privacyObserver) }
        if let isolationObserver { NotificationCenter.default.removeObserver(isolationObserver) }
    }
    @objc func getCapabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            call.resolve(["contractVersion": 1, "supported": self?.supported == true, "wholePresentation": self?.supported == true,
                "historyActions": self?.supported == true,
                "profileMenuRows": self?.supported == true,
                "profileContentHandoff": self?.supported == true,
                "agentProfileMenu": self?.supported == true,
                "terminalRefreshes": self?.supported == true,
                "terminalReadmission": self?.supported == true,
                "coherentShell": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell,
                "generation": self?.container?.isolationGeneration ?? 0, "isolated": self?.container?.interactionIsolated == true])
        }
    }
    @objc func apply(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.supported, let parent = self.bridge?.viewController, let container = self.container else {
                call.reject("NATIVE_DRAWER_UNSUPPORTED"); return
            }
            guard self.retiringControllers.isEmpty else { call.reject("NATIVE_DRAWER_RETIRING"); return }
            // Decode a closed shape without persisting/logging raw options.
            guard let options = call.options as? [String: Any], NativeDrawerProjection.hasClosedShape(options), JSONSerialization.isValidJSONObject(options),
                  let bytes = try? JSONSerialization.data(withJSONObject: options), bytes.count <= 2_200_000,
                  let next = try? JSONDecoder().decode(NativeDrawerProjection.self, from: bytes), next.valid else {
                call.reject("NATIVE_DRAWER_INVALID_STATE"); return
            }
            let shield = HushhSessionPrivacyShield.shared
            let privacy = shield.snapshot()
            shield.observeDocument(next.documentId)
            guard privacy.appIsActive, !privacy.shielded, next.privacyGeneration == privacy.generation,
                  shield.acceptsDocument(next.documentId) else { call.reject("NATIVE_DRAWER_PRIVATE_STATE_UNAVAILABLE"); return }
            var session = self.sessionFence
            guard session.admit(next.identity) else { call.reject("NATIVE_DRAWER_STALE_OWNER"); return }
            let replacingSession = !self.sessionFence.contains(next.identity)
            // Validate all admission metadata before detaching either family's
            // old owner. The replacement is atomic on the main actor.
            var lease = replacingSession ? NativeDrawerLease() : self.leases[next.family] ?? NativeDrawerLease()
            guard lease.apply(next) else { call.reject("NATIVE_DRAWER_STALE_STATE"); return }
            if replacingSession {
                self.retireAll()
                self.leases.removeAll()
                self.sessionFence = session
                guard self.retiringControllers.isEmpty else { call.reject("NATIVE_DRAWER_RETIRING"); return }
            }
            guard !next.open || !self.controllers.contains(where: { family, control in
                family != next.family && (control.model.projection.open || control.motion.progress > 0)
            }) else { call.reject("NATIVE_DRAWER_OVERLAP"); return }
            self.leases[next.family] = lease
            if let previous = self.controllers[next.family], previous.model.projection.identity != next.identity {
                self.detach(next.family)
                guard self.retiringControllers.isEmpty else { call.reject("NATIVE_DRAWER_RETIRING"); return }
            }
            if let previous = self.controllers[next.family] { previous.update(next) }
            else {
                let controller = NativeDrawerPresentationController(next)
                if next.family == "history" {
                    controller.leadingHeaderFrame = { [weak container] in
                        container?.installedFrame("chat-history-toggle")
                    }
                }
                parent.addChild(controller)
                controller.view.frame = container.bounds
                controller.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                if let cover = container.subviews.first(where: { $0.accessibilityIdentifier == HushhSessionPrivacyShield.accessibilityIdentifier }) {
                    container.insertSubview(controller.view, belowSubview: cover)
                } else { container.addSubview(controller.view) }
                controller.didMove(toParent: parent)
                controller.isolation = { [weak self] _ in
                    guard let self else { return }
                    // Retiring presenters remain owners until their menu/alert
                    // disappears, even after leaving the active registry.
                    let covered = self.controllers.values.contains { $0.coversUnderlyingPresentation } ||
                        self.retiringControllers.values.contains { $0.coversUnderlyingPresentation }
                    self.container?.isolateForOwnedDrawer(covered)
                }
                controller.model.choose = { [weak self] action, row, text in self?.emit(next.family, action: action, row: row, text: text) == true }
                controller.invalidateInteractions = { [weak self] in self?.leases[next.family]?.invalidateInteractions() }
                controller.requestReadmission = { [weak self, weak controller] in
                    guard let self, let controller, self.controllers[next.family] === controller,
                          let lease = self.leases[next.family] else { return }
                    let state = controller.model.projection
                    let privacy = HushhSessionPrivacyShield.shared.snapshot()
                    guard self.supported, self.sessionFence.contains(state.identity), privacy.appIsActive,
                          !privacy.shielded, state.privacyGeneration == privacy.generation else { return }
                    var event = self.receipt(state, phase: "active")
                    event.removeValue(forKey: "phase")
                    event["interactionGeneration"] = lease.interactionGeneration
                    self.notifyListeners("readmissionRequested", data: event, retainUntilConsumed: false)
                }
                self.controllers[next.family] = controller
                controller.activateInitialPresentation()
            }
            call.resolve(self.receipt(next, phase: "active"))
        }
    }
    @MainActor private func emit(_ family: String, action: String, row: String?, text: String?) -> Bool {
        guard let controller = controllers[family], var lease = leases[family],
              controller.allowsInteraction(action, row: row, text: text) else { return false }
        let state = controller.model.projection
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        guard sessionFence.contains(state.identity), privacy.appIsActive, !privacy.shielded, state.privacyGeneration == privacy.generation,
              let sequence = lease.emit(action: action, row: row, state: state, text: text) else { return false }
        leases[family] = lease
        #if DEBUG
        if action == "close" { controller.observeClose(sequence: sequence) }
        #endif
        if action == "row" { controller.model.pendingSequence = sequence }
        var event = receipt(state, phase: "active")
        event.removeValue(forKey: "phase")
        event["sequence"] = sequence; event["action"] = action
        event["interactionGeneration"] = lease.interactionGeneration
        if let row { event["rowId"] = row }
        if let text { event["text"] = text }
        notifyListeners("choice", data: event, retainUntilConsumed: false)
        return true
    }
    @objc func confirmChoice(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let controller = self.controllers[identity.family],
                  var lease = self.leases[identity.family] else { call.resolve(["valid": false]); return }
            let privacy = HushhSessionPrivacyShield.shared.snapshot()
            let action = call.getString("action") ?? ""
            let row = call.getString("rowId")
            let text = call.getString("text")
            let state = controller.model.projection
            let allowed = self.supported && self.sessionFence.contains(identity) && privacy.appIsActive && !privacy.shielded &&
                state.privacyGeneration == privacy.generation && controller.allowsInteraction(action, row: row, text: text)
            let valid = lease.confirm(identity: identity, update: call.getInt("updateSequence") ?? -1,
                privacy: call.getInt("privacyGeneration") ?? -1, sequence: call.getInt("sequence") ?? -1,
                interaction: call.getInt("interactionGeneration") ?? -1,
                action: action, row: row, allowed: allowed, text: text)
            self.leases[identity.family] = lease
            #if DEBUG
            if action == "close" { controller.observeClose(sequence: call.getInt("sequence") ?? -1, confirmed: valid) }
            #endif
            call.resolve(["valid": valid])
        }
    }
    @objc func settleChoice(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.supported, let identity = self.identity(call),
                  let controller = self.controllers[identity.family], var lease = self.leases[identity.family],
                  let sequence = call.getInt("sequence"), let success = call.getBool("success") else {
                call.resolve(["valid": false]); return
            }
            let privacy = HushhSessionPrivacyShield.shared.snapshot()
            guard privacy.appIsActive, !privacy.shielded, self.sessionFence.contains(identity),
                  privacy.generation == call.getInt("privacyGeneration"),
                  lease.settle(identity: identity, privacy: privacy.generation, sequence: sequence, success: success) else {
                call.resolve(["valid": false]); return
            }
            self.leases[identity.family] = lease
            // A late completion cannot clear a reopened editor or a newer choice.
            controller.model.settle(sequence: sequence, success: success)
            call.resolve(["valid": true])
        }
    }
    @objc func retire(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call) else {
                call.reject("NATIVE_DRAWER_STALE_RETIREMENT"); return
            }
            var session = self.sessionFence
            guard session.admit(identity) else { call.reject("NATIVE_DRAWER_STALE_OWNER"); return }
            if !self.sessionFence.contains(identity) {
                self.retireAll(); self.leases.removeAll(); self.sessionFence = session
            }
            var lease = self.leases[identity.family] ?? NativeDrawerLease()
            if let retiring = self.retiringControllers.values.first(where: { $0.model.projection.identity == identity }) {
                let state = retiring.model.projection
                retiring.retire { call.resolve(self.receipt(state, phase: "retired")) }
                return
            }
            // Privacy may already have detached this exact presentation. A
            // targeted tombstone proves absence; an old identity can never
            // acknowledge or remove the next owner's controller.
            if self.controllers[identity.family] == nil, lease.retire(identity) {
                self.leases[identity.family] = lease
                call.resolve(self.retiredReceipt(identity, lease: lease)); return
            }
            guard let controller = self.controllers[identity.family], lease.retire(identity) else {
                call.reject("NATIVE_DRAWER_STALE_RETIREMENT"); return
            }
            let state = controller.model.projection
            self.leases[identity.family] = lease
            self.detach(identity.family) { call.resolve(self.receipt(state, phase: "retired")) }
        }
    }
    private func identity(_ call: CAPPluginCall) -> NativeDrawerIdentity? {
        guard let document = call.getString("documentId"), let owner = call.getString("ownerEpoch"),
              let ownerGeneration = call.getInt("ownerGeneration"), let revision = call.getInt("revision"), let family = call.getString("family") else { return nil }
        let identity = NativeDrawerIdentity(documentId: document, ownerEpoch: owner, ownerGeneration: ownerGeneration, revision: revision, family: family)
        return identity.valid ? identity : nil
    }
    private func receipt(_ state: NativeDrawerProjection, phase: String) -> [String: Any] {
        ["documentId": state.documentId, "ownerEpoch": state.ownerEpoch, "ownerGeneration": state.ownerGeneration, "revision": state.revision,
         "family": state.family, "updateSequence": state.updateSequence, "privacyGeneration": state.privacyGeneration, "phase": phase]
    }
    private func retiredReceipt(_ identity: NativeDrawerIdentity, lease: NativeDrawerLease) -> [String: Any] {
        ["documentId": identity.documentId, "ownerEpoch": identity.ownerEpoch, "ownerGeneration": identity.ownerGeneration,
         "revision": identity.revision, "family": identity.family, "updateSequence": lease.updateSequence,
         "privacyGeneration": max(0, lease.privacyGeneration), "phase": "retired"]
    }
    @MainActor private func detach(_ family: String, completion: @escaping () -> Void = {}) {
        guard let controller = controllers.removeValue(forKey: family) else { completion(); return }
        let shield = HushhSessionPrivacyShield.shared
        let token = shield.beginPresentationRetirement()
        let identity = ObjectIdentifier(controller)
        retiringControllers[identity] = controller
        controller.retire { [self] in
            retiringControllers.removeValue(forKey: identity)
            shield.completePresentationRetirement(token)
            completion()
        }
    }
    @MainActor private func retireAll() {
        for family in Array(controllers.keys) {
            if let identity = leases[family]?.identity { _ = leases[family]?.retire(identity) }
            detach(family)
        }
    }
}
