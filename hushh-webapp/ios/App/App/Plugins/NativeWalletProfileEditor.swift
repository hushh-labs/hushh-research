import SwiftUI
import UIKit

struct NativeWalletProfileDraft: Codable, NativeProfileEditorDraft {
    static let fields: [(String, String, Int)] = [
        ("fullName", "Name", 80), ("username", "Username", 30), ("headline", "Headline", 120),
        ("organisation", "Organisation", 80), ("locationLabel", "Location", 80), ("summary", "About you", 400),
        ("skills", "Skills", 492), ("email", "Email", 254), ("phone", "Phone", 32),
        ("website", "Website", 300), ("linkedin", "LinkedIn", 300), ("github", "GitHub", 300), ("portfolio", "Portfolio", 300)]
    static var keys: Set<String> { Set(fields.map { $0.0 } + ["preferredContact"]) }
    var values: [String: String]
    init(from decoder: Decoder) throws { values = try decoder.singleValueContainer().decode([String: String].self) }
    func encode(to encoder: Encoder) throws { var container = encoder.singleValueContainer(); try container.encode(values) }
    static var empty: Self { var values = Dictionary(uniqueKeysWithValues: fields.map { ($0.0, "") }); values["preferredContact"] = "email"; return Self(values: values) }
    init(values: [String: String]) { self.values = values }
    var valid: Bool { Set(values.keys) == Self.keys && Self.fields.allSatisfy { (values[$0.0]?.utf16.count ?? Int.max) <= $0.2 } && ["email", "phone", "linkedin", "website"].contains(values["preferredContact"] ?? "") }
    var event: [String: Any] { values }
    subscript(_ field: String) -> String {
        get { values[field] ?? "" }
        set { if Self.keys.contains(field) { values[field] = newValue } }
    }
}
struct NativeWalletProfileEditor: Decodable {
    let destinationId: String; let draft: NativeWalletProfileDraft; let draftRevision: Int; let acknowledgedEditRevision: Int
    let busy: Bool; let canSave: Bool; let error: String?
    var valid: Bool { NativeDrawerIdentity.identifier(destinationId) && draft.valid && [draftRevision, acknowledgedEditRevision].allSatisfy { $0 >= 0 && $0 <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration } && (error?.utf16.count ?? 0) <= 1024 }
    static func closed(_ value: [String: Any]) -> Bool {
        Set(value.keys) == ["destinationId", "draft", "draftRevision", "acknowledgedEditRevision", "busy", "canSave", "error"] &&
            (value["draft"] as? [String: Any]).map { Set($0.keys) == NativeWalletProfileDraft.keys } == true
    }
}
struct NativeWalletProfileProjection: NativeProfileEditorProjection {
    let identity: NativeWorkspaceIdentity; let destinationId: String; let updateSequence: Int; let privacyGeneration: Int
    let acknowledgedEditRevision: Int; let draftRevision: Int; var draft: NativeWalletProfileDraft
    let busy: Bool; let canSave: Bool; var error: String?; let accentHex: String
    var scene: String { "wallet-profile" }; var checking: Bool { false }; var primary: String { "save" }
    var valid: Bool { identity.valid && draft.valid }
    init(_ state: NativeWorkspaceProjection, _ editor: NativeWalletProfileEditor) {
        identity = state.identity; destinationId = editor.destinationId; updateSequence = state.updateSequence; privacyGeneration = state.privacyGeneration
        acknowledgedEditRevision = editor.acknowledgedEditRevision; draftRevision = editor.draftRevision; draft = editor.draft
        busy = editor.busy; canSave = editor.canSave; error = editor.error; accentHex = state.accentHex
    }
}
@MainActor final class NativeWalletWorkspaceEditor {
    let model: NativeProfileEditorModel<NativeWalletProfileProjection>
    private var action: NativeProfileNameAction?
    init(state: NativeWorkspaceProjection, editor: NativeWalletProfileEditor, workspace: NativeWorkspaceModel) {
        let model = NativeProfileEditorModel(NativeWalletProfileProjection(state, editor)); self.model = model; model.setPresentationEnabled(false)
        model.edit = { [weak workspace, weak model] draft, composing, revision in
            guard let workspace, let model, workspace.active, workspace.state.walletProfileEditor?.destinationId == model.projection.destinationId,
                  let visit = workspace.state.wallet?.detailVisitId, workspace.canInteractDetail?(visit, false) == true else { return false }
            Self.emit(workspace, model: model, draft: draft, revision: revision, composing: composing, final: false); return true
        }
        model.finalEdit = { [weak workspace, weak model] draft, revision in
            guard let workspace, let model else { return }
            Self.emit(workspace, model: model, draft: draft, revision: revision, composing: false, final: true)
        }
        model.choose = { [weak self, weak workspace] action in
            guard let self, let workspace, let visit = workspace.state.wallet?.detailVisitId else { return false }
            self.action = action
            return workspace.choice(action.action == "save" ? "wallet-save" : "wallet-cancel", editRevision: action.editRevision, detailVisitId: visit)
        }
    }
    private static func emit(_ workspace: NativeWorkspaceModel, model: NativeProfileEditorModel<NativeWalletProfileProjection>, draft: NativeWalletProfileDraft, revision: Int, composing: Bool, final: Bool) {
        let projection = model.projection
        var event = projection.identity.event.merging(["destinationId": projection.destinationId, "updateSequence": projection.updateSequence, "privacyGeneration": projection.privacyGeneration,
            "editRevision": revision, "composing": composing, "draft": draft.event]) { _, new in new }
        if final { event["baseDraftRevision"] = projection.draftRevision }
        workspace.emitEdit?(final ? "workspaceFinalEdit" : "workspaceEdit", event)
    }
    func update(_ state: NativeWorkspaceProjection, editor: NativeWalletProfileEditor) -> Bool { model.update(NativeWalletProfileProjection(state, editor)) }
    func confirm(_ choice: NativeWorkspaceAction) -> Bool { action.map { $0.editRevision == choice.editRevision && model.confirm($0) } == true }
    func settle() { if let action { _ = model.settle(action) }; action = nil }
    func clear() { model.clear(); action = nil }
}

@available(iOS 26.0, *) struct NativeWalletProfileForm: View {
    @ObservedObject var model: NativeProfileEditorModel<NativeWalletProfileProjection>
    var body: some View {
        Form {
            ForEach(NativeWalletProfileDraft.fields, id: \.0) { field in
                Section(field.1) {
                    if field.0 == "summary" {
                        NativeProfilePrivateText(model: model, name: field.0, label: field.1, maximum: field.2, identifier: "native-wallet-profile-\(field.0)").frame(minHeight: 96)
                    } else {
                        NativeProfilePrivateField(model: model, name: field.0, label: field.1, maximum: field.2, keyboard: field.0 == "email" ? .emailAddress : field.0 == "phone" ? .phonePad : ["website", "linkedin", "github", "portfolio"].contains(field.0) ? .URL : .default, identifier: "native-wallet-profile-\(field.0)").frame(minHeight: 44)
                    }
                }
            }
            Picker("Preferred contact", selection: Binding(get: { model.draft["preferredContact"] }, set: { value in model.change { $0["preferredContact"] = value } })) {
                Text("Email").tag("email"); Text("Phone").tag("phone"); Text("LinkedIn").tag("linkedin"); Text("Website").tag("website")
            }.pickerStyle(.navigationLink).disabled(!model.canEdit || model.composing)
            if let error = model.projection.error { Text(error).foregroundStyle(.red) }
            Section {
                Button(model.projection.busy ? "Saving…" : "Save") { model.action("save") }.disabled(!model.canSave)
                Button("Cancel") { model.action("cancel") }.disabled(!model.canCancel)
            }
        }.accessibilityIdentifier("native-wallet-profile-editor")
    }
}
