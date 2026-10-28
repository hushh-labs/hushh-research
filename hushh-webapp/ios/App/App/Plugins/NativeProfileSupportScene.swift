import SwiftUI
import UIKit

/// Private, volatile support form. React owns validation and delivery; this
/// scene has no account credentials, networking, persistence or diagnostics.
struct NativeSupportDraft: Codable, Equatable {
    var kind: String
    var message: String
    static let kinds = ["bug_report", "support_request", "developer_reachout"]
    var valid: Bool { Self.kinds.contains(kind) && message.utf16.count <= 8000 }
}
struct NativeSupportProjection: Decodable {
    let documentId: String, ownerEpoch: String, family: String, scene: String, destinationId: String
    let ownerGeneration: Int, revision: Int, updateSequence: Int, privacyGeneration: Int
    let draftRevision: Int, acknowledgedEditRevision: Int
    var draft: NativeSupportDraft
    let canSave: Bool, busy: Bool, sent: Bool
    var error: String?
    var replyLine: String
    let placeholder: String, submitLabel: String, successTitle: String
    var successDescription: String
    let appearance: String, accentHex: String, foregroundHex: String
    static let keys = NativeProfileNameProjection.keys.union([
        "sent", "replyLine", "placeholder", "submitLabel", "successTitle", "successDescription"
    ])
    var identity: NativeDrawerIdentity {
        NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, family: family)
    }
    var valid: Bool {
        let max = HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
        return identity.valid && family == "profile" && scene == "support" && NativeDrawerIdentity.identifier(destinationId) &&
            updateSequence > 0 && updateSequence <= max &&
            [privacyGeneration, draftRevision, acknowledgedEditRevision].allSatisfy { $0 >= 0 && $0 <= max } &&
            draft.valid && !(sent && (canSave || busy)) && (error?.utf16.count ?? 0) <= 1024 &&
            [replyLine, placeholder, submitLabel, successTitle, successDescription].allSatisfy { $0.utf16.count <= 1024 } &&
            HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil
    }
    func receipt(_ phase: String) -> [String: Any] {
        ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration, "revision": revision,
         "family": family, "scene": scene, "destinationId": destinationId, "updateSequence": updateSequence,
         "privacyGeneration": privacyGeneration, "phase": phase]
    }
}

@MainActor
final class NativeSupportModel: ObservableObject {
    @Published private(set) var projection: NativeSupportProjection
    @Published private(set) var draft: NativeSupportDraft
    @Published private(set) var composing = false
    @Published private(set) var pending: NativeProfileNameAction?
    @Published private(set) var retired = false
    private(set) var editRevision = 0
    private var sequence = 0, confirmedSequence = 0
    weak var editor: UITextView?
    var edit: ((NativeSupportDraft, Bool, Int) -> Bool)?
    var choose: ((NativeProfileNameAction) -> Bool)?
    var changed: (() -> Void)?
    var canDismiss: Bool { !retired && !projection.busy && pending == nil }
    var canEdit: Bool { canDismiss && !projection.sent }
    var canSend: Bool {
        canEdit && !composing && editor?.markedTextRange == nil && projection.canSave &&
            projection.acknowledgedEditRevision == editRevision && draft.message.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count >= 10
    }
    var accent: UIColor { HushhNativeControlAppearance.color(projection.accentHex) ?? .label }
    init(_ projection: NativeSupportProjection) { self.projection = projection; draft = projection.draft }
    func update(_ next: NativeSupportProjection) -> Bool {
        guard !retired, next.valid, next.identity == projection.identity, next.destinationId == projection.destinationId,
              next.privacyGeneration == projection.privacyGeneration, next.updateSequence > projection.updateSequence,
              next.draftRevision >= projection.draftRevision, next.acknowledgedEditRevision >= projection.acknowledgedEditRevision,
              next.acknowledgedEditRevision <= editRevision else { return false }
        projection = next
        if next.acknowledgedEditRevision == editRevision && !composing { draft = next.draft }
        return true
    }
    func change(kind: String? = nil, message: String? = nil, composing: Bool? = nil) {
        guard canEdit, editRevision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        let next = NativeSupportDraft(kind: kind ?? draft.kind, message: message ?? draft.message)
        let marked = composing ?? self.composing
        guard next.valid, next != draft || marked != self.composing else { return }
        draft = next; self.composing = marked; editRevision += 1
        if edit?(next, marked, editRevision) != true { clear() }
    }
    func action(_ action: String) {
        guard action == "cancel" ? canDismiss : action == "save" && canSend,
              sequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        sequence += 1
        let intent = NativeProfileNameAction(updateSequence: projection.updateSequence, editRevision: editRevision, sequence: sequence, action: action)
        pending = intent; changed?()
        if choose?(intent) != true { pending = nil; changed?() }
    }
    func confirm(_ intent: NativeProfileNameAction) -> Bool {
        guard !retired, pending == intent, intent.sequence > confirmedSequence, !projection.busy,
              intent.action == "cancel" ? intent.updateSequence <= projection.updateSequence :
                intent.action == "save" && intent.updateSequence == projection.updateSequence && !projection.sent && !composing &&
                  editor?.markedTextRange == nil && projection.canSave && intent.editRevision == editRevision &&
                  projection.acknowledgedEditRevision == editRevision else { return false }
        confirmedSequence = intent.sequence; return true
    }
    func settle(_ intent: NativeProfileNameAction) -> Bool {
        guard !retired, pending == intent else { return false }
        pending = nil; changed?(); return true
    }
    func clear() {
        retired = true
        editor?.unmarkText(); editor?.resignFirstResponder(); editor?.text = ""; editor?.undoManager?.removeAllActions()
        draft.message = ""; projection.draft.message = ""; projection.error = nil; projection.replyLine = ""; projection.successDescription = ""
        pending = nil; edit = nil; choose = nil
    }
}

@available(iOS 26.0, *)
private struct NativeSupportEditor: UIViewRepresentable {
    @ObservedObject var model: NativeSupportModel
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator; view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body); view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 10, left: 0, bottom: 10, right: 0)
        view.textContainer.lineFragmentPadding = 0
        view.accessibilityLabel = "Message"; view.accessibilityIdentifier = "native-support-message"
        model.editor = view
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        view.isEditable = model.canEdit; view.textColor = .label; view.tintColor = model.accent
        if view.markedTextRange == nil && view.text != model.draft.message {
            let selection = view.selectedRange
            view.text = model.draft.message
            let start = min(selection.location, view.text.utf16.count)
            view.selectedRange = NSRange(location: start, length: min(selection.length, view.text.utf16.count - start))
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator(model) }
    static func dismantleUIView(_ view: UITextView, coordinator: Coordinator) {
        view.delegate = nil; view.resignFirstResponder(); view.text = ""; view.undoManager?.removeAllActions()
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        let model: NativeSupportModel
        init(_ model: NativeSupportModel) { self.model = model }
        func textViewDidChange(_ view: UITextView) { capture(view) }
        func textViewDidChangeSelection(_ view: UITextView) { capture(view) }
        private func capture(_ view: UITextView) { model.change(message: view.text ?? "", composing: view.markedTextRange != nil) }
        func textView(_ view: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            let current = (view.text ?? "") as NSString
            return model.canEdit && range.location <= current.length && range.length <= current.length - range.location &&
                current.replacingCharacters(in: range, with: text).utf16.count <= 8000
        }
    }
}

@available(iOS 26.0, *)
private struct NativeSupportContent: View {
    @ObservedObject var model: NativeSupportModel
    var body: some View {
        NavigationStack {
            Form {
                if model.projection.sent {
                    Section {
                        Label(model.projection.successTitle, systemImage: "checkmark.circle")
                            .font(.headline).accessibilityIdentifier("native-support-success")
                        Text(model.projection.successDescription).foregroundStyle(.secondary)
                        Button("Done") { model.action("cancel") }.frame(minHeight: 44)
                            .disabled(!model.canDismiss).accessibilityIdentifier("native-support-done")
                    }
                } else {
                    Section("What do you need?") {
                        Picker("Support request type", selection: Binding(get: { model.draft.kind }, set: { model.change(kind: $0) })) {
                            Text("Problem").tag("bug_report")
                            Text("Help").tag("support_request")
                            Text("Feedback").tag("developer_reachout")
                        }.pickerStyle(.segmented).disabled(!model.canEdit)
                            .accessibilityIdentifier("native-support-kind")
                    }
                    Section {
                        NativeSupportEditor(model: model).frame(minHeight: 176)
                    } header: { Text("Message") } footer: {
                        Text(model.draft.message.isEmpty ? model.projection.placeholder : model.projection.replyLine)
                    }
                    Section {
                        if let error = model.projection.error {
                            Text(error).foregroundStyle(.red).accessibilityIdentifier("native-support-error")
                        }
                        Button { model.action("save") } label: {
                            HStack {
                                if model.projection.busy { ProgressView() }
                                Text(model.projection.busy ? "Sending…" : model.projection.submitLabel)
                            }.frame(maxWidth: .infinity, minHeight: 44)
                        }.disabled(!model.canSend).accessibilityIdentifier("native-support-send")
                    } footer: {
                        Text("Your message goes to One support, with an internal copy to our support lead. No automatic receipt is sent.")
                    }
                }
            }.navigationTitle("Help & feedback").navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(model.projection.sent ? "Done" : "Cancel") { model.action("cancel") }
                            .disabled(!model.canDismiss).accessibilityIdentifier("native-support-cancel")
                    }
                }
                .tint(Color(uiColor: model.accent))
        }.accessibilityIdentifier("native-support-scene")
    }
}

@MainActor
final class NativeProfileSupportScene: NSObject, NativeProfileOwnedForm {
    let model: NativeSupportModel
    var identity: NativeDrawerIdentity { model.projection.identity }
    var sceneName: String { "support" }
    func receipt(_ phase: String) -> [String: Any] { model.projection.receipt(phase) }
    private lazy var sheet: NativeProfileOwnedSheet = {
        let model = model
        return NativeProfileOwnedSheet(makeHost: { [weak model] in
            guard #available(iOS 26.0, *), let model else { return nil }
            return UIHostingController(rootView: NativeSupportContent(model: model))
        }, canPresent: { [weak model] in model?.retired == false },
           canDismiss: { [weak model] in model?.canDismiss == true },
           hasPending: { [weak model] in model?.pending != nil },
           appearance: { [weak model] in
               guard let model else { return nil }
               return HushhNativeControlAppearance(appearance: model.projection.appearance,
                   accentHex: model.projection.accentHex, foregroundHex: model.projection.foregroundHex)
           }, cancel: { [weak model] in model?.action("cancel") }, clear: { [weak model] in model?.clear() })
    }()
    var coverage: (() -> Void)? { didSet { sheet.coverage = coverage } }
    var coversPresentation: Bool { sheet.coversPresentation }
    var presentationSettled: Bool { sheet.presentationSettled }
    var feedbackPresenter: UIViewController? { sheet.feedbackPresenter }
    func refreshPrivacy() { sheet.refresh() }
    init(_ projection: NativeSupportProjection) {
        model = NativeSupportModel(projection)
        super.init()
        model.changed = { [weak self] in self?.sheet.refresh() }
    }
    func present(from parent: UIViewController, completion: @escaping (Bool) -> Void) -> Bool { sheet.present(from: parent, completion: completion) }
    func update(_ state: NativeSupportProjection) -> Bool {
        guard model.update(state) else { return false }; sheet.refresh(); return true
    }
    func settle(_ action: NativeProfileNameAction) -> Bool {
        guard model.settle(action) else { return false }; sheet.refresh(); return true
    }
    func retire(completion: @escaping () -> Void) { sheet.retire(completion: completion) }
}
