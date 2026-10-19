import SwiftUI
import UIKit

/// NativeDrawers v1 ordinary-form extension. All text is volatile private
/// presentation. This type has no network, credential or persistence port.
struct NativeProfileNameProjection: Decodable {
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
    let appearance: String
    let accentHex: String
    let foregroundHex: String
    var destinationId: String? = nil

    var identity: NativeDrawerIdentity {
        NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch,
            ownerGeneration: ownerGeneration, revision: revision, family: family)
    }
    static let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene",
        "updateSequence", "privacyGeneration", "draftRevision", "acknowledgedEditRevision", "draft", "canSave", "busy",
        "error", "appearance", "accentHex", "foregroundHex", "destinationId"]
    var valid: Bool {
        let maximum = HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
        return identity.valid && family == "profile" && ["account-name", "referral-handle"].contains(scene) &&
            (scene != "referral-handle" || destinationId != nil) &&
            (destinationId == nil || NativeDrawerIdentity.identifier(destinationId!)) &&
            updateSequence > 0 && updateSequence <= maximum &&
            [privacyGeneration, draftRevision, acknowledgedEditRevision].allSatisfy { $0 >= 0 && $0 <= maximum } &&
            draft.utf16.count <= (scene == "referral-handle" ? 32 : 4096) && (error?.utf16.count ?? 0) <= 1024 &&
            HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil
    }
    func receipt(phase: String) -> [String: Any] {
        var receipt: [String: Any] = ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration, "revision": revision,
         "family": family, "scene": scene, "updateSequence": updateSequence,
         "privacyGeneration": privacyGeneration, "phase": phase]
        if let destinationId { receipt["destinationId"] = destinationId }
        return receipt
    }
    var cleared: NativeProfileNameProjection {
        NativeProfileNameProjection(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration,
            revision: revision, family: family, scene: scene, updateSequence: updateSequence, privacyGeneration: privacyGeneration,
            draftRevision: draftRevision, acknowledgedEditRevision: acknowledgedEditRevision, draft: "", canSave: false,
            busy: false, error: nil, appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex, destinationId: destinationId)
    }
}

struct NativeProfileNameAction: Equatable {
    let updateSequence: Int
    let editRevision: Int
    let sequence: Int
    let action: String
}

@MainActor
final class NativeProfileNameModel: ObservableObject {
    private(set) var projection: NativeProfileNameProjection
    @Published private(set) var text: String
    @Published private(set) var composing = false
    @Published private(set) var editRevision = 0
    @Published private(set) var pending: NativeProfileNameAction?
    @Published private(set) var retired = false
    @Published private(set) var appearanceRevision = 0
    private var actionSequence = 0
    private var confirmedSequence = 0
    weak var editor: UITextField?
    var edit: ((String, Bool, Int) -> Bool)?
    var choose: ((NativeProfileNameAction) -> Bool)?
    var canEdit: Bool { !retired && !projection.busy && pending == nil }
    var maximumLength: Int { projection.scene == "referral-handle" ? 32 : 4096 }
    var canSave: Bool { canEdit && !composing && projection.canSave && projection.acknowledgedEditRevision == editRevision }
    var accent: UIColor { HushhNativeControlAppearance.color(projection.accentHex) ?? .label }

    init(_ projection: NativeProfileNameProjection) {
        self.projection = projection
        text = projection.draft
    }
    func update(_ next: NativeProfileNameProjection) -> Bool {
        guard !retired, next.valid, next.identity == projection.identity, next.scene == projection.scene,
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
        let value = field.text ?? ""
        let marked = field.markedTextRange != nil
        guard value != text || marked != composing else { return }
        guard value.utf16.count <= maximumLength, editRevision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        text = value
        composing = marked
        editRevision += 1
        if edit?(value, marked, editRevision) != true { clear() }
    }
    func action(_ action: String) {
        guard canEdit, action == "cancel" || action == "save" && canSave,
              actionSequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        actionSequence += 1
        let intent = NativeProfileNameAction(updateSequence: projection.updateSequence,
            editRevision: editRevision, sequence: actionSequence, action: action)
        pending = intent
        if choose?(intent) != true { pending = nil }
    }
    func confirm(_ action: NativeProfileNameAction) -> Bool {
        guard !retired, pending == action, action.sequence > confirmedSequence,
              (action.action == "cancel" ? action.updateSequence <= projection.updateSequence : projection.updateSequence == action.updateSequence),
              !projection.busy,
              action.action == "cancel" || (!composing && projection.canSave &&
                  action.editRevision == editRevision && projection.acknowledgedEditRevision == editRevision) else { return false }
        confirmedSequence = action.sequence
        return true
    }
    func settle(_ action: NativeProfileNameAction) -> Bool {
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
private struct NativeProfileNameField: UIViewRepresentable {
    @ObservedObject var model: NativeProfileNameModel
    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.delegate = context.coordinator
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        field.font = .preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        let handle = model.projection.scene == "referral-handle"
        field.textContentType = handle ? .username : .name
        field.autocapitalizationType = handle ? .none : .words
        field.autocorrectionType = .no
        field.returnKeyType = .done
        field.accessibilityLabel = handle ? "Leaderboard handle" : "Display name"
        field.accessibilityIdentifier = "native-profile-name-editor"
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
        private let model: NativeProfileNameModel
        init(_ model: NativeProfileNameModel) { self.model = model }
        @objc func changed(_ field: UITextField) { model.capture(field) }
        func textFieldDidChangeSelection(_ textField: UITextField) { model.capture(textField) }
        func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
            guard model.canEdit, let current = textField.text as NSString?, range.location <= current.length,
                  range.length <= current.length - range.location else { return false }
            return current.replacingCharacters(in: range, with: string).utf16.count <= model.maximumLength
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
private struct NativeProfileNameContent: View {
    @ObservedObject var model: NativeProfileNameModel
    private var title: String { model.projection.scene == "referral-handle" ? "Leaderboard handle" : "Display name" }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { model.action("cancel") } label: {
                    Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.glass).accessibilityLabel("Cancel")
                .accessibilityIdentifier("native-profile-name-cancel").disabled(!model.canEdit)
                Spacer(minLength: 12)
                Text(title).font(.headline).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                Button("Save") { model.action("save") }
                    .buttonStyle(.glassProminent).frame(minWidth: 44, minHeight: 44)
                    .disabled(!model.canSave).accessibilityIdentifier("native-profile-name-save")
            }.padding(.horizontal, 16).padding(.vertical, 8)
            Form {
                Section(title) {
                    NativeProfileNameField(model: model).frame(minHeight: 44)
                }
                if let error = model.projection.error, !model.retired {
                    Text(error).foregroundStyle(.red).accessibilityIdentifier("native-profile-name-error")
                }
                if model.projection.busy { ProgressView("Saving…") }
            }
        }
        .tint(Color(uiColor: model.accent))
        .preferredColorScheme(model.projection.appearance == "dark" ? .dark : .light)
    }
}

/// One complete UIKit sheet above retained native navigation and the existing
/// WebView. UIKit owns its keyboard, scrolling, scrim and dismissal.
@MainActor
final class NativeProfileNameScene: NSObject, NativeProfileOwnedForm {
    let model: NativeProfileNameModel
    var identity: NativeDrawerIdentity { model.projection.identity }
    var sceneName: String { model.projection.scene }
    func receipt(_ phase: String) -> [String: Any] { model.projection.receipt(phase: phase) }
    private lazy var sheet: NativeProfileOwnedSheet = {
        let model = model
        return NativeProfileOwnedSheet(makeHost: { [weak model] in
            guard #available(iOS 26.0, *), let model else { return nil }
            return UIHostingController(rootView: NativeProfileNameContent(model: model))
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
    var presentationSettled: Bool { sheet.presentationSettled }
    func refreshPrivacy() { sheet.refresh() }
    init(_ projection: NativeProfileNameProjection) { model = NativeProfileNameModel(projection) }

    func present(from parent: UIViewController, completion: @escaping (Bool) -> Void) -> Bool {
        sheet.present(from: parent, completion: completion)
    }
    func update(_ projection: NativeProfileNameProjection) -> Bool {
        guard model.update(projection) else { return false }
        sheet.refresh()
        return true
    }
    func settle(_ action: NativeProfileNameAction) -> Bool {
        guard model.settle(action) else { return false }
        sheet.refresh()
        return true
    }
    func retire(completion: @escaping () -> Void) {
        sheet.retire(completion: completion)
    }
}
