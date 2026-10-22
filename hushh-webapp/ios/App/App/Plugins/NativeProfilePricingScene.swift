import SwiftUI
import UIKit

enum NativeProfilePricingDecimal {
    /// Only the active keyboard's decimal mark is normalized. Mixed notation
    /// stays invalid; the shared React cents parser remains authoritative.
    static func canonical(_ value: String, separator: String) -> String {
        guard !separator.isEmpty, separator != ".", !value.contains(".") else { return value }
        return value.replacingOccurrences(of: separator, with: ".")
    }
}

/// NativeDrawers v1 ordinary-form extension. All text is volatile private
/// presentation. This type has no network, credential or persistence port.
struct NativeProfilePricingProjection: Decodable {
    let documentId: String
    let ownerEpoch: String
    let ownerGeneration: Int
    let revision: Int
    let family: String
    let scene: String
    let updateSequence: Int
    let privacyGeneration: Int
    let draftRevision: Int
    let acknowledgedEditRevision: Int
    let draft: String
    let canSave: Bool
    let busy: Bool
    let error: String?
    let notice: String?
    let appearance: String
    let accentHex: String
    let foregroundHex: String
    let destinationId: String

    var identity: NativeDrawerIdentity {
        NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch,
            ownerGeneration: ownerGeneration, revision: revision, family: family)
    }
    static let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene",
        "updateSequence", "privacyGeneration", "draftRevision", "acknowledgedEditRevision", "draft", "canSave", "busy",
        "error", "notice", "appearance", "accentHex", "foregroundHex", "destinationId"]
    var valid: Bool {
        let maximum = HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
        return identity.valid && family == "profile" && scene == "request-price" &&
            NativeDrawerIdentity.identifier(destinationId) &&
            updateSequence > 0 && updateSequence <= maximum &&
            [privacyGeneration, draftRevision, acknowledgedEditRevision].allSatisfy { $0 >= 0 && $0 <= maximum } &&
            draft.utf16.count <= 32 && (error?.utf16.count ?? 0) <= 1024 && (notice?.utf16.count ?? 0) <= 1024 &&
            HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil
    }
    func receipt(phase: String) -> [String: Any] {
        var receipt: [String: Any] = ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration, "revision": revision,
         "family": family, "scene": scene, "updateSequence": updateSequence,
         "privacyGeneration": privacyGeneration, "phase": phase]
        receipt["destinationId"] = destinationId
        return receipt
    }
    var cleared: NativeProfilePricingProjection {
        NativeProfilePricingProjection(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration,
            revision: revision, family: family, scene: scene, updateSequence: updateSequence, privacyGeneration: privacyGeneration,
            draftRevision: draftRevision, acknowledgedEditRevision: acknowledgedEditRevision, draft: "", canSave: false,
            busy: false, error: nil, notice: nil, appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex, destinationId: destinationId)
    }
}

// Shared action metadata only; the Pricing projection and operation port stay
// feature-specific and cannot authorize an Account change.
typealias NativeProfilePricingAction = NativeProfileNameAction

@MainActor
final class NativeProfilePricingModel: ObservableObject {
    private(set) var projection: NativeProfilePricingProjection
    @Published private(set) var text: String
    @Published private(set) var composing = false
    @Published private(set) var editRevision = 0
    @Published private(set) var pending: NativeProfilePricingAction?
    @Published private(set) var retired = false
    @Published private(set) var appearanceRevision = 0
    private var actionSequence = 0
    private var confirmedSequence = 0
    weak var editor: UITextField?
    var edit: ((String, Bool, Int) -> Bool)?
    var choose: ((NativeProfilePricingAction) -> Bool)?
    var canEdit: Bool { !retired && !projection.busy && pending == nil }
    var canSave: Bool { canEdit && !composing && projection.canSave && projection.acknowledgedEditRevision == editRevision }
    var accent: UIColor { HushhNativeControlAppearance.color(projection.accentHex) ?? .label }

    init(_ projection: NativeProfilePricingProjection) {
        self.projection = projection
        text = projection.draft
    }
    func update(_ next: NativeProfilePricingProjection) -> Bool {
        guard !retired, next.valid, next.identity == projection.identity,
              next.destinationId == projection.destinationId,
              next.privacyGeneration == projection.privacyGeneration,
              next.updateSequence > projection.updateSequence, next.draftRevision >= projection.draftRevision,
              next.acknowledgedEditRevision >= projection.acknowledgedEditRevision,
              next.acknowledgedEditRevision <= editRevision else { return false }
        projection = next
        if next.acknowledgedEditRevision == editRevision && !composing { text = next.draft }
        appearanceRevision += 1
        return true
    }
    func capture(_ field: UITextField) {
        guard canEdit, field === editor else { return }
        let value = NativeProfilePricingDecimal.canonical(field.text ?? "", separator: Locale.current.decimalSeparator ?? ".")
        let marked = field.markedTextRange != nil
        guard value != text || marked != composing else { return }
        guard value.utf16.count <= 32, editRevision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        text = value
        composing = marked
        editRevision += 1
        if edit?(value, marked, editRevision) != true { clear() }
    }
    func action(_ action: String) {
        if let editor { capture(editor) }
        guard canEdit, action == "cancel" || action == "save" && canSave,
              actionSequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        actionSequence += 1
        let intent = NativeProfilePricingAction(updateSequence: projection.updateSequence,
            editRevision: editRevision, sequence: actionSequence, action: action)
        pending = intent
        if choose?(intent) != true { pending = nil }
    }
    func confirm(_ action: NativeProfilePricingAction) -> Bool {
        guard !retired, pending == action, action.sequence > confirmedSequence,
              (action.action == "cancel" ? action.updateSequence <= projection.updateSequence : projection.updateSequence == action.updateSequence),
              !projection.busy,
              action.action == "cancel" || (!composing && projection.canSave &&
                  action.editRevision == editRevision && projection.acknowledgedEditRevision == editRevision) else { return false }
        confirmedSequence = action.sequence
        return true
    }
    func settle(_ action: NativeProfilePricingAction) -> Bool {
        guard !retired, pending == action else { return false }
        pending = nil
        return true
    }
    func clear() {
        retired = true
        editor?.unmarkText()
        editor?.resignFirstResponder()
        editor?.text = ""
        editor?.undoManager?.removeAllActions()
        text = ""
        projection = projection.cleared
        pending = nil
        edit = nil
        choose = nil
    }
}

@available(iOS 26.0, *)
private struct NativeProfilePricingField: UIViewRepresentable {
    @ObservedObject var model: NativeProfilePricingModel
    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        field.font = .preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.keyboardType = .decimalPad
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.returnKeyType = .done
        field.accessibilityLabel = "Default price (USD)"
        field.accessibilityIdentifier = "native-profile-pricing-editor"
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        model.editor = field
        return field
    }
    func updateUIView(_ field: UITextField, context: Context) {
        field.isEnabled = model.canEdit
        field.textColor = .label
        field.tintColor = model.accent
        // Theme/validation acknowledgements must not replace an active IME
        // composition, selection or undo stack.
        if field.markedTextRange == nil && field.text != model.text {
            let range = field.selectedTextRange
            let offset = range.map { field.offset(from: field.beginningOfDocument, to: $0.start) }
            field.text = model.text
            if let offset, let position = field.position(from: field.beginningOfDocument, offset: min(offset, model.text.utf16.count)) {
                field.selectedTextRange = field.textRange(from: position, to: position)
            }
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator(model) }
    static func dismantleUIView(_ field: UITextField, coordinator: Coordinator) {
        field.resignFirstResponder()
        field.text = ""
        field.undoManager?.removeAllActions()
        field.delegate = nil
        field.removeTarget(coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
    }
    final class Coordinator: NSObject, UITextFieldDelegate {
        private let model: NativeProfilePricingModel
        init(_ model: NativeProfilePricingModel) { self.model = model }
        @objc func changed(_ field: UITextField) { model.capture(field) }
        func textFieldDidChangeSelection(_ textField: UITextField) { model.capture(textField) }
        func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
            guard model.canEdit, let current = textField.text as NSString?, range.location <= current.length,
                  range.length <= current.length - range.location else { return false }
            return current.replacingCharacters(in: range, with: string).utf16.count <= 32
        }
        func textFieldShouldReturn(_ textField: UITextField) -> Bool {
            guard textField.markedTextRange == nil else { return false }
            model.capture(textField)
            textField.resignFirstResponder()
            return false
        }
    }
}

@available(iOS 26.0, *)
private struct NativeProfilePricingContent: View {
    @ObservedObject var model: NativeProfilePricingModel
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { model.action("cancel") } label: {
                    Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.glass).accessibilityLabel("Cancel price change")
                .accessibilityIdentifier("native-profile-pricing-cancel").disabled(!model.canEdit)
                Spacer(minLength: 12)
                Text("Default price (USD)").font(.headline).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                Button("Save") { model.action("save") }
                    .buttonStyle(.glassProminent).frame(minWidth: 44, minHeight: 44)
                    .disabled(!model.canSave).accessibilityIdentifier("native-profile-pricing-save")
            }.padding(.horizontal, 16).padding(.vertical, 8)
            Form {
                Section {
                    NativeProfilePricingField(model: model).frame(minHeight: 44)
                } header: { Text("Default price (USD)") } footer: { Text("$0.50–$500, including cents.") }
                if let error = model.projection.error, !model.retired {
                    Text(error).foregroundStyle(.red).accessibilityIdentifier("native-profile-pricing-error")
                }
                if model.projection.busy { ProgressView("Saving…") }
                if let notice = model.projection.notice, !model.retired { Text(notice).foregroundStyle(.secondary) }
            }
        }
        .tint(Color(uiColor: model.accent))
        .preferredColorScheme(model.projection.appearance == "dark" ? .dark : .light)
    }
}

/// One complete UIKit sheet above retained native navigation and the existing
/// WebView. UIKit owns its keyboard, scrolling, scrim and dismissal.
@MainActor
final class NativeProfilePricingScene: NSObject, NativeProfileOwnedForm {
    let model: NativeProfilePricingModel
    var identity: NativeDrawerIdentity { model.projection.identity }
    var sceneName: String { "request-price" }
    func receipt(_ phase: String) -> [String: Any] { model.projection.receipt(phase: phase) }
    private lazy var sheet: NativeProfileOwnedSheet = {
        let model = model
        return NativeProfileOwnedSheet(makeHost: { [weak model] in
            guard #available(iOS 26.0, *), let model else { return nil }
            return UIHostingController(rootView: NativeProfilePricingContent(model: model))
        }, canPresent: { [weak model] in model?.retired == false },
           canDismiss: { [weak model] in model?.canEdit == true },
           hasPending: { [weak model] in model?.pending != nil },
           appearance: { [weak model] in
               guard let model else { return nil }
               return HushhNativeControlAppearance(appearance: model.projection.appearance,
                   accentHex: model.projection.accentHex, foregroundHex: model.projection.foregroundHex)
           }, cancel: { [weak model] in model?.action("cancel") },
           clear: { [weak model] in model?.clear() })
    }()
    var coverage: (() -> Void)? { didSet { sheet.coverage = coverage } }
    var coversPresentation: Bool { sheet.coversPresentation }
    init(_ projection: NativeProfilePricingProjection) { model = NativeProfilePricingModel(projection) }

    func present(from parent: UIViewController, completion: @escaping (Bool) -> Void) -> Bool {
        sheet.present(from: parent, completion: completion)
    }
    func update(_ projection: NativeProfilePricingProjection) -> Bool {
        guard model.update(projection) else { return false }
        sheet.refresh()
        return true
    }
    func settle(_ action: NativeProfilePricingAction) -> Bool {
        guard model.settle(action) else { return false }
        sheet.refresh()
        return true
    }
    func retire(completion: @escaping () -> Void) {
        sheet.retire(completion: completion)
    }
}
