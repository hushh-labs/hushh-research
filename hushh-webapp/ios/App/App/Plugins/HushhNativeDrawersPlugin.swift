import Capacitor
import UIKit

/// Volatile private projections and confirmed choices only. This plugin never
/// performs navigation, persistence, cryptography or provider/network operations.
@objc(HushhNativeDrawersPlugin)
final class HushhNativeDrawersPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "HushhNativeDrawersPlugin"
    let jsName = "HushhNativeDrawers"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyWalletCardScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmWalletCardAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleWalletCardAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireWalletCardScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getWalletCardState", returnType: CAPPluginReturnPromise),

        CAPPluginMethod(name: "prepareOwnedChoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "updateOwnedChoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireOwnedChoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getOwnedChoiceState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyFeedback", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireFeedback", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyProfilePaymentsScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmProfilePaymentsAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleProfilePaymentsAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireProfilePaymentsScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "apply", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPresentationState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmChoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "copyProfileReferralLink", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleChoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retire", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyProfileNameScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmProfileNameAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleProfileNameAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireProfileNameScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyProfileStyleScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmProfileStyleAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleProfileStyleAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireProfileStyleScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyProfileSupportScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmProfileSupportAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleProfileSupportAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireProfileSupportScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyProfilePhoneScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmProfilePhoneAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleProfilePhoneAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireProfilePhoneScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyProfilePasswordScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmProfilePasswordAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleProfilePasswordAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireProfilePasswordScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyProfilePricingScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmProfilePricingAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleProfilePricingAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireProfilePricingScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyProfileWorldModelScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmProfileWorldModelAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleProfileWorldModelAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireProfileWorldModelScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyProfileRuntimeScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmProfileRuntimeAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleProfileRuntimeAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireProfileRuntimeScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyProfileConnectorScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyProfileMemoryScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmProfileMemoryAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleProfileMemoryAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireProfileMemoryScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmProfileConnectorAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleProfileConnectorAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireProfileConnectorScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyWorkspace", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireWorkspace", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmWorkspaceChoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleWorkspaceChoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getWorkspaceState", returnType: CAPPluginReturnPromise),
    ]
    private var leases = [String: NativeDrawerLease]()
    private var controllers = [String: NativeDrawerPresentationController]()
    private var retiringControllers = [ObjectIdentifier: NativeDrawerPresentationController]()
    private var form: NativeProfileOwnedForm?
    @MainActor private func admitRoutePresentationOwner(_ identity: NativeOwnedChoiceIdentity) -> Bool {
        guard supported, UIDevice.current.userInterfaceIdiom == .phone else { return false }
        var session = sessionFence
        guard session.admitOwner(documentId: identity.documentId, ownerEpoch: identity.ownerEpoch, ownerGeneration: identity.ownerGeneration) else { return false }
        if !sessionFence.containsOwner(documentId: identity.documentId, ownerEpoch: identity.ownerEpoch, ownerGeneration: identity.ownerGeneration) {
            retireAll(); leases.removeAll(); sessionFence = session
        }
        return true
    }
    @MainActor private lazy var walletCard: NativeWalletCardCoordinator = {
        let value = NativeWalletCardCoordinator()
        value.parent = { [weak self] in self?.bridge?.viewController }
        value.available = { [weak self] in
            guard let self else { return false }
            return self.supported && self.ownedChoices.concealed && self.form == nil && self.retiringForms.isEmpty &&
                self.retiringControllers.isEmpty && (self.workspace == nil || self.workspace?.permitsWalletForm == true) && self.retiringWorkspaces.isEmpty &&
                !self.controllers.values.contains { $0.coversUnderlyingPresentation }
        }
        value.admitOwner = { [weak self] in self?.admitRoutePresentationOwner($0) == true }
        value.currentOwner = { [weak self] identity in self?.sessionFence.containsOwner(documentId: identity.documentId,
            ownerEpoch: identity.ownerEpoch, ownerGeneration: identity.ownerGeneration) == true }
        value.changed = { [weak self] in self?.reconcileIsolation() }
        value.emit = { [weak self] name, event in self?.notifyListeners(name, data: event, retainUntilConsumed: false) }
        return value
    }()
    @MainActor private lazy var ownedChoices: NativeOwnedChoiceCoordinator = {
        let choice = NativeOwnedChoiceCoordinator()
        choice.parent = { [weak self] in self?.bridge?.viewController }
        choice.available = { [weak self] in
            guard let self else { return false }
            return self.supported && UIDevice.current.userInterfaceIdiom == .phone && self.walletCard.concealed && self.form == nil &&
                self.retiringForms.isEmpty && self.retiringControllers.isEmpty && self.workspace == nil &&
                self.retiringWorkspaces.isEmpty && !self.controllers.values.contains { $0.coversUnderlyingPresentation }
        }
        choice.admitOwner = { [weak self] in self?.admitRoutePresentationOwner($0) == true }
        choice.currentOwner = { [weak self] identity in self?.sessionFence.containsOwner(documentId: identity.documentId, ownerEpoch: identity.ownerEpoch, ownerGeneration: identity.ownerGeneration) == true }
        choice.changed = { [weak self] in self?.reconcileIsolation() }
        choice.emit = { [weak self] event in self?.notifyListeners("ownedChoice", data: event, retainUntilConsumed: false) }
        return choice
    }()
    @MainActor private lazy var feedback: NativeFeedbackPresentation = {
        let presenter = NativeFeedbackPresentation()
        presenter.ended = { [weak self] event in self?.notifyListeners("feedbackEnded", data: event, retainUntilConsumed: false) }
        return presenter
    }()
    private var nameScene: NativeProfileNameScene? {
        get { form as? NativeProfileNameScene }
        set { form = newValue }
    }
    private var styleScene: NativeProfileStyleScene? { form as? NativeProfileStyleScene }
    private var supportScene: NativeProfileSupportScene? { form as? NativeProfileSupportScene }
    private var phoneScene: NativeProfilePhoneScene? { form as? NativeProfilePhoneScene }
    private var passwordScene: NativeProfilePasswordScene? { form as? NativeProfilePasswordScene }
    private var worldModelScene: NativeProfileWorldModelScene? { form as? NativeProfileWorldModelScene }
    private var runtimeScene: NativeProfileRuntimeScene? { form as? NativeProfileRuntimeScene }
    private var connectorScene: NativeProfileConnectorScene? { form as? NativeProfileConnectorScene }
    private var memoryScene: NativeProfileMemoryScene? { form as? NativeProfileMemoryScene }
    private var paymentsScene: NativeProfilePaymentsScene? { form as? NativeProfilePaymentsScene }
    private var pricingScene: NativeProfilePricingScene? {
        get { form as? NativeProfilePricingScene }
        set { form = newValue }
    }
    private var retiringForms = [ObjectIdentifier: NativeProfileOwnedForm]()
    private var formOwner: String?
    private var formRevision = 0
    private var workspace: NativeWorkspacePresentation?
    // Metadata tombstone only: retirement cannot be undone by a delayed apply.
    private var workspaceIdentity: NativeWorkspaceIdentity?
    private var workspaceRetiredReceipt: [String: Any]?
    private var retiringWorkspaces = [NativeWorkspaceIdentity: NativeWorkspacePresentation]()
    private var workspaceRetirementCallbacks = [NativeWorkspaceIdentity: [() -> Void]]()
    private var workspaceRetirementFence = NativeWorkspaceRetirementFence()
    private var sessionFence = NativeDrawerSessionFence()
    private var privacyObserver: NSObjectProtocol?
    private var retiredPrivacyGeneration: Int?
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
            HushhSessionPrivacyShield.shared.profilePresentationsConcealed = { [weak self] in
                guard let self else { return false }
                return self.walletCard.concealed && self.ownedChoices.concealed && self.form == nil && self.retiringForms.isEmpty && self.retiringControllers.isEmpty &&
                    self.workspace == nil && self.retiringWorkspaces.isEmpty &&
                    !self.controllers.values.contains { $0.coversUnderlyingPresentation }
            }
            self?.privacyObserver = NotificationCenter.default.addObserver(
                forName: HushhSessionPrivacyShield.presentationDidChange, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    let shield = HushhSessionPrivacyShield.shared
                    let privacy = shield.snapshot()
                    if privacy.shielded {
                        // A retirement completion/readiness publication is not
                        // a second inactive boundary. Keep this cycle's newly
                        // prepared hosts, but never carry old private replicas.
                        if self.retiredPrivacyGeneration != privacy.generation {
                            self.retiredPrivacyGeneration = privacy.generation
                            if self.controllers["profile"]?.coversUnderlyingPresentation == true || self.form != nil {
                                shield.requireProfilePreparation()
                            }
                            self.retireAll()
                        } else if !shield.coveredProfilePreparationIsAuthorized && privacy.preparationAuthorized {
                            self.retireAll() // Auth selected the committed safe/web gate.
                        }
                    } else {
                        for controller in self.controllers.values { controller.setPrivacyQuarantined(false) }
                        self.form?.refreshPrivacy()
                        self.reconcileIsolation()
                    }
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
    @objc func applyWalletCardScene(_ call: CAPPluginCall) { DispatchQueue.main.async { [weak self] in self?.walletCard.apply(call) } }
    @objc func confirmWalletCardAction(_ call: CAPPluginCall) { DispatchQueue.main.async { [weak self] in self?.walletCard.action(call, settlement: false) } }
    @objc func settleWalletCardAction(_ call: CAPPluginCall) { DispatchQueue.main.async { [weak self] in self?.walletCard.action(call, settlement: true) } }
    @objc func retireWalletCardScene(_ call: CAPPluginCall) { DispatchQueue.main.async { [weak self] in self?.walletCard.retire(call) } }
    @objc func getWalletCardState(_ call: CAPPluginCall) { DispatchQueue.main.async { [weak self] in self?.walletCard.read(call) } }
    @objc func prepareOwnedChoice(_ call: CAPPluginCall) { DispatchQueue.main.async { [weak self] in self?.ownedChoices.prepare(call) } }
    @objc func updateOwnedChoice(_ call: CAPPluginCall) { DispatchQueue.main.async { [weak self] in self?.ownedChoices.update(call) } }
    @objc func retireOwnedChoice(_ call: CAPPluginCall) { DispatchQueue.main.async { [weak self] in self?.ownedChoices.retire(call) } }
    @objc func getOwnedChoiceState(_ call: CAPPluginCall) { DispatchQueue.main.async { [weak self] in self?.ownedChoices.readState(call) } }

    @objc func getCapabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            call.resolve(["contractVersion": 1, "supported": self?.supported == true, "wholePresentation": self?.supported == true,
                "walletCardForms": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "ownedChoices": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "privateFeedback": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "historyActions": self?.supported == true,
                "profileMenuRows": self?.supported == true,
                "profilePortrait": self?.supported == true,
                "profileContentHandoff": self?.supported == true,
                "profileNavigationStack": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "compatibleBackRefreshes": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileTrustedDevices": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileSettingsPages": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileVoiceSettings": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileAccountActions": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileLegalReader": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileNameScene": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profilePreparation": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileReferralPages": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileStyleScene": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileSupportScene": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profilePhoneScene": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileVaultMethods": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profilePasswordScene": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profilePricingScene": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profilePayoutPages": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileMemoryPages": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileSharedMemoryPages": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileSecretMemoryPages": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileWorldModelPublicProfiles": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileWorldModelPages": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileRuntimeScene": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileConnectorScene": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileMemoryScene": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                // Qualification-only candidate. Ordinary builds keep the
                // established renderer through the single shell policy.
                "profileConnectorPages": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileHostingPages": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profilePaymentsPages": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profilePaymentsScene": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileSoftwareUpdatePages": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "profileFinancePreferences": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "routeWorkspaces": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone ? ["referrals", "wallet"] : [],
                "agentProfileMenu": self?.supported == true,
                "terminalRefreshes": self?.supported == true,
                "closeSettlements": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell && UIDevice.current.userInterfaceIdiom == .phone,
                "terminalReadmission": self?.supported == true,
                "presentationCompletion": self?.supported == true,
                "coherentShell": self?.supported == true && NativeDrawerQualificationPolicy.coherentShell,
                "generation": self?.container?.isolationGeneration ?? 0, "isolated": self?.container?.interactionIsolated == true])
        }
    }
    @MainActor private func profilePreparationIsReady(_ target: NativeProfilePreparationTarget) -> Bool {
        guard supported, sessionFence.contains(target.identity), retiringControllers.isEmpty,
              retiringForms.isEmpty, workspace == nil, retiringWorkspaces.isEmpty,
              let controller = controllers["profile"], target.matches(controller.model.projection),
              controller.presentationLayoutSettled, controller.view.window === bridge?.viewController?.view.window,
              controller.view.frame == container?.bounds, controller.view.bounds.size == container?.bounds.size,
              container?.preparationBaseIsConcealed == true,
              !controllers.contains(where: { $0.key != "profile" && $0.value.coversUnderlyingPresentation }) else { return false }
        if let scene = target.formScene {
            guard let form, form.sceneName == scene, form.presentationSettled else { return false }
            let receipt = form.receipt("active")
            return target.matchesForm(form.identity, scene: scene, destination: receipt["destinationId"] as? String,
                privacy: receipt["privacyGeneration"] as? Int ?? -1)
        }
        return form == nil
    }
    @objc func applyFeedback(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.supported, NativeDrawerQualificationPolicy.coherentShell,
                  UIDevice.current.userInterfaceIdiom == .phone,
                  let options = call.options as? [String: Any], Set(options.keys) == NativeFeedbackProjection.keys,
                  JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options),
                  bytes.count <= 12000, let state = try? JSONDecoder().decode(NativeFeedbackProjection.self, from: bytes), state.valid else {
                call.reject("NATIVE_FEEDBACK_INVALID"); return
            }
            let shield = HushhSessionPrivacyShield.shared
            let privacy = shield.snapshot()
            guard privacy.appIsActive, !privacy.shielded, privacy.generation == state.privacyGeneration,
                  shield.acceptsDocument(state.documentId), self.sessionFence.contains(state.identity),
                  self.leases[state.family]?.identity == state.identity,
                  let controller = self.controllers[state.family], state.belongs(to: controller.model.projection),
                  self.retiringControllers.isEmpty, self.retiringForms.isEmpty else {
                call.resolve(["applied": false]); return
            }
            let parent: UIViewController?
            if let form = self.form {
                parent = form.identity.documentId == state.documentId && form.identity.ownerEpoch == state.ownerEpoch &&
                    form.identity.ownerGeneration == state.ownerGeneration && form.identity.family == state.family && form.identity.revision == state.formRevision &&
                    form.sceneName == state.formScene ? form.feedbackPresenter : nil
            } else {
                parent = state.formScene == nil && controller.presentationLayoutSettled &&
                    controller.model.interactionEnabled ? controller.host : nil
            }
            guard let parent, parent.view.window === self.bridge?.viewController?.view.window,
                  parent.presentedViewController == nil else { call.resolve(["applied": false]); return }
            call.resolve(["applied": self.feedback.apply(state, to: parent)])
        }
    }
    @objc func retireFeedback(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let options = call.options as? [String: Any],
                  Set(options.keys) == NativeFeedbackProjection.keys.subtracting(["message", "tone", "duration", "dismissible"]),
                  JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options),
                  bytes.count <= 12000,
                  let identity = try? JSONDecoder().decode(NativeDrawerIdentity.self, from: bytes), identity.valid,
                  let id = options["feedbackId"] as? String, NativeDrawerIdentity.identifier(id) else {
                call.reject("NATIVE_FEEDBACK_INVALID"); return
            }
            // IDs are opaque and owner-bound. Cleanup never authorizes an action.
            guard self.sessionFence.contains(identity) else { call.resolve(["retired": false]); return }
            guard let sequence = options["feedbackSequence"] as? Int, let revision = options["feedbackRevision"] as? Int,
                  sequence > 0, revision >= 0, sequence <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
                  revision <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { call.reject("NATIVE_FEEDBACK_INVALID"); return }
            self.feedback.retire(id: id, sequence: sequence, revision: revision, owner: identity, context: options)
            call.resolve(["retired": true])
        }
    }
    @objc func apply(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.supported, let parent = self.bridge?.viewController, let container = self.container else {
                call.reject("NATIVE_DRAWER_UNSUPPORTED"); return
            }
            guard self.retiringControllers.isEmpty, self.retiringWorkspaces.isEmpty else { call.reject("NATIVE_DRAWER_RETIRING"); return }
            // Decode a closed shape without persisting/logging raw options.
            guard let options = call.options as? [String: Any], NativeDrawerProjection.hasClosedShape(options), JSONSerialization.isValidJSONObject(options),
                  let bytes = try? JSONSerialization.data(withJSONObject: options), bytes.count <= 2_200_000,
                  let next = try? JSONDecoder().decode(NativeDrawerProjection.self, from: bytes), next.valid else {
                call.reject("NATIVE_DRAWER_INVALID_STATE"); return
            }
            let shield = HushhSessionPrivacyShield.shared
            let privacy = shield.snapshot()
            shield.observeDocument(next.documentId)
            let preparationTarget = next.profilePreparation.map { description in
                NativeProfilePreparationTarget(documentId: next.documentId, ownerEpoch: next.ownerEpoch,
                    ownerGeneration: next.ownerGeneration, revision: next.revision, updateSequence: next.updateSequence,
                    privacyGeneration: next.privacyGeneration, visitId: description.visitId,
                    destinationId: next.profileDestinationId, supportDestinationId: next.profileSupportDestinationId,
                    formScene: description.formScene)
            }
            guard privacy.appIsActive, (!privacy.shielded || preparationTarget.map(shield.canBeginProfilePreparation) == true), next.privacyGeneration == privacy.generation,
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
            if let previous = self.controllers[next.family], previous.model.projection.identity != next.identity {
                self.detach(next.family)
                guard self.retiringControllers.isEmpty else { call.reject("NATIVE_DRAWER_RETIRING"); return }
            }
            // Commit a ticket only after the candidate session, ordering,
            // overlap and retirement checks pass. A rejected Apply cannot
            // replace a live readiness target or cancel its release.
            if privacy.shielded, let target = preparationTarget {
                guard shield.beginProfilePreparation(target, ready: { [weak self] in self?.profilePreparationIsReady(target) == true }) != nil
                else { call.reject("NATIVE_PROFILE_PREPARATION_REFUSED"); return }
            }
            self.leases[next.family] = lease
            if let previous = self.controllers[next.family] {
                self.feedback.retainOnly(next)
                if next.family == "profile", (previous.model.projection.profileDestinationId != next.profileDestinationId ||
                    previous.model.projection.profileSupportDestinationId != next.profileSupportDestinationId),
                   self.form != nil { self.retireProfileForm() }
                previous.setPrivacyQuarantined(privacy.shielded)
                previous.update(next)
            }
            else {
                let controller = NativeDrawerPresentationController(next)
                controller.setPrivacyQuarantined(privacy.shielded)
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
                controller.requestRecovery = { [weak self, weak controller] in
                    guard let self, let controller, self.controllers[next.family] === controller else { return }
                    let state = controller.model.projection
                    let shield = HushhSessionPrivacyShield.shared
                    let privacy = shield.snapshot()
                    guard self.supported, self.sessionFence.contains(state.identity), shield.acceptsDocument(state.documentId),
                          privacy.appIsActive, !privacy.shielded, privacy.generation == state.privacyGeneration else { return }
                    shield.protectForPresentationRecovery()
                }
                self.controllers[next.family] = controller
                controller.presentationDidSettle = { [weak self, weak controller] state in
                    guard let self, let controller, self.controllers[state.family] === controller,
                          self.sessionFence.contains(state.identity) else { return }
                    let privacy = HushhSessionPrivacyShield.shared.snapshot()
                    guard privacy.appIsActive, (!privacy.shielded || HushhSessionPrivacyShield.shared.acceptsPreparedDrawer(state)), privacy.generation == state.privacyGeneration else { return }
                    var event = self.receipt(state, phase: "active")
                    event["settled"] = true
                    self.notifyListeners("presentationSettled", data: event, retainUntilConsumed: false)
                    HushhSessionPrivacyShield.shared.profilePreparationDidChange()
                }
                controller.activateInitialPresentation()
            }
            call.resolve(self.receipt(next, phase: "active"))
        }
    }
    @objc func getPresentationState(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.supported, let identity = self.identity(call),
                  self.sessionFence.contains(identity) else { call.resolve(["valid": false]); return }
            if let lease = self.leases[identity.family], lease.retiredIdentity == identity,
               !self.retiringControllers.values.contains(where: { $0.model.projection.identity == identity }),
               self.controllers[identity.family]?.model.projection.identity != identity,
               identity.family != "profile" || self.form == nil && self.retiringForms.isEmpty {
                // Readback proves actual disappearance, not just that retire
                // was requested. It cannot replay a choice or dismiss a new owner.
                var result = self.retiredReceipt(identity, lease: lease)
                result["valid"] = true; result["settled"] = true
                call.resolve(result); return
            }
            guard let controller = self.controllers[identity.family],
                  controller.model.projection.identity == identity else { call.resolve(["valid": false]); return }
            let state = controller.model.projection
            let privacy = HushhSessionPrivacyShield.shared.snapshot()
            guard privacy.appIsActive, (!privacy.shielded || HushhSessionPrivacyShield.shared.acceptsPreparedDrawer(state)), privacy.generation == state.privacyGeneration else {
                call.resolve(["valid": false]); return
            }
            var result = self.receipt(state, phase: "active")
            result["valid"] = true
            result["settled"] = privacy.shielded ? controller.presentationLayoutSettled : controller.presentationSettled
            call.resolve(result)
        }
    }
    @MainActor private func emit(_ family: String, action: String, row: String?, text: String?) -> Bool {
        guard form == nil, retiringForms.isEmpty, let controller = controllers[family], var lease = leases[family],
              controller.allowsInteraction(action, row: row, text: text) else { return false }
        let state = controller.model.projection
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        guard sessionFence.contains(state.identity), privacy.appIsActive, !privacy.shielded, state.privacyGeneration == privacy.generation,
              let sequence = lease.emit(action: action, row: row, state: state, text: text) else { return false }
        leases[family] = lease
        if action == "close" { controller.recordCloseIntent(sequence: sequence) }
        #if DEBUG
        if action == "close" { controller.observeClose(sequence: sequence) }
        #endif
        if action == "row" || action == "back" || action == "root" || action == "ancestor" { controller.model.pendingSequence = sequence }
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
            let allowed = self.supported && self.form == nil && self.retiringForms.isEmpty && self.sessionFence.contains(identity) && privacy.appIsActive && !privacy.shielded &&
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
    /// Acknowledged utility effect after React's current authored Copy choice.
    /// Confirmation itself remains side-effect free; uncertainty never retries.
    @objc func copyProfileReferralLink(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "updateSequence",
                "privacyGeneration", "sequence", "interactionGeneration", "action", "rowId", "link"]
            guard let self, self.supported, Set(call.options.keys).isSubset(of: keys),
                  let identity = self.identity(call), identity.family == "profile", self.sessionFence.contains(identity),
                  let controller = self.controllers["profile"], var lease = self.leases["profile"],
                  call.getString("action") == "row", call.getString("rowId") == "referral-copy",
                  let link = call.getString("link"), link.utf16.count <= 4096,
                  let url = URL(string: link), url.scheme == "https", url.host != nil,
                  let update = call.getInt("updateSequence"), let privacy = call.getInt("privacyGeneration"),
                  let sequence = call.getInt("sequence"), let interaction = call.getInt("interactionGeneration") else {
                call.resolve(["copied": false]); return
            }
            let shield = HushhSessionPrivacyShield.shared
            let current = shield.snapshot()
            let projection = controller.model.projection
            guard current.appIsActive, !current.shielded, current.generation == privacy,
                  shield.acceptsDocument(identity.documentId), projection.open, projection.enabled,
                  projection.profileStack?.last?.id == "referrals",
                  projection.activeSections.first(where: { $0.id == "referral-link" })?.rows.first(where: { $0.id == "referral-link-value" })?.detail == link,
                  lease.consumeConfirmedRowEffect(identity: identity, update: update, privacy: privacy,
                    sequence: sequence, interaction: interaction, row: "referral-copy") else {
                call.resolve(["copied": false]); return
            }
            self.leases["profile"] = lease
            UIPasteboard.general.string = link
            UIAccessibility.post(notification: .announcement, argument: "Link copied")
            call.resolve(["copied": true])
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
            let closing = lease.isCloseSettlement(sequence: sequence)
            guard privacy.appIsActive, !privacy.shielded, self.sessionFence.contains(identity),
                  privacy.generation == call.getInt("privacyGeneration"),
                  lease.settle(identity: identity, privacy: privacy.generation, sequence: sequence, success: success) else {
                call.resolve(["valid": false]); return
            }
            self.leases[identity.family] = lease
            // A late completion cannot clear a reopened editor or a newer choice.
            if closing { controller.settleClose(sequence: sequence, success: success) }
            else { controller.model.settle(sequence: sequence, success: success) }
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
        feedback.retireFamily(family)
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
        if family == "profile" { retireProfileForm(completion: completion) }
        else { completion() }
    }
    @MainActor private func retireAll() {
        walletCard.retire()
        ownedChoices.retire()
        feedback.clear()
        retireWorkspacePresentation()
        retireProfileForm()
        for family in Array(controllers.keys) {
            if let identity = leases[family]?.identity { _ = leases[family]?.retire(identity) }
            detach(family)
        }
    }

    @MainActor private func reconcileIsolation() {
        let formCovered = walletCard.coversPresentation || ownedChoices.coversPresentation || form?.coversPresentation == true || !retiringForms.isEmpty
        for controller in controllers.values { controller.setFormCoverage(formCovered) }
        let covered = walletCard.coversPresentation || ownedChoices.coversPresentation || controllers.values.contains { $0.coversUnderlyingPresentation } ||
            retiringControllers.values.contains { $0.coversUnderlyingPresentation } ||
            form?.coversPresentation == true || retiringForms.values.contains { $0.coversPresentation }
        workspace?.setExternalCoverage(covered)
        let workspaceCovered = workspace?.coversPresentation == true || retiringWorkspaces.values.contains { $0.coversPresentation }
        container?.isolateForOwnedDrawer(covered || workspaceCovered)
        workspace?.refresh()
        HushhSessionPrivacyShield.shared.profilePreparationDidChange()
    }

    @MainActor private func retireWorkspacePresentation() {
        guard let workspace else { return }
        let state = workspace.model.state
        let identity = state.identity
        workspaceRetirementFence.retire(identity)
        workspaceRetiredReceipt = state.receipt("retired", settled: false)
        retiringWorkspaces[identity] = workspace
        self.workspace = nil
        let shield = HushhSessionPrivacyShield.shared
        let privacyRetirement = shield.beginPresentationRetirement()
        workspace.retire { [weak self] in
            shield.completePresentationRetirement(privacyRetirement)
            guard let self else { return }
            self.retiringWorkspaces.removeValue(forKey: identity)
            if self.workspaceIdentity == identity { self.workspaceRetiredReceipt = state.receipt("retired", settled: true) }
            let callbacks = self.workspaceRetirementCallbacks.removeValue(forKey: identity) ?? []
            callbacks.forEach { $0() }
        }
    }
    // Public admission stages contain no scene fields or owner identifiers.
    @MainActor static var workspaceAdmissionStage = 0
    @objc func applyWorkspace(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            Self.workspaceAdmissionStage = 1
            guard let self, self.supported, NativeDrawerQualificationPolicy.coherentShell, UIDevice.current.userInterfaceIdiom == .phone,
                  let parent = self.bridge?.viewController, let container = self.container else { call.reject("NATIVE_WORKSPACE_INVALID"); return }
            Self.workspaceAdmissionStage = 2
            guard let options = call.options as? [String: Any], NativeWorkspaceProjection.closed(options) else { call.reject("NATIVE_WORKSPACE_INVALID"); return }
            Self.workspaceAdmissionStage = 21
            guard JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options) else { call.reject("NATIVE_WORKSPACE_INVALID"); return }
            Self.workspaceAdmissionStage = 22
            guard bytes.count <= 1_000_000 else { call.reject("NATIVE_WORKSPACE_INVALID"); return }
            Self.workspaceAdmissionStage = 3
            guard let next = try? JSONDecoder().decode(NativeWorkspaceProjection.self, from: bytes), next.valid else { call.reject("NATIVE_WORKSPACE_INVALID"); return }
            Self.workspaceAdmissionStage = 4
            let privacy = HushhSessionPrivacyShield.shared.snapshot()
            guard privacy.appIsActive, !privacy.shielded, privacy.generation == next.privacyGeneration,
                  HushhSessionPrivacyShield.shared.acceptsDocument(next.documentId),
                  abs(container.bounds.width - next.frame.viewportWidth) <= 1, abs(container.bounds.height - next.frame.viewportHeight) <= 1 else { call.reject("NATIVE_WORKSPACE_UNAVAILABLE"); return }
            Self.workspaceAdmissionStage = 5
            var session = self.sessionFence
            guard session.admitOwner(documentId: next.documentId, ownerEpoch: next.ownerEpoch, ownerGeneration: next.ownerGeneration),
                  !self.workspaceRetirementFence.retired(next.identity) else { call.reject("NATIVE_WORKSPACE_STALE_OWNER"); return }
            if !self.sessionFence.containsOwner(documentId: next.documentId, ownerEpoch: next.ownerEpoch, ownerGeneration: next.ownerGeneration) {
                self.retireAll(); self.leases.removeAll(); self.sessionFence = session
            }
            guard self.retiringControllers.isEmpty, self.retiringWorkspaces.isEmpty else { call.reject("NATIVE_WORKSPACE_RETIRING"); return }
            if let old = self.workspaceIdentity, old != next.identity {
                let sameOwner = old.documentId == next.documentId && old.ownerEpoch == next.ownerEpoch && old.ownerGeneration == next.ownerGeneration
                guard old.documentId != next.documentId || sameOwner && next.revision > old.revision || next.ownerGeneration > old.ownerGeneration else { call.reject("NATIVE_WORKSPACE_STALE"); return }
                self.retireWorkspacePresentation()
                guard self.retiringWorkspaces.isEmpty else { call.reject("NATIVE_WORKSPACE_RETIRING"); return }
            }
            if let presentation = self.workspace {
                guard presentation.model.update(next) else { call.reject("NATIVE_WORKSPACE_STALE"); return }
                presentation.refresh()
            } else {
                guard self.workspaceIdentity != next.identity, let presentation = NativeWorkspacePresentation(next, parent: parent, container: container) else { call.reject("NATIVE_WORKSPACE_RETIRED"); return }
                self.workspaceIdentity = next.identity; self.workspaceRetiredReceipt = nil; self.workspace = presentation
                presentation.coverage = { [weak self] in self?.reconcileIsolation() }
                presentation.model.emit = { [weak self] event in self?.notifyListeners("workspaceChoice", data: event, retainUntilConsumed: false) }
                presentation.model.emitEdit = { [weak self] name, event in self?.notifyListeners(name, data: event, retainUntilConsumed: false) }
            }
            Self.workspaceAdmissionStage = 6
            // Decoding isn't completed presentation. Transfer body coverage
            // only after retained containment and the native layout pass.
            self.workspace?.prepare { [weak self] settled in
                guard settled, let current = self?.workspace, current.model.state.identity == next.identity,
                      current.model.state.updateSequence == next.updateSequence, current.ready else { call.reject("NATIVE_WORKSPACE_NOT_READY"); return }
                Self.workspaceAdmissionStage = 7
                call.resolve(next.receipt("active", settled: true))
            }
        }
    }
    @MainActor private func decodeWorkspaceIdentity(_ call: CAPPluginCall) -> NativeWorkspaceIdentity? {
        guard let document = call.getString("documentId"), let owner = call.getString("ownerEpoch"), let generation = call.getInt("ownerGeneration"),
              let revision = call.getInt("revision"), let family = call.getString("workspace") else { return nil }
        let identity = NativeWorkspaceIdentity(documentId: document, ownerEpoch: owner, ownerGeneration: generation, revision: revision, workspace: family)
        return identity.valid ? identity : nil
    }
    @objc func getWorkspaceState(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.decodeWorkspaceIdentity(call) else { call.resolve(["valid": false]); return }
            if let workspace = self.workspace, workspace.model.state.identity == identity { call.resolve(workspace.model.state.receipt("active", settled: workspace.ready)) }
            else if identity == self.workspaceIdentity, let receipt = self.workspaceRetiredReceipt { call.resolve(receipt) }
            else if self.workspaceRetirementFence.retired(identity) { call.resolve(self.workspaceAbsence(identity)) }
            else { call.resolve(["valid": false]) }
        }
    }
    @objc func retireWorkspace(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, Set(call.options.keys) == ["documentId", "ownerEpoch", "ownerGeneration", "revision", "workspace"], let identity = self.decodeWorkspaceIdentity(call),
                  HushhSessionPrivacyShield.shared.acceptsDocument(identity.documentId) else { call.reject("NATIVE_WORKSPACE_STALE"); return }
            // Cancellation is a tombstone even when it arrives before apply.
            self.workspaceRetirementFence.retire(identity)
            if self.workspace?.model.state.identity == identity { self.retireWorkspacePresentation() }
            let finish = { [weak self] in guard let self else { return }; call.resolve(self.workspaceAbsence(identity)) }
            if self.retiringWorkspaces[identity] != nil { self.workspaceRetirementCallbacks[identity, default: []].append(finish) }
            else { finish() }
        }
    }
    @MainActor private func workspaceAbsence(_ identity: NativeWorkspaceIdentity) -> [String: Any] {
        identity.event.merging(["phase": "retired", "settled": retiringWorkspaces[identity] == nil, "updateSequence": 0,
            "privacyGeneration": HushhSessionPrivacyShield.shared.snapshot().generation, "layoutRevision": 0]) { _, new in new }
    }
    @objc func confirmWorkspaceChoice(_ call: CAPPluginCall) { resolveWorkspaceChoice(call, confirm: true) }
    @objc func settleWorkspaceChoice(_ call: CAPPluginCall) { resolveWorkspaceChoice(call, confirm: false) }
    private func resolveWorkspaceChoice(_ call: CAPPluginCall, confirm: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard Set(call.options.keys).isSubset(of: ["documentId", "ownerEpoch", "ownerGeneration", "revision", "workspace", "privacyGeneration", "updateSequence", "sequence", "action", "rowId", "text", "editRevision", "domain", "detailVisitId", "dismissed"]),
                  let self, let presentation = self.workspace, let identity = self.decodeWorkspaceIdentity(call), identity == presentation.model.state.identity,
                  call.getInt("privacyGeneration") == presentation.model.state.privacyGeneration,
                  let sequence = call.getInt("sequence"), let update = call.getInt("updateSequence"), let action = call.getString("action"), sequence > 0 else { call.resolve(["valid": false]); return }
            let choice = NativeWorkspaceAction(sequence: sequence, updateSequence: update, action: action, row: call.getString("rowId"), text: call.getString("text"), editRevision: call.getInt("editRevision"), domain: call.getString("domain"), detailVisitId: call.getString("detailVisitId"), dismissed: call.getBool("dismissed"))
            let valid = confirm ? presentation.model.confirm(choice) : presentation.model.settle(choice)
            if !confirm { self.reconcileIsolation() }
            call.resolve(["valid": valid])
        }
    }
    @MainActor private var profileParentPresentationIsReady: Bool {
        HushhSessionPrivacyShield.shared.snapshot().shielded ? controllers["profile"]?.presentationLayoutSettled == true :
            controllers["profile"]?.presentationSettled == true
    }
    @MainActor private func profileFormPresentationIsCurrent(_ identity: NativeDrawerIdentity, privacy: Int, scene: String = "account-name", destinationId: String? = nil) -> Bool {
        profileFormOwnerIsCurrent(identity, privacy: privacy, scene: scene, destinationId: destinationId, preparing: true)
    }
    @MainActor private func profileFormOwnerIsCurrent(_ identity: NativeDrawerIdentity, privacy: Int, scene: String = "account-name", destinationId: String? = nil, preparing: Bool = false) -> Bool {
        let shield = HushhSessionPrivacyShield.shared
        let state = shield.snapshot()
        guard supported, NativeDrawerQualificationPolicy.coherentShell, UIDevice.current.userInterfaceIdiom == .phone,
              sessionFence.contains(identity), state.appIsActive,
              (!state.shielded || preparing && shield.acceptsPreparedForm(identity, scene: scene, destination: destinationId, privacy: privacy)), state.generation == privacy,
              shield.acceptsDocument(identity.documentId), let profile = controllers["profile"]?.model.projection else { return false }
        let nativeAccount = ["account-name", "phone"].contains(scene) && profile.open && profile.profileStack?.last?.id == "account" &&
            destinationId != nil && destinationId == profile.profileDestinationId
        let nativeReferral = scene == "referral-handle" && profile.open && profile.profileStack?.last?.id == "referrals" &&
            destinationId != nil && destinationId == profile.profileDestinationId
        let nativePreferences = scene == "writing-style" && profile.open && profile.profileStack?.last?.id == "preferences" &&
            destinationId != nil && destinationId == profile.profileDestinationId
        let nativeSupport = scene == "support" && profile.open && profile.profileStack?.isEmpty == true &&
            destinationId != nil && destinationId == profile.profileSupportDestinationId
        let nativeVault = scene == "vault-passphrase" && profile.open && profile.profileStack?.last?.id == "vault" &&
            destinationId != nil && destinationId == profile.profileDestinationId
        let nativePricing = scene == "request-price" && profile.open && profile.profileStack?.last?.id == "request-pricing" &&
            destinationId != nil && destinationId == profile.profileDestinationId
        let worldModelDestinations: [String: Set<String>] = ["world-model-fact-edit": ["world-model-fact", "world-model-review-fact"], "world-model-sources": ["world-model-sources"], "world-model-public-profiles": ["world-model-sources"], "world-model-invitation": ["world-model-invitations"]]
        let nativeWorldModel = worldModelDestinations[scene]?.contains(profile.profileStack?.last?.id ?? "") == true && profile.open &&
            destinationId != nil && destinationId == profile.profileDestinationId
        let nativeRuntime = scene == "runtime-provider" && profile.open && profile.profileStack?.last?.id == "gemini" &&
            destinationId != nil && destinationId == profile.profileDestinationId
        let connectorDestinations = ["connector-custom-server": "connector-custom", "connector-profile-link": "connector-detail", "connector-packet-price": "connector-packet"]
        let nativeMemory = scene == "memory-financial-context" && profile.open && profile.profileStack?.last?.id == "memory-domain" &&
            destinationId != nil && destinationId == profile.profileDestinationId
        let nativePayments = ["payment-funding": "commerce-funding", "payment-country": "commerce-payouts"][scene] == profile.profileStack?.last?.id &&
            ["payment-funding", "payment-country"].contains(scene) && profile.open && destinationId != nil && destinationId == profile.profileDestinationId
        let nativeConnector = connectorDestinations[scene] == profile.profileStack?.last?.id && connectorDestinations[scene] != nil && profile.open &&
            destinationId != nil && destinationId == profile.profileDestinationId
        return profile.documentId == identity.documentId && profile.ownerEpoch == identity.ownerEpoch &&
            profile.ownerGeneration == identity.ownerGeneration && profile.surfaceOpen == true &&
            (!profile.open && destinationId == nil && scene == "account-name" || nativeAccount || nativeReferral || nativePreferences || nativeSupport || nativeVault || nativePricing || nativeWorldModel || nativeRuntime || nativeConnector || nativeMemory || nativePayments) && profile.enabled
    }
    @objc func applyProfileRuntimeScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let parent = self.bridge?.viewController,
                  let options = call.options as? [String: Any], Set(options.keys).isSubset(of: NativeRuntimeProjection.keys),
                  let draft = options["draft"] as? [String: Any], Set(draft.keys) == NativeRuntimeProjection.draftKeys,
                  JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options), bytes.count <= 65_536,
                  let next = try? JSONDecoder().decode(NativeRuntimeProjection.self, from: bytes), next.valid,
                  self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: next.scene, destinationId: next.destinationId),
                  self.retiringForms.isEmpty else { call.reject("NATIVE_PROFILE_RUNTIME_UNAVAILABLE"); return }
            if let scene = self.runtimeScene {
                guard scene.identity == next.identity, scene.update(next) else { call.reject("NATIVE_PROFILE_RUNTIME_STALE_STATE"); return }
                call.resolve(next.receipt("active")); return
            }
            guard self.form == nil, self.profileParentPresentationIsReady else { call.reject("NATIVE_PROFILE_PRESENTATION_PENDING"); return }
            let owner = self.profileFormOwnerKey(next.identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            guard next.revision > self.formRevision, next.acknowledgedEditRevision == 0 else { call.reject("NATIVE_PROFILE_RUNTIME_RETIRED"); return }
            let scene = NativeProfileRuntimeScene(next); self.form = scene; self.formRevision = next.revision
            scene.coverage = { [weak self] in self?.reconcileIsolation() }
            scene.model.finalEdit = { [weak self, weak scene] draft, revision in
                guard let self, let scene, self.sessionFence.contains(scene.identity),
                      self.runtimeScene === scene || self.retiringForms[ObjectIdentifier(scene)] === scene else { return }
                let state = scene.model.projection
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["draft"] = draft.event; event["composing"] = false; event["editRevision"] = revision
                event["baseDraftRevision"] = state.draftRevision; event["acknowledgedEditRevision"] = state.acknowledgedEditRevision
                self.notifyListeners("profileRuntimeFinalEdit", data: event, retainUntilConsumed: false)
            }
            scene.model.edit = { [weak self, weak scene] draft, composing, revision in
                guard let self, let scene, self.runtimeScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: state.scene, destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["draft"] = draft.event; event["composing"] = composing; event["editRevision"] = revision
                self.notifyListeners("profileRuntimeEdit", data: event, retainUntilConsumed: false); return true
            }
            scene.model.choose = { [weak self, weak scene] action in
                guard let self, let scene, self.runtimeScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: state.scene, destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["sequence"] = action.sequence; event["action"] = action.action; event["editRevision"] = action.editRevision
                self.notifyListeners("profileRuntimeAction", data: event, retainUntilConsumed: false); return true
            }
            guard scene.present(from: parent, completion: { [weak self, weak scene] presented in
                guard let self, let scene else { call.reject("NATIVE_PROFILE_RUNTIME_RETIRED"); return }
                guard presented, self.runtimeScene === scene,
                      self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: next.scene, destinationId: next.destinationId) else {
                    if self.runtimeScene === scene { self.retireProfileForm() }; call.reject("NATIVE_PROFILE_RUNTIME_RETIRED"); return
                }
                call.resolve(next.receipt("active"))
            }) else { self.retireProfileForm(); call.reject("NATIVE_PROFILE_RUNTIME_PRESENTATION_REFUSED"); return }
        }
    }
    @objc func confirmProfileRuntimeAction(_ call: CAPPluginCall) { runtimeAction(call, settlement: false) }
    @objc func settleProfileRuntimeAction(_ call: CAPPluginCall) { runtimeAction(call, settlement: true) }
    private func runtimeAction(_ call: CAPPluginCall, settlement: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: "runtime-provider", destinationId: call.getString("destinationId")),
                  let scene = self.runtimeScene, scene.identity == identity, scene.model.projection.destinationId == call.getString("destinationId"),
                  let action = self.nameAction(call, scene: "runtime-provider") else { call.resolve(["valid": false]); return }
            call.resolve(["valid": settlement ? scene.settle(action) : scene.model.confirm(action)])
        }
    }
    @objc func retireProfileRuntimeScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, Set(call.options.keys).isSubset(of: ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"]),
                  let identity = self.identity(call), identity.family == "profile", call.getString("scene") == "runtime-provider",
                  let destination = call.getString("destinationId"), NativeDrawerIdentity.identifier(destination) else { call.reject("NATIVE_PROFILE_RUNTIME_STALE_RETIREMENT"); return }
            if let scene = self.retiringForms.values.first(where: { $0.identity == identity && $0.sceneName == "runtime-provider" && $0.receipt("retired")["destinationId"] as? String == destination }) {
                scene.retire { call.resolve(scene.receipt("retired")) }; return
            }
            if let scene = self.runtimeScene {
                guard scene.identity == identity, scene.model.projection.destinationId == destination else { call.reject("NATIVE_PROFILE_RUNTIME_STALE_RETIREMENT"); return }
                self.retireProfileForm { call.resolve(scene.receipt("retired")) }; return
            }
            guard self.sessionFence.contains(identity) else { call.reject("NATIVE_PROFILE_RUNTIME_STALE_RETIREMENT"); return }
            // Main-actor admission creates the form before presentation starts.
            // With neither an active nor retiring instance there is nothing to
            // withdraw; an unadmitted revision cannot poison other form leases.
            var receipt = self.retiredReceipt(identity, lease: NativeDrawerLease()); receipt["scene"] = "runtime-provider"; receipt["destinationId"] = destination
            call.resolve(receipt)
        }
    }
    @objc func applyProfileConnectorScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let parent = self.bridge?.viewController,
                  let options = call.options as? [String: Any], Set(options.keys).isSubset(of: NativeConnectorProjection.keys),
                  let sceneName = call.getString("scene"), !NativeConnectorProjection.draftKeys(sceneName).isEmpty,
                  let draft = options["draft"] as? [String: Any], Set(draft.keys) == NativeConnectorProjection.draftKeys(sceneName),
                  JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options), bytes.count <= 65_536,
                  let next = try? JSONDecoder().decode(NativeConnectorProjection.self, from: bytes), next.valid,
                  self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: next.scene, destinationId: next.destinationId),
                  self.retiringForms.isEmpty else { call.reject("NATIVE_PROFILE_CONNECTOR_UNAVAILABLE"); return }
            if let scene = self.connectorScene {
                guard scene.identity == next.identity, scene.update(next) else { call.reject("NATIVE_PROFILE_CONNECTOR_STALE_STATE"); return }
                call.resolve(next.receipt("active")); return
            }
            guard self.form == nil, self.profileParentPresentationIsReady else { call.reject("NATIVE_PROFILE_PRESENTATION_PENDING"); return }
            let owner = self.profileFormOwnerKey(next.identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            guard next.revision > self.formRevision, next.acknowledgedEditRevision == 0 else { call.reject("NATIVE_PROFILE_CONNECTOR_RETIRED"); return }
            let scene = NativeProfileConnectorScene(next); self.form = scene; self.formRevision = next.revision
            scene.coverage = { [weak self] in self?.reconcileIsolation() }
            scene.model.finalEdit = { [weak self, weak scene] draft, revision in
                guard let self, let scene, self.sessionFence.contains(scene.identity),
                      self.connectorScene === scene || self.retiringForms[ObjectIdentifier(scene)] === scene else { return }
                let state = scene.model.projection
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["draft"] = draft.event; event["composing"] = false; event["editRevision"] = revision
                event["baseDraftRevision"] = state.draftRevision; event["acknowledgedEditRevision"] = state.acknowledgedEditRevision
                self.notifyListeners("profileConnectorFinalEdit", data: event, retainUntilConsumed: false)
            }
            scene.model.edit = { [weak self, weak scene] draft, composing, revision in
                guard let self, let scene, self.connectorScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: state.scene, destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["draft"] = draft.event; event["composing"] = composing; event["editRevision"] = revision
                self.notifyListeners("profileConnectorEdit", data: event, retainUntilConsumed: false); return true
            }
            scene.model.choose = { [weak self, weak scene] action in
                guard let self, let scene, self.connectorScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: state.scene, destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["sequence"] = action.sequence; event["action"] = action.action; event["editRevision"] = action.editRevision
                self.notifyListeners("profileConnectorAction", data: event, retainUntilConsumed: false); return true
            }
            guard scene.present(from: parent, completion: { [weak self, weak scene] presented in
                guard let self, let scene else { call.reject("NATIVE_PROFILE_CONNECTOR_RETIRED"); return }
                guard presented, self.connectorScene === scene,
                      self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: next.scene, destinationId: next.destinationId) else {
                    if self.connectorScene === scene { self.retireProfileForm() }; call.reject("NATIVE_PROFILE_CONNECTOR_RETIRED"); return
                }
                call.resolve(next.receipt("active"))
            }) else { self.retireProfileForm(); call.reject("NATIVE_PROFILE_CONNECTOR_PRESENTATION_REFUSED"); return }
        }
    }
    @objc func confirmProfileConnectorAction(_ call: CAPPluginCall) { connectorAction(call, settlement: false) }
    @objc func settleProfileConnectorAction(_ call: CAPPluginCall) { connectorAction(call, settlement: true) }
    private func connectorAction(_ call: CAPPluginCall, settlement: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  let sceneName = call.getString("scene"), !NativeConnectorProjection.draftKeys(sceneName).isEmpty,
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: sceneName, destinationId: call.getString("destinationId")),
                  let scene = self.connectorScene, scene.identity == identity, scene.sceneName == sceneName, scene.model.projection.destinationId == call.getString("destinationId"),
                  let action = self.nameAction(call, scene: sceneName) else { call.resolve(["valid": false]); return }
            call.resolve(["valid": settlement ? scene.settle(action) : scene.model.confirm(action)])
        }
    }
    @objc func retireProfileConnectorScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, Set(call.options.keys).isSubset(of: ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"]),
                  let identity = self.identity(call), identity.family == "profile", let sceneName = call.getString("scene"), !NativeConnectorProjection.draftKeys(sceneName).isEmpty,
                  let destination = call.getString("destinationId"), NativeDrawerIdentity.identifier(destination) else { call.reject("NATIVE_PROFILE_CONNECTOR_STALE_RETIREMENT"); return }
            if let scene = self.retiringForms.values.first(where: { $0.identity == identity && $0.sceneName == sceneName && $0.receipt("retired")["destinationId"] as? String == destination }) {
                scene.retire { call.resolve(scene.receipt("retired")) }; return
            }
            if let scene = self.connectorScene {
                guard scene.identity == identity, scene.sceneName == sceneName, scene.model.projection.destinationId == destination else { call.reject("NATIVE_PROFILE_CONNECTOR_STALE_RETIREMENT"); return }
                self.retireProfileForm { call.resolve(scene.receipt("retired")) }; return
            }
            guard self.sessionFence.contains(identity) else { call.reject("NATIVE_PROFILE_CONNECTOR_STALE_RETIREMENT"); return }
            // Main-actor admission creates the form before presentation starts.
            // With neither an active nor retiring instance there is nothing to
            // withdraw; an unadmitted revision cannot poison other form leases.
            var receipt = self.retiredReceipt(identity, lease: NativeDrawerLease()); receipt["scene"] = sceneName; receipt["destinationId"] = destination
            call.resolve(receipt)
        }
    }
    @objc func applyProfileMemoryScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let parent = self.bridge?.viewController,
                  let options = call.options as? [String: Any], Set(options.keys).isSubset(of: NativeMemoryProjection.keys),
                  let sceneName = call.getString("scene"), sceneName == "memory-financial-context",
                  let draft = options["draft"] as? [String: Any], Set(draft.keys) == Set(["category", "text"]),
                  JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options), bytes.count <= 1_048_576,
                  let next = try? JSONDecoder().decode(NativeMemoryProjection.self, from: bytes), next.valid,
                  self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: next.scene, destinationId: next.destinationId),
                  self.retiringForms.isEmpty else { call.reject("NATIVE_PROFILE_CONNECTOR_UNAVAILABLE"); return }
            if let scene = self.memoryScene {
                guard scene.identity == next.identity, scene.update(next) else { call.reject("NATIVE_PROFILE_CONNECTOR_STALE_STATE"); return }
                call.resolve(next.receipt("active")); return
            }
            guard self.form == nil, self.profileParentPresentationIsReady else { call.reject("NATIVE_PROFILE_PRESENTATION_PENDING"); return }
            let owner = self.profileFormOwnerKey(next.identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            guard next.revision > self.formRevision, next.acknowledgedEditRevision == 0 else { call.reject("NATIVE_PROFILE_CONNECTOR_RETIRED"); return }
            let scene = NativeProfileMemoryScene(next); self.form = scene; self.formRevision = next.revision
            scene.coverage = { [weak self] in self?.reconcileIsolation() }
            scene.model.finalEdit = { [weak self, weak scene] draft, revision in
                guard let self, let scene, self.sessionFence.contains(scene.identity),
                      self.memoryScene === scene || self.retiringForms[ObjectIdentifier(scene)] === scene else { return }
                let state = scene.model.projection
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["draft"] = draft.event; event["composing"] = false; event["editRevision"] = revision
                event["baseDraftRevision"] = state.draftRevision; event["acknowledgedEditRevision"] = state.acknowledgedEditRevision
                self.notifyListeners("profileMemoryFinalEdit", data: event, retainUntilConsumed: false)
            }
            scene.model.edit = { [weak self, weak scene] draft, composing, revision in
                guard let self, let scene, self.memoryScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: state.scene, destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["draft"] = draft.event; event["composing"] = composing; event["editRevision"] = revision
                self.notifyListeners("profileMemoryEdit", data: event, retainUntilConsumed: false); return true
            }
            scene.model.choose = { [weak self, weak scene] action in
                guard let self, let scene, self.memoryScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: state.scene, destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["sequence"] = action.sequence; event["action"] = action.action; event["editRevision"] = action.editRevision
                self.notifyListeners("profileMemoryAction", data: event, retainUntilConsumed: false); return true
            }
            guard scene.present(from: parent, completion: { [weak self, weak scene] presented in
                guard let self, let scene else { call.reject("NATIVE_PROFILE_CONNECTOR_RETIRED"); return }
                guard presented, self.memoryScene === scene,
                      self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: next.scene, destinationId: next.destinationId) else {
                    if self.memoryScene === scene { self.retireProfileForm() }; call.reject("NATIVE_PROFILE_CONNECTOR_RETIRED"); return
                }
                call.resolve(next.receipt("active"))
            }) else { self.retireProfileForm(); call.reject("NATIVE_PROFILE_CONNECTOR_PRESENTATION_REFUSED"); return }
        }
    }
    @objc func confirmProfileMemoryAction(_ call: CAPPluginCall) { memoryAction(call, settlement: false) }
    @objc func settleProfileMemoryAction(_ call: CAPPluginCall) { memoryAction(call, settlement: true) }
    private func memoryAction(_ call: CAPPluginCall, settlement: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  let sceneName = call.getString("scene"), sceneName == "memory-financial-context",
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: sceneName, destinationId: call.getString("destinationId")),
                  let scene = self.memoryScene, scene.identity == identity, scene.sceneName == sceneName, scene.model.projection.destinationId == call.getString("destinationId"),
                  let action = self.nameAction(call, scene: sceneName) else { call.resolve(["valid": false]); return }
            call.resolve(["valid": settlement ? scene.settle(action) : scene.model.confirm(action)])
        }
    }
    @objc func retireProfileMemoryScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, Set(call.options.keys).isSubset(of: ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"]),
                  let identity = self.identity(call), identity.family == "profile", let sceneName = call.getString("scene"), sceneName == "memory-financial-context",
                  let destination = call.getString("destinationId"), NativeDrawerIdentity.identifier(destination) else { call.reject("NATIVE_PROFILE_CONNECTOR_STALE_RETIREMENT"); return }
            if let scene = self.retiringForms.values.first(where: { $0.identity == identity && $0.sceneName == sceneName && $0.receipt("retired")["destinationId"] as? String == destination }) {
                scene.retire { call.resolve(scene.receipt("retired")) }; return
            }
            if let scene = self.memoryScene {
                guard scene.identity == identity, scene.sceneName == sceneName, scene.model.projection.destinationId == destination else { call.reject("NATIVE_PROFILE_CONNECTOR_STALE_RETIREMENT"); return }
                self.retireProfileForm { call.resolve(scene.receipt("retired")) }; return
            }
            guard self.sessionFence.contains(identity) else { call.reject("NATIVE_PROFILE_CONNECTOR_STALE_RETIREMENT"); return }
            // Main-actor admission creates the form before presentation starts.
            // With neither an active nor retiring instance there is nothing to
            // withdraw; an unadmitted revision cannot poison other form leases.
            var receipt = self.retiredReceipt(identity, lease: NativeDrawerLease()); receipt["scene"] = sceneName; receipt["destinationId"] = destination
            call.resolve(receipt)
        }
    }
    @objc func applyProfilePaymentsScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let parent = self.bridge?.viewController,
                  let options = call.options as? [String: Any], Set(options.keys).isSubset(of: NativePaymentsProjection.keys),
                  let sceneName = call.getString("scene"), ["payment-funding", "payment-country"].contains(sceneName),
                  let draft = options["draft"] as? [String: Any], Set(draft.keys) == Set(["value"]),
                  JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options), bytes.count <= 8192,
                  let next = try? JSONDecoder().decode(NativePaymentsProjection.self, from: bytes), next.valid,
                  self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: next.scene, destinationId: next.destinationId),
                  self.retiringForms.isEmpty else { call.reject("NATIVE_PROFILE_PAYMENTS_UNAVAILABLE"); return }
            if let scene = self.paymentsScene {
                guard scene.identity == next.identity, scene.update(next) else { call.reject("NATIVE_PROFILE_PAYMENTS_STALE_STATE"); return }
                call.resolve(next.receipt("active")); return
            }
            guard self.form == nil, self.profileParentPresentationIsReady else { call.reject("NATIVE_PROFILE_PRESENTATION_PENDING"); return }
            let owner = self.profileFormOwnerKey(next.identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            guard next.revision > self.formRevision, next.acknowledgedEditRevision == 0 else { call.reject("NATIVE_PROFILE_PAYMENTS_RETIRED"); return }
            let scene = NativeProfilePaymentsScene(next); self.form = scene; self.formRevision = next.revision
            scene.coverage = { [weak self] in self?.reconcileIsolation() }
            scene.model.finalEdit = { [weak self, weak scene] draft, revision in
                guard let self, let scene, self.sessionFence.contains(scene.identity),
                      self.paymentsScene === scene || self.retiringForms[ObjectIdentifier(scene)] === scene else { return }
                let state = scene.model.projection
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["draft"] = draft.event; event["composing"] = false; event["editRevision"] = revision
                event["baseDraftRevision"] = state.draftRevision; event["acknowledgedEditRevision"] = state.acknowledgedEditRevision
                self.notifyListeners("profilePaymentsFinalEdit", data: event, retainUntilConsumed: false)
            }
            scene.model.edit = { [weak self, weak scene] draft, composing, revision in
                guard let self, let scene, self.paymentsScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: state.scene, destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["draft"] = draft.event; event["composing"] = composing; event["editRevision"] = revision
                self.notifyListeners("profilePaymentsEdit", data: event, retainUntilConsumed: false); return true
            }
            scene.model.choose = { [weak self, weak scene] action in
                guard let self, let scene, self.paymentsScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: state.scene, destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["sequence"] = action.sequence; event["action"] = action.action; event["editRevision"] = action.editRevision
                self.notifyListeners("profilePaymentsAction", data: event, retainUntilConsumed: false); return true
            }
            guard scene.present(from: parent, completion: { [weak self, weak scene] presented in
                guard let self, let scene else { call.reject("NATIVE_PROFILE_PAYMENTS_RETIRED"); return }
                guard presented, self.paymentsScene === scene,
                      self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: next.scene, destinationId: next.destinationId) else {
                    if self.paymentsScene === scene { self.retireProfileForm() }; call.reject("NATIVE_PROFILE_PAYMENTS_RETIRED"); return
                }
                call.resolve(next.receipt("active"))
            }) else { self.retireProfileForm(); call.reject("NATIVE_PROFILE_PAYMENTS_PRESENTATION_REFUSED"); return }
        }
    }
    @objc func confirmProfilePaymentsAction(_ call: CAPPluginCall) { paymentsAction(call, settlement: false) }
    @objc func settleProfilePaymentsAction(_ call: CAPPluginCall) { paymentsAction(call, settlement: true) }
    private func paymentsAction(_ call: CAPPluginCall, settlement: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  let sceneName = call.getString("scene"), ["payment-funding", "payment-country"].contains(sceneName),
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: sceneName, destinationId: call.getString("destinationId")),
                  let scene = self.paymentsScene, scene.identity == identity, scene.sceneName == sceneName, scene.model.projection.destinationId == call.getString("destinationId"),
                  let action = self.nameAction(call, scene: sceneName) else { call.resolve(["valid": false]); return }
            call.resolve(["valid": settlement ? scene.settle(action) : scene.model.confirm(action)])
        }
    }
    @objc func retireProfilePaymentsScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, Set(call.options.keys).isSubset(of: ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"]),
                  let identity = self.identity(call), identity.family == "profile", let sceneName = call.getString("scene"), ["payment-funding", "payment-country"].contains(sceneName),
                  let destination = call.getString("destinationId"), NativeDrawerIdentity.identifier(destination) else { call.reject("NATIVE_PROFILE_PAYMENTS_STALE_RETIREMENT"); return }
            if let scene = self.retiringForms.values.first(where: { $0.identity == identity && $0.sceneName == sceneName && $0.receipt("retired")["destinationId"] as? String == destination }) {
                scene.retire { call.resolve(scene.receipt("retired")) }; return
            }
            if let scene = self.paymentsScene {
                guard scene.identity == identity, scene.sceneName == sceneName, scene.model.projection.destinationId == destination else { call.reject("NATIVE_PROFILE_PAYMENTS_STALE_RETIREMENT"); return }
                self.retireProfileForm { call.resolve(scene.receipt("retired")) }; return
            }
            guard self.sessionFence.contains(identity) else { call.reject("NATIVE_PROFILE_PAYMENTS_STALE_RETIREMENT"); return }
            // Main-actor admission creates the form before presentation starts.
            // With neither an active nor retiring instance there is nothing to
            // withdraw; an unadmitted revision cannot poison other form leases.
            var receipt = self.retiredReceipt(identity, lease: NativeDrawerLease()); receipt["scene"] = sceneName; receipt["destinationId"] = destination
            call.resolve(receipt)
        }
    }
    @objc func applyProfileWorldModelScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let parent = self.bridge?.viewController,
                  let options = call.options as? [String: Any], Set(options.keys).isSubset(of: NativeWorldModelProjection.keys),
                  let sceneName = options["scene"] as? String, let draft = options["draft"] as? [String: Any],
                  Set(draft.keys) == NativeWorldModelDraft.keys(sceneName),
                  JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options), bytes.count <= 65_536,
                  let next = try? JSONDecoder().decode(NativeWorldModelProjection.self, from: bytes), next.valid,
                  self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: next.scene, destinationId: next.destinationId),
                  self.retiringForms.isEmpty else { call.reject("NATIVE_PROFILE_WORLD_MODEL_UNAVAILABLE"); return }
            if let scene = self.worldModelScene {
                guard scene.identity == next.identity, scene.update(next) else { call.reject("NATIVE_PROFILE_WORLD_MODEL_STALE_STATE"); return }
                call.resolve(next.receipt("active")); return
            }
            guard self.form == nil, self.profileParentPresentationIsReady else { call.reject("NATIVE_PROFILE_PRESENTATION_PENDING"); return }
            let owner = self.profileFormOwnerKey(next.identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            guard next.revision > self.formRevision, next.acknowledgedEditRevision == 0 else { call.reject("NATIVE_PROFILE_WORLD_MODEL_RETIRED"); return }
            let scene = NativeProfileWorldModelScene(next)
            self.form = scene; self.formRevision = next.revision
            scene.coverage = { [weak self] in self?.reconcileIsolation() }
            scene.model.edit = { [weak self, weak scene] draft, composing, revision in
                guard let self, let scene, self.worldModelScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: state.scene, destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["draft"] = draft.event; event["composing"] = composing; event["editRevision"] = revision
                self.notifyListeners("profileWorldModelEdit", data: event, retainUntilConsumed: false); return true
            }
            scene.model.choose = { [weak self, weak scene] action in
                guard let self, let scene, self.worldModelScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: state.scene, destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["sequence"] = action.sequence; event["action"] = action.action; event["editRevision"] = action.editRevision
                self.notifyListeners("profileWorldModelAction", data: event, retainUntilConsumed: false); return true
            }
            guard scene.present(from: parent, completion: { [weak self, weak scene] presented in
                guard let self, let scene else { call.reject("NATIVE_PROFILE_WORLD_MODEL_RETIRED"); return }
                guard presented, self.worldModelScene === scene,
                      self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: next.scene, destinationId: next.destinationId) else {
                    if self.worldModelScene === scene { self.retireProfileForm() }
                    call.reject("NATIVE_PROFILE_WORLD_MODEL_RETIRED"); return
                }
                call.resolve(next.receipt("active"))
            }) else { self.retireProfileForm(); call.reject("NATIVE_PROFILE_WORLD_MODEL_PRESENTATION_REFUSED"); return }
        }
    }
    @objc func confirmProfileWorldModelAction(_ call: CAPPluginCall) { worldModelAction(call, settlement: false) }
    @objc func settleProfileWorldModelAction(_ call: CAPPluginCall) { worldModelAction(call, settlement: true) }
    private func worldModelAction(_ call: CAPPluginCall, settlement: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"), let name = call.getString("scene"),
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: name, destinationId: call.getString("destinationId")),
                  let scene = self.worldModelScene, scene.identity == identity, scene.sceneName == name,
                  scene.model.projection.destinationId == call.getString("destinationId"), let action = self.nameAction(call, scene: name) else { call.resolve(["valid": false]); return }
            call.resolve(["valid": settlement ? scene.settle(action) : scene.model.confirm(action)])
        }
    }
    @objc func retireProfileWorldModelScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, Set(call.options.keys).isSubset(of: ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId"]),
                  let identity = self.identity(call), identity.family == "profile", let name = call.getString("scene"),
                  !NativeWorldModelDraft.keys(name).isEmpty, let destination = call.getString("destinationId"), NativeDrawerIdentity.identifier(destination) else { call.reject("NATIVE_PROFILE_WORLD_MODEL_STALE_RETIREMENT"); return }
            if let scene = self.retiringForms.values.first(where: { $0.identity == identity && $0.sceneName == name && $0.receipt("retired")["destinationId"] as? String == destination }) {
                scene.retire { call.resolve(scene.receipt("retired")) }; return
            }
            if let scene = self.worldModelScene {
                guard scene.identity == identity, scene.sceneName == name, scene.model.projection.destinationId == destination else { call.reject("NATIVE_PROFILE_WORLD_MODEL_STALE_RETIREMENT"); return }
                self.retireProfileForm { call.resolve(scene.receipt("retired")) }; return
            }
            guard self.sessionFence.contains(identity) else { call.reject("NATIVE_PROFILE_WORLD_MODEL_STALE_RETIREMENT"); return }
            let owner = self.profileFormOwnerKey(identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            self.formRevision = max(self.formRevision, identity.revision)
            var receipt = self.retiredReceipt(identity, lease: NativeDrawerLease()); receipt["scene"] = name; receipt["destinationId"] = destination
            call.resolve(receipt)
        }
    }
    private func profileFormOwnerKey(_ identity: NativeDrawerIdentity) -> String {
        "\(identity.documentId):\(identity.ownerEpoch):\(identity.ownerGeneration)"
    }
    @objc func applyProfilePasswordScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let parent = self.bridge?.viewController,
                  let options = call.options as? [String: Any], Set(options.keys).isSubset(of: NativePasswordProjection.keys),
                  JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options), bytes.count <= 65_536,
                  let next = try? JSONDecoder().decode(NativePasswordProjection.self, from: bytes), next.valid,
                  self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: next.scene, destinationId: next.destinationId),
                  self.retiringForms.isEmpty else { call.reject("NATIVE_PROFILE_PASSWORD_UNAVAILABLE"); return }
            if let scene = self.passwordScene {
                guard scene.identity == next.identity, scene.update(next) else { call.reject("NATIVE_PROFILE_PASSWORD_STALE_STATE"); return }
                call.resolve(next.receipt("active")); return
            }
            guard self.form == nil, self.profileParentPresentationIsReady else { call.reject("NATIVE_PROFILE_PRESENTATION_PENDING"); return }
            let owner = self.profileFormOwnerKey(next.identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            guard next.revision > self.formRevision, next.acknowledgedEditRevision == 0 else { call.reject("NATIVE_PROFILE_PASSWORD_RETIRED"); return }
            let scene = NativeProfilePasswordScene(next)
            self.form = scene; self.formRevision = next.revision
            scene.coverage = { [weak self] in self?.reconcileIsolation() }
            scene.model.edit = { [weak self, weak scene] password, confirmation, composing, revision in
                guard let self, let scene, self.passwordScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: state.scene, destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["password"] = password; event["confirmation"] = confirmation; event["composing"] = composing; event["editRevision"] = revision
                self.notifyListeners("profilePasswordEdit", data: event, retainUntilConsumed: false); return true
            }
            scene.model.choose = { [weak self, weak scene] action in
                guard let self, let scene, self.passwordScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: state.scene, destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["sequence"] = action.sequence; event["action"] = action.action; event["editRevision"] = action.editRevision
                self.notifyListeners("profilePasswordAction", data: event, retainUntilConsumed: false); return true
            }
            guard scene.present(from: parent, completion: { [weak self, weak scene] presented in
                guard let self, let scene else { call.reject("NATIVE_PROFILE_PASSWORD_RETIRED"); return }
                guard presented, self.passwordScene === scene,
                      self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: next.scene, destinationId: next.destinationId) else {
                    if self.passwordScene === scene { self.retireProfileForm() }
                    call.reject("NATIVE_PROFILE_PASSWORD_RETIRED"); return
                }
                call.resolve(next.receipt("active"))
            }) else { self.retireProfileForm(); call.reject("NATIVE_PROFILE_PASSWORD_PRESENTATION_REFUSED"); return }
        }
    }
    @objc func confirmProfilePasswordAction(_ call: CAPPluginCall) { passwordAction(call, settlement: false) }
    @objc func settleProfilePasswordAction(_ call: CAPPluginCall) { passwordAction(call, settlement: true) }
    private func passwordAction(_ call: CAPPluginCall, settlement: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: "vault-passphrase", destinationId: call.getString("destinationId")),
                  let scene = self.passwordScene, scene.identity == identity, scene.model.projection.destinationId == call.getString("destinationId"),
                  let action = self.nameAction(call, scene: "vault-passphrase") else { call.resolve(["valid": false]); return }
            call.resolve(["valid": settlement ? scene.settle(action) : scene.model.confirm(action)])
        }
    }
    @objc func retireProfilePasswordScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), identity.family == "profile", call.getString("scene") == "vault-passphrase",
                  let destination = call.getString("destinationId"), NativeDrawerIdentity.identifier(destination) else { call.reject("NATIVE_PROFILE_PASSWORD_STALE_RETIREMENT"); return }
            if let scene = self.retiringForms.values.first(where: { $0.identity == identity && $0.sceneName == "vault-passphrase" && $0.receipt("retired")["destinationId"] as? String == destination }) {
                scene.retire { call.resolve(scene.receipt("retired")) }; return
            }
            if let scene = self.passwordScene {
                guard scene.identity == identity, scene.model.projection.destinationId == destination else { call.reject("NATIVE_PROFILE_PASSWORD_STALE_RETIREMENT"); return }
                self.retireProfileForm { call.resolve(scene.receipt("retired")) }; return
            }
            guard self.sessionFence.contains(identity) else { call.reject("NATIVE_PROFILE_PASSWORD_STALE_RETIREMENT"); return }
            let owner = self.profileFormOwnerKey(identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            self.formRevision = max(self.formRevision, identity.revision)
            var receipt = self.retiredReceipt(identity, lease: NativeDrawerLease())
            receipt["scene"] = "vault-passphrase"; receipt["destinationId"] = destination
            call.resolve(receipt)
        }
    }
    @objc func applyProfilePricingScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let parent = self.bridge?.viewController,
                  let options = call.options as? [String: Any], Set(options.keys).isSubset(of: NativeProfilePricingProjection.keys),
                  JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options),
                  bytes.count <= 32_768, let next = try? JSONDecoder().decode(NativeProfilePricingProjection.self, from: bytes),
                  next.valid, self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: "request-price", destinationId: next.destinationId), self.retiringForms.isEmpty else {
                call.reject("NATIVE_PROFILE_PRICING_UNAVAILABLE"); return
            }
            if let scene = self.pricingScene {
                guard scene.model.projection.identity == next.identity, scene.update(next) else {
                    call.reject("NATIVE_PROFILE_PRICING_STALE_STATE"); return
                }
                call.resolve(next.receipt(phase: "active")); return
            }
            guard self.form == nil else { call.reject("NATIVE_PROFILE_FORM_OCCUPIED"); return }
            guard self.profileParentPresentationIsReady else { call.reject("NATIVE_PROFILE_PRESENTATION_PENDING"); return }
            let owner = self.profileFormOwnerKey(next.identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            guard next.revision > self.formRevision, next.acknowledgedEditRevision == 0 else {
                call.reject("NATIVE_PROFILE_PRICING_RETIRED"); return
            }
            let scene = NativeProfilePricingScene(next)
            self.pricingScene = scene
            self.formRevision = next.revision
            scene.coverage = { [weak self] in self?.reconcileIsolation() }
            scene.model.edit = { [weak self, weak scene] text, composing, revision in
                guard let self, let scene, self.pricingScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: "request-price", destinationId: state.destinationId) else { return false }
                var event = state.receipt(phase: "active")
                event.removeValue(forKey: "phase")
                event["text"] = text; event["composing"] = composing; event["editRevision"] = revision
                self.notifyListeners("profilePricingEdit", data: event, retainUntilConsumed: false)
                return true
            }
            scene.model.choose = { [weak self, weak scene] action in
                guard let self, let scene, self.pricingScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: "request-price", destinationId: state.destinationId) else { return false }
                var event = state.receipt(phase: "active")
                event.removeValue(forKey: "phase")
                event["sequence"] = action.sequence; event["action"] = action.action; event["editRevision"] = action.editRevision
                self.notifyListeners("profilePricingAction", data: event, retainUntilConsumed: false)
                return true
            }
            guard scene.present(from: parent, completion: { [weak self, weak scene] presented in
                guard let self, let scene else { call.reject("NATIVE_PROFILE_PRICING_RETIRED"); return }
                guard presented, self.pricingScene === scene,
                      self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: "request-price", destinationId: next.destinationId) else {
                    if self.pricingScene === scene { self.retireProfileForm() }
                    call.reject("NATIVE_PROFILE_PRICING_RETIRED"); return
                }
                call.resolve(next.receipt(phase: "active"))
            }) else {
                self.retireProfileForm()
                call.reject("NATIVE_PROFILE_PRICING_PRESENTATION_REFUSED"); return
            }
        }
    }
    @objc func confirmProfilePricingAction(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: "request-price", destinationId: call.getString("destinationId")), let scene = self.pricingScene,
                  scene.model.projection.destinationId == call.getString("destinationId"),
                  scene.model.projection.identity == identity, let action = self.nameAction(call, scene: "request-price") else {
                call.resolve(["valid": false]); return
            }
            call.resolve(["valid": scene.model.confirm(action)])
        }
    }
    @objc func settleProfilePricingAction(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: "request-price", destinationId: call.getString("destinationId")), let scene = self.pricingScene,
                  scene.model.projection.destinationId == call.getString("destinationId"),
                  scene.model.projection.identity == identity, let action = self.nameAction(call, scene: "request-price") else {
                call.resolve(["valid": false]); return
            }
            call.resolve(["valid": scene.settle(action)])
        }
    }
    @objc func retireProfilePricingScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), identity.family == "profile",
                  call.getString("scene") == "request-price", let destination = call.getString("destinationId"),
                  NativeDrawerIdentity.identifier(destination) else { call.reject("NATIVE_PROFILE_PRICING_STALE_RETIREMENT"); return }
            if let scene = self.retiringForms.values.first(where: { $0.identity == identity && $0.sceneName == "request-price" && $0.receipt("retired")["destinationId"] as? String == destination }) {
                scene.retire { call.resolve(scene.receipt("retired")) }; return
            }
            if let scene = self.pricingScene {
                guard scene.model.projection.identity == identity, scene.model.projection.destinationId == destination else { call.reject("NATIVE_PROFILE_PRICING_STALE_RETIREMENT"); return }
                self.retireProfileForm { call.resolve(scene.model.projection.receipt(phase: "retired")) }; return
            }
            guard self.sessionFence.contains(identity) else { call.reject("NATIVE_PROFILE_PRICING_STALE_RETIREMENT"); return }
            let owner = self.profileFormOwnerKey(identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            self.formRevision = max(self.formRevision, identity.revision)
            var receipt = self.retiredReceipt(identity, lease: NativeDrawerLease())
            receipt["scene"] = "request-price"
            receipt["destinationId"] = destination
            call.resolve(receipt)
        }
    }
    @objc func applyProfilePhoneScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let parent = self.bridge?.viewController,
                  let options = call.options as? [String: Any], NativePhoneProjection.hasClosedShape(options),
                  JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options),
                  bytes.count <= 131_072, let next = try? JSONDecoder().decode(NativePhoneProjection.self, from: bytes), next.valid,
                  self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: "phone", destinationId: next.destinationId),
                  self.retiringForms.isEmpty else { call.reject("NATIVE_PROFILE_PHONE_UNAVAILABLE"); return }
            if let scene = self.phoneScene {
                guard scene.identity == next.identity, scene.update(next) else { call.reject("NATIVE_PROFILE_PHONE_STALE_STATE"); return }
                call.resolve(next.receipt("active")); return
            }
            guard self.form == nil, self.profileParentPresentationIsReady else {
                call.reject("NATIVE_PROFILE_PRESENTATION_PENDING"); return
            }
            let owner = self.profileFormOwnerKey(next.identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            guard next.revision > self.formRevision, next.acknowledgedEditRevision == 0 else { call.reject("NATIVE_PROFILE_PHONE_RETIRED"); return }
            let scene = NativeProfilePhoneScene(next)
            self.form = scene; self.formRevision = next.revision
            scene.coverage = { [weak self] in self?.reconcileIsolation() }
            scene.model.edit = { [weak self, weak scene] draft, step, composing, revision in
                guard let self, let scene, self.form === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: "phone", destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["draft"] = ["country": draft.country, "number": draft.number, "code": draft.code]
                event["step"] = step; event["composing"] = composing; event["editRevision"] = revision
                self.notifyListeners("profilePhoneEdit", data: event, retainUntilConsumed: false)
                return true
            }
            scene.model.choose = { [weak self, weak scene] action in
                guard let self, let scene, self.form === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: "phone", destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["action"] = action.action; event["intent"] = action.intent
                event["sequence"] = action.sequence; event["editRevision"] = action.editRevision
                self.notifyListeners("profilePhoneAction", data: event, retainUntilConsumed: false)
                return true
            }
            guard scene.present(from: parent, completion: { [weak self, weak scene] presented in
                guard let self, let scene else { call.reject("NATIVE_PROFILE_PHONE_RETIRED"); return }
                guard presented, self.form === scene,
                      self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: "phone", destinationId: next.destinationId) else {
                    if self.form === scene { self.retireProfileForm() }
                    call.reject("NATIVE_PROFILE_PHONE_RETIRED"); return
                }
                call.resolve(next.receipt("active"))
            }) else { self.retireProfileForm(); call.reject("NATIVE_PROFILE_PHONE_PRESENTATION_REFUSED"); return }
        }
    }
    private func phoneAction(_ call: CAPPluginCall) -> NativePhoneAction? {
        let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId",
            "updateSequence", "privacyGeneration", "editRevision", "sequence", "action", "intent"]
        guard Set(call.options.keys).isSubset(of: keys), call.getString("scene") == "phone",
              let update = call.getInt("updateSequence"), update > 0, let edit = call.getInt("editRevision"), edit >= 0,
              let sequence = call.getInt("sequence"), sequence > 0,
              [update, edit, sequence].allSatisfy({ $0 <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration }),
              let action = call.getString("action"), action == "cancel" ? call.getString("intent") == nil :
                action == "change" && ["send", "verify", "resend", "back", "continue"].contains(call.getString("intent") ?? "") else { return nil }
        return NativePhoneAction(updateSequence: update, editRevision: edit, sequence: sequence, action: action, intent: call.getString("intent"))
    }
    @objc func confirmProfilePhoneAction(_ call: CAPPluginCall) { settleOrConfirmPhone(call, settlement: false) }
    @objc func settleProfilePhoneAction(_ call: CAPPluginCall) { settleOrConfirmPhone(call, settlement: true) }
    private func settleOrConfirmPhone(_ call: CAPPluginCall, settlement: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: "phone", destinationId: call.getString("destinationId")),
                  let scene = self.phoneScene, scene.identity == identity, scene.model.projection.destinationId == call.getString("destinationId"),
                  let action = self.phoneAction(call) else { call.resolve(["valid": false]); return }
            call.resolve(["valid": settlement ? scene.settle(action) : scene.model.confirm(action)])
        }
    }
    @objc func retireProfilePhoneScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), identity.family == "profile", call.getString("scene") == "phone",
                  let destination = call.getString("destinationId"), NativeDrawerIdentity.identifier(destination) else {
                call.reject("NATIVE_PROFILE_PHONE_STALE_RETIREMENT"); return
            }
            if let scene = self.retiringForms.values.first(where: { $0.identity == identity && $0.sceneName == "phone" && $0.receipt("retired")["destinationId"] as? String == destination }) {
                scene.retire { call.resolve(scene.receipt("retired")) }; return
            }
            if let scene = self.phoneScene {
                guard scene.identity == identity, scene.model.projection.destinationId == destination else { call.reject("NATIVE_PROFILE_PHONE_STALE_RETIREMENT"); return }
                self.retireProfileForm { call.resolve(scene.receipt("retired")) }; return
            }
            guard self.sessionFence.contains(identity) else { call.reject("NATIVE_PROFILE_PHONE_STALE_RETIREMENT"); return }
            let owner = self.profileFormOwnerKey(identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            self.formRevision = max(self.formRevision, identity.revision)
            var receipt = self.retiredReceipt(identity, lease: NativeDrawerLease())
            receipt["scene"] = "phone"; receipt["destinationId"] = destination
            call.resolve(receipt)
        }
    }
    @objc func applyProfileNameScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let parent = self.bridge?.viewController,
                  let options = call.options as? [String: Any], Set(options.keys).isSubset(of: NativeProfileNameProjection.keys),
                  JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options),
                  bytes.count <= 32_768, let next = try? JSONDecoder().decode(NativeProfileNameProjection.self, from: bytes),
                  next.valid, self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: next.scene, destinationId: next.destinationId), self.retiringForms.isEmpty else {
                call.reject("NATIVE_PROFILE_NAME_UNAVAILABLE"); return
            }
            if let scene = self.nameScene {
                guard scene.model.projection.identity == next.identity, scene.update(next) else {
                    call.reject("NATIVE_PROFILE_NAME_STALE_STATE"); return
                }
                call.resolve(next.receipt(phase: "active")); return
            }
            guard self.form == nil else { call.reject("NATIVE_PROFILE_FORM_OCCUPIED"); return }
            guard self.profileParentPresentationIsReady else { call.reject("NATIVE_PROFILE_PRESENTATION_PENDING"); return }
            let owner = self.profileFormOwnerKey(next.identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            guard next.revision > self.formRevision, next.acknowledgedEditRevision == 0 else {
                call.reject("NATIVE_PROFILE_NAME_RETIRED"); return
            }
            let scene = NativeProfileNameScene(next)
            self.nameScene = scene
            self.formRevision = next.revision
            scene.coverage = { [weak self] in self?.reconcileIsolation() }
            scene.model.edit = { [weak self, weak scene] text, composing, revision in
                guard let self, let scene, self.nameScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: state.scene, destinationId: state.destinationId) else { return false }
                var event = state.receipt(phase: "active")
                event.removeValue(forKey: "phase")
                event["text"] = text; event["composing"] = composing; event["editRevision"] = revision
                self.notifyListeners("profileNameEdit", data: event, retainUntilConsumed: false)
                return true
            }
            scene.model.choose = { [weak self, weak scene] action in
                guard let self, let scene, self.nameScene === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: state.scene, destinationId: state.destinationId) else { return false }
                var event = state.receipt(phase: "active")
                event.removeValue(forKey: "phase")
                event["sequence"] = action.sequence; event["action"] = action.action; event["editRevision"] = action.editRevision
                self.notifyListeners("profileNameAction", data: event, retainUntilConsumed: false)
                return true
            }
            guard scene.present(from: parent, completion: { [weak self, weak scene] presented in
                guard let self, let scene else { call.reject("NATIVE_PROFILE_NAME_RETIRED"); return }
                guard presented, self.nameScene === scene,
                      self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: next.scene, destinationId: next.destinationId) else {
                    if self.nameScene === scene { self.retireProfileForm() }
                    call.reject("NATIVE_PROFILE_NAME_RETIRED"); return
                }
                call.resolve(next.receipt(phase: "active"))
            }) else {
                self.retireProfileForm()
                call.reject("NATIVE_PROFILE_NAME_PRESENTATION_REFUSED"); return
            }
        }
    }
    private func nameAction(_ call: CAPPluginCall, scene: String = "account-name", settlement: Bool = false) -> NativeProfileNameAction? {
        let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene",
            "updateSequence", "privacyGeneration", "editRevision", "sequence", "action"]
        let allowed = (settlement ? keys.union(["saved"]) : keys).union(["destinationId"])
        guard Set(call.options.keys).isSubset(of: allowed), call.getString("scene") == scene,
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
                  let requestedScene = call.getString("scene"), ["account-name", "referral-handle"].contains(requestedScene),
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: requestedScene, destinationId: call.getString("destinationId")), let scene = self.nameScene,
                  scene.model.projection.destinationId == call.getString("destinationId"),
                  scene.sceneName == requestedScene, scene.model.projection.identity == identity, let action = self.nameAction(call, scene: requestedScene) else {
                call.resolve(["valid": false]); return
            }
            call.resolve(["valid": scene.model.confirm(action)])
        }
    }
    @objc func settleProfileNameAction(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  let requestedScene = call.getString("scene"), ["account-name", "referral-handle"].contains(requestedScene),
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: requestedScene, destinationId: call.getString("destinationId")), let scene = self.nameScene,
                  scene.model.projection.destinationId == call.getString("destinationId"),
                  scene.sceneName == requestedScene, scene.model.projection.identity == identity, let action = self.nameAction(call, scene: requestedScene) else {
                call.resolve(["valid": false]); return
            }
            call.resolve(["valid": scene.settle(action)])
        }
    }
    @objc func retireProfileNameScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), identity.family == "profile",
                  let requestedScene = call.getString("scene"), ["account-name", "referral-handle"].contains(requestedScene) else { call.reject("NATIVE_PROFILE_NAME_STALE_RETIREMENT"); return }
            if let scene = self.retiringForms.values.first(where: { $0.identity == identity && $0.sceneName == requestedScene && $0.receipt("retired")["destinationId"] as? String == call.getString("destinationId") }) {
                scene.retire { call.resolve(scene.receipt("retired")) }; return
            }
            if let scene = self.nameScene {
                guard scene.sceneName == requestedScene, scene.model.projection.destinationId == call.getString("destinationId"), scene.model.projection.identity == identity else { call.reject("NATIVE_PROFILE_NAME_STALE_RETIREMENT"); return }
                self.retireProfileForm { call.resolve(scene.model.projection.receipt(phase: "retired")) }; return
            }
            guard self.sessionFence.contains(identity) else { call.reject("NATIVE_PROFILE_NAME_STALE_RETIREMENT"); return }
            let owner = self.profileFormOwnerKey(identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            self.formRevision = max(self.formRevision, identity.revision)
            var receipt = self.retiredReceipt(identity, lease: NativeDrawerLease())
            receipt["scene"] = requestedScene
            if let id = call.getString("destinationId") { receipt["destinationId"] = id }
            call.resolve(receipt)
        }
    }
    @MainActor private func retireProfileForm(completion: @escaping () -> Void = {}) {
        feedback.retireFamily("profile")
        guard let scene = form else {
            let retiring = Array(retiringForms.values)
            guard !retiring.isEmpty else { completion(); return }
            let group = DispatchGroup()
            for scene in retiring {
                group.enter()
                scene.retire { group.leave() }
            }
            group.notify(queue: .main, execute: completion)
            return
        }
        form = nil
        let id = ObjectIdentifier(scene)
        let shield = HushhSessionPrivacyShield.shared
        let token = shield.beginPresentationRetirement()
        retiringForms[id] = scene
        scene.retire { [self] in
            retiringForms.removeValue(forKey: id)
            reconcileIsolation()
            shield.completePresentationRetirement(token)
            completion()
        }
    }

    @objc func applyProfileStyleScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let parent = self.bridge?.viewController,
                  let options = call.options as? [String: Any], Set(options.keys).isSubset(of: NativeProfileStyleProjection.keys),
                  JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options),
                  bytes.count <= 32_768, let next = try? JSONDecoder().decode(NativeProfileStyleProjection.self, from: bytes),
                  next.valid, self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: "writing-style", destinationId: next.destinationId), self.retiringForms.isEmpty else {
                call.reject("NATIVE_PROFILE_STYLE_UNAVAILABLE"); return
            }
            if let scene = self.styleScene {
                guard scene.identity == next.identity, scene.update(next) else { call.reject("NATIVE_PROFILE_STYLE_STALE_STATE"); return }
                call.resolve(next.receipt("active")); return
            }
            guard self.form == nil else { call.reject("NATIVE_PROFILE_FORM_OCCUPIED"); return }
            guard self.profileParentPresentationIsReady else { call.reject("NATIVE_PROFILE_PRESENTATION_PENDING"); return }
            let owner = self.profileFormOwnerKey(next.identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            guard next.revision > self.formRevision, next.acknowledgedEditRevision == 0 else { call.reject("NATIVE_PROFILE_STYLE_RETIRED"); return }
            let scene = NativeProfileStyleScene(next)
            self.form = scene; self.formRevision = next.revision
            scene.coverage = { [weak self] in self?.reconcileIsolation() }
            scene.model.edit = { [weak self, weak scene] field, value, composing, revision in
                guard let self, let scene, self.form === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: "writing-style", destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["field"] = field; event["value"] = value?.bridge ?? NSNull()
                event["composing"] = composing; event["editRevision"] = revision
                self.notifyListeners("profileStyleEdit", data: event, retainUntilConsumed: false)
                return true
            }
            scene.model.choose = { [weak self, weak scene] action in
                guard let self, let scene, self.form === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: "writing-style", destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["sequence"] = action.sequence; event["action"] = action.action; event["editRevision"] = action.editRevision
                self.notifyListeners("profileStyleAction", data: event, retainUntilConsumed: false)
                return true
            }
            guard scene.present(from: parent, completion: { [weak self, weak scene] presented in
                guard let self, let scene else { call.reject("NATIVE_PROFILE_STYLE_RETIRED"); return }
                guard presented, self.form === scene, self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: "writing-style", destinationId: next.destinationId) else {
                    if self.form === scene { self.retireProfileForm() }
                    call.reject("NATIVE_PROFILE_STYLE_RETIRED"); return
                }
                call.resolve(next.receipt("active"))
            }) else { self.retireProfileForm(); call.reject("NATIVE_PROFILE_STYLE_PRESENTATION_REFUSED"); return }
        }
    }
    @objc func confirmProfileStyleAction(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: "writing-style", destinationId: call.getString("destinationId")),
                  let scene = self.styleScene, scene.identity == identity, scene.model.projection.destinationId == call.getString("destinationId"),
                  let action = self.nameAction(call, scene: "writing-style") else { call.resolve(["valid": false]); return }
            call.resolve(["valid": scene.model.confirm(action)])
        }
    }
    @objc func settleProfileStyleAction(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: "writing-style", destinationId: call.getString("destinationId")),
                  let scene = self.styleScene, scene.identity == identity, scene.model.projection.destinationId == call.getString("destinationId"),
                  let action = self.nameAction(call, scene: "writing-style", settlement: true) else { call.resolve(["valid": false]); return }
            call.resolve(["valid": scene.settle(action, saved: call.getBool("saved") == true)])
        }
    }
    @objc func retireProfileStyleScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), identity.family == "profile", call.getString("scene") == "writing-style" else {
                call.reject("NATIVE_PROFILE_STYLE_STALE_RETIREMENT"); return
            }
            if let scene = self.retiringForms.values.first(where: { $0.identity == identity && $0.sceneName == "writing-style" }) {
                scene.retire { call.resolve(scene.receipt("retired")) }; return
            }
            if let scene = self.styleScene {
                guard scene.identity == identity else { call.reject("NATIVE_PROFILE_STYLE_STALE_RETIREMENT"); return }
                self.retireProfileForm { call.resolve(scene.receipt("retired")) }; return
            }
            guard self.sessionFence.contains(identity) else { call.reject("NATIVE_PROFILE_STYLE_STALE_RETIREMENT"); return }
            let owner = self.profileFormOwnerKey(identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            self.formRevision = max(self.formRevision, identity.revision)
            var receipt = self.retiredReceipt(identity, lease: NativeDrawerLease()); receipt["scene"] = "writing-style"
            if let destination = call.getString("destinationId") {
                guard NativeDrawerIdentity.identifier(destination) else { call.reject("NATIVE_PROFILE_STYLE_STALE_RETIREMENT"); return }
                receipt["destinationId"] = destination
            }
            call.resolve(receipt)
        }
    }

    @objc func applyProfileSupportScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let parent = self.bridge?.viewController, let options = call.options as? [String: Any],
                  Set(options.keys).isSubset(of: NativeSupportProjection.keys),
                  let draft = options["draft"] as? [String: Any], Set(draft.keys) == Set(["kind", "message"]),
                  JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options), bytes.count <= 98_304,
                  let next = try? JSONDecoder().decode(NativeSupportProjection.self, from: bytes), next.valid,
                  self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: "support", destinationId: next.destinationId),
                  self.retiringForms.isEmpty else { call.reject("NATIVE_PROFILE_SUPPORT_UNAVAILABLE"); return }
            if let scene = self.supportScene {
                guard scene.identity == next.identity, scene.update(next) else { call.reject("NATIVE_PROFILE_SUPPORT_STALE_STATE"); return }
                call.resolve(next.receipt("active")); return
            }
            guard self.form == nil else { call.reject("NATIVE_PROFILE_FORM_OCCUPIED"); return }
            guard self.profileParentPresentationIsReady else { call.reject("NATIVE_PROFILE_PRESENTATION_PENDING"); return }
            let owner = self.profileFormOwnerKey(next.identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            guard next.revision > self.formRevision, next.acknowledgedEditRevision == 0 else { call.reject("NATIVE_PROFILE_SUPPORT_RETIRED"); return }
            let scene = NativeProfileSupportScene(next)
            self.form = scene; self.formRevision = next.revision
            scene.coverage = { [weak self] in self?.reconcileIsolation() }
            scene.model.edit = { [weak self, weak scene] draft, composing, revision in
                guard let self, let scene, self.form === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: "support", destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["draft"] = ["kind": draft.kind, "message": draft.message]; event["composing"] = composing; event["editRevision"] = revision
                self.notifyListeners("profileSupportEdit", data: event, retainUntilConsumed: false)
                return true
            }
            scene.model.choose = { [weak self, weak scene] action in
                guard let self, let scene, self.form === scene else { return false }
                let state = scene.model.projection
                guard self.profileFormOwnerIsCurrent(state.identity, privacy: state.privacyGeneration, scene: "support", destinationId: state.destinationId) else { return false }
                var event = state.receipt("active"); event.removeValue(forKey: "phase")
                event["sequence"] = action.sequence; event["action"] = action.action; event["editRevision"] = action.editRevision
                self.notifyListeners("profileSupportAction", data: event, retainUntilConsumed: false)
                return true
            }
            guard scene.present(from: parent, completion: { [weak self, weak scene] presented in
                guard let self, let scene else { call.reject("NATIVE_PROFILE_SUPPORT_RETIRED"); return }
                guard presented, self.form === scene, self.profileFormPresentationIsCurrent(next.identity, privacy: next.privacyGeneration, scene: "support", destinationId: next.destinationId) else {
                    if self.form === scene { self.retireProfileForm() }
                    call.reject("NATIVE_PROFILE_SUPPORT_RETIRED"); return
                }
                call.resolve(next.receipt("active"))
            }) else { self.retireProfileForm(); call.reject("NATIVE_PROFILE_SUPPORT_PRESENTATION_REFUSED"); return }
        }
    }
    @objc func confirmProfileSupportAction(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: "support", destinationId: call.getString("destinationId")),
                  let scene = self.supportScene, scene.identity == identity, scene.model.projection.destinationId == call.getString("destinationId"),
                  let action = self.nameAction(call, scene: "support") else { call.resolve(["valid": false]); return }
            call.resolve(["valid": scene.model.confirm(action)])
        }
    }
    @objc func settleProfileSupportAction(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let privacy = call.getInt("privacyGeneration"),
                  self.profileFormOwnerIsCurrent(identity, privacy: privacy, scene: "support", destinationId: call.getString("destinationId")),
                  let scene = self.supportScene, scene.identity == identity, scene.model.projection.destinationId == call.getString("destinationId"),
                  let action = self.nameAction(call, scene: "support", settlement: true) else { call.resolve(["valid": false]); return }
            call.resolve(["valid": scene.settle(action)])
        }
    }
    @objc func retireProfileSupportScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), identity.family == "profile", call.getString("scene") == "support",
                  let destination = call.getString("destinationId"), NativeDrawerIdentity.identifier(destination) else {
                call.reject("NATIVE_PROFILE_SUPPORT_STALE_RETIREMENT"); return
            }
            if let scene = self.retiringForms.values.first(where: { $0.identity == identity && $0.sceneName == "support" && $0.receipt("retired")["destinationId"] as? String == destination }) {
                scene.retire { call.resolve(scene.receipt("retired")) }; return
            }
            if let scene = self.supportScene {
                guard scene.identity == identity, scene.model.projection.destinationId == destination else { call.reject("NATIVE_PROFILE_SUPPORT_STALE_RETIREMENT"); return }
                self.retireProfileForm { call.resolve(scene.receipt("retired")) }; return
            }
            guard self.sessionFence.contains(identity) else { call.reject("NATIVE_PROFILE_SUPPORT_STALE_RETIREMENT"); return }
            let owner = self.profileFormOwnerKey(identity)
            if self.formOwner != owner { self.formOwner = owner; self.formRevision = 0 }
            self.formRevision = max(self.formRevision, identity.revision)
            var receipt = self.retiredReceipt(identity, lease: NativeDrawerLease())
            receipt["scene"] = "support"; receipt["destinationId"] = destination
            call.resolve(receipt)
        }
    }
}
