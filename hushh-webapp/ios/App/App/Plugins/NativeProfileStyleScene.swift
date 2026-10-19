import SwiftUI
import UIKit

/// Private, volatile ordinary Settings values. No credential, transport or store.
enum NativeProfileStyleValue: Codable, Equatable {
    case text(String), flag(Bool)
    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let flag = try? value.decode(Bool.self) { self = .flag(flag) }
        else { self = .text(try value.decode(String.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self { case .text(let text): try value.encode(text); case .flag(let flag): try value.encode(flag) }
    }
    var bridge: Any { switch self { case .text(let text): return text; case .flag(let flag): return flag } }
    var text: String { if case .text(let text) = self { return text }; return "" }
}
struct NativeProfileStyleOption: Decodable, Equatable { let value: String; let label: String }
struct NativeProfileStyleMenuBinding {
    let identity: NativeDrawerIdentity, privacy: Int, choices: [String: [NativeProfileStyleOption]]
    init(_ state: NativeProfileStyleProjection) { identity = state.identity; privacy = state.privacyGeneration; choices = state.choices }
}
struct NativeProfileStyleProjection: Decodable {
    let documentId: String, ownerEpoch: String, family: String, scene: String
    let ownerGeneration: Int, revision: Int, updateSequence: Int, privacyGeneration: Int
    let draftRevision: Int, acknowledgedEditRevision: Int
    var draft: [String: NativeProfileStyleValue]
    let choices: [String: [NativeProfileStyleOption]]
    let canSave: Bool, busy: Bool, unavailable: Bool, suggested: Bool
    var error: String?
    let appearance: String, accentHex: String, foregroundHex: String
    var destinationId: String? = nil
    static let fields: Set<String> = ["preferred_name", "tone", "length", "language", "avoid_em_dashes", "owner_style_note"]
    static let keys: Set<String> = NativeProfileNameProjection.keys.union(["choices", "unavailable", "suggested"])
    var identity: NativeDrawerIdentity {
        NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, family: family)
    }
    func validValue(_ value: NativeProfileStyleValue?, field: String) -> Bool {
        guard Self.fields.contains(field) else { return false }
        guard let value else { return true }
        switch (field, value) {
        case ("avoid_em_dashes", .flag): return true
        case ("preferred_name", .text(let text)): return text.utf16.count <= 64
        case ("owner_style_note", .text(let text)): return text.utf16.count <= 280
        case (_, .text(let text)): return choices[field]?.contains { $0.value == text } == true
        default: return false
        }
    }
    var valid: Bool {
        let max = HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
        return identity.valid && family == "profile" && scene == "writing-style" &&
            (destinationId == nil || NativeDrawerIdentity.identifier(destinationId!)) && updateSequence > 0 && updateSequence <= max &&
            [privacyGeneration, draftRevision, acknowledgedEditRevision].allSatisfy { $0 >= 0 && $0 <= max } &&
            Set(choices.keys) == Set(["tone", "length", "language"]) && choices.values.allSatisfy { options in
                !options.isEmpty && options.count <= 16 && Set(options.map(\.value)).count == options.count &&
                    options.allSatisfy { !$0.value.isEmpty && $0.value.utf16.count <= 24 && !$0.label.isEmpty && $0.label.utf16.count <= 64 }
            } && draft.allSatisfy { validValue($0.value, field: $0.key) } && (error?.utf16.count ?? 0) <= 1024 &&
            HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil
    }
    func receipt(_ phase: String) -> [String: Any] {
        var result: [String: Any] = ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration, "revision": revision,
         "family": family, "scene": scene, "updateSequence": updateSequence, "privacyGeneration": privacyGeneration, "phase": phase]
        if let destinationId { result["destinationId"] = destinationId }
        return result
    }
}

@MainActor
final class NativeProfileStyleModel: ObservableObject {
    @Published private(set) var projection: NativeProfileStyleProjection
    @Published private(set) var draft: [String: NativeProfileStyleValue]
    @Published private(set) var pending: NativeProfileNameAction?
    @Published private(set) var retired = false
    @Published private(set) var composing = false
    @Published private(set) var saved = false
    private(set) var editRevision = 0
    private var actionSequence = 0, confirmedSequence = 0
    private var menus = NSHashTable<NativeDrawerMenuControl>.weakObjects()
    private var retiringMenus = [NativeDrawerMenuControl]()
    private var editors = NSHashTable<UIView>.weakObjects()
    var edit: ((String, NativeProfileStyleValue?, Bool, Int) -> Bool)?
    var choose: ((NativeProfileNameAction) -> Bool)?
    var changed: (() -> Void)?
    private var hasMarkedText: Bool {
        editors.allObjects.contains { ($0 as? UITextView)?.markedTextRange != nil || ($0 as? UITextField)?.markedTextRange != nil }
    }
    private var hasVisibleMenu: Bool { (menus.allObjects + retiringMenus).contains { $0.menuVisible } }
    var canEdit: Bool { !retired && !projection.busy && pending == nil }
    var canSave: Bool { canEdit && !composing && !hasMarkedText && projection.canSave && projection.acknowledgedEditRevision == editRevision && !hasVisibleMenu }
    var canDismiss: Bool { canEdit && !hasVisibleMenu }
    var accent: UIColor { HushhNativeControlAppearance.color(projection.accentHex) ?? .label }
    init(_ projection: NativeProfileStyleProjection) { self.projection = projection; draft = projection.draft }
    func update(_ next: NativeProfileStyleProjection) -> Bool {
        guard !retired, next.valid, next.identity == projection.identity, next.destinationId == projection.destinationId, next.choices == projection.choices,
              next.privacyGeneration == projection.privacyGeneration, next.updateSequence > projection.updateSequence,
              next.draftRevision >= projection.draftRevision, next.acknowledgedEditRevision >= projection.acknowledgedEditRevision,
              next.acknowledgedEditRevision <= editRevision else { return false }
        projection = next
        if next.acknowledgedEditRevision == editRevision && !composing { draft = next.draft }
        return true
    }
    func change(_ field: String, _ value: NativeProfileStyleValue?, composing: Bool = false) {
        guard canEdit, projection.validValue(value, field: field), value != draft[field] || composing != self.composing,
              editRevision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        draft[field] = value; self.composing = composing; saved = false; editRevision += 1
        if edit?(field, value, composing, editRevision) != true { clear() }
    }
    func action(_ action: String) {
        guard canEdit, action == "cancel" || action == "save" && canSave,
              actionSequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        actionSequence += 1
        let intent = NativeProfileNameAction(updateSequence: projection.updateSequence, editRevision: editRevision, sequence: actionSequence, action: action)
        pending = intent; changed?()
        if choose?(intent) != true { pending = nil; changed?() }
    }
    func confirm(_ intent: NativeProfileNameAction) -> Bool {
        guard !retired, pending == intent, intent.sequence > confirmedSequence, !projection.busy,
              intent.action == "cancel" ? intent.updateSequence <= projection.updateSequence :
                intent.updateSequence == projection.updateSequence && !composing && !hasMarkedText && projection.canSave &&
                  intent.editRevision == editRevision && projection.acknowledgedEditRevision == editRevision else { return false }
        confirmedSequence = intent.sequence; return true
    }
    func settle(_ intent: NativeProfileNameAction, saved: Bool) -> Bool {
        guard !retired, pending == intent else { return false }
        pending = nil; self.saved = saved; changed?(); return true
    }
    func register(_ editor: UIView) { editors.add(editor) }
    func register(_ menu: NativeDrawerMenuControl) { menus.add(menu) }
    func chooseOption(_ field: String, value: NativeProfileStyleValue?, from source: NativeProfileStyleMenuBinding) {
        guard canEdit, source.identity == projection.identity, source.privacy == projection.privacyGeneration,
              source.choices == projection.choices else { return }
        change(field, value)
    }
    func menuVisibilityChanged() { objectWillChange.send(); changed?() }
    func withdraw(_ menu: NativeDrawerMenuControl) {
        menus.remove(menu)
        retiringMenus.append(menu)
        menu.dismissOwnedMenu { [weak self, weak menu] in
            self?.retiringMenus.removeAll { $0 === menu }
            self?.menuVisibilityChanged()
        }
    }
    func dismissMenus(_ completion: @escaping () -> Void) {
        let all = menus.allObjects + retiringMenus
        guard !all.isEmpty else { completion(); return }
        let group = DispatchGroup()
        for menu in all { group.enter(); menu.dismissOwnedMenu { group.leave() } }
        group.notify(queue: .main, execute: completion)
    }
    func clear() {
        retired = true
        for editor in editors.allObjects {
            if let field = editor as? UITextField { field.unmarkText(); field.text = "" }
            if let field = editor as? UITextView { field.unmarkText(); field.text = "" }
            editor.resignFirstResponder(); editor.undoManager?.removeAllActions()
        }
        draft = [:]; projection.draft = [:]; projection.error = nil
        pending = nil; saved = false; edit = nil; choose = nil
    }
}

@available(iOS 26.0, *)
struct NativeProfileStyleText: UIViewRepresentable {
    @ObservedObject var model: NativeProfileStyleModel
    let field: String
    let multiline: Bool
    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 10, left: 0, bottom: 10, right: 0)
        view.textContainer.lineFragmentPadding = 0
        view.isScrollEnabled = multiline
        view.textContainer.maximumNumberOfLines = multiline ? 0 : 1
        view.autocapitalizationType = multiline ? .sentences : .words
        view.accessibilityLabel = multiline ? "Style note" : "Name One calls you"
        view.accessibilityIdentifier = "native-style-\(field)"
        model.register(view)
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        view.isEditable = model.canEdit; view.textColor = .label; view.tintColor = model.accent
        let text = model.draft[field]?.text ?? ""
        if view.markedTextRange == nil && view.text != text {
            let selection = view.selectedRange
            view.text = text
            view.selectedRange = NSRange(location: min(selection.location, text.utf16.count), length: 0)
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator(model, field, multiline) }
    static func dismantleUIView(_ view: UITextView, coordinator: Coordinator) {
        view.resignFirstResponder(); view.delegate = nil; view.text = ""; view.undoManager?.removeAllActions()
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        let model: NativeProfileStyleModel, field: String, multiline: Bool
        init(_ model: NativeProfileStyleModel, _ field: String, _ multiline: Bool) { self.model = model; self.field = field; self.multiline = multiline }
        func textViewDidChange(_ view: UITextView) { capture(view) }
        func textViewDidChangeSelection(_ view: UITextView) { capture(view) }
        private func capture(_ view: UITextView) {
            let marked = view.markedTextRange != nil
            let current = view.text ?? ""
            let text = !multiline && !marked ? current.replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "") : current
            model.change(field, .text(text), composing: marked)
        }
        func textView(_ view: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            let current = view.text as NSString
            guard model.canEdit, range.location <= current.length, range.length <= current.length - range.location else { return false }
            if !multiline && text == "\n" {
                guard view.markedTextRange == nil else { return false }
                capture(view); view.resignFirstResponder(); return false
            }
            let replacement = !multiline && view.markedTextRange == nil ? text.replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "") : text
            return current.replacingCharacters(in: range, with: replacement).utf16.count <= (multiline ? 280 : 64)
        }
    }
}

@available(iOS 26.0, *)
private struct NativeProfileStyleMenu: UIViewRepresentable {
    @ObservedObject var model: NativeProfileStyleModel
    let field: String, label: String
    func makeCoordinator() -> NativeProfileStyleModel { model }
    func makeUIView(context: Context) -> NativeDrawerMenuControl {
        let button = NativeDrawerMenuControl(type: .system)
        button.showsMenuAsPrimaryAction = true
        button.contentHorizontalAlignment = .trailing
        button.titleLabel?.font = .preferredFont(forTextStyle: .body)
        button.titleLabel?.adjustsFontForContentSizeCategory = true
        button.accessibilityIdentifier = "native-style-\(field)"
        button.visibilityChanged = { [weak model] in model?.menuVisibilityChanged() }
        model.register(button)
        return button
    }
    func updateUIView(_ button: NativeDrawerMenuControl, context: Context) {
        button.isEnabled = model.canEdit; button.tintColor = model.accent
        button.accessibilityLabel = label
        let selected = model.draft[field]?.text
        let options = [NativeProfileStyleOption(value: "", label: "No preference")] + (model.projection.choices[field] ?? [])
        let title = options.first { $0.value == selected }?.label ?? "No preference"
        button.setTitle(title, for: .normal)
        button.accessibilityValue = title
        // Never replace an open menu or bind a delayed choice to new options.
        guard !button.menuVisible else { return }
        let source = NativeProfileStyleMenuBinding(model.projection)
        let key = field
        button.menu = UIMenu(children: options.map { option in
            UIAction(title: option.label, state: option.value == (selected ?? "") ? .on : .off) { [weak button, weak model] _ in
                button?.afterDismissal {
                    model?.chooseOption(key, value: option.value.isEmpty ? nil : .text(option.value), from: source)
                }
            }
        })
    }
    static func dismantleUIView(_ button: NativeDrawerMenuControl, coordinator: NativeProfileStyleModel) { coordinator.withdraw(button) }
}

@available(iOS 26.0, *)
private struct NativeProfileStyleContent: View {
    @ObservedObject var model: NativeProfileStyleModel
    private func label(_ title: String, _ icon: String) -> some View {
        HStack(spacing: 12) {
            if let artwork = NativeProfileArtwork.resolve(icon) {
                Image(uiImage: artwork.base).resizable()
                    .foregroundStyle(Color(uiColor: HushhNativeControlAppearance.color(artwork.colorHex) ?? .label))
                    .frame(width: 28, height: 28).frame(width: 32, height: 32).accessibilityHidden(true)
            }
            Text(title)
        }
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button("Close") { model.action("cancel") }.buttonStyle(.glass).disabled(!model.canEdit)
                    .frame(minWidth: 44, minHeight: 44).accessibilityIdentifier("native-style-close")
                Spacer(minLength: 12)
                Text("Writing style").font(.headline).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                Button("Save") { model.action("save") }.buttonStyle(.glassProminent).disabled(!model.canSave)
                    .frame(minWidth: 44, minHeight: 44).accessibilityIdentifier("native-style-save")
            }.padding(.horizontal, 16).padding(.vertical, 8)
            Form {
                Section {
                    VStack(alignment: .leading) {
                        label("Call me", "style-name")
                        NativeProfileStyleText(model: model, field: "preferred_name", multiline: false).frame(height: 44)
                    }
                    choice("Tone", "tone", "style-tone")
                    choice("Length", "length", "style-length")
                    choice("Language", "language", "style-language")
                    Toggle(isOn: Binding(get: { model.draft["avoid_em_dashes"] == .flag(true) },
                        set: { model.change("avoid_em_dashes", .flag($0)) })) {
                        label("Avoid em dashes", "style-punctuation")
                    }.disabled(!model.canEdit).accessibilityIdentifier("native-style-avoid_em_dashes").frame(minHeight: 44)
                } footer: { Text("These change One's writing, never what it can see, share or do.") }
                Section("Style note") {
                    NativeProfileStyleText(model: model, field: "owner_style_note", multiline: true).frame(minHeight: 112)
                }
                if model.projection.unavailable { Text("Couldn't read your writing style. Reopen Preferences to try again.").foregroundStyle(.secondary) }
                if model.projection.suggested { Text("Suggested in Chat · Not saved").foregroundStyle(.secondary) }
                if let error = model.projection.error { Text(error).foregroundStyle(.red) }
                if model.projection.busy { ProgressView("Saving…") }
                if model.saved && !model.projection.canSave && !model.projection.busy && !model.projection.suggested {
                    Text("Saved").foregroundStyle(.secondary).accessibilityIdentifier("native-style-saved")
                }
            }
        }.tint(Color(uiColor: model.accent)).preferredColorScheme(model.projection.appearance == "dark" ? .dark : .light)
    }
    private func choice(_ title: String, _ field: String, _ icon: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            label(title, icon)
            NativeProfileStyleMenu(model: model, field: field, label: title).frame(minHeight: 44)
        }
    }
}

@MainActor
final class NativeProfileStyleScene: NSObject, NativeProfileOwnedForm {
    let model: NativeProfileStyleModel
    var identity: NativeDrawerIdentity { model.projection.identity }
    var sceneName: String { "writing-style" }
    func receipt(_ phase: String) -> [String: Any] { model.projection.receipt(phase) }
    private lazy var sheet: NativeProfileOwnedSheet = {
        let model = model
        return NativeProfileOwnedSheet(makeHost: { [weak model] in
            guard #available(iOS 26.0, *), let model else { return nil }
            return UIHostingController(rootView: NativeProfileStyleContent(model: model))
        }, canPresent: { [weak model] in model?.retired == false }, canDismiss: { [weak model] in model?.canDismiss == true },
           hasPending: { [weak model] in model?.pending != nil }, appearance: { [weak model] in
               guard let model else { return nil }
               return HushhNativeControlAppearance(appearance: model.projection.appearance, accentHex: model.projection.accentHex, foregroundHex: model.projection.foregroundHex)
           }, cancel: { [weak model] in model?.action("cancel") }, clear: { [weak model] in model?.clear() },
           dismissPopups: { [weak model] completion in if let model { model.dismissMenus(completion) } else { completion() } })
    }()
    var coverage: (() -> Void)? { didSet { sheet.coverage = coverage } }
    var coversPresentation: Bool { sheet.coversPresentation }
    var presentationSettled: Bool { sheet.presentationSettled }
    func refreshPrivacy() { sheet.refresh() }
    init(_ projection: NativeProfileStyleProjection) {
        model = NativeProfileStyleModel(projection)
        super.init()
        model.changed = { [weak self] in self?.sheet.refresh() }
    }
    func present(from parent: UIViewController, completion: @escaping (Bool) -> Void) -> Bool { sheet.present(from: parent, completion: completion) }
    func update(_ projection: NativeProfileStyleProjection) -> Bool {
        guard model.update(projection) else { return false }; sheet.refresh(); return true
    }
    func settle(_ action: NativeProfileNameAction, saved: Bool) -> Bool {
        guard model.settle(action, saved: saved) else { return false }; sheet.refresh(); return true
    }
    func retire(completion: @escaping () -> Void) { sheet.retire(completion: completion) }
}
