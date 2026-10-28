import Capacitor
import SwiftUI
import UIKit

/// Private, volatile presentation replicas. Validation, lookup, encryption and
/// save-job ownership remain with the existing Wallet feature in React.
struct NativeWalletCardDraft: Codable, NativeProfileEditorDraft {
    var pan: String; var cardholderName: String; var expiry: String
    var network: String; var issuingRegion: String; var securityCode: String
    static let empty = Self(pan: "", cardholderName: "", expiry: "", network: "auto", issuingRegion: "none", securityCode: "")
    var valid: Bool {
        pan.utf16.count <= 32 && cardholderName.utf16.count <= 120 && expiry.utf16.count <= 7 &&
        network.utf16.count <= 64 && issuingRegion.utf16.count <= 8 && securityCode.utf16.count <= 4
    }
    var event: [String: Any] { ["pan": pan, "cardholderName": cardholderName, "expiry": expiry,
        "network": network, "issuingRegion": issuingRegion, "securityCode": securityCode] }
    subscript(_ field: String) -> String {
        get {
            switch field {
            case "pan": return pan
            case "cardholderName": return cardholderName
            case "expiry": return expiry
            case "network": return network
            case "issuingRegion": return issuingRegion
            case "securityCode": return securityCode
            default: return ""
            }
        }
        set {
            switch field {
            case "pan": pan = newValue
            case "cardholderName": cardholderName = newValue
            case "expiry": expiry = newValue
            case "network": network = newValue
            case "issuingRegion": issuingRegion = newValue
            case "securityCode": securityCode = newValue
            default: break
            }
        }
    }
}

struct NativeWalletCardProjection: Decodable, NativeProfileEditorProjection {
    let documentId: String; let ownerEpoch: String; let ownerGeneration: Int; let revision: Int; let visitId: String
    let updateSequence: Int; let privacyGeneration: Int; let acknowledgedEditRevision: Int; let draftRevision: Int
    var draft: NativeWalletCardDraft; let busy: Bool; let canSave: Bool; var error: String?
    let appearance: String; let accentHex: String; let foregroundHex: String
    let networks: [NativeDrawerOption]; let regions: [NativeDrawerOption]
    let collectSecurityCode: Bool; let scanEnabled: Bool; let networkLoading: Bool; let networkHint: String?
    var scene: String { "wallet-card" }; var destinationId: String { visitId }
    var primary: String { "save" }; var checking: Bool { false }
    var identity: NativeOwnedChoiceIdentity { .init(documentId: documentId, ownerEpoch: ownerEpoch,
        ownerGeneration: ownerGeneration, visitId: visitId, revision: revision) }
    static let keys = NativeOwnedChoiceIdentity.keys.union(["updateSequence", "privacyGeneration", "acknowledgedEditRevision", "draftRevision",
        "draft", "busy", "canSave", "error", "appearance", "accentHex", "foregroundHex", "networks", "regions",
        "collectSecurityCode", "scanEnabled", "networkLoading", "networkHint"])
    var valid: Bool {
        let max = HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
        return identity.valid && draft.valid && updateSequence > 0 && updateSequence <= max &&
            [privacyGeneration, acknowledgedEditRevision, draftRevision].allSatisfy { $0 >= 0 && $0 <= max } &&
            (error?.utf16.count ?? 0) <= 4096 && (networkHint?.utf16.count ?? 0) <= 1024 &&
            !networks.isEmpty && networks.count <= 64 && !regions.isEmpty && regions.count <= 256 &&
            Set(networks.map(\.id)).count == networks.count && Set(regions.map(\.id)).count == regions.count &&
            networks.contains { $0.id == draft.network } && regions.contains { $0.id == draft.issuingRegion } &&
            (networks + regions).allSatisfy { NativeDrawerIdentity.identifier($0.id) && !$0.label.isEmpty && $0.label.utf16.count <= 256 } &&
            HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex) != nil
    }
    func receipt(_ phase: String) -> [String: Any] {
        ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration, "revision": revision,
         "visitId": visitId, "updateSequence": updateSequence, "privacyGeneration": privacyGeneration, "phase": phase]
    }
}

@available(iOS 26.0, *) private struct NativeWalletCardBody: View {
    @ObservedObject var model: NativeProfileEditorModel<NativeWalletCardProjection>
    let media: (String) -> Void
    var body: some View {
        NavigationStack {
            Form {
                if model.projection.scanEnabled {
                    Section {
                        HStack {
                            Button { media("camera") } label: { Label("Scan card", systemImage: "camera") }
                            Spacer()
                            Button { media("photos") } label: { Label("Photo", systemImage: "photo") }
                        }.disabled(!model.canSave)
                    }
                }
                Section {
                    field("pan", "Card number", maximum: 32, keyboard: .numberPad)
                    field("cardholderName", "Name on card", maximum: 120)
                    field("expiry", "Expiry (MM/YY)", maximum: 7, keyboard: .numbersAndPunctuation)
                    Picker("Card network", selection: Binding(get: { model.draft.network }, set: { value in
                        guard model.projection.networks.contains(where: { $0.id == value }) else { return }
                        model.change { $0.network = value }
                    })) {
                        ForEach(model.projection.networks, id: \.id) { Text($0.label).tag($0.id) }
                    }.pickerStyle(.navigationLink).accessibilityIdentifier("native-wallet-card-network").disabled(!model.canEdit)
                    Picker("Issuing region", selection: Binding(get: { model.draft.issuingRegion }, set: { value in
                        guard model.projection.regions.contains(where: { $0.id == value }) else { return }
                        model.change { $0.issuingRegion = value }
                    })) {
                        ForEach(model.projection.regions, id: \.id) { Text($0.label).tag($0.id) }
                    }.pickerStyle(.navigationLink).accessibilityIdentifier("native-wallet-card-region").disabled(!model.canEdit)
                    if model.projection.collectSecurityCode {
                        NativeProfilePrivateField(model: model, name: "securityCode", label: "CVV", maximum: 4,
                            secure: true, keyboard: .numberPad, identifier: "native-wallet-card-cvv").frame(minHeight: 44)
                    }
                }
                if let hint = model.projection.networkHint { Text(hint).font(.footnote).foregroundStyle(.secondary) }
                if let error = model.projection.error, !model.retired {
                    Text(error).foregroundStyle(Color(uiColor: .systemRed)).accessibilityAddTraits(.updatesFrequently)
                }
            }
            .navigationTitle("Add card").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { model.action("cancel") } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Cancel").accessibilityIdentifier("native-wallet-card-cancel").disabled(!model.canCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { model.action("save") }.buttonStyle(.glassProminent)
                        .accessibilityIdentifier("native-wallet-card-save").disabled(!model.canSave || model.projection.networkLoading)
                }
            }
        }
        .tint(Color(uiColor: model.accent)).preferredColorScheme(model.projection.appearance == "dark" ? .dark : .light)
        .accessibilityIdentifier("native-wallet-card-form")
    }
    private func field(_ name: String, _ label: String, maximum: Int, keyboard: UIKeyboardType = .default) -> some View {
        NativeProfilePrivateField(model: model, name: name, label: label, maximum: maximum,
            keyboard: keyboard, identifier: "native-wallet-card-\(name)").frame(minHeight: 44)
    }
}

/// A route-owned form, not a Profile drawer. No Profile lease is borrowed.
@MainActor final class NativeWalletCardScene {
    let model: NativeProfileEditorModel<NativeWalletCardProjection>
    private(set) var mediaIntent: String?
    private(set) var wasDismissed = false
    var coverage: (() -> Void)? { didSet { sheet.coverage = coverage } }
    private lazy var sheet = NativeProfileOwnedSheet(makeHost: { [weak self] in
        guard #available(iOS 26.0, *), let self else { return nil }
        return UIHostingController(rootView: NativeWalletCardBody(model: self.model, media: { [weak self] in self?.requestMedia($0) }))
    }, canPresent: { [weak self] in self?.model.retired == false }, canDismiss: { [weak self] in self?.model.canCancel == true },
       hasPending: { [weak self] in self?.model.pending != nil }, appearance: { [weak self] in
        guard let value = self?.model.projection else { return nil }
        return HushhNativeControlAppearance(appearance: value.appearance, accentHex: value.accentHex, foregroundHex: value.foregroundHex)
    }, cancel: { [weak self] in self?.wasDismissed = true; self?.model.action("cancel") }, clear: { [weak self] in self?.model.clear(); self?.mediaIntent = nil },
       dismissPopups: { [weak self] completion in
        if let self { self.model.dismissEditorMenus(completion: completion) } else { completion() }
    })
    init(_ projection: NativeWalletCardProjection) { model = .init(projection) }
    var coversPresentation: Bool { sheet.coversPresentation }
    var presentationSettled: Bool { sheet.presentationSettled }
    func present(from parent: UIViewController, completion: @escaping (Bool) -> Void) -> Bool { sheet.present(from: parent, completion: completion) }
    func update(_ value: NativeWalletCardProjection) -> Bool { guard model.update(value) else { return false }; sheet.refresh(); return true }
    func settle(_ action: NativeProfileNameAction) -> Bool { guard model.settle(action) else { return false }; mediaIntent = nil; sheet.refresh(); return true }
    func retire(completion: @escaping () -> Void) { sheet.retire(completion: completion) }
    private func requestMedia(_ source: String) {
        guard model.projection.scanEnabled, model.canSave, ["camera", "photos"].contains(source) else { return }
        mediaIntent = source; model.action("save")
        if model.pending == nil { mediaIntent = nil }
    }
}

/// One route-owned sheet above the retained shell. Only private presentation
/// replicas and confirmed intents cross this boundary; no operation runs here.
@MainActor final class NativeWalletCardCoordinator {
    var parent: () -> UIViewController? = { nil }
    var available: () -> Bool = { false }
    var admitOwner: (NativeOwnedChoiceIdentity) -> Bool = { _ in false }
    var currentOwner: (NativeOwnedChoiceIdentity) -> Bool = { _ in false }
    var changed: () -> Void = {}
    var emit: (String, [String: Any]) -> Void = { _, _ in }
    @MainActor private final class Session {
        let scene: NativeWalletCardScene
        var active = false; var retiring = false
        var retirement = [() -> Void]()
        init(_ projection: NativeWalletCardProjection) { scene = .init(projection) }
    }
    private var current: Session?
    private var retired = [String: Int]()
    private var lastReceipt: [String: Any]?
    var concealed: Bool { current == nil }
    var coversPresentation: Bool { current?.active == true && current?.scene.coversPresentation == true }
    private func key(_ identity: NativeOwnedChoiceIdentity) -> String { "\(identity.documentId):\(identity.ownerEpoch):\(identity.ownerGeneration)" }
    private func permitted(_ value: NativeWalletCardProjection) -> Bool {
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        return currentOwner(value.identity) && privacy.appIsActive && !privacy.shielded &&
            privacy.generation == value.privacyGeneration && HushhSessionPrivacyShield.shared.acceptsDocument(value.documentId)
    }
    private func decode<T: Decodable>(_ call: CAPPluginCall, keys: Set<String>, as: T.Type) -> T? {
        guard let options = call.options as? [String: Any], Set(options.keys).isSubset(of: keys),
              JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options),
              bytes.count <= 131_072 else { return nil }
        return try? JSONDecoder().decode(T.self, from: bytes)
    }
    func apply(_ call: CAPPluginCall) {
        guard let options = call.options as? [String: Any],
              let draft = options["draft"] as? [String: Any], Set(draft.keys) == Set(["pan", "cardholderName", "expiry", "network", "issuingRegion", "securityCode"]),
              ["networks", "regions"].allSatisfy({ name in
                  (options[name] as? [[String: Any]])?.allSatisfy { Set($0.keys) == Set(["id", "label", "selected"]) } == true
              }),
              let next = decode(call, keys: NativeWalletCardProjection.keys, as: NativeWalletCardProjection.self), next.valid,
              admitOwner(next.identity), permitted(next) else { call.reject("WALLET_CARD_SCENE_UNAVAILABLE"); return }
        if let current {
            guard current.active, !current.retiring, current.scene.model.projection.identity == next.identity,
                  current.scene.update(next) else { call.reject("WALLET_CARD_SCENE_STALE"); return }
            call.resolve(next.receipt("active")); return
        }
        guard next.updateSequence == 1, next.acknowledgedEditRevision == 0,
              next.revision > (retired[key(next.identity)] ?? 0), available(),
              let parent = parent(), parent.presentedViewController == nil, parent.view.window != nil else {
            call.reject("WALLET_CARD_SCENE_PRESENTATION_REFUSED"); return
        }
        let session = Session(next); current = session
        session.scene.coverage = { [weak self] in self?.changed() }
        session.scene.model.edit = { [weak self, weak session] draft, composing, revision in
            guard let self, let session, self.current === session, session.active, !session.retiring,
                  self.permitted(session.scene.model.projection) else { return false }
            self.emitEdit(session, draft: draft, composing: composing, revision: revision, final: false); return true
        }
        session.scene.model.finalEdit = { [weak self, weak session] draft, revision in
            guard let self, let session, self.current === session, self.currentOwner(session.scene.model.projection.identity),
                  HushhSessionPrivacyShield.shared.acceptsDocument(session.scene.model.projection.documentId) else { return }
            self.emitEdit(session, draft: draft, composing: false, revision: revision, final: true)
        }
        session.scene.model.choose = { [weak self, weak session] action in
            guard let self, let session, self.current === session, session.active, !session.retiring,
                  (session.scene.presentationSettled || action.action == "cancel" && session.scene.wasDismissed), self.permitted(session.scene.model.projection) else { return false }
            let state = session.scene.model.projection
            var event = state.receipt("active"); event.removeValue(forKey: "phase")
            event["sequence"] = action.sequence; event["editRevision"] = action.editRevision
            event["action"] = action.action == "cancel" ? "cancel" : session.scene.mediaIntent == nil ? "save" : "change"
            if let intent = session.scene.mediaIntent { event["intent"] = intent }
            self.emit("walletCardAction", event); return true
        }
        guard session.scene.present(from: parent, completion: { [weak self, weak session] ready in
            guard let self, let session, self.current === session, !session.retiring,
                  ready, self.permitted(session.scene.model.projection) else {
                if let self, let session, self.current === session { self.retire() }; call.reject("WALLET_CARD_SCENE_RETIRED"); return
            }
            session.active = true; self.changed(); call.resolve(next.receipt("active"))
        }) else { retire(); call.reject("WALLET_CARD_SCENE_PRESENTATION_REFUSED"); return }
    }
    private func emitEdit(_ session: Session, draft: NativeWalletCardDraft, composing: Bool, revision: Int, final: Bool) {
        let state = session.scene.model.projection
        var event = state.receipt("active"); event.removeValue(forKey: "phase")
        event["draft"] = draft.event; event["baseDraftRevision"] = state.draftRevision; event["composing"] = composing; event["editRevision"] = revision
        emit(final ? "walletCardFinalEdit" : "walletCardEdit", event)
    }
    func action(_ call: CAPPluginCall, settlement: Bool) {
        let keys = NativeOwnedChoiceIdentity.keys.union(["privacyGeneration", "updateSequence", "editRevision", "sequence", "action", "intent"])
        guard let identity = decode(call, keys: keys, as: NativeOwnedChoiceIdentity.self), let current,
              current.active, !current.retiring, current.scene.model.projection.identity == identity,
              permitted(current.scene.model.projection), settlement || current.scene.presentationSettled || current.scene.wasDismissed && call.getString("action") == "cancel",
              call.getInt("privacyGeneration") == current.scene.model.projection.privacyGeneration,
              let pending = current.scene.model.pending, call.getInt("sequence") == pending.sequence,
              call.getInt("editRevision") == pending.editRevision, call.getInt("updateSequence") == pending.updateSequence,
              call.getString("action") == (pending.action == "cancel" ? "cancel" : current.scene.mediaIntent == nil ? "save" : "change"),
              call.getString("intent") == current.scene.mediaIntent else { call.resolve(["valid": false]); return }
        if settlement {
            // Settlement abandons this exact pending intent; it never commits
            // an operation. A refused stale confirmation must not freeze UI.
            call.resolve(["valid": current.scene.settle(pending)])
        } else {
            let valid = current.scene.model.confirm(pending)
            call.resolve(["valid": valid])
        }
    }
    func retire(_ call: CAPPluginCall) {
        guard let identity = decode(call, keys: NativeOwnedChoiceIdentity.keys, as: NativeOwnedChoiceIdentity.self), identity.valid,
              currentOwner(identity) else { call.reject("WALLET_CARD_RETIRE_INVALID"); return }
        if let current {
            guard current.scene.model.projection.identity == identity else { call.reject("WALLET_CARD_RETIRE_STALE"); return }
            guard current.retirement.count < 8 else { call.reject("WALLET_CARD_RETIRE_BUSY"); return }
            current.retirement.append { [weak current] in
                guard let current else { call.reject("WALLET_CARD_RETIRE_UNCONFIRMED"); return }
                call.resolve(current.scene.model.projection.receipt("retired"))
            }
            retire(); return
        }
        retired[key(identity)] = max(retired[key(identity)] ?? 0, identity.revision)
        call.resolve(absent(identity))
    }
    private func absent(_ identity: NativeOwnedChoiceIdentity) -> [String: Any] {
        ["documentId": identity.documentId, "ownerEpoch": identity.ownerEpoch, "ownerGeneration": identity.ownerGeneration,
         "revision": identity.revision, "visitId": identity.visitId, "privacyGeneration": HushhSessionPrivacyShield.shared.snapshot().generation,
         "updateSequence": 0, "phase": "retired"]
    }
    func read(_ call: CAPPluginCall) {
        guard let identity = decode(call, keys: NativeOwnedChoiceIdentity.keys, as: NativeOwnedChoiceIdentity.self), identity.valid,
              currentOwner(identity) else { call.reject("WALLET_CARD_READ_INVALID"); return }
        if let current, current.scene.model.projection.identity == identity {
            guard current.active, !current.retiring, current.scene.presentationSettled else { call.reject("WALLET_CARD_TRANSITION_PENDING"); return }
            call.resolve(current.scene.model.projection.receipt("active")); return
        }
        guard identity.revision <= (retired[key(identity)] ?? 0) else { call.reject("WALLET_CARD_STATE_UNKNOWN"); return }
        let matches = lastReceipt?["documentId"] as? String == identity.documentId && lastReceipt?["ownerEpoch"] as? String == identity.ownerEpoch &&
            lastReceipt?["ownerGeneration"] as? Int == identity.ownerGeneration && lastReceipt?["revision"] as? Int == identity.revision && lastReceipt?["visitId"] as? String == identity.visitId
        call.resolve(matches ? lastReceipt! : absent(identity))
    }
    func retire() {
        guard let current, !current.retiring else { return }
        current.retiring = true
        let identity = current.scene.model.projection.identity
        retired[key(identity)] = max(retired[key(identity)] ?? 0, identity.revision)
        if retired.count > 64 { retired = [key(identity): identity.revision] }
        let shield = HushhSessionPrivacyShield.shared, token = HushhSessionPrivacyShield.shared.beginPresentationRetirement()
        current.scene.retire { [weak self, weak current] in
            shield.completePresentationRetirement(token)
            guard let self, let current, self.current === current else { return }
            self.lastReceipt = current.scene.model.projection.receipt("retired")
            self.current = nil; self.changed()
            let callbacks = current.retirement; current.retirement = []; callbacks.forEach { $0() }
        }
    }
}
