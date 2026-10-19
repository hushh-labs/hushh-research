import SwiftUI
import UIKit

struct NativeMemoryDraft: Codable, NativeProfileEditorDraft {
    static let categories = ["general", "portfolio", "risk", "kyc", "tax", "documents"]
    var category: String; var text: String
    static let empty = Self(category: "general", text: "")
    var valid: Bool { Self.categories.contains(category) && text.utf16.count <= 100_000 }
    var event: [String: Any] { ["category": category, "text": text] }
    subscript(_ name: String) -> String {
        get { name == "text" ? text : name == "category" ? category : "" }
        set { if name == "text" { text = newValue }; if name == "category" { category = newValue } }
    }
}
struct NativeMemoryProjection: Decodable, NativeProfileEditorProjection {
    let documentId: String; let ownerEpoch: String; let ownerGeneration: Int; let revision: Int; let family: String
    let scene: String; let destinationId: String; let updateSequence: Int; let privacyGeneration: Int; let acknowledgedEditRevision: Int; let draftRevision: Int
    var draft: NativeMemoryDraft; let canSave: Bool; let busy: Bool; var error: String?
    let appearance: String; let accentHex: String; let foregroundHex: String
    var checking: Bool { false }; var primary: String { "save" }
    var identity: NativeDrawerIdentity { NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, family: family) }
    static let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId", "updateSequence", "privacyGeneration", "acknowledgedEditRevision", "draftRevision", "draft", "canSave", "busy", "error", "appearance", "accentHex", "foregroundHex"]
    var valid: Bool {
        let max = HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
        return identity.valid && family == "profile" && scene == "memory-financial-context" && NativeDrawerIdentity.identifier(destinationId) && draft.valid &&
            updateSequence > 0 && updateSequence <= max && [privacyGeneration, acknowledgedEditRevision, draftRevision].allSatisfy { $0 >= 0 && $0 <= max } &&
            (error?.utf16.count ?? 0) <= 1024 && HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil
    }
    func receipt(_ phase: String) -> [String: Any] {
        ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration, "revision": revision, "family": family,
         "scene": scene, "destinationId": destinationId, "updateSequence": updateSequence, "privacyGeneration": privacyGeneration, "phase": phase]
    }
}
typealias NativeMemoryEditorModel = NativeProfileEditorModel<NativeMemoryProjection>

/// UIKit's editor retains selection, marked text and undo independently from
/// SwiftUI body updates. It adds no persistence or mutation authority.
@available(iOS 26.0, *) struct NativeProfilePrivateText<Projection: NativeProfileEditorProjection>: UIViewRepresentable {
    @ObservedObject var model: NativeProfileEditorModel<Projection>
    let name: String; let label: String; let maximum: Int; let identifier: String
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView(); view.delegate = context.coordinator
        view.backgroundColor = .clear; view.font = .preferredFont(forTextStyle: .body); view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0); view.textContainer.lineFragmentPadding = 0
        view.accessibilityLabel = label; view.accessibilityIdentifier = identifier
        model.register(view, name: name); return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.owner = self; view.isEditable = model.canEdit; view.textColor = .label; view.tintColor = model.accent
        let value = model.draft[name]
        if view.markedTextRange == nil && view.text != value {
            let selection = view.selectedRange; view.text = value
            let start = min(selection.location, value.utf16.count)
            view.selectedRange = NSRange(location: start, length: min(selection.length, value.utf16.count - start))
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    static func dismantleUIView(_ view: UITextView, coordinator: Coordinator) {
        coordinator.owner.model.capture(); view.delegate = nil; view.unmarkText(); view.resignFirstResponder(); view.text = ""; view.undoManager?.removeAllActions()
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        var owner: NativeProfilePrivateText; init(_ owner: NativeProfilePrivateText) { self.owner = owner }
        func textViewDidChange(_ textView: UITextView) { owner.model.capture() }
        func textViewDidEndEditing(_ textView: UITextView) { owner.model.capture() }
        func textView(_ textView: UITextView, willPresentEditMenuWith animator: any UIEditMenuInteractionAnimating) { owner.model.editMenuPresented(textView) }
        func textView(_ textView: UITextView, willDismissEditMenuWith animator: any UIEditMenuInteractionAnimating) {
            let model = owner.model; animator.addCompletion { model.editMenuDismissed(textView) }
        }
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            let current = textView.text ?? ""
            guard owner.model.canEdit, let r = Range(range, in: current) else { return false }
            return current.replacingCharacters(in: r, with: text).utf16.count <= owner.maximum
        }
    }
}
@available(iOS 26.0, *) private struct NativeMemoryContent: View {
    @ObservedObject var model: NativeMemoryEditorModel
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { model.action("cancel") } label: { Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44) }
                    .buttonStyle(.glass).accessibilityLabel("Cancel").accessibilityIdentifier("native-memory-cancel").disabled(!model.canCancel)
                Spacer(minLength: 8); Text("Financial context").font(.headline).accessibilityAddTraits(.isHeader); Spacer(minLength: 8)
                Button { model.action("save") } label: { Image(systemName: "checkmark").frame(minWidth: 44, minHeight: 44) }
                    .buttonStyle(.glassProminent).accessibilityLabel("Save").accessibilityIdentifier("native-memory-save").disabled(!model.canSave)
            }.padding(.horizontal, 16).padding(.vertical, 8)
            Form {
                Picker("Category", selection: Binding(get: { model.draft.category }, set: { value in model.change { $0.category = value } })) {
                    Text("General").tag("general"); Text("Portfolio").tag("portfolio"); Text("Risk").tag("risk")
                    Text("KYC").tag("kyc"); Text("Tax").tag("tax"); Text("Documents").tag("documents")
                }.disabled(!model.canEdit || model.composing).accessibilityIdentifier("native-memory-category")
                Section("What should Hussh remember?") {
                    NativeProfilePrivateText(model: model, name: "text", label: "Financial context", maximum: 100_000, identifier: "native-memory-text").frame(minHeight: 160)
                }
                if model.projection.busy { ProgressView("Saving…") }
                if let error = model.projection.error, !model.retired { Text(error).foregroundStyle(Color(uiColor: .systemRed)).accessibilityAddTraits(.updatesFrequently) }
            }
        }.tint(Color(uiColor: model.accent)).preferredColorScheme(model.projection.appearance == "dark" ? .dark : .light)
    }
}
@MainActor final class NativeProfileMemoryScene: NSObject, NativeProfileOwnedForm {
    let model: NativeMemoryEditorModel
    var identity: NativeDrawerIdentity { model.projection.identity }
    var sceneName: String { model.projection.scene }
    func receipt(_ phase: String) -> [String: Any] { model.projection.receipt(phase) }
    private lazy var sheet: NativeProfileOwnedSheet = {
        let model = model
        return NativeProfileOwnedSheet(makeHost: { [weak model] in
            guard #available(iOS 26.0, *), let model else { return nil }
            return UIHostingController(rootView: NativeMemoryContent(model: model))
        }, canPresent: { [weak model] in model?.retired == false }, canDismiss: { [weak model] in model?.canCancel == true },
           hasPending: { [weak model] in model?.pending != nil }, appearance: { [weak model] in
               guard let model else { return nil }
               return HushhNativeControlAppearance(appearance: model.projection.appearance, accentHex: model.projection.accentHex, foregroundHex: model.projection.foregroundHex)
           }, cancel: { [weak model] in model?.action("cancel") }, clear: { [weak model] in model?.clear() })
    }()
    var coverage: (() -> Void)? { didSet { sheet.coverage = coverage } }
    var coversPresentation: Bool { sheet.coversPresentation }
    var presentationSettled: Bool { sheet.presentationSettled }
    func refreshPrivacy() { sheet.refresh() }
    init(_ projection: NativeMemoryProjection) { model = NativeMemoryEditorModel(projection) }
    func present(from parent: UIViewController, completion: @escaping (Bool) -> Void) -> Bool { sheet.present(from: parent, completion: completion) }
    func update(_ projection: NativeMemoryProjection) -> Bool { guard model.update(projection) else { return false }; sheet.refresh(); return true }
    func settle(_ action: NativeProfileNameAction) -> Bool { guard model.settle(action) else { return false }; sheet.refresh(); return true }
    func retire(completion: @escaping () -> Void) { sheet.retire(completion: completion) }
}
