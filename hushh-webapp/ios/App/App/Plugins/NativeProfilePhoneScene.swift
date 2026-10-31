import SwiftUI
import UIKit

/// Presentation-only replicas. Provider challenge/session/keys never cross here.
struct NativePhoneDraft: Codable, Equatable {
    var country: String, number: String, code: String
    var valid: Bool {
        country.range(of: "^[A-Z]{2}$", options: .regularExpression) != nil &&
            number.utf16.count <= 64 && code.utf16.count <= 64
    }
}
struct NativePhoneCountry: Codable, Equatable { let value: String, label: String, dialCode: String }
struct NativePhoneProjection: Decodable {
    let documentId: String, ownerEpoch: String, family: String, scene: String, destinationId: String
    let ownerGeneration: Int, revision: Int, updateSequence: Int, privacyGeneration: Int, draftRevision: Int, acknowledgedEditRevision: Int
    var draft: NativePhoneDraft
    let step: String, mode: String, countries: [NativePhoneCountry]
    var maskedDestination: String, error: String?
    let canSave: Bool, busy: Bool, appearance: String, accentHex: String, foregroundHex: String
    static let keys = NativeProfileNameProjection.keys.union(["step", "mode", "countries", "maskedDestination"])
    static func hasClosedShape(_ value: [String: Any]) -> Bool {
        guard Set(value.keys).isSubset(of: keys), let draft = value["draft"] as? [String: Any],
              Set(draft.keys) == Set(["country", "number", "code"]), let countries = value["countries"] as? [[String: Any]] else { return false }
        return countries.allSatisfy { Set($0.keys) == Set(["value", "label", "dialCode"]) }
    }
    var identity: NativeDrawerIdentity {
        NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, family: family)
    }
    var valid: Bool {
        let max = HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
        return identity.valid && family == "profile" && scene == "phone" && NativeDrawerIdentity.identifier(destinationId) &&
            updateSequence > 0 && updateSequence <= max &&
            [privacyGeneration, draftRevision, acknowledgedEditRevision].allSatisfy { $0 >= 0 && $0 <= max } && draft.valid &&
            ["phone", "code", "linked"].contains(step) && ["link", "replace"].contains(mode) &&
            !countries.isEmpty && countries.count <= 256 && Set(countries.map(\.value)).count == countries.count &&
            countries.allSatisfy { option in option.value.range(of: "^[A-Z]{2}$", options: .regularExpression) != nil &&
                !option.label.isEmpty && option.label.utf16.count <= 128 && option.dialCode.range(of: "^\\+\\d{1,4}$", options: .regularExpression) != nil } &&
            countries.contains { $0.value == draft.country } && maskedDestination.utf16.count <= 64 && (error?.utf16.count ?? 0) <= 1024 &&
            HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil
    }
    func allows(_ intent: String?) -> Bool {
        switch step {
        case "phone": return intent == "send"
        case "code": return ["verify", "resend", "back"].contains(intent ?? "")
        case "linked": return intent == "continue"
        default: return false
        }
    }
    func receipt(_ phase: String) -> [String: Any] {
        ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration, "revision": revision,
         "family": family, "scene": scene, "destinationId": destinationId, "updateSequence": updateSequence,
         "privacyGeneration": privacyGeneration, "phase": phase]
    }
}
struct NativePhoneAction: Equatable {
    let updateSequence: Int, editRevision: Int, sequence: Int
    let action: String
    var intent: String?
}

@MainActor final class NativePhoneModel: ObservableObject {
    @Published private(set) var projection: NativePhoneProjection
    @Published private(set) var draft: NativePhoneDraft
    @Published private(set) var pending: NativePhoneAction?
    @Published private(set) var composing = false
    @Published private(set) var retired = false
    private(set) var editRevision = 0
    private var sequence = 0, confirmed = 0
    private let editors = NSHashTable<UITextField>.weakObjects()
    var edit: ((NativePhoneDraft, String, Bool, Int) -> Bool)?
    var choose: ((NativePhoneAction) -> Bool)?
    var changed: (() -> Void)?
    var canEdit: Bool { !retired && !projection.busy && pending == nil }
    var canAct: Bool { canEdit && !composing && !editors.allObjects.contains { $0.markedTextRange != nil } &&
        projection.canSave && projection.acknowledgedEditRevision == editRevision }
    var accent: UIColor { HushhNativeControlAppearance.color(projection.accentHex) ?? .label }
    init(_ state: NativePhoneProjection) { projection = state; draft = state.draft }
    func update(_ next: NativePhoneProjection) -> Bool {
        guard !retired, next.valid, next.identity == projection.identity, next.destinationId == projection.destinationId,
              next.privacyGeneration == projection.privacyGeneration, next.updateSequence > projection.updateSequence,
              next.draftRevision >= projection.draftRevision, next.acknowledgedEditRevision >= projection.acknowledgedEditRevision,
              next.acknowledgedEditRevision <= editRevision, next.countries == projection.countries else { return false }
        let stageChanged = next.step != projection.step
        projection = next
        if next.acknowledgedEditRevision == editRevision && !composing { draft = next.draft }
        if stageChanged { editors.allObjects.forEach { $0.resignFirstResponder() } }
        return true
    }
    func register(_ field: UITextField) { editors.add(field) }
    func change(field: String, value: String, composing: Bool = false) {
        guard canEdit, editRevision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        var next = draft
        if projection.step == "phone" && field == "country" && projection.countries.contains(where: { $0.value == value }) { next.country = value }
        else if projection.step == "phone" && field == "number" { next.number = value }
        else if projection.step == "code" && field == "code" { next.code = value }
        else { return }
        guard next.valid, next != draft || self.composing != composing else { return }
        draft = next; self.composing = composing; editRevision += 1
        if edit?(next, projection.step, composing, editRevision) != true { clear() }
    }
    func action(_ intent: String? = nil) {
        guard intent == nil ? canEdit : canAct && projection.allows(intent),
              sequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return }
        sequence += 1
        let event = NativePhoneAction(updateSequence: projection.updateSequence, editRevision: editRevision,
            sequence: sequence, action: intent == nil ? "cancel" : "change", intent: intent)
        pending = event; changed?()
        if choose?(event) != true { pending = nil; changed?() }
    }
    func confirm(_ event: NativePhoneAction) -> Bool {
        guard !retired, pending == event, event.sequence > confirmed, !projection.busy,
              event.action == "cancel" ? event.intent == nil && event.updateSequence <= projection.updateSequence :
                event.action == "change" && projection.allows(event.intent) && !composing &&
                  !editors.allObjects.contains(where: { $0.markedTextRange != nil }) && projection.canSave &&
                  event.updateSequence == projection.updateSequence && event.editRevision == editRevision &&
                  projection.acknowledgedEditRevision == editRevision else { return false }
        confirmed = event.sequence; return true
    }
    func settle(_ event: NativePhoneAction) -> Bool {
        guard !retired, pending == event else { return false }
        pending = nil; changed?(); return true
    }
    func clear() {
        retired = true
        editors.allObjects.forEach { $0.unmarkText(); $0.resignFirstResponder(); $0.text = ""; $0.undoManager?.removeAllActions() }
        draft.number = ""; draft.code = ""; projection.draft.number = ""; projection.draft.code = ""
        projection.maskedDestination = ""; projection.error = nil; pending = nil; edit = nil; choose = nil
    }
}

@available(iOS 26.0, *) private struct NativePhoneField: UIViewRepresentable {
    @ObservedObject var model: NativePhoneModel
    let code: Bool
    func makeUIView(context: Context) -> UITextField {
        let view = UITextField()
        view.delegate = context.coordinator; view.backgroundColor = .clear
        view.font = .preferredFont(forTextStyle: .body); view.adjustsFontForContentSizeCategory = true
        view.keyboardType = code ? .numberPad : .phonePad; view.textContentType = code ? .oneTimeCode : .telephoneNumber
        view.placeholder = code ? "One-time code" : "Phone number"; view.accessibilityLabel = view.placeholder
        view.accessibilityIdentifier = code ? "native-phone-code" : "native-phone-number"
        view.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        model.register(view); return view
    }
    func updateUIView(_ view: UITextField, context: Context) {
        view.isEnabled = model.canEdit; view.tintColor = model.accent; view.textColor = .label
        let text = code ? model.draft.code : model.draft.number
        if view.markedTextRange == nil && view.text != text {
            let selection = view.selectedTextRange.map { view.offset(from: view.beginningOfDocument, to: $0.start) }
            view.text = text
            if let selection, let start = view.position(from: view.beginningOfDocument, offset: min(selection, text.utf16.count)) {
                view.selectedTextRange = view.textRange(from: start, to: start)
            }
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator(model, code) }
    static func dismantleUIView(_ view: UITextField, coordinator: Coordinator) {
        view.delegate = nil; view.resignFirstResponder(); view.text = ""; view.undoManager?.removeAllActions()
    }
    final class Coordinator: NSObject, UITextFieldDelegate {
        let model: NativePhoneModel, code: Bool
        init(_ model: NativePhoneModel, _ code: Bool) { self.model = model; self.code = code }
        @objc func changed(_ view: UITextField) { model.change(field: code ? "code" : "number", value: view.text ?? "", composing: view.markedTextRange != nil) }
        func textFieldDidChangeSelection(_ view: UITextField) { changed(view) }
        func textField(_ view: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
            let value = (view.text ?? "") as NSString
            return model.canEdit && range.location <= value.length && range.length <= value.length - range.location &&
                value.replacingCharacters(in: range, with: string).utf16.count <= 64
        }
    }
}

@available(iOS 26.0, *) private struct NativePhoneContent: View {
    @ObservedObject var model: NativePhoneModel
    var body: some View {
        NavigationStack {
            Form {
                if model.projection.step == "phone" {
                    Section("Country code") {
                        Picker("Country code", selection: Binding(get: { model.draft.country }, set: { model.change(field: "country", value: $0) })) {
                            ForEach(model.projection.countries, id: \.value) { country in Text("\(country.label) (\(country.dialCode))").tag(country.value) }
                        }.pickerStyle(.navigationLink).disabled(!model.canEdit).accessibilityIdentifier("native-phone-country")
                    }
                    Section("Phone number") { NativePhoneField(model: model, code: false).frame(minHeight: 44) }
                    Section { operation("Send verification code", "send") }
                } else if model.projection.step == "code" {
                    Section { Text("Enter the code sent to \(model.projection.maskedDestination).") }
                    Section("One-time code") { NativePhoneField(model: model, code: true).frame(minHeight: 44) }
                    Section {
                        operation("Save phone number", "verify")
                            .disabled(model.draft.code.range(of: "^\\d{6}$", options: .regularExpression) == nil)
                        operation("Resend code", "resend")
                        operation("Use a different number", "back")
                    }
                } else {
                    Section { Label("Phone verified", systemImage: "checkmark.shield"); Text(model.projection.maskedDestination) }
                    Section { operation("Continue", "continue") }
                }
                if let error = model.projection.error { Section { Text(error).foregroundStyle(.red).accessibilityIdentifier("native-phone-error") } }
                if model.projection.busy { ProgressView("Updating…") }
            }.navigationTitle(model.projection.step == "code" ? "Verify phone number" : model.projection.mode == "replace" ? "Change phone number" : "Add phone number")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) {
                    Button(model.projection.step == "code" ? "Back" : "Cancel") { model.action(model.projection.step == "code" ? "back" : nil) }
                        .disabled(model.projection.step == "code" ? !model.canAct : !model.canEdit).accessibilityIdentifier("native-phone-back")
                } }
                .tint(Color(uiColor: model.accent))
        }.preferredColorScheme(model.projection.appearance == "dark" ? .dark : .light).accessibilityIdentifier("native-phone-scene")
    }
    private func operation(_ title: String, _ intent: String) -> some View {
        Button(title) { model.action(intent) }.frame(minHeight: 44).disabled(!model.canAct).accessibilityIdentifier("native-phone-\(intent)")
    }
}

@MainActor final class NativeProfilePhoneScene: NSObject, NativeProfileOwnedForm {
    let model: NativePhoneModel
    var identity: NativeDrawerIdentity { model.projection.identity }
    var sceneName: String { "phone" }
    func receipt(_ phase: String) -> [String: Any] { model.projection.receipt(phase) }
    private lazy var sheet: NativeProfileOwnedSheet = {
        let model = model
        return NativeProfileOwnedSheet(makeHost: { [weak model] in
            guard #available(iOS 26.0, *), let model else { return nil }
            return UIHostingController(rootView: NativePhoneContent(model: model))
        }, canPresent: { [weak model] in model?.retired == false }, canDismiss: { [weak model] in model?.canEdit == true },
           hasPending: { [weak model] in model?.pending != nil }, appearance: { [weak model] in
               guard let state = model?.projection else { return nil }
               return HushhNativeControlAppearance(appearance: state.appearance, accentHex: state.accentHex, foregroundHex: state.foregroundHex)
           }, cancel: { [weak model] in model?.action() }, clear: { [weak model] in model?.clear() })
    }()
    var coverage: (() -> Void)? { didSet { sheet.coverage = coverage } }
    var coversPresentation: Bool { sheet.coversPresentation }
    var presentationSettled: Bool { sheet.presentationSettled }
    var feedbackPresenter: UIViewController? { sheet.feedbackPresenter }
    func refreshPrivacy() { sheet.refresh() }
    init(_ projection: NativePhoneProjection) {
        model = NativePhoneModel(projection); super.init(); model.changed = { [weak self] in self?.sheet.refresh() }
    }
    func present(from parent: UIViewController, completion: @escaping (Bool) -> Void) -> Bool { sheet.present(from: parent, completion: completion) }
    func update(_ next: NativePhoneProjection) -> Bool { guard model.update(next) else { return false }; sheet.refresh(); return true }
    func settle(_ event: NativePhoneAction) -> Bool { guard model.settle(event) else { return false }; sheet.refresh(); return true }
    func retire(completion: @escaping () -> Void) { sheet.retire(completion: completion) }
}
