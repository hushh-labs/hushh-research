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
        CAPPluginMethod(name: "applyProfileNameScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmProfileNameAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleProfileNameAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireProfileNameScene", returnType: CAPPluginReturnPromise),
    ]
    private var leases = [String: NativeDrawerLease]()
    private var controllers = [String: NativeDrawerPresentationController]()
    private var retiringControllers = [ObjectIdentifier: NativeDrawerPresentationController]()
    private var nameScene: NativeProfileNameScene?
    private var retiringNameScenes = [ObjectIdentifier: NativeProfileNameScene]()
    private var nameOwner: String?
    private var nameRevision = 0
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
                "profileNameScene": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
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
                    self.reconcileIsolation()
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
                retiring.retire {
                    self.afterOwnedFormRetirement(identity.family) { call.resolve(self.receipt(state, phase: "retired")) }
                }
                return
            }
            // Privacy may already have detached this exact presentation. A
            // targeted tombstone proves absence; an old identity can never
            // acknowledge or remove the next owner's controller.
            if self.controllers[identity.family] == nil, lease.retire(identity) {
                self.leases[identity.family] = lease
                self.afterOwnedFormRetirement(identity.family) { call.resolve(self.retiredReceipt(identity, lease: lease)) }; return
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
        guard let controller = controllers.removeValue(forKey: family) else {
            afterOwnedFormRetirement(family, completion: completion); return
        }
        // Withdraw the private form immediately, but join its actual UIKit
        // dismissal as well as the drawer before acknowledging retirement.
        let group = DispatchGroup()
        group.enter()
        afterOwnedFormRetirement(family) { group.leave() }
        let shield = HushhSessionPrivacyShield.shared
        let token = shield.beginPresentationRetirement()
        let identity = ObjectIdentifier(controller)
        retiringControllers[identity] = controller
        group.enter()
        controller.retire { [self] in
            retiringControllers.removeValue(forKey: identity)
            shield.completePresentationRetirement(token)
            group.leave()
        }
        group.notify(queue: .main, execute: completion)
    }
    @MainActor private func afterOwnedFormRetirement(_ family: String, completion: @escaping () -> Void) {
        if family == "profile" { retireNameScene(completion: completion) }
        else { completion() }
    }
    @MainActor private func retireAll() {
        retireNameScene()
        for family in Array(controllers.keys) {
            if let identity = leases[family]?.identity { _ = leases[family]?.retire(identity) }
            detach(family)
        }
    }

    @MainActor private func reconcileIsolation() {
        let covered = controllers.values.contains { $0.coversUnderlyingPresentation } ||
            retiringControllers.values.contains { $0.coversUnderlyingPresentation } ||
            nameScene?.coversPresentation == true || retiringNameScenes.values.contains { $0.coversPresentation }
        container?.isolateForOwnedDrawer(covered)
    }
    @MainActor private func nameOwnerIsCurrent(_ identity: NativeDrawerIdentity, privacy: Int) -> Bool {
        let shield = HushhSessionPrivacyShield.shared
        let state = shield.snapshot()
        guard supported, NativeDrawerQualificationPolicy.coherentShell, UIDevice.current.userInterfaceIdiom == .phone,
              sessionFence.contains(identity), state.appIsActive, !state.shielded, state.generation == privacy,
              shield.acceptsDocument(identity.documentId), let profile = controllers["profile"]?.model.projection else { return false }
        return profile.documentId == identity.documentId && profile.ownerEpoch == identity.ownerEpoch &&
            profile.ownerGeneration == identity.ownerGeneration && profile.surfaceOpen == true && !profile.open && profile.enabled
    }
    private func nameOwnerKey(_ identity: NativeDrawerIdentity) -> String {
        "\(identity.documentId):\(identity.ownerEpoch):\(identity.ownerGeneration)"
    }
    @objc func applyProfileNameScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let parent = self.bridge?.viewController,
                  let options = call.options as? [String: Any], Set(options.keys).isSubset(of: NativeProfileNameProjection.keys),
                  JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options),
                  bytes.count <= 32_768, let next = try? JSONDecoder().decode(NativeProfileNameProjection.self, from: bytes),
                  next.valid, self.nameOwnerIsCurrent(next.identity, privacy: next.privacyGeneration), self.retiringNameScenes.isEmpty else {
                call.reject("NATIVE_PROFILE_NAME_UNAVAILABLE"); return
            }
            if let scene = self.nameScene {
                guard scene.model.projection.identity == next.identity, scene.update(next) else {
                    call.reject("NATIVE_PROFILE_NAME_STALE_STATE"); return
                }
                call.resolve(next.receipt(phase: "active")); return
            }
            let owner = self.nameOwnerKey(next.identity)
            if self.nameOwner != owner { self.nameOwner = owner; self.nameRevision = 0 }
            guard next.revision > self.nameRevision, next.acknowledgedEditRevision == 0 else {
                call.reject("NATIVE_PROFILE_NAME_RETIRED"); return
            }
            let scene = NativeProfileNameScene(next)
            self.nameScene = scene
            self.nameRevision = next.revision
            scene.coverage = { [weak self] in self?.reconcileIsolation() }
            scene.model.edit = { [weak self, weak scene] text, composing, revision in
                guard let self, let scene, self.nameScene === scene else { return false }
                let state = scene.model.projection
                guard self.nameOwnerIsCurrent(state.identity, privacy: state.privacyGeneration) else { return false }
                var event = state.receipt(phase: "active")
                event.removeValue(forKey: "phase")
                event["text"] = text; event["composing"] = composing; event["editRevision"] = revision
                self.notifyListeners("profileNameEdit", data: event, retainUntilConsumed: false)
                return true
            }
            scene.model.choose = { [weak self, weak scene] action in
                guard let self, let scene, self.nameScene === scene else { return false }
                let state = scene.model.projection
                guard self.nameOwnerIsCurrent(state.identity, privacy: state.privacyGeneration) else { return false }
                var event = state.receipt(phase: "active")
                event.removeValue(forKey: "phase")
                event["sequence"] = action.sequence; event["action"] = action.action; event["editRevision"] = action.editRevision
                self.notifyListeners("profileNameAction", data: event, retainUntilConsumed: false)
                return true
            }
            guard scene.present(from: parent, completion: { [weak self, weak scene] presented in
                guard let self, let scene else { call.reject("NATIVE_PROFILE_NAME_RETIRED"); return }
                guard presented, self.nameScene === scene,
                      self.nameOwnerIsCurrent(next.identity, privacy: next.privacyGeneration) else {
                    if self.nameScene === scene { self.retireNameScene() }
                    call.reject("NATIVE_PROFILE_NAME_RETIRED"); return
                }
                call.resolve(next.receipt(phase: "active"))
            }) else {
                self.retireNameScene()
                call.reject("NATIVE_PROFILE_NAME_PRESENTATION_REFUSED"); return
            }
        }
    }
    private func nameAction(_ call: CAPPluginCall) -> NativeProfileNameAction? {
        let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene",
            "updateSequence", "privacyGeneration", "editRevision", "sequence", "action"]
        guard Set(call.options.keys).isSubset(of: keys), call.getString("scene") == "account-name",
              let update = call.getInt("updateSequence"), update > 0,
              let edit = call.getInt("editRevision"), edit >= 0,
              let sequence = call.getInt("sequence"), sequence > 0,
              [update, edit, sequence].allSatisfy({ $0 <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration }),
              let action = call.getString("action"), ["save", "cancel"].contains(action) else { return nil }
        return NativeProfileNameAction(updateSequence: update, editRevision: edit, sequence: sequence, action: action)
    }
    @objc func confirmProfileNameAction(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  self.nameOwnerIsCurrent(identity, privacy: privacy), let scene = self.nameScene,
                  scene.model.projection.identity == identity, let action = self.nameAction(call) else {
                call.resolve(["valid": false]); return
            }
            call.resolve(["valid": scene.model.confirm(action)])
        }
    }
    @objc func settleProfileNameAction(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  self.nameOwnerIsCurrent(identity, privacy: privacy), let scene = self.nameScene,
                  scene.model.projection.identity == identity, let action = self.nameAction(call) else {
                call.resolve(["valid": false]); return
            }
            call.resolve(["valid": scene.settle(action)])
        }
    }
    @objc func retireProfileNameScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), identity.family == "profile",
                  call.getString("scene") == "account-name" else { call.reject("NATIVE_PROFILE_NAME_STALE_RETIREMENT"); return }
            if let scene = self.retiringNameScenes.values.first(where: { $0.model.projection.identity == identity }) {
                scene.retire { call.resolve(scene.model.projection.receipt(phase: "retired")) }; return
            }
            if let scene = self.nameScene {
                guard scene.model.projection.identity == identity else { call.reject("NATIVE_PROFILE_NAME_STALE_RETIREMENT"); return }
                self.retireNameScene { call.resolve(scene.model.projection.receipt(phase: "retired")) }; return
            }
            guard self.sessionFence.contains(identity) else { call.reject("NATIVE_PROFILE_NAME_STALE_RETIREMENT"); return }
            let owner = self.nameOwnerKey(identity)
            if self.nameOwner != owner { self.nameOwner = owner; self.nameRevision = 0 }
            self.nameRevision = max(self.nameRevision, identity.revision)
            var receipt = self.retiredReceipt(identity, lease: NativeDrawerLease())
            receipt["scene"] = "account-name"
            call.resolve(receipt)
        }
    }
    @MainActor private func retireNameScene(completion: @escaping () -> Void = {}) {
        guard let scene = nameScene else {
            let retiring = Array(retiringNameScenes.values)
            guard !retiring.isEmpty else { completion(); return }
            let group = DispatchGroup()
            for scene in retiring {
                group.enter()
                scene.retire { group.leave() }
            }
            group.notify(queue: .main, execute: completion)
            return
        }
        nameScene = nil
        let id = ObjectIdentifier(scene)
        let shield = HushhSessionPrivacyShield.shared
        let token = shield.beginPresentationRetirement()
        retiringNameScenes[id] = scene
        scene.retire { [self] in
            retiringNameScenes.removeValue(forKey: id)
            reconcileIsolation()
            shield.completePresentationRetirement(token)
            completion()
        }
    }
}
