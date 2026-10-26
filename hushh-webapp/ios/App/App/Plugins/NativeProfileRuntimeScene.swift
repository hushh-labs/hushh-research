import SwiftUI
import UIKit

/// Process-memory presentation only. The existing React/service owner validates
/// and encrypts credentials. No key, token or persistence authority is received.
protocol NativeProfileEditorDraft: Equatable {
    static var empty: Self { get }
    var valid: Bool { get }
    subscript(_ field: String) -> String { get set }
}
protocol NativeProfileEditorProjection {
    associatedtype Draft: NativeProfileEditorDraft
    associatedtype Identity: Equatable
    var identity: Identity { get }
    var scene: String { get }
    var destinationId: String { get }
    var valid: Bool { get }
    var draft: Draft { get set }
    var updateSequence: Int { get }
    var privacyGeneration: Int { get }
    var acknowledgedEditRevision: Int { get }
    var draftRevision: Int { get }
    var busy: Bool { get }
    var canSave: Bool { get }
    var checking: Bool { get }
    var primary: String { get }
    var accentHex: String { get }
    var error: String? { get set }
}
/// UIKit edit menus live beyond their field's SwiftUI body. Track actual
/// dismissal completion without borrowing an operation or feature lifetime.
@MainActor final class NativeEditorMenuLifetime {
    private var visible = [ObjectIdentifier: UIView]()
    private var retirement = [() -> Void]()
    func contains(_ view: UIView) -> Bool { visible[ObjectIdentifier(view)] != nil }
    func presented(_ view: UIView) { visible[ObjectIdentifier(view)] = view }
    func dismissed(_ view: UIView) {
        visible.removeValue(forKey: ObjectIdentifier(view))
        if visible.isEmpty { let callbacks = retirement; retirement.removeAll(); callbacks.forEach { $0() } }
    }
    func dismiss(_ views: [UIView], completion: @escaping () -> Void) {
        guard !visible.isEmpty else { completion(); return }
        retirement.append(completion)
        if #available(iOS 16.0, *) {
            // clear() scrubs text/undo state and removes editor registries
            // first. Retain only the visible menu's already-scrubbed trigger
            // until UIKit reports its actual dismissal completion.
            let targets = Dictionary((views + Array(visible.values)).map { (ObjectIdentifier($0), $0) }, uniquingKeysWith: { first, _ in first })
            for view in targets.values { for interaction in view.interactions { (interaction as? UIEditMenuInteraction)?.dismissMenu() } }
        }
    }
}
struct NativeRuntimeDraft: Codable, NativeProfileEditorDraft {
    var credential: String; var transport: String; var project: String; var location: String
    static let empty = Self(credential: "", transport: "developer_api", project: "", location: "")
    var valid: Bool { credential.utf16.count <= 8192 && ["developer_api", "vertex_api_key"].contains(transport) && project.utf16.count <= 256 && location.utf16.count <= 128 }
    var event: [String: Any] { ["credential": credential, "transport": transport, "project": project, "location": location] }
    subscript(_ field: String) -> String {
        get { switch field { case "credential": return credential; case "project": return project; case "location": return location; default: return "" } }
        set { switch field { case "credential": credential = newValue; case "project": project = newValue; case "location": location = newValue; default: break } }
    }
}
struct NativeRuntimeProjection: Decodable, NativeProfileEditorProjection {
    let documentId: String; let ownerEpoch: String; let ownerGeneration: Int; let revision: Int; let family: String
    let scene: String; let destinationId: String; let updateSequence: Int; let privacyGeneration: Int; let acknowledgedEditRevision: Int; let draftRevision: Int
    var draft: NativeRuntimeDraft; let canSave: Bool; let busy: Bool; let checking: Bool; let primary: String; var error: String?
    let appearance: String; let accentHex: String; let foregroundHex: String
    var identity: NativeDrawerIdentity { NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, family: family) }
    static let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId", "updateSequence", "privacyGeneration", "acknowledgedEditRevision", "draftRevision", "draft", "canSave", "busy", "checking", "primary", "error", "appearance", "accentHex", "foregroundHex"]
    static let draftKeys: Set<String> = ["credential", "transport", "project", "location"]
    var valid: Bool {
        let max = HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
        return identity.valid && family == "profile" && scene == "runtime-provider" && NativeDrawerIdentity.identifier(destinationId) && draft.valid &&
            updateSequence > 0 && updateSequence <= max && [privacyGeneration, acknowledgedEditRevision, draftRevision].allSatisfy { $0 >= 0 && $0 <= max } &&
            ["validate", "save"].contains(primary) && (error?.utf16.count ?? 0) <= 1024 && HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil
    }
    func receipt(_ phase: String) -> [String: Any] {
        ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration, "revision": revision, "family": family,
         "scene": scene, "destinationId": destinationId, "updateSequence": updateSequence, "privacyGeneration": privacyGeneration, "phase": phase]
    }
}
/// Shared private editor mechanics only. Each feature keeps a closed projection,
/// authored SwiftUI body and its existing React validation/operation owner.
@MainActor final class NativeProfileEditorModel<Projection: NativeProfileEditorProjection>: ObservableObject {
    @Published private(set) var projection: Projection
    @Published private(set) var draft: Projection.Draft
    @Published private(set) var editRevision = 0
    @Published private(set) var pending: NativeProfileNameAction?
    @Published private(set) var retired = false
    private var sequence = 0; private var confirmed = 0; private var lastComposing = false
    private var fields = [String: WeakField]()
    private final class WeakField { weak var value: UITextField?; init(_ value: UITextField) { self.value = value } }
    private var textViews = [String: WeakTextView]()
    private let editMenus = NativeEditorMenuLifetime()
    func editMenuPresented(_ view: UIView) { editMenus.presented(view) }
    func editMenuDismissed(_ view: UIView) {
        if retired { (view as? UITextView)?.delegate = nil; (view as? UITextField)?.delegate = nil }
        editMenus.dismissed(view)
    }
    func dismissEditorMenus(completion: @escaping () -> Void) {
        editMenus.dismiss(fields.values.compactMap(\.value).map({ $0 as UIView }) + textViews.values.compactMap(\.value).map({ $0 as UIView }), completion: completion)
    }
    private final class WeakTextView { weak var value: UITextView?; init(_ value: UITextView) { self.value = value } }
    var edit: ((Projection.Draft, Bool, Int) -> Bool)?
    var choose: ((NativeProfileNameAction) -> Bool)?
    var finalEdit: ((Projection.Draft, Int) -> Void)?
    var composing: Bool { fields.values.contains { $0.value?.markedTextRange != nil } || textViews.values.contains { $0.value?.markedTextRange != nil } }
    var canEdit: Bool { !retired && !projection.busy && pending == nil }
    var canCancel: Bool { !retired && !projection.busy && (pending == nil || projection.primary == "validate" && pending?.action == "save") }
    var canSave: Bool { canEdit && !projection.checking && !composing && projection.canSave && projection.acknowledgedEditRevision == editRevision }
    var accent: UIColor { HushhNativeControlAppearance.color(projection.accentHex) ?? .label }
    init(_ projection: Projection) { self.projection = projection; draft = projection.draft }
    func register(_ field: UITextField, name: String) { fields[name] = WeakField(field) }
    func register(_ field: UITextView, name: String) { textViews[name] = WeakTextView(field) }
    func update(_ next: Projection) -> Bool {
        guard !retired, next.valid, next.identity == projection.identity, next.scene == projection.scene, next.destinationId == projection.destinationId,
              next.privacyGeneration == projection.privacyGeneration, next.updateSequence > projection.updateSequence,
              next.draftRevision >= projection.draftRevision,
              next.acknowledgedEditRevision >= projection.acknowledgedEditRevision, next.acknowledgedEditRevision <= editRevision else { return false }
        if next.acknowledgedEditRevision == editRevision && !composing { draft = next.draft }
        projection = next; return true
    }
    private func emit(_ value: Projection.Draft) {
        guard canEdit, value.valid, editRevision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        let marked = composing
        guard value != draft || marked != lastComposing else { return }
        draft = value; lastComposing = marked; editRevision += 1
        if edit?(value, marked, editRevision) != true { clear() }
    }
    func capture() {
        var value = draft
        for (name, field) in fields { if let text = field.value?.text { value[name] = text } }
        for (name, field) in textViews { if let text = field.value?.text { value[name] = text } }
        emit(value)
    }
    func change(_ mutation: (inout Projection.Draft) -> Void) {
        capture()
        guard canEdit, !composing else { return }
        var value = draft; mutation(&value)
        guard value.valid else { return }
        for (name, field) in fields where value[name] != draft[name] {
            field.value?.text = value[name]; field.value?.undoManager?.removeAllActions()
        }
        for (name, field) in textViews where value[name] != draft[name] {
            field.value?.text = value[name]; field.value?.undoManager?.removeAllActions()
        }
        emit(value)
    }
    func action(_ value: String) {
        capture()
        guard (value == "cancel" ? canCancel : value == "save" && canSave), sequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        sequence += 1
        let action = NativeProfileNameAction(updateSequence: projection.updateSequence, editRevision: editRevision, sequence: sequence, action: value)
        pending = action; if choose?(action) != true { pending = nil }
    }
    func confirm(_ action: NativeProfileNameAction) -> Bool {
        guard !retired, !projection.busy, pending == action, action.sequence > confirmed,
              (action.action == "cancel" ? action.updateSequence <= projection.updateSequence : action.updateSequence == projection.updateSequence),
              action.action == "cancel" || !projection.checking && !composing && projection.canSave && action.editRevision == editRevision && projection.acknowledgedEditRevision == editRevision else { return false }
        confirmed = action.sequence; return true
    }
    func settle(_ action: NativeProfileNameAction) -> Bool { guard !retired, pending == action else { return false }; pending = nil; return true }
    func clear() {
        guard !retired else { return }
        retired = true; edit = nil; choose = nil
        let editors = fields.values.compactMap(\.value)
        for field in editors { field.unmarkText(); field.resignFirstResponder() }
        for field in textViews.values.compactMap({ $0.value }) { field.unmarkText(); field.resignFirstResponder() }
        var last = draft
        for (name, field) in fields { if let text = field.value?.text { last[name] = text } }
        for (name, field) in textViews { if let text = field.value?.text { last[name] = text } }
        // A committed edit is still unacknowledged even if the bridge callback
        // accepted dispatch. This also covers callback rejection after emit()
        // updated the local draft; equality alone cannot prove React received it.
        if !composing && last.valid && (last != draft || lastComposing || editRevision > projection.acknowledgedEditRevision), editRevision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration {
            editRevision += 1; finalEdit?(last, editRevision)
        }
        finalEdit = nil
        for field in editors { field.text = ""; field.undoManager?.removeAllActions() }
        for field in textViews.values.compactMap({ $0.value }) {
            if !editMenus.contains(field) { field.delegate = nil }
            field.unmarkText(); field.resignFirstResponder(); field.text = ""; field.undoManager?.removeAllActions()
        }
        fields.removeAll(); textViews.removeAll(); draft = .empty; projection.draft = .empty; projection.error = nil; pending = nil
    }
}
typealias NativeRuntimeModel = NativeProfileEditorModel<NativeRuntimeProjection>
@available(iOS 26.0, *) struct NativeProfilePrivateField<Projection: NativeProfileEditorProjection>: UIViewRepresentable {
    @ObservedObject var model: NativeProfileEditorModel<Projection>
    let name: String; let label: String; let maximum: Int
    var secure = false
    var keyboard: UIKeyboardType = .default
    let identifier: String
    func makeUIView(context: Context) -> UITextField {
        let field = UITextField(); field.delegate = context.coordinator; field.placeholder = label
        field.isSecureTextEntry = secure; field.textContentType = nil; field.keyboardType = keyboard
        field.autocapitalizationType = .none; field.autocorrectionType = .no; field.spellCheckingType = .no
        field.smartDashesType = .no; field.smartQuotesType = .no; field.smartInsertDeleteType = .no
        field.font = .preferredFont(forTextStyle: .body); field.adjustsFontForContentSizeCategory = true
        field.accessibilityLabel = label; field.accessibilityIdentifier = identifier
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed), for: .editingChanged)
        model.register(field, name: name); return field
    }
    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.owner = self; field.isEnabled = model.canEdit; field.textColor = .label; field.tintColor = model.accent
        let text = model.draft[name]
        if field.markedTextRange == nil && field.text != text {
            let selection = field.selectedTextRange.map { (field.offset(from: field.beginningOfDocument, to: $0.start), field.offset(from: field.beginningOfDocument, to: $0.end)) }
            field.text = text
            if let selection, let start = field.position(from: field.beginningOfDocument, offset: min(selection.0, text.utf16.count)),
               let end = field.position(from: field.beginningOfDocument, offset: min(selection.1, text.utf16.count)) { field.selectedTextRange = field.textRange(from: start, to: end) }
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    static func dismantleUIView(_ field: UITextField, coordinator: Coordinator) {
        field.delegate = nil; field.removeTarget(coordinator, action: #selector(Coordinator.changed), for: .editingChanged)
        field.unmarkText(); field.resignFirstResponder(); field.text = ""; field.undoManager?.removeAllActions()
    }
    final class Coordinator: NSObject, UITextFieldDelegate {
        var owner: NativeProfilePrivateField; init(_ owner: NativeProfilePrivateField) { self.owner = owner }
        @objc func changed() { owner.model.capture() }
        func textFieldDidChangeSelection(_ field: UITextField) { owner.model.capture() }
        func textField(_ textField: UITextField, willPresentEditMenuWith animator: any UIEditMenuInteractionAnimating) { owner.model.editMenuPresented(textField) }
        func textField(_ textField: UITextField, willDismissEditMenuWith animator: any UIEditMenuInteractionAnimating) {
            let model = owner.model; animator.addCompletion { model.editMenuDismissed(textField) }
        }
        func textField(_ field: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
            guard owner.model.canEdit, let text = field.text as NSString?, range.location <= text.length, range.length <= text.length - range.location else { return false }
            return text.replacingCharacters(in: range, with: string).utf16.count <= owner.maximum
        }
        func textFieldShouldReturn(_ field: UITextField) -> Bool { guard field.markedTextRange == nil else { return false }; owner.model.capture(); field.resignFirstResponder(); return false }
    }
}
@available(iOS 26.0, *) private struct NativeRuntimeContent: View {
    @ObservedObject var model: NativeRuntimeModel
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { model.action("cancel") } label: { Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44) }
                    .buttonStyle(.glass).accessibilityLabel("Cancel Gemini configuration").accessibilityIdentifier("native-runtime-cancel").disabled(!model.canCancel)
                Spacer(minLength: 8); Text("Gemini connection").font(.headline).accessibilityAddTraits(.isHeader); Spacer(minLength: 8)
                Button { model.action("save") } label: {
                    Image(systemName: model.projection.primary == "save" ? "checkmark" : "checkmark.shield").frame(width: 44, height: 44)
                }.buttonStyle(.glassProminent).disabled(!model.canSave)
                    .accessibilityLabel(model.projection.primary == "save" ? "Save Gemini key" : "Validate Gemini key").accessibilityIdentifier("native-runtime-submit")
            }.padding(.horizontal, 16).padding(.vertical, 8)
            Form {
                Section("API endpoint") {
                    Picker("API endpoint", selection: Binding(get: { model.draft.transport }, set: { value in model.change { $0.transport = value } })) {
                        Text("AI Studio").tag("developer_api"); Text("Vertex").tag("vertex_api_key")
                    }.pickerStyle(.segmented).disabled(!model.canEdit).accessibilityIdentifier("native-runtime-transport")
                }
                if model.draft.transport == "vertex_api_key" {
                    Section("Google Cloud") {
                        NativeProfilePrivateField(model: model, name: "project", label: "Google Cloud project ID", maximum: 256, identifier: "native-runtime-project").frame(minHeight: 44)
                        NativeProfilePrivateField(model: model, name: "location", label: "Vertex location", maximum: 128, identifier: "native-runtime-location").frame(minHeight: 44)
                    }
                }
                Section { NativeProfilePrivateField(model: model, name: "credential", label: "Gemini API key", maximum: 8192, secure: true, identifier: "native-runtime-credential").frame(minHeight: 44) }
                    footer: { Text("Validate the key before confirming it. Your key stays locked to you.") }
                if let error = model.projection.error, !model.retired { Text(error).foregroundStyle(Color(uiColor: .systemRed)).accessibilityAddTraits(.updatesFrequently) }
                if model.projection.busy || model.projection.checking { ProgressView("Checking Gemini…") }
                else if model.projection.primary == "save" { Label("Key is responding and ready to save.", systemImage: "checkmark.circle") }
            }
        }.tint(Color(uiColor: model.accent)).preferredColorScheme(model.projection.appearance == "dark" ? .dark : .light)
    }
}
@MainActor final class NativeProfileRuntimeScene: NSObject, NativeProfileOwnedForm {
    let model: NativeRuntimeModel
    var identity: NativeDrawerIdentity { model.projection.identity }
    var sceneName: String { model.projection.scene }
    func receipt(_ phase: String) -> [String: Any] { model.projection.receipt(phase) }
    private lazy var sheet: NativeProfileOwnedSheet = {
        let model = model
        return NativeProfileOwnedSheet(makeHost: { [weak model] in
            guard #available(iOS 26.0, *), let model else { return nil }
            return UIHostingController(rootView: NativeRuntimeContent(model: model))
        }, canPresent: { [weak model] in model?.retired == false }, canDismiss: { [weak model] in model?.canCancel == true },
           hasPending: { [weak model] in model?.pending != nil }, appearance: { [weak model] in
               guard let model else { return nil }
               return HushhNativeControlAppearance(appearance: model.projection.appearance, accentHex: model.projection.accentHex, foregroundHex: model.projection.foregroundHex)
           }, cancel: { [weak model] in model?.action("cancel") }, clear: { [weak model] in model?.clear() },
           dismissPopups: { [weak model] completion in if let model { model.dismissEditorMenus(completion: completion) } else { completion() } })
    }()
    var coverage: (() -> Void)? { didSet { sheet.coverage = coverage } }
    var coversPresentation: Bool { sheet.coversPresentation }
    var presentationSettled: Bool { sheet.presentationSettled }
    var feedbackPresenter: UIViewController? { sheet.feedbackPresenter }
    func refreshPrivacy() { sheet.refresh() }
    init(_ projection: NativeRuntimeProjection) { model = NativeRuntimeModel(projection) }
    func present(from parent: UIViewController, completion: @escaping (Bool) -> Void) -> Bool { sheet.present(from: parent, completion: completion) }
    func update(_ projection: NativeRuntimeProjection) -> Bool { guard model.update(projection) else { return false }; sheet.refresh(); return true }
    func settle(_ action: NativeProfileNameAction) -> Bool { guard model.settle(action) else { return false }; sheet.refresh(); return true }
    func retire(completion: @escaping () -> Void) { sheet.retire(completion: completion) }
}
