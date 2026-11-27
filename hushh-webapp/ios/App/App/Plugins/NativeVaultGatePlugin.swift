import Capacitor
import SwiftUI
import UIKit

struct NativeVaultGateIdentity: Equatable {
    let documentId: String
    let ownerEpoch: String
    let ownerGeneration: Int
    let revision: Int
    let destinationId: String

    static let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "scene", "destinationId"]
    var valid: Bool {
        NativeDrawerIdentity.identifier(documentId) && NativeDrawerIdentity.identifier(ownerEpoch) &&
            NativeDrawerIdentity.identifier(destinationId) && ownerGeneration > 0 && revision > 0 &&
            [ownerGeneration, revision].allSatisfy { $0 <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration }
    }
    func payload() -> [String: Any] {
        ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration,
         "revision": revision, "scene": "vault-hard-gate", "destinationId": destinationId]
    }
}

struct NativeVaultGateProjection {
    static let identityKeys = NativeVaultGateIdentity.keys
    static let keys: Set<String> = identityKeys.union([
        "updateSequence", "privacyGeneration", "acknowledgedEditRevision", "step", "title", "description",
        "password", "confirmation", "recoveryKeyInput", "recoveryKey", "error", "primaryLabel", "primaryEnabled",
        "busy", "busyLabel", "showPasswordUnlock", "showGeneratedUnlock", "generatedUnlockLabel",
        "generatedUnlockEnabled", "showRecoveryAction", "showSignOut", "signOutBusy", "showLostVaultDelete",
        "showCopy", "copied", "showDownload", "showRecoverySaved", "savedLabel", "quickMethodLabel",
        "quickMethodBody", "quickMethodEnabled", "skipMethodLabel", "showCreateQuickUnlock", "createWantsQuickUnlock",
        "createQuickUnlockLabel", "appearance", "accentHex", "foregroundHex"
    ])

    let identity: NativeVaultGateIdentity
    let updateSequence: Int
    let privacyGeneration: Int
    let acknowledgedEditRevision: Int
    let step: String
    let title: String
    let description: String
    var password: String
    var confirmation: String
    var recoveryKeyInput: String
    var recoveryKey: String
    let error: String
    let primaryLabel: String
    let primaryEnabled: Bool
    let busy: Bool
    let busyLabel: String
    let showPasswordUnlock: Bool
    let showGeneratedUnlock: Bool
    let generatedUnlockLabel: String
    let generatedUnlockEnabled: Bool
    let showRecoveryAction: Bool
    let showSignOut: Bool
    let signOutBusy: Bool
    let showLostVaultDelete: Bool
    let showCopy: Bool
    let copied: Bool
    let showDownload: Bool
    let showRecoverySaved: Bool
    let savedLabel: String
    let quickMethodLabel: String
    let quickMethodBody: String
    let quickMethodEnabled: Bool
    let skipMethodLabel: String
    let showCreateQuickUnlock: Bool
    let createWantsQuickUnlock: Bool
    let createQuickUnlockLabel: String
    let appearance: String
    let accentHex: String
    let foregroundHex: String

    init?(_ raw: [String: Any]) {
        guard Set(raw.keys) == Self.keys,
              let documentId = raw["documentId"] as? String, let ownerEpoch = raw["ownerEpoch"] as? String,
              let ownerGeneration = raw["ownerGeneration"] as? Int, let revision = raw["revision"] as? Int,
              raw["scene"] as? String == "vault-hard-gate", let destinationId = raw["destinationId"] as? String,
              let updateSequence = raw["updateSequence"] as? Int, let privacyGeneration = raw["privacyGeneration"] as? Int,
              let acknowledgedEditRevision = raw["acknowledgedEditRevision"] as? Int,
              let step = raw["step"] as? String, let title = raw["title"] as? String,
              let description = raw["description"] as? String, let password = raw["password"] as? String,
              let confirmation = raw["confirmation"] as? String, let recoveryKeyInput = raw["recoveryKeyInput"] as? String,
              let recoveryKey = raw["recoveryKey"] as? String, let error = raw["error"] as? String,
              let primaryLabel = raw["primaryLabel"] as? String, let primaryEnabled = raw["primaryEnabled"] as? Bool,
              let busy = raw["busy"] as? Bool, let busyLabel = raw["busyLabel"] as? String,
              let showPasswordUnlock = raw["showPasswordUnlock"] as? Bool, let showGeneratedUnlock = raw["showGeneratedUnlock"] as? Bool,
              let generatedUnlockLabel = raw["generatedUnlockLabel"] as? String, let generatedUnlockEnabled = raw["generatedUnlockEnabled"] as? Bool,
              let showRecoveryAction = raw["showRecoveryAction"] as? Bool, let showSignOut = raw["showSignOut"] as? Bool,
              let signOutBusy = raw["signOutBusy"] as? Bool, let showLostVaultDelete = raw["showLostVaultDelete"] as? Bool,
              let showCopy = raw["showCopy"] as? Bool, let copied = raw["copied"] as? Bool,
              let showDownload = raw["showDownload"] as? Bool, let showRecoverySaved = raw["showRecoverySaved"] as? Bool,
              let savedLabel = raw["savedLabel"] as? String, let quickMethodLabel = raw["quickMethodLabel"] as? String,
              let quickMethodBody = raw["quickMethodBody"] as? String, let quickMethodEnabled = raw["quickMethodEnabled"] as? Bool,
              let skipMethodLabel = raw["skipMethodLabel"] as? String, let appearance = raw["appearance"] as? String,
              let showCreateQuickUnlock = raw["showCreateQuickUnlock"] as? Bool,
              let createWantsQuickUnlock = raw["createWantsQuickUnlock"] as? Bool,
              let createQuickUnlockLabel = raw["createQuickUnlockLabel"] as? String,
              let accentHex = raw["accentHex"] as? String, let foregroundHex = raw["foregroundHex"] as? String else { return nil }
        let identity = NativeVaultGateIdentity(documentId: documentId, ownerEpoch: ownerEpoch,
            ownerGeneration: ownerGeneration, revision: revision, destinationId: destinationId)
        guard identity.valid, updateSequence > 0 && updateSequence <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
              [privacyGeneration, acknowledgedEditRevision].allSatisfy({ $0 >= 0 && $0 <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration }),
              ["create", "unlock", "recovery", "recovery-disclosure", "method"].contains(step),
              title.utf16.count <= 128, description.utf16.count <= 256, error.utf16.count <= 512,
              password.utf16.count <= 4096, confirmation.utf16.count <= 4096,
              recoveryKeyInput.utf16.count <= 256, recoveryKey.utf16.count <= 256,
              [primaryLabel, busyLabel, generatedUnlockLabel, savedLabel, quickMethodLabel, quickMethodBody, skipMethodLabel, createQuickUnlockLabel].allSatisfy({ $0.utf16.count <= 512 }),
              HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil else { return nil }
        self.identity = identity; self.updateSequence = updateSequence; self.privacyGeneration = privacyGeneration
        self.acknowledgedEditRevision = acknowledgedEditRevision; self.step = step; self.title = title
        self.description = description; self.password = password; self.confirmation = confirmation
        self.recoveryKeyInput = recoveryKeyInput; self.recoveryKey = recoveryKey; self.error = error
        self.primaryLabel = primaryLabel; self.primaryEnabled = primaryEnabled; self.busy = busy
        self.busyLabel = busyLabel; self.showPasswordUnlock = showPasswordUnlock
        self.showGeneratedUnlock = showGeneratedUnlock; self.generatedUnlockLabel = generatedUnlockLabel
        self.generatedUnlockEnabled = generatedUnlockEnabled; self.showRecoveryAction = showRecoveryAction
        self.showSignOut = showSignOut; self.signOutBusy = signOutBusy; self.showLostVaultDelete = showLostVaultDelete
        self.showCopy = showCopy; self.copied = copied; self.showDownload = showDownload
        self.showRecoverySaved = showRecoverySaved; self.savedLabel = savedLabel; self.quickMethodLabel = quickMethodLabel
        self.quickMethodBody = quickMethodBody; self.quickMethodEnabled = quickMethodEnabled
        self.skipMethodLabel = skipMethodLabel; self.showCreateQuickUnlock = showCreateQuickUnlock
        self.createWantsQuickUnlock = createWantsQuickUnlock; self.createQuickUnlockLabel = createQuickUnlockLabel
        self.appearance = appearance
        self.accentHex = accentHex; self.foregroundHex = foregroundHex
    }

    func receipt(_ phase: String) -> [String: Any] {
        var value = identity.payload(); value["updateSequence"] = updateSequence
        value["privacyGeneration"] = privacyGeneration; value["phase"] = phase
        return value
    }
}

struct NativeVaultGateAction: Equatable {
    let editRevision: Int
    let sequence: Int
    let action: String
    static let names: Set<String> = ["primary", "password", "generated_unlock", "recovery", "sign_out", "delete_lost_vault",
        "copy_recovery", "download_recovery", "recovery_saved", "enable_quick_unlock", "skip_quick_unlock", "toggle_quick_unlock"]
}

@MainActor final class NativeVaultGateModel: ObservableObject {
    @Published private(set) var projection: NativeVaultGateProjection
    @Published private(set) var password: String
    @Published private(set) var confirmation: String
    @Published private(set) var recoveryKeyInput: String
    @Published private(set) var composing = false
    @Published private(set) var retired = false
    private(set) var editRevision = 0
    private var actionSequence = 0
    private var confirmedActionSequence = 0
    @Published private var pendingAction: NativeVaultGateAction?
    private var committed = [String: String]()
    private var suppressCapture = 0
    private let editMenus = NativeEditorMenuLifetime()
    weak var passwordField: UITextField?
    weak var confirmationField: UITextField?
    weak var recoveryField: UITextField?
    var onEdit: ((String, String, String, Bool, Int) -> Bool)?
    var onAction: ((NativeVaultGateAction) -> Bool)?
    func editMenuPresented(_ field: UITextField) { editMenus.presented(field) }
    func beginEditMenuDismissal(_ field: UITextField) -> UUID? { editMenus.beginDismissal(field) }
    func editMenuDismissed(_ field: UITextField, token: UUID) { editMenus.dismissed(field, token: token) }

    init(_ projection: NativeVaultGateProjection) {
        self.projection = projection; password = projection.password; confirmation = projection.confirmation
        recoveryKeyInput = projection.recoveryKeyInput
        committed = ["password": projection.password, "confirmation": projection.confirmation, "recoveryKeyInput": projection.recoveryKeyInput]
    }
    var canEdit: Bool { !retired && !projection.busy && pendingAction == nil }
    var canChoose: Bool {
        canEdit && !composing && projection.acknowledgedEditRevision == editRevision
    }
    var accent: UIColor { HushhNativeControlAppearance.color(projection.accentHex) ?? .label }
    var foreground: UIColor { HushhNativeControlAppearance.color(projection.foregroundHex) ?? .label }

    func update(_ next: NativeVaultGateProjection) -> Bool {
        guard !retired, next.identity == projection.identity, next.privacyGeneration == projection.privacyGeneration,
              next.updateSequence > projection.updateSequence, next.acknowledgedEditRevision >= projection.acknowledgedEditRevision,
              next.acknowledgedEditRevision <= editRevision else { return false }
        projection = next
        if next.acknowledgedEditRevision == editRevision && !composing {
            setFields(password: next.password, confirmation: next.confirmation, recovery: next.recoveryKeyInput)
            committed = ["password": next.password, "confirmation": next.confirmation, "recoveryKeyInput": next.recoveryKeyInput]
        }
        return true
    }
    private func setFields(password: String, confirmation: String, recovery: String) {
        self.password = password; self.confirmation = confirmation; recoveryKeyInput = recovery
    }
    func capture() {
        guard canEdit, suppressCapture == 0 else { return }
        let first = passwordField?.text ?? password, second = confirmationField?.text ?? confirmation
        let recovery = recoveryField?.text ?? recoveryKeyInput
        let marked = passwordField?.markedTextRange != nil || confirmationField?.markedTextRange != nil || recoveryField?.markedTextRange != nil
        if marked {
            guard !composing, editRevision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
            composing = true; editRevision += 1
            if onEdit?(committed["password"] ?? "", committed["confirmation"] ?? "", committed["recoveryKeyInput"] ?? "", true, editRevision) != true { scrub() }
            return
        }
        guard first != password || second != confirmation || recovery != recoveryKeyInput || composing else { return }
        guard first.utf16.count <= 4096, second.utf16.count <= 4096, recovery.utf16.count <= 256,
              editRevision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { scrub(); return }
        setFields(password: first, confirmation: second, recovery: recovery); composing = false; editRevision += 1
        committed = ["password": first, "confirmation": second, "recoveryKeyInput": recovery]
        if onEdit?(first, second, recovery, false, editRevision) != true { scrub() }
    }
    func choose(_ name: String) {
        capture()
        guard canChoose, NativeVaultGateAction.names.contains(name),
              actionIsAvailable(name),
              actionSequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        actionSequence += 1
        let action = NativeVaultGateAction(editRevision: editRevision, sequence: actionSequence, action: name)
        pendingAction = action
        if onAction?(action) != true { pendingAction = nil }
    }
    private func actionIsAvailable(_ name: String) -> Bool {
        switch name {
        case "primary": return projection.primaryEnabled && projection.step != "recovery-disclosure"
        case "password": return projection.showPasswordUnlock
        case "generated_unlock": return projection.showGeneratedUnlock && projection.generatedUnlockEnabled
        case "recovery": return projection.showRecoveryAction
        case "sign_out": return projection.showSignOut && !projection.signOutBusy
        case "delete_lost_vault": return projection.showLostVaultDelete
        case "copy_recovery": return projection.showCopy
        case "download_recovery": return projection.showDownload
        case "recovery_saved": return projection.showRecoverySaved
        case "enable_quick_unlock": return projection.step == "method" && projection.quickMethodEnabled
        case "skip_quick_unlock": return projection.step == "method"
        case "toggle_quick_unlock": return projection.step == "create" && projection.showCreateQuickUnlock
        default: return false
        }
    }
    func confirm(_ action: NativeVaultGateAction) -> Bool {
        guard !retired, pendingAction == action, action.sequence > confirmedActionSequence,
              action.editRevision == editRevision, projection.acknowledgedEditRevision == editRevision,
              !composing, !projection.busy else { return false }
        confirmedActionSequence = action.sequence
        return true
    }
    func settle(_ action: NativeVaultGateAction) -> Bool {
        guard !retired, pendingAction == action, action.sequence == confirmedActionSequence else { return false }
        pendingAction = nil
        return true
    }
    func scrub() {
        retired = true; pendingAction = nil
        projection.password = ""; projection.confirmation = ""; projection.recoveryKeyInput = ""; projection.recoveryKey = ""
        suppressCapture += 1
        [passwordField, confirmationField, recoveryField].compactMap { $0 }.forEach {
            $0.text = ""; $0.resignFirstResponder()
        }
        suppressCapture -= 1
        setFields(password: "", confirmation: "", recovery: ""); committed = [:]; composing = false
    }
    func retire(completion: @escaping () -> Void) {
        scrub()
        editMenus.dismiss([passwordField, confirmationField, recoveryField].compactMap { $0 }, completion: completion)
    }
}

@MainActor private struct NativeVaultGateTextField: UIViewRepresentable {
    @ObservedObject var model: NativeVaultGateModel
    let field: String
    let placeholder: String
    let secure: Bool
    var value: String {
        switch field { case "password": model.password; case "confirmation": model.confirmation; default: model.recoveryKeyInput }
    }
    private var contentType: UITextContentType? {
        guard field == "password" else { return nil }
        return model.projection.step == "create" ? .newPassword : .password
    }
    private var returnKeyType: UIReturnKeyType {
        switch (field, model.projection.step) {
        case ("password", "create"): .next
        case ("confirmation", "create"), ("password", "unlock"): .go
        default: .default
        }
    }
    func makeUIView(context: Context) -> UITextField {
        let input = UITextField(); input.delegate = context.coordinator; input.text = value
        input.isSecureTextEntry = secure; input.placeholder = placeholder; input.borderStyle = .roundedRect
        input.autocorrectionType = .no; input.autocapitalizationType = field == "recoveryKeyInput" ? .allCharacters : .none
        input.textContentType = contentType; input.returnKeyType = returnKeyType
        input.addTarget(context.coordinator, action: #selector(Coordinator.changed), for: .editingChanged)
        input.accessibilityIdentifier = "native-vault-gate-\(field)"
        context.coordinator.attach(input)
        return input
    }
    func updateUIView(_ view: UITextField, context: Context) {
        if view.text != value { NativeTextFieldProjection.apply(value, to: view) }
        view.isEnabled = model.canEdit
        if view.isSecureTextEntry != secure { view.isSecureTextEntry = secure }
        view.textContentType = contentType; view.returnKeyType = returnKeyType
    }
    func makeCoordinator() -> Coordinator { Coordinator(model: model, field: field) }
    @MainActor final class Coordinator: NSObject, UITextFieldDelegate {
        let model: NativeVaultGateModel; let field: String
        init(model: NativeVaultGateModel, field: String) { self.model = model; self.field = field }
        func attach(_ value: UITextField) {
            switch field { case "password": model.passwordField = value; case "confirmation": model.confirmationField = value; default: model.recoveryField = value }
        }
        @objc func changed() { model.capture() }
        func textFieldDidChangeSelection(_ textField: UITextField) { model.capture() }
        func textField(_ textField: UITextField, willPresentEditMenuWith animator: any UIEditMenuInteractionAnimating) {
            model.editMenuPresented(textField)
        }
        func textField(_ textField: UITextField, willDismissEditMenuWith animator: any UIEditMenuInteractionAnimating) {
            let model = model
            guard let token = model.beginEditMenuDismissal(textField) else { return }
            animator.addCompletion { model.editMenuDismissed(textField, token: token) }
        }
        func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
            guard model.canEdit, let text = textField.text as NSString?, range.location <= text.length,
                  range.length <= text.length - range.location else { return false }
            let limit = field == "recoveryKeyInput" ? 256 : 4096
            return text.replacingCharacters(in: range, with: string).utf16.count <= limit
        }
        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            guard textField.markedTextRange == nil, !model.composing else { return false }
            switch (field, model.projection.step) {
            case ("password", "create"):
                model.capture()
                guard model.canEdit else { return false }
                model.confirmationField?.becomeFirstResponder()
            case ("confirmation", "create"), ("password", "unlock"):
                // choose() captures once and keeps the action behind the edit acknowledgement fence.
                model.choose("primary")
            default:
                model.capture()
                textField.resignFirstResponder()
            }
            return false
        }
    }
}

@available(iOS 26.0, *) @MainActor struct NativeVaultGateContent: View {
    @ObservedObject var model: NativeVaultGateModel
    var body: some View {
        let state = model.projection
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text(state.title).font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                if !state.description.isEmpty { Text(state.description).foregroundStyle(.secondary) }
                if ["create", "unlock"].contains(state.step) {
                    NativeVaultGateTextField(model: model, field: "password", placeholder: "Password", secure: true)
                    if state.step == "create" { NativeVaultGateTextField(model: model, field: "confirmation", placeholder: "Confirm password", secure: true) }
                }
                if state.step == "recovery" { NativeVaultGateTextField(model: model, field: "recoveryKeyInput", placeholder: "Recovery key", secure: false) }
                if state.step == "create" && state.showCreateQuickUnlock {
                    Button { model.choose("toggle_quick_unlock") } label: {
                        Label(state.createQuickUnlockLabel, systemImage: state.createWantsQuickUnlock ? "checkmark.circle.fill" : "circle")
                    }.disabled(!model.canChoose)
                }
                if state.step == "recovery-disclosure" && !state.recoveryKey.isEmpty {
                    Text(state.recoveryKey).textSelection(.enabled).font(.system(.body, design: .monospaced))
                }
                if !state.error.isEmpty { Text(state.error).foregroundStyle(.red).accessibilityAddTraits(.updatesFrequently) }
                if state.busy { ProgressView(state.busyLabel) }
                if state.step != "recovery-disclosure" {
                    Button(state.primaryLabel) { model.choose("primary") }
                        .buttonStyle(.borderedProminent).disabled(!state.primaryEnabled || !model.canChoose)
                }
                if state.showPasswordUnlock { Button("Unlock with password") { model.choose("password") }.disabled(!model.canChoose) }
                if state.showGeneratedUnlock { Button(state.generatedUnlockLabel) { model.choose("generated_unlock") }.disabled(!state.generatedUnlockEnabled || !model.canChoose) }
                if state.showRecoveryAction { Button("Use recovery key") { model.choose("recovery") }.disabled(!model.canChoose) }
                if state.showSignOut { Button("Sign out") { model.choose("sign_out") }.disabled(!model.canChoose || state.signOutBusy) }
                if state.showLostVaultDelete { Button("Delete lost vault", role: .destructive) { model.choose("delete_lost_vault") }.disabled(!model.canChoose) }
                if state.showCopy { Button(state.copied ? "Copied" : "Copy recovery key") { model.choose("copy_recovery") }.disabled(!model.canChoose) }
                if state.showDownload { Button("Download recovery key") { model.choose("download_recovery") }.disabled(!model.canChoose) }
                if state.showRecoverySaved { Button(state.savedLabel) { model.choose("recovery_saved") }.disabled(!model.canChoose) }
                if state.step == "method" {
                    Button(state.quickMethodLabel) { model.choose("enable_quick_unlock") }.disabled(!state.quickMethodEnabled || !model.canChoose)
                    if !state.quickMethodBody.isEmpty { Text(state.quickMethodBody).foregroundStyle(.secondary) }
                    Button(state.skipMethodLabel) { model.choose("skip_quick_unlock") }.disabled(!model.canChoose)
                }
            }.frame(maxWidth: 520, alignment: .leading).padding(.horizontal, 24).padding(.vertical, 32)
                .frame(maxWidth: .infinity, minHeight: UIScreen.main.bounds.height, alignment: .top)
        }
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        .scrollDismissesKeyboard(.interactively)
        .tint(Color(uiColor: model.accent))
        .foregroundStyle(Color(uiColor: model.foreground))
        .preferredColorScheme(state.appearance == "dark" ? .dark : .light)
        .interactiveDismissDisabled(true)
        .background(PreventVaultGateDismissal())
    }
}

@available(iOS 26.0, *) private struct PreventVaultGateDismissal: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController { Controller() }
    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}
    private final class Controller: UIViewController {
        override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); parent?.isModalInPresentation = true }
    }
}

@objc(HushhNativeVaultGatePlugin)
final class NativeVaultGatePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "HushhNativeVaultGatePlugin"
    let jsName = "HushhNativeVaultGate"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyVaultGateScene", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmVaultGateAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "settleVaultGateAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retireVaultGateScene", returnType: CAPPluginReturnPromise),
    ]
    private var model: NativeVaultGateModel?
    private weak var host: UIViewController?
    private var presented: UIViewController?
    private var observations = [NSObjectProtocol]()
    private var highestRevisionByOwner = [String: Int]()
    private var retiring = false
    private var retirementRequiresEvent = false
    private var retirementCompletions = [([String: Any]) -> Void]()

    override func load() {
        super.load()
        let center = NotificationCenter.default
        observations.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.retireForInvalidation() }
        })
        observations.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor [weak self] in self?.retireForInvalidation() }
        })
        observations.append(center.addObserver(forName: HushhSessionPrivacyShield.presentationDidChange, object: nil, queue: .main) { [weak self] _ in
            guard HushhSessionPrivacyShield.shared.snapshot().shielded else { return }
            Task { @MainActor [weak self] in self?.retireForInvalidation() }
        })
    }
    deinit { observations.forEach(NotificationCenter.default.removeObserver) }

    @objc func getCapabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let eligible = NativeDrawerQualificationPolicy.deviceEligible
            call.resolve(["available": eligible])
        }
    }
    @objc func applyVaultGateScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.retiring, #available(iOS 26.0, *), NativeDrawerQualificationPolicy.deviceEligible,
                  let parent = self.bridge?.viewController as? MyViewController,
                  let raw = call.options as? [String: Any], JSONSerialization.isValidJSONObject(raw),
                  let bytes = try? JSONSerialization.data(withJSONObject: raw), bytes.count <= 65_536,
                  let next = NativeVaultGateProjection(raw), parent.authorizesNativeDocument(next.identity.documentId),
                  HushhSessionPrivacyShield.shared.snapshot().appIsActive,
                  !HushhSessionPrivacyShield.shared.snapshot().shielded,
                  HushhSessionPrivacyShield.shared.snapshot().generation == next.privacyGeneration else {
                call.reject("NATIVE_VAULT_GATE_UNAVAILABLE"); return
            }
            let ownerKey = "\(next.identity.documentId):\(next.identity.ownerEpoch):\(next.identity.ownerGeneration)"
            if let scene = self.model {
                guard scene.projection.identity == next.identity, scene.projection.privacyGeneration == next.privacyGeneration,
                      scene.update(next) else { call.reject("NATIVE_VAULT_GATE_STALE_STATE"); return }
                call.resolve(next.receipt("active")); return
            }
            guard self.presented == nil, next.acknowledgedEditRevision == 0,
                  next.identity.revision > (self.highestRevisionByOwner[ownerKey] ?? 0) else {
                call.reject("NATIVE_VAULT_GATE_RETIRED"); return
            }
            let scene = NativeVaultGateModel(next); self.model = scene; self.host = parent; self.retiring = false
            self.highestRevisionByOwner[ownerKey] = next.identity.revision
            scene.onEdit = { [weak self, weak scene] password, confirmation, recovery, composing, revision in
                guard let self, let scene, self.model === scene, self.current(scene) else { return false }
                var event = scene.projection.receipt("active"); event.removeValue(forKey: "phase")
                event["password"] = password; event["confirmation"] = confirmation; event["recoveryKeyInput"] = recovery
                event["composing"] = composing; event["editRevision"] = revision
                self.notifyListeners("vaultGateEdit", data: event, retainUntilConsumed: false); return true
            }
            scene.onAction = { [weak self, weak scene] action in
                guard let self, let scene, self.model === scene, self.current(scene) else { return false }
                var event = scene.projection.receipt("active"); event.removeValue(forKey: "phase")
                event["editRevision"] = action.editRevision; event["sequence"] = action.sequence; event["action"] = action.action
                self.notifyListeners("vaultGateAction", data: event, retainUntilConsumed: false); return true
            }
            let controller = UIHostingController(rootView: NativeVaultGateContent(model: scene))
            controller.view.backgroundColor = .systemBackground; controller.modalPresentationStyle = .fullScreen
            controller.isModalInPresentation = true; controller.view.accessibilityIdentifier = "native-vault-hard-gate"
            self.presented = controller
            parent.present(controller, animated: false) { [weak self, weak scene] in
                guard let self, let scene, self.model === scene, self.current(scene), controller.presentingViewController === parent else {
                    self?.retireForInvalidation(); call.reject("NATIVE_VAULT_GATE_RETIRED"); return
                }
                call.resolve(next.receipt("active"))
            }
        }
    }
    @objc func confirmVaultGateAction(_ call: CAPPluginCall) { action(call, settle: false) }
    @objc func settleVaultGateAction(_ call: CAPPluginCall) { action(call, settle: true) }
    private func action(_ call: CAPPluginCall, settle: Bool) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let scene = self.model, self.current(scene),
                  let action = self.readAction(call, scene: scene),
                  call.getInt("privacyGeneration") == scene.projection.privacyGeneration,
                  let updateSequence = call.getInt("updateSequence"), updateSequence > 0,
                  settle ? updateSequence <= scene.projection.updateSequence : updateSequence == scene.projection.updateSequence else {
                call.resolve(["valid": false]); return
            }
            call.resolve(["valid": settle ? scene.settle(action) : scene.confirm(action)])
        }
    }
    @MainActor private func readAction(_ call: CAPPluginCall, scene: NativeVaultGateModel) -> NativeVaultGateAction? {
        let expectedKeys = NativeVaultGateIdentity.keys.union(["updateSequence", "privacyGeneration", "editRevision", "sequence", "action"])
        guard let options = call.options as? [String: Any], Set(options.keys) == expectedKeys else { return nil }
        guard call.getString("documentId") == scene.projection.identity.documentId,
              call.getString("ownerEpoch") == scene.projection.identity.ownerEpoch,
              call.getInt("ownerGeneration") == scene.projection.identity.ownerGeneration,
              call.getInt("revision") == scene.projection.identity.revision,
              call.getString("scene") == "vault-hard-gate",
              call.getString("destinationId") == scene.projection.identity.destinationId,
              let editRevision = call.getInt("editRevision"), let sequence = call.getInt("sequence"),
              let name = call.getString("action"), NativeVaultGateAction.names.contains(name),
              editRevision >= 0, sequence > 0 else { return nil }
        return NativeVaultGateAction(editRevision: editRevision, sequence: sequence, action: name)
    }
    @objc func retireVaultGateScene(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let scene = self.model, self.matches(call, scene: scene) else { call.reject("NATIVE_VAULT_GATE_STALE_RETIREMENT"); return }
            self.retire(scene, notify: false) { receipt in call.resolve(receipt) }
        }
    }
    @MainActor private func matches(_ call: CAPPluginCall, scene: NativeVaultGateModel) -> Bool {
        let identity = scene.projection.identity
        let expectedKeys = NativeVaultGateIdentity.keys.union(["updateSequence", "privacyGeneration"])
        guard let options = call.options as? [String: Any], Set(options.keys) == expectedKeys else { return false }
        return call.getString("documentId") == identity.documentId && call.getString("ownerEpoch") == identity.ownerEpoch &&
            call.getInt("ownerGeneration") == identity.ownerGeneration && call.getInt("revision") == identity.revision &&
            call.getString("scene") == "vault-hard-gate" && call.getString("destinationId") == identity.destinationId &&
            call.getInt("updateSequence") == scene.projection.updateSequence &&
            call.getInt("privacyGeneration") == scene.projection.privacyGeneration
    }
    @MainActor func mainFrameDocumentDidCommit(_ documentId: String) {
        guard let scene = model, scene.projection.identity.documentId != documentId else { return }
        retire(scene, notify: true)
    }
    @MainActor private func current(_ scene: NativeVaultGateModel) -> Bool {
        guard model === scene, !scene.retired, !retiring,
              let parent = host as? MyViewController,
              parent.authorizesNativeDocument(scene.projection.identity.documentId) else { return false }
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        return privacy.appIsActive && !privacy.shielded && privacy.generation == scene.projection.privacyGeneration
    }
    @MainActor private func retireForInvalidation() { if let scene = model { retire(scene, notify: true) } }
    @MainActor private func retire(_ scene: NativeVaultGateModel, notify: Bool, completion: (([String: Any]) -> Void)? = nil) {
        guard model === scene else { completion?(scene.projection.receipt("retired")); return }
        if notify { retirementRequiresEvent = true }
        if let completion { retirementCompletions.append(completion) }
        guard !retiring else { return }
        retiring = true; scene.retire { [weak self, weak scene] in
            guard let self, let scene else { return }
            let receipt = scene.projection.receipt("retired")
            guard let controller = self.presented else {
                self.model = nil; self.host = nil; self.retiring = false
                self.finishRetirement(receipt); return
            }
            controller.dismiss(animated: false) { [weak self, weak scene] in
                guard let self, let scene else { return }
                if self.model === scene { self.model = nil; self.host = nil; self.presented = nil }
                self.retiring = false
                self.finishRetirement(receipt)
            }
        }
    }
    @MainActor private func finishRetirement(_ receipt: [String: Any]) {
        let shouldNotify = retirementRequiresEvent
        retirementRequiresEvent = false
        let completions = retirementCompletions
        retirementCompletions.removeAll()
        if shouldNotify { notifyListeners("vaultGateRetired", data: receipt, retainUntilConsumed: false) }
        completions.forEach { $0(receipt) }
    }
}
