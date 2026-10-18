import SwiftUI
import UIKit

/// Only the person's custom-server draft. Vault access and provider operations
/// never cross this boundary; the existing feature controller owns both.
struct NativeConnectorDraft: Codable, NativeProfileEditorDraft {
    var name: String; var endpoint: String; var credential: String; var oauthIssuer: String
    var oauthClientId: String; var oauthClientSecret: String; var oauthAuthMethod: String
    static let empty = Self(name: "", endpoint: "", credential: "", oauthIssuer: "", oauthClientId: "", oauthClientSecret: "", oauthAuthMethod: "none")
    var valid: Bool {
        name.utf16.count <= 100 && endpoint.utf16.count <= 2048 && credential.utf16.count <= 8192 && oauthIssuer.utf16.count <= 2048 &&
        oauthClientId.utf16.count <= 8192 && oauthClientSecret.utf16.count <= 8192 &&
        ["none", "client_secret_post", "client_secret_basic"].contains(oauthAuthMethod) && (oauthAuthMethod != "none" || oauthClientSecret.isEmpty)
    }
    var event: [String: Any] { ["name": name, "endpoint": endpoint, "credential": credential, "oauthIssuer": oauthIssuer,
                              "oauthClientId": oauthClientId, "oauthClientSecret": oauthClientSecret, "oauthAuthMethod": oauthAuthMethod] }
    subscript(_ field: String) -> String {
        get { switch field {
        case "name": return name; case "endpoint": return endpoint; case "credential": return credential; case "oauthIssuer": return oauthIssuer
        case "oauthClientId": return oauthClientId; case "oauthClientSecret": return oauthClientSecret; default: return ""
        } }
        set { switch field {
        case "name": name = newValue; case "endpoint": endpoint = newValue; case "credential": credential = newValue; case "oauthIssuer": oauthIssuer = newValue
        case "oauthClientId": oauthClientId = newValue; case "oauthClientSecret": oauthClientSecret = newValue; default: break
        } }
    }
}
struct NativeConnectorProjection: Decodable, NativeProfileEditorProjection {
    let documentId: String; let ownerEpoch: String; let ownerGeneration: Int; let revision: Int; let family: String
    let scene: String; let destinationId: String; let updateSequence: Int; let privacyGeneration: Int; let acknowledgedEditRevision: Int; let draftRevision: Int
    var draft: NativeConnectorDraft; let canSave: Bool; let busy: Bool; var error: String?
    let appearance: String; let accentHex: String; let foregroundHex: String
    var checking: Bool { false }; var primary: String { "save" }
    var identity: NativeDrawerIdentity { NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch, ownerGeneration: ownerGeneration, revision: revision, family: family) }
    static let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family", "scene", "destinationId", "updateSequence", "privacyGeneration", "acknowledgedEditRevision", "draftRevision", "draft", "canSave", "busy", "error", "appearance", "accentHex", "foregroundHex"]
    static let draftKeys: Set<String> = ["name", "endpoint", "credential", "oauthIssuer", "oauthClientId", "oauthClientSecret", "oauthAuthMethod"]
    var valid: Bool {
        let max = HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
        return identity.valid && family == "profile" && scene == "connector-custom-server" && NativeDrawerIdentity.identifier(destinationId) && draft.valid &&
            updateSequence > 0 && updateSequence <= max && [privacyGeneration, acknowledgedEditRevision, draftRevision].allSatisfy { $0 >= 0 && $0 <= max } &&
            (error?.utf16.count ?? 0) <= 1024 && HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil
    }
    func receipt(_ phase: String) -> [String: Any] {
        ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration, "revision": revision, "family": family,
         "scene": scene, "destinationId": destinationId, "updateSequence": updateSequence, "privacyGeneration": privacyGeneration, "phase": phase]
    }
}
typealias NativeConnectorModel = NativeProfileEditorModel<NativeConnectorProjection>
@available(iOS 26.0, *) private struct NativeConnectorContent: View {
    @ObservedObject var model: NativeConnectorModel
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Button { model.action("cancel") } label: { Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44) }
                    .buttonStyle(.glass).accessibilityLabel("Cancel connector setup").accessibilityIdentifier("native-connector-cancel").disabled(!model.canCancel)
                Spacer(minLength: 8); Text("Add connector").font(.headline).accessibilityAddTraits(.isHeader); Spacer(minLength: 8)
                Button { model.action("save") } label: { Image(systemName: "checkmark").frame(minWidth: 44, minHeight: 44) }
                    .buttonStyle(.glassProminent).accessibilityLabel("Add connector").accessibilityIdentifier("native-connector-submit").disabled(!model.canSave)
            }.padding(.horizontal, 16).padding(.vertical, 8)
            Form {
                Section {
                    field("name", "Name", maximum: 100)
                    field("endpoint", "Server URL", maximum: 2048, keyboard: .URL)
                    field("credential", "Access token (optional)", maximum: 8192, secure: true)
                } header: { Text("Server") } footer: { Text("Use the server endpoint, not its sign-in page. An access token is sent as Authorization: Bearer and kept in your vault. Never use your vault token.") }
                Section {
                    field("oauthIssuer", "Authorization server issuer", maximum: 2048, keyboard: .URL)
                    field("oauthClientId", "Client ID", maximum: 8192)
                    Picker("Token authentication", selection: Binding(get: { model.draft.oauthAuthMethod }, set: { value in
                        model.change { draft in draft.oauthAuthMethod = value; if value == "none" { draft.oauthClientSecret = "" } }
                    })) {
                        Text("Public client").tag("none")
                        Text("Client secret in request").tag("client_secret_post")
                        Text("Client secret in header").tag("client_secret_basic")
                    }.disabled(!model.canEdit || model.composing).accessibilityIdentifier("native-connector-authentication")
                    if model.draft.oauthAuthMethod != "none" { field("oauthClientSecret", "Client secret", maximum: 8192, secure: true) }
                } header: { Text("OAuth settings") } footer: { Text("Only add servers you trust. One uses this server’s tools without asking each time. Block any tool you don’t want it to use.") }
                if model.projection.busy { ProgressView("Checking connector…") }
                if let error = model.projection.error, !model.retired { Text(error).foregroundStyle(Color(uiColor: .systemRed)).accessibilityAddTraits(.updatesFrequently) }
            }
        }.tint(Color(uiColor: model.accent)).preferredColorScheme(model.projection.appearance == "dark" ? .dark : .light)
    }
    private func field(_ name: String, _ label: String, maximum: Int, secure: Bool = false, keyboard: UIKeyboardType = .default) -> some View {
        NativeProfilePrivateField(model: model, name: name, label: label, maximum: maximum, secure: secure, keyboard: keyboard,
                                  identifier: "native-connector-\(name)").frame(minHeight: 44)
    }
}
@MainActor final class NativeProfileConnectorScene: NSObject, NativeProfileOwnedForm {
    let model: NativeConnectorModel
    var identity: NativeDrawerIdentity { model.projection.identity }
    var sceneName: String { model.projection.scene }
    func receipt(_ phase: String) -> [String: Any] { model.projection.receipt(phase) }
    private lazy var sheet: NativeProfileOwnedSheet = {
        let model = model
        return NativeProfileOwnedSheet(makeHost: { [weak model] in
            guard #available(iOS 26.0, *), let model else { return nil }
            return UIHostingController(rootView: NativeConnectorContent(model: model))
        }, canPresent: { [weak model] in model?.retired == false }, canDismiss: { [weak model] in model?.canCancel == true },
           hasPending: { [weak model] in model?.pending != nil }, appearance: { [weak model] in
               guard let model else { return nil }
               return HushhNativeControlAppearance(appearance: model.projection.appearance, accentHex: model.projection.accentHex, foregroundHex: model.projection.foregroundHex)
           }, cancel: { [weak model] in model?.action("cancel") }, clear: { [weak model] in model?.clear() })
    }()
    var coverage: (() -> Void)? { didSet { sheet.coverage = coverage } }
    var coversPresentation: Bool { sheet.coversPresentation }
    init(_ projection: NativeConnectorProjection) { model = NativeConnectorModel(projection) }
    func present(from parent: UIViewController, completion: @escaping (Bool) -> Void) -> Bool { sheet.present(from: parent, completion: completion) }
    func update(_ projection: NativeConnectorProjection) -> Bool { guard model.update(projection) else { return false }; sheet.refresh(); return true }
    func settle(_ action: NativeProfileNameAction) -> Bool { guard model.settle(action) else { return false }; sheet.refresh(); return true }
    func retire(completion: @escaping () -> Void) { sheet.retire(completion: completion) }
}
