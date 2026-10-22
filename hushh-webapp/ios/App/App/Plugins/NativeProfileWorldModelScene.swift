import SwiftUI
import UIKit

/// Volatile form replicas only. Labels and field kinds are authored here, not
/// supplied by an executable UI schema. React owns validation and operations.
struct NativeWorldModelDraft: Codable, Equatable {
    var text: String?
    var urls: String?
    var permitted: Bool?
    var name: String?
    var email: String?
    var phone: String?
    func valid(_ scene: String) -> Bool {
        switch scene {
        case "world-model-fact-edit":
            return text != nil && text!.utf16.count <= 600 && urls == nil && permitted == nil && name == nil && email == nil && phone == nil
        case "world-model-sources", "world-model-public-profiles":
            return urls != nil && urls!.utf16.count <= 6144 && permitted != nil && text == nil && name == nil && email == nil && phone == nil
        case "world-model-invitation":
            return name != nil && name!.utf16.count <= 160 && email != nil && email!.utf16.count <= 320 && phone != nil && phone!.utf16.count <= 16 && text == nil && urls == nil && permitted == nil
        default: return false
        }
    }
    static func keys(_ scene: String) -> Set<String> {
        switch scene {
        case "world-model-fact-edit": return ["text"]
        case "world-model-sources", "world-model-public-profiles": return ["urls", "permitted"]
        case "world-model-invitation": return ["name", "email", "phone"]
        default: return []
        }
    }
    var event: [String: Any] {
        var value = [String: Any]()
        if let text { value["text"] = text }; if let urls { value["urls"] = urls }; if let permitted { value["permitted"] = permitted }
        if let name { value["name"] = name }; if let email { value["email"] = email }; if let phone { value["phone"] = phone }
        return value
    }
    subscript(_ field: String) -> String {
        get {
            switch field { case "text": return text ?? ""; case "urls": return urls ?? ""; case "name": return name ?? ""; case "email": return email ?? ""; case "phone": return phone ?? ""; default: return "" }
        }
        set {
            switch field { case "text": text = newValue; case "urls": urls = newValue; case "name": name = newValue; case "email": email = newValue; case "phone": phone = newValue; default: break }
        }
    }
}

struct NativeWorldModelProjection: Decodable {
    let documentId: String; let ownerEpoch: String; let ownerGeneration: Int; let revision: Int; let family: String
    let scene: String; let destinationId: String; let updateSequence: Int; let privacyGeneration: Int
    let draftRevision: Int; let acknowledgedEditRevision: Int; var draft: NativeWorldModelDraft
    let canSave: Bool; let busy: Bool; var error: String?
    let appearance: String; let accentHex: String; let foregroundHex: String
    var identity: NativeDrawerIdentity { NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, family: family) }
    static let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId", "updateSequence", "privacyGeneration", "draftRevision", "acknowledgedEditRevision", "draft", "canSave", "busy", "error", "appearance", "accentHex", "foregroundHex"]
    var valid: Bool {
        let max = HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
        return identity.valid && family == "profile" && NativeDrawerIdentity.identifier(destinationId) && draft.valid(scene) &&
            updateSequence > 0 && updateSequence <= max && [privacyGeneration, draftRevision, acknowledgedEditRevision].allSatisfy { $0 >= 0 && $0 <= max } &&
            (error?.utf16.count ?? 0) <= 1024 && HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil
    }
    func receipt(_ phase: String) -> [String: Any] {
        ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration, "revision": revision, "family": family, "scene": scene,
         "destinationId": destinationId, "updateSequence": updateSequence, "privacyGeneration": privacyGeneration, "phase": phase]
    }
}

@MainActor
final class NativeWorldModelFormModel: ObservableObject {
    @Published private(set) var projection: NativeWorldModelProjection
    @Published private(set) var draft: NativeWorldModelDraft
    @Published private(set) var editRevision = 0
    @Published private(set) var pending: NativeProfileNameAction?
    @Published private(set) var retired = false
    private var actionSequence = 0
    private var confirmedSequence = 0
    private var editors = NSHashTable<UITextView>.weakObjects()
    var edit: ((NativeWorldModelDraft, Bool, Int) -> Bool)?
    var choose: ((NativeProfileNameAction) -> Bool)?
    var composing: Bool { editors.allObjects.contains { $0.markedTextRange != nil } }
    var canEdit: Bool { !retired && !projection.busy && pending == nil }
    var canSave: Bool { canEdit && !composing && projection.canSave && projection.acknowledgedEditRevision == editRevision }
    var accent: UIColor { HushhNativeControlAppearance.color(projection.accentHex) ?? .label }
    init(_ projection: NativeWorldModelProjection) { self.projection = projection; draft = projection.draft }
    func register(_ editor: UITextView) { editors.add(editor) }
    func update(_ next: NativeWorldModelProjection) -> Bool {
        guard !retired, next.valid, next.identity == projection.identity, next.scene == projection.scene, next.destinationId == projection.destinationId,
              next.privacyGeneration == projection.privacyGeneration, next.updateSequence > projection.updateSequence,
              next.draftRevision >= projection.draftRevision, next.acknowledgedEditRevision >= projection.acknowledgedEditRevision,
              next.acknowledgedEditRevision <= editRevision else { return false }
        if next.acknowledgedEditRevision == editRevision && !composing { draft = next.draft }
        projection = next; return true
    }
    func change(_ value: NativeWorldModelDraft) {
        guard canEdit, value.valid(projection.scene), editRevision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        draft = value; editRevision += 1
        if edit?(value, composing, editRevision) != true { clear() }
    }
    func capture(_ editor: UITextView, field: String) {
        guard editors.contains(editor), canEdit else { return }
        var value = draft; value[field] = editor.text ?? ""
        // Marked-text completion also needs an acknowledged edit, even when
        // the visible text is unchanged. Never submit unfinished composition.
        change(value)
    }
    func action(_ action: String) {
        guard canEdit, action == "cancel" || action == "save" && canSave,
              actionSequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        actionSequence += 1
        let intent = NativeProfileNameAction(updateSequence: projection.updateSequence, editRevision: editRevision, sequence: actionSequence, action: action)
        pending = intent; if choose?(intent) != true { pending = nil }
    }
    func confirm(_ action: NativeProfileNameAction) -> Bool {
        guard !retired, !projection.busy, pending == action, action.sequence > confirmedSequence,
              (action.action == "cancel" ? action.updateSequence <= projection.updateSequence : action.updateSequence == projection.updateSequence),
              action.action == "cancel" || (!composing && projection.canSave && action.editRevision == editRevision && projection.acknowledgedEditRevision == editRevision) else { return false }
        confirmedSequence = action.sequence; return true
    }
    func settle(_ action: NativeProfileNameAction) -> Bool { guard !retired, pending == action else { return false }; pending = nil; return true }
    func clear() {
        retired = true; edit = nil; choose = nil
        for editor in editors.allObjects { editor.unmarkText(); editor.resignFirstResponder(); editor.text = ""; editor.undoManager?.removeAllActions() }
        draft = NativeWorldModelDraft(); projection.draft = NativeWorldModelDraft(); projection.error = nil; pending = nil
    }
}

@available(iOS 26.0, *)
private struct NativeWorldModelField: UIViewRepresentable {
    @ObservedObject var model: NativeWorldModelFormModel
    let field: String; let label: String; let maximum: Int; var multiline = false
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView(); view.delegate = context.coordinator; view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body); view.adjustsFontForContentSizeCategory = true
        view.isScrollEnabled = multiline; view.textContainerInset = .zero; view.textContainer.lineFragmentPadding = 0
        view.accessibilityLabel = label; view.accessibilityIdentifier = "native-world-model-\(field)"
        let verbatim = ["urls", "email", "phone"].contains(field)
        view.autocapitalizationType = verbatim ? .none : .sentences; view.autocorrectionType = verbatim ? .no : .default
        view.smartQuotesType = verbatim ? .no : .default; view.smartDashesType = verbatim ? .no : .default; view.smartInsertDeleteType = verbatim ? .no : .default
        view.keyboardType = field == "email" ? .emailAddress : field == "phone" ? .phonePad : field == "urls" ? .URL : .default
        model.register(view); return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.owner = self
        view.isEditable = model.canEdit; view.textColor = .label; view.tintColor = model.accent
        let value = model.draft[field]
        if view.markedTextRange == nil && view.text != value {
            let selection = view.selectedRange; view.text = value
            let start = min(selection.location, value.utf16.count)
            view.selectedRange = NSRange(location: start, length: min(selection.length, value.utf16.count - start))
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    static func dismantleUIView(_ view: UITextView, coordinator: Coordinator) {
        view.delegate = nil; view.unmarkText(); view.resignFirstResponder(); view.text = ""; view.undoManager?.removeAllActions()
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        var owner: NativeWorldModelField
        private var lastMarked = false
        init(_ owner: NativeWorldModelField) { self.owner = owner }
        func capture(_ view: UITextView) {
            let marked = view.markedTextRange != nil
            guard view.text != owner.model.draft[owner.field] || marked != lastMarked else { return }
            lastMarked = marked; owner.model.capture(view, field: owner.field)
        }
        func textViewDidChange(_ textView: UITextView) { capture(textView) }
        func textViewDidChangeSelection(_ textView: UITextView) { capture(textView) }
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard owner.model.canEdit, let value = textView.text as NSString?, range.location <= value.length, range.length <= value.length - range.location else { return false }
            if !owner.multiline && text == "\n" && textView.markedTextRange == nil { capture(textView); textView.resignFirstResponder(); return false }
            return value.replacingCharacters(in: range, with: text).utf16.count <= owner.maximum
        }
    }
}

@available(iOS 26.0, *)
private struct NativeWorldModelFormContent: View {
    @ObservedObject var model: NativeWorldModelFormModel
    var profileResearch: Bool { model.projection.scene == "world-model-public-profiles" }
    var title: String { profileResearch ? "Research your profiles" : model.projection.scene == "world-model-fact-edit" ? "Corrected wording" : model.projection.scene == "world-model-sources" ? "Add a public source" : "Invite someone" }
    var button: String { profileResearch ? "Research profiles" : model.projection.scene == "world-model-fact-edit" ? "Save" : model.projection.scene == "world-model-sources" ? "Read pages" : "Create" }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { model.action("cancel") } label: { Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44) }
                    .buttonStyle(.glass).accessibilityLabel("Cancel").accessibilityIdentifier("native-world-model-form-cancel").disabled(!model.canEdit)
                Spacer(minLength: 8); Text(title).font(.headline).accessibilityAddTraits(.isHeader); Spacer(minLength: 8)
                Button(button) { model.action("save") }.buttonStyle(.glassProminent).frame(minWidth: 44, minHeight: 44)
                    .disabled(!model.canSave).accessibilityIdentifier("native-world-model-form-save")
            }.padding(.horizontal, 16).padding(.vertical, 8)
            Form {
                if model.projection.scene == "world-model-fact-edit" {
                    Section("Corrected wording") { NativeWorldModelField(model: model, field: "text", label: "Corrected wording", maximum: 600, multiline: true).frame(minHeight: 140) }
                } else if model.projection.scene == "world-model-sources" || profileResearch {
                    Section {
                        NativeWorldModelField(model: model, field: "urls", label: "Page links, one per line", maximum: 6144, multiline: true).frame(minHeight: 140)
                        Toggle("These are public pages I chose myself, not search results.", isOn: Binding(get: { model.draft.permitted == true }, set: { selected in var draft = model.draft; draft.permitted = selected; model.change(draft) })).disabled(!model.canEdit)
                    } header: { Text("Page links, one per line") } footer: { Text(profileResearch ? "Use these profiles as starting links for GPT-5 mini research. Azure and Bing receive the public links. You review findings before saving." : "Add up to three public pages. You review every detail before it’s saved.") }
                } else {
                    Section("Their name") { NativeWorldModelField(model: model, field: "name", label: "Their name", maximum: 160).frame(minHeight: 44) }
                    Section("Their email") { NativeWorldModelField(model: model, field: "email", label: "Their email", maximum: 320).frame(minHeight: 44) }
                    Section { NativeWorldModelField(model: model, field: "phone", label: "Their phone with country code", maximum: 16).frame(minHeight: 44) } header: { Text("Their phone with country code") } footer: { Text("Enter at least one contact. If you enter both, either one can be used to claim.") }
                }
                if let error = model.projection.error, !model.retired { Text(error).foregroundStyle(.red) }
                if model.projection.busy { ProgressView() }
            }
        }.tint(Color(uiColor: model.accent)).preferredColorScheme(model.projection.appearance == "dark" ? .dark : .light)
    }
}

@MainActor
final class NativeProfileWorldModelScene: NSObject, NativeProfileOwnedForm {
    let model: NativeWorldModelFormModel
    var identity: NativeDrawerIdentity { model.projection.identity }
    var sceneName: String { model.projection.scene }
    func receipt(_ phase: String) -> [String: Any] { model.projection.receipt(phase) }
    private lazy var sheet: NativeProfileOwnedSheet = {
        let model = model
        return NativeProfileOwnedSheet(makeHost: { [weak model] in
            guard #available(iOS 26.0, *), let model else { return nil }
            return UIHostingController(rootView: NativeWorldModelFormContent(model: model))
        }, canPresent: { [weak model] in model?.retired == false }, canDismiss: { [weak model] in model?.canEdit == true },
           hasPending: { [weak model] in model?.pending != nil }, appearance: { [weak model] in
               guard let model else { return nil }
               return HushhNativeControlAppearance(appearance: model.projection.appearance, accentHex: model.projection.accentHex, foregroundHex: model.projection.foregroundHex)
           }, cancel: { [weak model] in model?.action("cancel") }, clear: { [weak model] in model?.clear() })
    }()
    var coverage: (() -> Void)? { didSet { sheet.coverage = coverage } }
    var coversPresentation: Bool { sheet.coversPresentation }
    var presentationSettled: Bool { sheet.presentationSettled }
    func refreshPrivacy() { sheet.refresh() }
    init(_ projection: NativeWorldModelProjection) { model = NativeWorldModelFormModel(projection) }
    func present(from parent: UIViewController, completion: @escaping (Bool) -> Void) -> Bool { sheet.present(from: parent, completion: completion) }
    func update(_ projection: NativeWorldModelProjection) -> Bool { guard model.update(projection) else { return false }; sheet.refresh(); return true }
    func settle(_ action: NativeProfileNameAction) -> Bool { guard model.settle(action) else { return false }; sheet.refresh(); return true }
    func retire(completion: @escaping () -> Void) { sheet.retire(completion: completion) }
}
