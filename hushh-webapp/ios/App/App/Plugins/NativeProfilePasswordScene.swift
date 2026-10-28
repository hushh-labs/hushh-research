import SwiftUI
import UIKit

/// Private protected form: no network, logging, persistence or Vault keys.
struct NativePasswordProjection: Decodable {
    let documentId: String
    let ownerEpoch: String
    let ownerGeneration: Int
    let revision: Int
    let family: String
    let scene: String
    let destinationId: String
    let updateSequence: Int
    let privacyGeneration: Int
    let acknowledgedEditRevision: Int
    let password: String
    let confirmation: String
    let canSave: Bool
    let busy: Bool
    let appearance: String
    let accentHex: String
    let foregroundHex: String
    var identity: NativeDrawerIdentity {
        NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, family: family)
    }
    static let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId",
        "updateSequence", "privacyGeneration", "acknowledgedEditRevision", "password", "confirmation", "canSave", "busy", "appearance", "accentHex", "foregroundHex"]
    var valid: Bool {
        let maximum = HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
        return identity.valid && family == "profile" && scene == "vault-passphrase" && NativeDrawerIdentity.identifier(destinationId) &&
            updateSequence > 0 && updateSequence <= maximum && [privacyGeneration, acknowledgedEditRevision].allSatisfy { $0 >= 0 && $0 <= maximum } &&
            password.utf16.count <= 4096 && confirmation.utf16.count <= 4096 &&
            (!canSave || password.utf16.count >= 8 && password == confirmation) &&
            HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil
    }
    func receipt(_ phase: String) -> [String: Any] {
        ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration, "revision": revision,
         "family": family, "scene": scene, "destinationId": destinationId, "updateSequence": updateSequence,
         "privacyGeneration": privacyGeneration, "phase": phase]
    }
    var cleared: Self {
        Self(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision,
            family: family, scene: scene, destinationId: destinationId, updateSequence: updateSequence, privacyGeneration: privacyGeneration,
            acknowledgedEditRevision: acknowledgedEditRevision, password: "", confirmation: "", canSave: false, busy: false,
            appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex)
    }
}

@MainActor final class NativePasswordModel: ObservableObject {
    private(set) var projection: NativePasswordProjection
    @Published private(set) var password: String
    @Published private(set) var confirmation: String
    @Published private(set) var composing = false
    @Published private(set) var editRevision = 0
    @Published private(set) var pending: NativeProfileNameAction?
    @Published private(set) var retired = false
    @Published private(set) var appearanceRevision = 0
    private var sequence = 0
    private var confirmed = 0
    weak var passwordField: UITextField?
    weak var confirmationField: UITextField?
    var edit: ((String, String, Bool, Int) -> Bool)?
    var choose: ((NativeProfileNameAction) -> Bool)?
    var canEdit: Bool { !retired && !projection.busy && pending == nil }
    var canSave: Bool { canEdit && !composing && projection.canSave && projection.acknowledgedEditRevision == editRevision }
    var accent: UIColor { HushhNativeControlAppearance.color(projection.accentHex) ?? .label }
    init(_ projection: NativePasswordProjection) {
        self.projection = projection; password = projection.password; confirmation = projection.confirmation
    }
    func update(_ next: NativePasswordProjection) -> Bool {
        guard !retired, next.valid, next.identity == projection.identity, next.destinationId == projection.destinationId,
              next.privacyGeneration == projection.privacyGeneration, next.updateSequence > projection.updateSequence,
              next.acknowledgedEditRevision >= projection.acknowledgedEditRevision, next.acknowledgedEditRevision <= editRevision else { return false }
        projection = next
        if next.acknowledgedEditRevision == editRevision && !composing { password = next.password; confirmation = next.confirmation }
        appearanceRevision += 1
        return true
    }
    func capture() {
        guard canEdit else { return }
        let first = passwordField?.text ?? password, second = confirmationField?.text ?? confirmation
        let marked = passwordField?.markedTextRange != nil || confirmationField?.markedTextRange != nil
        guard first != password || second != confirmation || marked != composing else { return }
        guard first.utf16.count <= 4096, second.utf16.count <= 4096,
              editRevision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        password = first; confirmation = second; composing = marked; editRevision += 1
        if edit?(first, second, marked, editRevision) != true { clear() }
    }
    func action(_ value: String) {
        // Capture any committed final field change before authorizing Save.
        capture()
        guard canEdit, value == "cancel" || value == "save" && canSave,
              sequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        sequence += 1
        let action = NativeProfileNameAction(updateSequence: projection.updateSequence, editRevision: editRevision, sequence: sequence, action: value)
        pending = action
        if choose?(action) != true { pending = nil }
    }
    func confirm(_ action: NativeProfileNameAction) -> Bool {
        guard !retired, pending == action, action.sequence > confirmed, !projection.busy,
              (action.action == "cancel" ? action.updateSequence <= projection.updateSequence : action.updateSequence == projection.updateSequence),
              action.action == "cancel" || !composing && projection.canSave && action.editRevision == editRevision && projection.acknowledgedEditRevision == editRevision else { return false }
        confirmed = action.sequence; return true
    }
    func settle(_ action: NativeProfileNameAction) -> Bool {
        guard !retired, pending == action else { return false }
        pending = nil; return true
    }
    func clear() {
        retired = true
        for field in [passwordField, confirmationField].compactMap({ $0 }) {
            field.unmarkText(); field.resignFirstResponder(); field.text = ""; field.undoManager?.removeAllActions()
        }
        password = ""; confirmation = ""; projection = projection.cleared
        pending = nil; edit = nil; choose = nil
    }
}

@available(iOS 26.0, *) private struct NativePasswordField: UIViewRepresentable {
    @ObservedObject var model: NativePasswordModel
    let confirmation: Bool
    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.isSecureTextEntry = true
        field.textContentType = .newPassword
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.font = .preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.returnKeyType = confirmation ? .done : .next
        field.placeholder = confirmation ? "Confirm password" : "New password"
        field.accessibilityLabel = field.placeholder
        field.accessibilityIdentifier = confirmation ? "native-profile-password-confirmation" : "native-profile-password-editor"
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed), for: .editingChanged)
        if confirmation { model.confirmationField = field } else { model.passwordField = field }
        return field
    }
    func updateUIView(_ field: UITextField, context: Context) {
        field.isEnabled = model.canEdit; field.textColor = .label; field.tintColor = model.accent
        let text = confirmation ? model.confirmation : model.password
        if field.markedTextRange == nil && field.text != text {
            let offset = field.selectedTextRange.map { field.offset(from: field.beginningOfDocument, to: $0.start) }
            field.text = text
            if let offset, let position = field.position(from: field.beginningOfDocument, offset: min(offset, text.utf16.count)) {
                field.selectedTextRange = field.textRange(from: position, to: position)
            }
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator(model, confirmation) }
    static func dismantleUIView(_ field: UITextField, coordinator: Coordinator) {
        field.delegate = nil; field.removeTarget(coordinator, action: #selector(Coordinator.changed), for: .editingChanged)
        field.resignFirstResponder(); field.text = ""; field.undoManager?.removeAllActions()
    }
    final class Coordinator: NSObject, UITextFieldDelegate {
        let model: NativePasswordModel
        let confirmation: Bool
        init(_ model: NativePasswordModel, _ confirmation: Bool) { self.model = model; self.confirmation = confirmation }
        @objc func changed() { model.capture() }
        func textFieldDidChangeSelection(_ field: UITextField) { model.capture() }
        func textField(_ field: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
            guard model.canEdit, let text = field.text as NSString?, range.location <= text.length, range.length <= text.length - range.location else { return false }
            return text.replacingCharacters(in: range, with: string).utf16.count <= 4096
        }
        func textFieldShouldReturn(_ field: UITextField) -> Bool {
            guard field.markedTextRange == nil else { return false }
            model.capture()
            if confirmation { field.resignFirstResponder() } else { model.confirmationField?.becomeFirstResponder() }
            return false
        }
    }
}

@available(iOS 26.0, *) private struct NativePasswordContent: View {
    @ObservedObject var model: NativePasswordModel
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { model.action("cancel") } label: { Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44) }
                    .buttonStyle(.glass).accessibilityLabel("Cancel password change").accessibilityIdentifier("native-profile-password-cancel").disabled(!model.canEdit)
                Spacer(minLength: 12)
                Text("Change password").font(.headline).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                Button("Save") { model.action("save") }.buttonStyle(.glassProminent).frame(minWidth: 44, minHeight: 44)
                    .disabled(!model.canSave).accessibilityIdentifier("native-profile-password-save")
            }.padding(.horizontal, 16).padding(.vertical, 8)
            Form {
                Section { NativePasswordField(model: model, confirmation: false).frame(minHeight: 44)
                    NativePasswordField(model: model, confirmation: true).frame(minHeight: 44)
                } footer: { Text("Use at least 8 characters. Your other unlock methods stay available.") }
                if model.projection.busy { ProgressView("Saving…") }
            }
        }.tint(Color(uiColor: model.accent)).preferredColorScheme(model.projection.appearance == "dark" ? .dark : .light)
    }
}

@MainActor final class NativeProfilePasswordScene: NSObject, NativeProfileOwnedForm {
    let model: NativePasswordModel
    var identity: NativeDrawerIdentity { model.projection.identity }
    var sceneName: String { "vault-passphrase" }
    func receipt(_ phase: String) -> [String: Any] { model.projection.receipt(phase) }
    private lazy var sheet: NativeProfileOwnedSheet = {
        let model = model
        return NativeProfileOwnedSheet(makeHost: { [weak model] in
            guard #available(iOS 26.0, *), let model else { return nil }
            return UIHostingController(rootView: NativePasswordContent(model: model))
        }, canPresent: { [weak model] in model?.retired == false }, canDismiss: { [weak model] in model?.canEdit == true },
        hasPending: { [weak model] in model?.pending != nil }, appearance: { [weak model] in
            guard let model else { return nil }
            return HushhNativeControlAppearance(appearance: model.projection.appearance, accentHex: model.projection.accentHex, foregroundHex: model.projection.foregroundHex)
        }, cancel: { [weak model] in model?.action("cancel") }, clear: { [weak model] in model?.clear() })
    }()
    var coverage: (() -> Void)? { didSet { sheet.coverage = coverage } }
    var coversPresentation: Bool { sheet.coversPresentation }
    var presentationSettled: Bool { sheet.presentationSettled }
    var feedbackPresenter: UIViewController? { sheet.feedbackPresenter }
    func refreshPrivacy() { sheet.refresh() }
    init(_ projection: NativePasswordProjection) { model = NativePasswordModel(projection) }
    func present(from parent: UIViewController, completion: @escaping (Bool) -> Void) -> Bool { sheet.present(from: parent, completion: completion) }
    func update(_ projection: NativePasswordProjection) -> Bool { guard model.update(projection) else { return false }; sheet.refresh(); return true }
    func settle(_ action: NativeProfileNameAction) -> Bool { guard model.settle(action) else { return false }; sheet.refresh(); return true }
    func retire(completion: @escaping () -> Void) { sheet.retire(completion: completion) }
}
