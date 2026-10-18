import SwiftUI
import UIKit

struct NativeWorkspaceOwner: Hashable { let documentId: String; let ownerEpoch: String; let generation: Int }
struct NativeWorkspaceRetirementFence {
    private var revisions = [NativeWorkspaceOwner: Int]()
    mutating func retire(_ identity: NativeWorkspaceIdentity) {
        guard identity.valid else { return }
        revisions[identity.ownerKey] = max(revisions[identity.ownerKey] ?? 0, identity.revision)
    }
    func retired(_ identity: NativeWorkspaceIdentity) -> Bool { identity.valid && identity.revision <= (revisions[identity.ownerKey] ?? 0) }
}

/// Private route-body replica. A route visit is independent of a Profile
/// drawer visit and cannot borrow its modal admission or operation authority.
struct NativeWorkspaceIdentity: Codable, Equatable, Hashable {
    let documentId: String; let ownerEpoch: String; let ownerGeneration: Int; let revision: Int; let workspace: String
    var valid: Bool {
        NativeDrawerIdentity.identifier(documentId) && NativeDrawerIdentity.identifier(ownerEpoch) && workspace == "referrals" &&
        ownerGeneration > 0 && revision > 0 && [ownerGeneration, revision].allSatisfy { $0 <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration }
    }
    var event: [String: Any] { ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration, "revision": revision, "workspace": workspace] }
    var ownerKey: NativeWorkspaceOwner { .init(documentId: documentId, ownerEpoch: ownerEpoch, generation: ownerGeneration) }
}
struct NativeWorkspaceFrame: Codable, Equatable {
    let x: Double; let y: Double; let width: Double; let height: Double
    let viewportWidth: Double; let viewportHeight: Double; let layoutRevision: Int
    var contentInset: Double? = nil
    var gutter: CGFloat { CGFloat(contentInset ?? 16) }
    var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }
    var valid: Bool {
        [x,y,width,height,viewportWidth,viewportHeight].allSatisfy(\.isFinite) && x >= 0 && y >= 0 && width > 0 && height > 0 &&
        viewportWidth > 0 && viewportHeight > 0 && viewportWidth <= 10000 && viewportHeight <= 10000 &&
        x + width <= viewportWidth + 1 && y + height <= viewportHeight + 1 && layoutRevision > 0 && layoutRevision <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration &&
        (contentInset == nil || (contentInset!.isFinite && contentInset! >= 0 && contentInset! <= 64 && contentInset! * 2 < width))
    }
}
struct NativeWorkspaceTabs: Codable { let label: String; let options: [NativeDrawerOption] }
struct NativeWorkspaceSearch: Codable { let id: String; let query: String; let label: String }
struct NativeWorkspaceCircleDraft: Codable, NativeProfileEditorDraft {
    var name: String; var kind: String
    static let empty = Self(name: "", kind: "family")
    var valid: Bool { name.utf16.count <= 80 && ["family", "friends", "other"].contains(kind) }
    var event: [String: Any] { ["name": name, "kind": kind] }
    subscript(_ field: String) -> String {
        get { field == "name" ? name : field == "kind" ? kind : "" }
        set { if field == "name" { name = newValue }; if field == "kind" { kind = newValue } }
    }
}
struct NativeWorkspaceCircleEditor: Codable {
    let destinationId: String; var draft: NativeWorkspaceCircleDraft; let draftRevision: Int; let acknowledgedEditRevision: Int
    let busy: Bool; let canSave: Bool; var error: String?
    var valid: Bool {
        NativeDrawerIdentity.identifier(destinationId) && draft.valid && [draftRevision, acknowledgedEditRevision].allSatisfy { $0 >= 0 && $0 <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration } &&
        (error?.utf16.count ?? 0) <= 1024
    }
}
struct NativeWorkspaceCircleProjection: NativeProfileEditorProjection {
    let identity: NativeWorkspaceIdentity; let destinationId: String; let updateSequence: Int; let privacyGeneration: Int
    let acknowledgedEditRevision: Int; let draftRevision: Int; var draft: NativeWorkspaceCircleDraft; let busy: Bool; let canSave: Bool; var error: String?
    let accentHex: String
    var scene: String { "referral-circle" }; var checking: Bool { false }; var primary: String { "save" }
    var valid: Bool { identity.valid && draft.valid }
    init(_ state: NativeWorkspaceProjection, _ editor: NativeWorkspaceCircleEditor) {
        identity = state.identity; destinationId = editor.destinationId; updateSequence = state.updateSequence; privacyGeneration = state.privacyGeneration
        acknowledgedEditRevision = editor.acknowledgedEditRevision; draftRevision = editor.draftRevision; draft = editor.draft; busy = editor.busy; canSave = editor.canSave; error = editor.error; accentHex = state.accentHex
    }
}
struct NativeWorkspaceProjection: Decodable {
    let documentId: String; let ownerEpoch: String; let ownerGeneration: Int; let revision: Int; let workspace: String
    let updateSequence: Int; let privacyGeneration: Int; let isolationGeneration: Int; let frame: NativeWorkspaceFrame
    let appearance: String; let accentHex: String; let foregroundHex: String
    let page: String; var title: String; let enabled: Bool; let backEnabled: Bool
    var sections: [NativeDrawerSection]; var tabs: NativeWorkspaceTabs?
    var search: NativeWorkspaceSearch?; var circleEditor: NativeWorkspaceCircleEditor?
    var identity: NativeWorkspaceIdentity { .init(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, workspace: workspace) }
    static let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "workspace", "updateSequence", "privacyGeneration", "isolationGeneration", "frame", "appearance", "accentHex", "foregroundHex", "page", "title", "enabled", "backEnabled", "sections", "tabs", "search", "circleEditor"]
    static func closed(_ value: [String: Any]) -> Bool {
        guard Set(value.keys).isSubset(of: keys), let frame = value["frame"] as? [String: Any], Set(frame.keys).isSubset(of: ["x", "y", "width", "height", "viewportWidth", "viewportHeight", "layoutRevision", "contentInset"]),
              let sections = value["sections"] as? [[String: Any]] else { return false }
        for section in sections {
            guard Set(section.keys).isSubset(of: ["id", "title", "rows"]), let rows = section["rows"] as? [[String: Any]] else { return false }
            for row in rows where !Set(row.keys).isSubset(of: ["id", "label", "detail", "symbol", "artworkId", "iconHex", "chevron", "trailing", "enabled", "destructive", "selected", "pending", "readOnly"]) { return false }
        }
        if let raw = value["tabs"] {
            guard let tabs = raw as? [String: Any], Set(tabs.keys) == ["label", "options"], let options = tabs["options"] as? [[String: Any]],
                  options.allSatisfy({ Set($0.keys) == ["id", "label", "selected"] }) else { return false }
        }
        if let raw = value["search"] { guard let search = raw as? [String: Any], Set(search.keys) == ["id", "query", "label"] else { return false } }
        if let raw = value["circleEditor"] {
            guard let editor = raw as? [String: Any], Set(editor.keys) == ["destinationId", "draft", "draftRevision", "acknowledgedEditRevision", "busy", "canSave", "error"],
                  let draft = editor["draft"] as? [String: Any], Set(draft.keys) == ["name", "kind"] else { return false }
        }
        return true
    }
    var valid: Bool {
        let max = HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
        guard identity.valid, updateSequence > 0, updateSequence <= max, privacyGeneration >= 0, privacyGeneration <= max, isolationGeneration >= 0, isolationGeneration <= max,
              frame.valid, ["overview", "rules", "circle-picker", "circle-create", "circle-people"].contains(page), NativeDrawerProjection.text(title, 256), sections.count <= 32,
              HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil else { return false }
        var ids = Set<String>(); var count = 0
        for section in sections {
            guard NativeDrawerIdentity.identifier(section.id), ids.insert(section.id).inserted, section.title == nil || NativeDrawerProjection.text(section.title!, 256) else { return false }
            for row in section.rows {
                count += 1
                guard count <= 200, NativeDrawerIdentity.identifier(row.id), ids.insert(row.id).inserted, NativeDrawerProjection.text(row.label, 4096),
                      row.detail == nil || NativeDrawerProjection.text(row.detail!, 4096), row.trailing == nil || NativeDrawerProjection.text(row.trailing!, 32),
                      row.symbol == nil || NativeDrawerIdentity.identifier(row.symbol!), row.artworkId == nil || NativeDrawerIdentity.identifier(row.artworkId!),
                      row.iconHex == nil || row.iconHex!.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil else { return false }
            }
        }
        if let tabs {
            guard NativeDrawerProjection.text(tabs.label, 64), (2...4).contains(tabs.options.count), tabs.options.filter(\.selected).count == 1 else { return false }
            for option in tabs.options { guard NativeDrawerIdentity.identifier(option.id), ids.insert(option.id).inserted, NativeDrawerProjection.text(option.label, 64) else { return false } }
        }
        if let search { guard NativeDrawerIdentity.identifier(search.id), ids.insert(search.id).inserted, search.query.utf16.count <= 256, NativeDrawerProjection.text(search.label, 64) else { return false } }
        if let circleEditor { guard page == "circle-create", circleEditor.valid else { return false } }
        return true
    }
    func receipt(_ phase: String, settled: Bool) -> [String: Any] {
        identity.event.merging(["updateSequence": updateSequence, "privacyGeneration": privacyGeneration, "layoutRevision": frame.layoutRevision, "phase": phase, "settled": settled]) { _, new in new }
    }
    func permits(_ action: String, row: String?, text: String? = nil) -> Bool {
        guard enabled else { return false }
        if action == "circle-save" || action == "circle-cancel" { return circleEditor != nil && circleEditor?.busy == false && row == nil && text == nil && (action == "circle-cancel" || circleEditor?.canSave == true) }
        if action == "back" { return backEnabled && row == nil }
        guard action == "row", let row else { return false }
        if search?.id == row { return text != nil && (text?.utf16.count ?? 257) <= 256 }
        guard text == nil else { return false }
        if tabs?.options.contains(where: { $0.id == row && !$0.selected }) == true { return true }
        return sections.contains { $0.rows.contains { $0.id == row && $0.enabled && $0.pending != true && $0.readOnly != true } }
    }
}
struct NativeWorkspaceAction: Equatable {
    let sequence: Int; let updateSequence: Int; let action: String; let row: String?
    var text: String? = nil; var editRevision: Int? = nil
}
@MainActor final class NativeWorkspaceModel: ObservableObject {
    @Published private(set) var state: NativeWorkspaceProjection
    @Published private(set) var pending: NativeWorkspaceAction?
    @Published private(set) var active = true
    var emit: (([String: Any]) -> Void)?
    var emitEdit: ((String, [String: Any]) -> Void)?
    var canInteract: (() -> Bool)?
    var scrolled: ((CGFloat, Bool) -> Void)?
    let searchMenus = NativeEditorMenuLifetime()
    weak var searchField: UITextField?
    private var sequence = 0; private var confirmed = 0
    @Published private(set) var editor: NativeProfileEditorModel<NativeWorkspaceCircleProjection>?
    private var editorAction: NativeProfileNameAction?
    init(_ state: NativeWorkspaceProjection) { self.state = state; _ = reconcileEditor() }
    var presentationComplete: Bool { state.circleEditor == nil || editor?.retired == false }
    @discardableResult private func reconcileEditor() -> Bool {
        guard let next = state.circleEditor else { editor?.clear(); editor = nil; editorAction = nil; return true }
        let projection = NativeWorkspaceCircleProjection(state, next)
        if let editor, editor.projection.destinationId == next.destinationId {
            if !editor.update(projection) { editor.clear(); self.editor = nil; return false }
            return true
        }
        editor?.clear()
        let model = NativeProfileEditorModel(projection); editor = model
        model.edit = { [weak self, weak model] draft, composing, revision in
            guard let self, let model, self.editor === model, self.active else { return false }
            self.emitEditor("workspaceEdit", draft, composing: composing, revision: revision, model: model); return true
        }
        model.finalEdit = { [weak self, weak model] draft, revision in
            guard let self, let model else { return }
            self.emitEditor("workspaceFinalEdit", draft, composing: false, revision: revision, model: model)
        }
        model.choose = { [weak self, weak model] action in
            guard let self, let model, self.editor === model else { return false }
            self.editorAction = action
            return self.choice(action.action == "save" ? "circle-save" : "circle-cancel", editRevision: action.editRevision)
        }
        return true
    }
    private func emitEditor(_ event: String, _ draft: NativeWorkspaceCircleDraft, composing: Bool, revision: Int, model: NativeProfileEditorModel<NativeWorkspaceCircleProjection>) {
        let projection = model.projection
        var payload = projection.identity.event.merging(["destinationId": projection.destinationId, "updateSequence": projection.updateSequence, "privacyGeneration": projection.privacyGeneration,
            "editRevision": revision, "composing": composing, "draft": draft.event]) { _, new in new }
        if event == "workspaceFinalEdit" { payload["baseDraftRevision"] = projection.draftRevision }
        emitEdit?(event, payload)
    }
    func update(_ next: NativeWorkspaceProjection) -> Bool {
        guard active, next.identity == state.identity, next.updateSequence > state.updateSequence,
              next.privacyGeneration == state.privacyGeneration, next.frame.layoutRevision >= state.frame.layoutRevision,
              next.frame.layoutRevision != state.frame.layoutRevision || next.frame == state.frame else { return false }
        state = next; return reconcileEditor()
    }
    @discardableResult func choice(_ action: String, row: String? = nil, text: String? = nil, editRevision: Int? = nil) -> Bool {
        guard active, pending == nil, canInteract?() == true, state.permits(action, row: row, text: text), sequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return false }
        sequence += 1
        let choice = NativeWorkspaceAction(sequence: sequence, updateSequence: state.updateSequence, action: action, row: row, text: text, editRevision: editRevision)
        pending = choice
        var event = state.identity.event.merging(["privacyGeneration": state.privacyGeneration, "sequence": sequence, "updateSequence": state.updateSequence, "action": action]) { _, new in new }
        if let row { event["rowId"] = row }; if let text { event["text"] = text }; if let editRevision { event["editRevision"] = editRevision }; emit?(event); return true
    }
    func confirm(_ action: NativeWorkspaceAction) -> Bool {
        guard active, canInteract?() == true, pending == action, action.sequence > confirmed, action.updateSequence == state.updateSequence,
              state.permits(action.action, row: action.row, text: action.text) else { return false }
        if action.action.hasPrefix("circle-") {
            guard let editorAction, editorAction.editRevision == action.editRevision, editor?.confirm(editorAction) == true else { return false }
        }
        confirmed = action.sequence; return true
    }
    func settle(_ action: NativeWorkspaceAction) -> Bool {
        guard pending == action else { return false }; pending = nil
        if let editorAction { _ = editor?.settle(editorAction); self.editorAction = nil }; return true
    }
    func clear() {
        active = false; pending = nil; emit = nil; canInteract = nil; scrolled = nil; editor?.clear(); editor = nil; emitEdit = nil
        searchField?.unmarkText(); searchField?.resignFirstResponder(); searchField?.text = ""; searchField?.undoManager?.removeAllActions()
        state.sections = []; state.tabs = nil; state.search = nil; state.circleEditor = nil; state.title = ""
    }
}
@available(iOS 26.0, *) private struct NativeWorkspaceBody: View {
    @ObservedObject var model: NativeWorkspaceModel
    @State private var scrollingFromPerson = false
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                if model.state.backEnabled {
                    Button { model.choice("back") } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }
                        .buttonStyle(.glass).buttonBorderShape(.circle).accessibilityLabel("Back").accessibilityIdentifier("native-workspace-back")
                }
                Text(model.state.title).font(.title2.bold()).frame(maxWidth: .infinity, alignment: .leading).accessibilityAddTraits(.isHeader)
            }.padding(.horizontal, model.state.frame.gutter).padding(.vertical, 8)
            if let tabs = model.state.tabs {
                Picker(tabs.label, selection: Binding(get: { tabs.options.first(where: \.selected)?.id ?? "" }, set: { model.choice("row", row: $0) })) {
                    ForEach(tabs.options, id: \.id) { option in Text(option.label).tag(option.id) }
                }.pickerStyle(.segmented).padding(.horizontal, model.state.frame.gutter).padding(.bottom, 8).accessibilityIdentifier("native-workspace-tabs")
            }
            if let search = model.state.search { NativeWorkspaceSearchField(model: model, search: search).padding(.horizontal, model.state.frame.gutter).padding(.bottom, 8) }
            if let editor = model.editor {
                NativeWorkspaceCircleForm(model: editor, gutter: model.state.frame.gutter)
            } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    ForEach(model.state.sections) { section in
                        VStack(alignment: .leading, spacing: 6) {
                            if let title = section.title { Text(title).font(.subheadline).foregroundStyle(.secondary).padding(.horizontal, 6).accessibilityAddTraits(.isHeader) }
                            VStack(spacing: 0) {
                                ForEach(Array(section.rows.enumerated()), id: \.element.id) { index, row in
                                    if row.readOnly == true { NativeSettingsRowLabel(row: row, accentHex: model.state.accentHex).accessibilityElement(children: .combine) }
                                    else {
                                        Button { model.choice("row", row: row.id) } label: { NativeSettingsRowLabel(row: row, accentHex: model.state.accentHex) }
                                            .buttonStyle(.plain).disabled(!row.enabled || row.pending == true)
                                            .accessibilityLabel(row.label).accessibilityValue([row.detail, row.trailing].compactMap { $0 }.joined(separator: ", "))
                                            .accessibilityIdentifier("native-workspace-row-\(row.id)")
                                    }
                                    if index < section.rows.count - 1 { Divider().padding(.horizontal, 16) }
                                }
                            }.background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                        }
                    }
                }.padding(.horizontal, model.state.frame.gutter).padding(.top, 8).padding(.bottom, 24)
            }.scrollDismissesKeyboard(.interactively).accessibilityIdentifier("native-workspace-scroll")
                .onScrollPhaseChange { _, phase in scrollingFromPerson = phase == .interacting || phase == .decelerating }
                .onScrollGeometryChange(for: CGFloat.self, of: { max(0, $0.contentOffset.y + $0.contentInsets.top) }) { _, value in model.scrolled?(value, scrollingFromPerson) }
            }
        }.background(Color(uiColor: .systemGroupedBackground))
            .tint(Color(uiColor: HushhNativeControlAppearance.color(model.state.accentHex) ?? .label))
            .preferredColorScheme(model.state.appearance == "dark" ? .dark : .light)
            .disabled(!model.active || !model.state.enabled)
    }
}
@available(iOS 26.0, *) private struct NativeWorkspaceCircleForm: View {
    @ObservedObject var model: NativeProfileEditorModel<NativeWorkspaceCircleProjection>
    let gutter: CGFloat
    var body: some View {
        Form {
            Section("Circle name") {
                NativeProfilePrivateField(model: model, name: "name", label: "Circle name", maximum: 80, identifier: "native-referral-circle-name").frame(minHeight: 44)
            }
            Picker("Circle type", selection: Binding(get: { model.draft.kind }, set: { value in model.change { $0.kind = value } })) {
                Text("Family").tag("family"); Text("Friends").tag("friends"); Text("Other").tag("other")
            }.pickerStyle(.segmented).disabled(!model.canEdit || model.composing).accessibilityIdentifier("native-referral-circle-kind")
            if let error = model.projection.error { Text(error).foregroundStyle(.red).accessibilityAddTraits(.updatesFrequently) }
            Section {
                Button(model.projection.busy ? "Saving…" : "Next") { model.action("save") }.disabled(!model.canSave).accessibilityIdentifier("native-referral-circle-next")
                Button("Cancel") { model.action("cancel") }.disabled(!model.canCancel)
            }
        }.contentMargins(.horizontal, gutter, for: .scrollContent)
    }
}
@available(iOS 26.0, *) private struct NativeWorkspaceSearchField: View {
    @ObservedObject var model: NativeWorkspaceModel
    let search: NativeWorkspaceSearch
    var body: some View {
        NativeWorkspaceSearchInput(model: model, search: search).padding(.horizontal, 14).frame(minHeight: 44).glassEffect(.regular, in: Capsule())
    }
}
@available(iOS 26.0, *) private struct NativeWorkspaceSearchInput: UIViewRepresentable {
    let model: NativeWorkspaceModel; let search: NativeWorkspaceSearch
    func makeUIView(context: Context) -> NativeWorkspaceSearchControl { NativeWorkspaceSearchControl(model: model, search: search) }
    func updateUIView(_ view: NativeWorkspaceSearchControl, context: Context) { view.update(search) }
    static func dismantleUIView(_ view: NativeWorkspaceSearchControl, coordinator: ()) { view.scrub() }
}
@available(iOS 26.0, *) @MainActor private final class NativeWorkspaceSearchControl: UIStackView, UITextFieldDelegate {
    private weak var model: NativeWorkspaceModel?
    private var search: NativeWorkspaceSearch
    private let field = UITextField()
    private let clear = UIButton(type: .system)
    init(model: NativeWorkspaceModel, search: NativeWorkspaceSearch) {
        self.model = model; self.search = search; super.init(frame: .zero)
        axis = .horizontal; spacing = 8; alignment = .center
        let icon = UIImageView(image: UIImage(systemName: "magnifyingglass")); icon.tintColor = .secondaryLabel; icon.isAccessibilityElement = false
        addArrangedSubview(icon); icon.widthAnchor.constraint(equalToConstant: 20).isActive = true
        field.delegate = self; field.font = .preferredFont(forTextStyle: .body); field.adjustsFontForContentSizeCategory = true
        field.autocapitalizationType = .none; field.autocorrectionType = .no; field.returnKeyType = .search
        field.text = search.query; field.placeholder = search.label; field.accessibilityLabel = search.label; field.accessibilityIdentifier = "native-workspace-search"
        field.addTarget(self, action: #selector(changed), for: .editingChanged); field.setContentHuggingPriority(.defaultLow, for: .horizontal); addArrangedSubview(field)
        clear.setImage(UIImage(systemName: "xmark.circle.fill"), for: .normal); clear.accessibilityLabel = "Clear search"
        clear.addTarget(self, action: #selector(clearSearch), for: .touchUpInside); addArrangedSubview(clear)
        clear.widthAnchor.constraint(equalToConstant: 44).isActive = true; clear.heightAnchor.constraint(equalToConstant: 44).isActive = true
        model.searchField = field; changed()
    }
    required init(coder: NSCoder) { fatalError("Native workspace search is programmatic") }
    func update(_ next: NativeWorkspaceSearch) {
        if field.markedTextRange == nil && (next.id != search.id || field.text == search.query) { field.text = next.query }
        search = next; field.placeholder = next.label; field.accessibilityLabel = next.label; field.textColor = .label
        field.tintColor = HushhNativeControlAppearance.color(model?.state.accentHex ?? "") ?? .label; changed()
    }
    @objc private func changed() { clear.isHidden = field.text?.isEmpty != false }
    @objc private func clearSearch() { field.unmarkText(); field.text = ""; changed(); submit() }
    private func submit() { guard field.markedTextRange == nil, model?.state.search?.id == search.id else { return }; _ = model?.choice("row", row: search.id, text: field.text ?? "") }
    func textFieldShouldReturn(_ textField: UITextField) -> Bool { submit(); return false }
    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
        guard model?.active == true, let text = textField.text, let span = Range(range, in: text) else { return false }
        return text.replacingCharacters(in: span, with: string).utf16.count <= 256
    }
    func textField(_ textField: UITextField, willPresentEditMenuWith animator: any UIEditMenuInteractionAnimating) { model?.searchMenus.presented(textField) }
    func textField(_ textField: UITextField, willDismissEditMenuWith animator: any UIEditMenuInteractionAnimating) {
        guard let menus = model?.searchMenus else { return }; animator.addCompletion { menus.dismissed(textField) }
    }
    func scrub() { field.unmarkText(); field.resignFirstResponder(); field.text = ""; field.undoManager?.removeAllActions(); field.delegate = nil }
}
@MainActor final class NativeWorkspacePresentation {
    static let installationID = "route-workspace"
    let model: NativeWorkspaceModel
    private let host: UIViewController
    private weak var container: NativePresentationContainer?
    private var retiring = false
    private var retirement = [() -> Void]()
    private var menusDismissed = false
    private var presentationsDismissed = false
    var ready: Bool { model.active && model.presentationComplete && host.parent != nil && host.viewIfLoaded?.window != nil && host.viewIfLoaded?.superview != nil }
    init?(_ state: NativeWorkspaceProjection, parent: UIViewController, container: NativePresentationContainer) {
        guard #available(iOS 26.0, *) else { return nil }
        model = NativeWorkspaceModel(state)
        host = UIHostingController(rootView: NativeWorkspaceBody(model: model))
        self.container = container
        host.view.backgroundColor = .systemGroupedBackground
        host.view.accessibilityIdentifier = "native-route-workspace"
        parent.addChild(host)
        container.install(host.view, id: Self.installationID, group: nil)
        container.ownWorkspaceScroll(state.identity)
        host.view.frame = state.frame.rect
        host.didMove(toParent: parent)
        model.canInteract = { [weak container, weak model] in
            guard let container, let model else { return false }
            let privacy = HushhSessionPrivacyShield.shared.snapshot()
            return model.active && container.allowsControl(Self.installationID) && container.isolationGeneration == model.state.isolationGeneration && privacy.appIsActive && !privacy.shielded && privacy.generation == model.state.privacyGeneration
        }
        model.scrolled = { [weak container, weak model] y, fromPerson in
            guard let model, model.active else { return }; container?.reportWorkspaceScroll(model.state.identity, y: y, fromPerson: fromPerson)
        }
        refresh()
    }
    func refresh() {
        host.overrideUserInterfaceStyle = model.state.appearance == "dark" ? .dark : .light
        host.view.frame = model.state.frame.rect; host.view.setNeedsLayout(); host.view.layoutIfNeeded()
        container?.setAdmission(Self.installationID, admitted: model.state.enabled && container?.isolationGeneration == model.state.isolationGeneration)
    }
    func retire(completion: @escaping () -> Void) {
        retirement.append(completion)
        guard !retiring else { return }; retiring = true
        let menus = DispatchGroup()
        if let editor = model.editor { menus.enter(); editor.dismissEditorMenus { menus.leave() } }
        menus.enter(); model.searchMenus.dismiss(model.searchField.map { [$0] } ?? []) { menus.leave() }
        menus.notify(queue: .main) { [self] in menusDismissed = true; finishRetirementIfReady() }
        container?.releaseWorkspaceScroll(model.state.identity)
        model.clear(); host.view.endEditing(true); host.willMove(toParent: nil)
        func dismissOwnedPresentation(_ completion: @escaping () -> Void) {
            guard host.presentedViewController != nil else { completion(); return }
            host.dismiss(animated: false, completion: completion)
        }
        dismissOwnedPresentation { [self] in presentationsDismissed = true; finishRetirementIfReady() }
    }
    private func finishRetirementIfReady() {
        guard menusDismissed, presentationsDismissed else { return }
        container?.remove(Self.installationID); host.removeFromParent()
        guard host.parent == nil, host.view.superview == nil else { return }
        let callbacks = retirement; retirement.removeAll(); callbacks.forEach { $0() }
    }
}
