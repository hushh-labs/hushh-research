import SwiftUI
import UIKit

struct NativePaymentsDraft: Codable, NativeProfileEditorDraft {
    var value: String
    static let empty = Self(value: "")
    var valid: Bool { value.utf16.count <= 64 }
    var event: [String: Any] { ["value": value] }
    subscript(_ name: String) -> String {
        get { name == "value" ? value : "" }
        set { if name == "value" { value = NativeProfilePricingDecimal.canonical(newValue, separator: Locale.current.decimalSeparator ?? ".") } }
    }
}
struct NativePaymentsProjection: Decodable, NativeProfileEditorProjection {
    let documentId: String; let ownerEpoch: String; let ownerGeneration: Int; let revision: Int; let family: String
    let scene: String; let destinationId: String; let updateSequence: Int; let privacyGeneration: Int; let acknowledgedEditRevision: Int; let draftRevision: Int
    var draft: NativePaymentsDraft; let canSave: Bool; let busy: Bool; var error: String?
    let appearance: String; let accentHex: String; let foregroundHex: String
    var checking: Bool { false }; var primary: String { "save" }
    var identity: NativeDrawerIdentity { NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, family: family) }
    static let keys = NativeMemoryProjection.keys
    var valid: Bool {
        let max = HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
        return identity.valid && family == "profile" && ["payment-funding", "payment-country"].contains(scene) && NativeDrawerIdentity.identifier(destinationId) && draft.valid &&
            (scene != "payment-country" || draft.value.utf16.count <= 2) && updateSequence > 0 && updateSequence <= max &&
            [privacyGeneration, acknowledgedEditRevision, draftRevision].allSatisfy { $0 >= 0 && $0 <= max } && (error?.utf16.count ?? 0) <= 1024 &&
            HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil
    }
    func receipt(_ phase: String) -> [String: Any] {
        ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration, "revision": revision, "family": family,
         "scene": scene, "destinationId": destinationId, "updateSequence": updateSequence, "privacyGeneration": privacyGeneration, "phase": phase]
    }
}
typealias NativePaymentsEditorModel = NativeProfileEditorModel<NativePaymentsProjection>

@available(iOS 26.0, *) private struct NativePaymentsContent: View {
    @ObservedObject var model: NativePaymentsEditorModel
    private var funding: Bool { model.projection.scene == "payment-funding" }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { model.action("cancel") } label: { Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44) }
                    .buttonStyle(.glass).accessibilityLabel("Cancel").accessibilityIdentifier("native-payments-cancel").disabled(!model.canCancel)
                Spacer(minLength: 8); Text(funding ? "Add funds" : "Payout country").font(.headline).accessibilityAddTraits(.isHeader); Spacer(minLength: 8)
                Button("Done") { model.action("save") }.frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("native-payments-done").disabled(!model.canSave)
            }.padding(.horizontal, 16).padding(.vertical, 8)
            Form {
                Section(funding ? "Add to balance (USD)" : "Payout country (two-letter code)") {
                    NativeProfilePrivateField(model: model, name: "value", label: funding ? "Amount" : "Country", maximum: funding ? 64 : 2,
                        keyboard: funding ? .decimalPad : .asciiCapable, identifier: "native-payments-value").frame(minHeight: 44)
                }
                Text(funding ? "$0.50–$1,000 per funding payment. Funding does not approve or buy access." : "Stripe verifies your individual identity, payout method and earning activity. No company is required.")
                    .font(.footnote).foregroundStyle(.secondary)
                if let error = model.projection.error, !model.retired { Text(error).foregroundStyle(Color(uiColor: .systemRed)).accessibilityAddTraits(.updatesFrequently) }
            }
        }.tint(Color(uiColor: model.accent)).preferredColorScheme(model.projection.appearance == "dark" ? .dark : .light)
    }
}
@MainActor final class NativeProfilePaymentsScene: NSObject, NativeProfileOwnedForm {
    let model: NativePaymentsEditorModel
    var identity: NativeDrawerIdentity { model.projection.identity }
    var sceneName: String { model.projection.scene }
    func receipt(_ phase: String) -> [String: Any] { model.projection.receipt(phase) }
    private lazy var sheet: NativeProfileOwnedSheet = {
        let model = model
        return NativeProfileOwnedSheet(makeHost: { [weak model] in
            guard #available(iOS 26.0, *), let model else { return nil }
            return UIHostingController(rootView: NativePaymentsContent(model: model))
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
    init(_ projection: NativePaymentsProjection) { model = NativePaymentsEditorModel(projection) }
    func present(from parent: UIViewController, completion: @escaping (Bool) -> Void) -> Bool { sheet.present(from: parent, completion: completion) }
    func update(_ projection: NativePaymentsProjection) -> Bool { guard model.update(projection) else { return false }; sheet.refresh(); return true }
    func settle(_ action: NativeProfileNameAction) -> Bool { guard model.settle(action) else { return false }; sheet.refresh(); return true }
    func retire(completion: @escaping () -> Void) { sheet.retire(completion: completion) }
}
