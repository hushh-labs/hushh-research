import Capacitor
import SwiftUI
import UIKit

/// Private, immediate finite choices. No feature values, credentials, transport,
/// persistence or operation callbacks are owned by this presentation.
struct NativeOwnedChoiceIdentity: Codable, Equatable {
    let documentId: String
    let ownerEpoch: String
    let ownerGeneration: Int
    let visitId: String
    let revision: Int
    static let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "visitId", "revision"]
    var valid: Bool {
        [documentId, ownerEpoch, visitId].allSatisfy(NativeDrawerIdentity.identifier) &&
            ownerGeneration > 0 && revision > 0 &&
            max(ownerGeneration, revision) <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
    }
}

struct NativeOwnedChoiceOption: Decodable, Identifiable, Equatable {
    let handle: String
    let label: String
    let disabled: Bool
    let selected: Bool
    var id: String { handle }
    var valid: Bool { NativeDrawerIdentity.identifier(handle) && !label.isEmpty && label.utf16.count <= 256 }
}

struct NativeOwnedChoiceProjection: Decodable, Equatable {
    let documentId: String
    let ownerEpoch: String
    let ownerGeneration: Int
    let visitId: String
    let revision: Int
    let privacyGeneration: Int
    let updateSequence: Int
    var title: String
    var options: [NativeOwnedChoiceOption]
    let appearance: String
    let accentHex: String
    let foregroundHex: String
    static let keys = NativeOwnedChoiceIdentity.keys.union([
        "privacyGeneration", "updateSequence", "title", "options", "appearance", "accentHex", "foregroundHex"])
    var identity: NativeOwnedChoiceIdentity {
        NativeOwnedChoiceIdentity(documentId: documentId, ownerEpoch: ownerEpoch,
            ownerGeneration: ownerGeneration, visitId: visitId, revision: revision)
    }
    var theme: HushhNativeControlAppearance? {
        HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex)
    }
    var valid: Bool {
        identity.valid && privacyGeneration >= 0 && updateSequence > 0 &&
            max(privacyGeneration, updateSequence) <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration &&
            !title.isEmpty && title.utf16.count <= 256 && options.count <= 256 &&
            options.allSatisfy(\.valid) && Set(options.map(\.handle)).count == options.count &&
            options.filter(\.selected).count <= 1 && theme != nil
    }
    func receipt(_ phase: String, sequence: Int? = nil) -> [String: Any] {
        ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration,
         "visitId": visitId, "revision": revision, "privacyGeneration": privacyGeneration,
         "updateSequence": sequence ?? updateSequence, "phase": phase]
    }
    static func closed(_ value: [String: Any]) -> Bool {
        Set(value.keys).isSubset(of: keys) && (value["options"] as? [[String: Any]])?.allSatisfy {
            Set($0.keys).isSubset(of: ["handle", "label", "disabled", "selected"])
        } == true
    }
}

@MainActor private final class OwnedChoiceModel: ObservableObject {
    @Published var title: String
    @Published var options: [NativeOwnedChoiceOption]
    @Published var accent: UIColor
    @Published var enabled = true
    var choose: ((String?) -> Void)?
    init(_ state: NativeOwnedChoiceProjection) {
        title = state.title; options = state.options; accent = state.theme!.accent
    }
    func clear() { enabled = false; title = ""; options = []; choose = nil }
}

@MainActor private struct OwnedChoiceBody: View {
    @ObservedObject var model: OwnedChoiceModel
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(model.title).font(.headline).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                Button("Cancel") { model.choose?(nil) }.frame(minWidth: 44, minHeight: 44)
                    .disabled(!model.enabled)
            }.padding(.horizontal, 20).padding(.top, 8)
            List(model.options) { option in
                Button {
                    model.choose?(option.handle)
                } label: {
                    HStack {
                        Text(option.label).foregroundStyle(.primary)
                        Spacer(minLength: 12)
                        if option.selected { Image(systemName: "checkmark").foregroundStyle(Color(uiColor: model.accent)) }
                    }.frame(minHeight: 44)
                }.disabled(!model.enabled || option.disabled)
                    .accessibilityAddTraits(option.selected ? .isSelected : [])
            }.listStyle(.insetGrouped)
        }.tint(Color(uiColor: model.accent))
            .background(Color(uiColor: .systemGroupedBackground))
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("native-owned-choice")
    }
}

/// Reuses the native presentation owner and dismissal proof. This coordinator
/// admits only a web-owned route whose bridge root is not already covered.
@MainActor final class NativeOwnedChoiceCoordinator {
    private let privacyShield: HushhSessionPrivacyShield
    init(privacyShield: HushhSessionPrivacyShield = .shared) { self.privacyShield = privacyShield }
    var parent: () -> UIViewController? = { nil }
    var available: () -> Bool = { false }
    var admitOwner: (NativeOwnedChoiceIdentity) -> Bool = { _ in false }
    var currentOwner: (NativeOwnedChoiceIdentity) -> Bool = { _ in false }
    var changed: () -> Void = {}
    var emit: ([String: Any]) -> Void = { _ in }
    private final class Session {
        var state: NativeOwnedChoiceProjection
        let model: OwnedChoiceModel
        let controller: UIViewController
        var presenter: HushhNativeChromePresenter?
        var pending: [CAPPluginCall]
        var retirements = [CAPPluginCall]()
        var active = false
        var retiring = false
        var handle: String?
        var updateSequence: Int
        init(_ state: NativeOwnedChoiceProjection, controller: UIViewController, model: OwnedChoiceModel, call: CAPPluginCall) {
            self.state = state; self.controller = controller; self.model = model
            pending = [call]; updateSequence = state.updateSequence
        }
    }
    private var current: Session?
    private var retired: [String: Int] = [:]
    private var lastReceipt: [String: Any]?
    private var lastEvent: [String: Any]?
    // UIKit owns opening hit testing. Transfer the WebView's interaction/AX
    // coverage only once the replacement presentation has actually laid out.
    // Active sessions retain coverage through actual dismissal completion.
    var coversPresentation: Bool { current?.active == true }
    var concealed: Bool { current == nil }
    private func key(_ identity: NativeOwnedChoiceIdentity) -> String {
        "\(identity.documentId):\(identity.ownerEpoch):\(identity.ownerGeneration)"
    }
    private func permitted(_ state: NativeOwnedChoiceProjection) -> Bool {
        privacyMatches(state) && currentOwner(state.identity)
    }
    private func privacyMatches(_ state: NativeOwnedChoiceProjection) -> Bool {
        let shield = privacyShield, privacy = shield.snapshot()
        return privacy.appIsActive && !privacy.shielded && privacy.generation == state.privacyGeneration &&
            shield.acceptsDocument(state.documentId)
    }
    private func decode<T: Decodable>(_ call: CAPPluginCall, keys: Set<String>, as type: T.Type) -> T? {
        guard let options = call.options as? [String: Any], Set(options.keys).isSubset(of: keys),
              JSONSerialization.isValidJSONObject(options), let bytes = try? JSONSerialization.data(withJSONObject: options),
              bytes.count <= 131_072 else { return nil }
        return try? JSONDecoder().decode(type, from: bytes)
    }
    func prepare(_ call: CAPPluginCall) {
        guard let options = call.options as? [String: Any], NativeOwnedChoiceProjection.closed(options),
              let next = decode(call, keys: NativeOwnedChoiceProjection.keys, as: NativeOwnedChoiceProjection.self), next.valid,
              next.updateSequence == 1, privacyMatches(next), admitOwner(next.identity), permitted(next) else {
            call.reject("OWNED_CHOICE_UNAVAILABLE"); return
        }
        if let current {
            guard current.state == next, !current.retiring, current.pending.count < 8 else {
                call.reject("OWNED_CHOICE_BUSY"); return
            }
            if current.active { call.resolve(next.receipt("active", sequence: current.updateSequence)) }
            else { current.pending.append(call) }
            return
        }
        guard next.revision > (retired[key(next.identity)] ?? 0), available(),
              let parent = parent(), parent.view.window != nil, parent.presentedViewController == nil else {
            call.reject("OWNED_CHOICE_PRESENTATION_REFUSED"); return
        }
        let model = OwnedChoiceModel(next)
        let host = UIHostingController(rootView: OwnedChoiceBody(model: model))
        host.view.accessibilityIdentifier = "native-owned-choice"
        host.overrideUserInterfaceStyle = next.theme!.style; host.view.tintColor = next.theme!.accent
        host.modalPresentationStyle = .pageSheet
        host.sheetPresentationController?.detents = next.options.count <= 6 ? [.medium(), .large()] : [.large()]
        host.sheetPresentationController?.prefersGrabberVisible = true
        let session = Session(next, controller: host, model: model, call: call)
        let presenter = HushhNativeChromePresenter(parent: parent, controller: host,
            updateSequence: 1, animatedDismissal: true, privacyShield: privacyShield, onChoice: { _, _ in })
        session.presenter = presenter; current = session
        model.choose = { [weak self, weak session] handle in
            guard let self, let session, self.current === session, session.active, !session.retiring,
                  self.permitted(session.state), session.model.enabled,
                  handle == nil || session.state.options.contains(where: { $0.handle == handle && !$0.disabled }) else { return }
            session.model.enabled = false; session.handle = handle
            session.presenter?.choose(nil)
        }
        presenter.didPresent = { [weak self, weak session, weak parent] in
            guard let self, let session, self.current === session else { return }
            guard !session.retiring, self.permitted(session.state), session.controller.presentingViewController === parent,
                  session.controller.view.window != nil, session.controller.view.bounds.width > 0 else {
                self.retire(); return
            }
            session.active = true
            self.changed()
            let calls = session.pending; session.pending = []
            calls.forEach { $0.resolve(session.state.receipt("active", sequence: session.updateSequence)) }
        }
        presenter.didRetire = { [weak self, weak session] in
            guard let self, let session else { return }
            self.finish(session)
        }
        changed(); parent.view.endEditing(true); presenter.present()
    }
    func update(_ call: CAPPluginCall) {
        let keys = NativeOwnedChoiceIdentity.keys.union(["privacyGeneration", "updateSequence", "appearance", "accentHex", "foregroundHex"])
        if let identity = decode(call, keys: keys, as: NativeOwnedChoiceIdentity.self), current == nil,
           let receipt = retiredReceipt(identity) { call.resolve(receipt); return }
        guard let identity = decode(call, keys: keys, as: NativeOwnedChoiceIdentity.self), let session = current,
              session.state.identity == identity, session.active, !session.retiring, permitted(session.state),
              call.getInt("privacyGeneration") == session.state.privacyGeneration,
              let sequence = call.getInt("updateSequence"), sequence > session.updateSequence,
              sequence <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
              let appearance = call.getString("appearance"), let accent = call.getString("accentHex"),
              let foreground = call.getString("foregroundHex"),
              let theme = HushhNativeControlAppearance(appearance: appearance, accentHex: accent, foregroundHex: foreground) else {
            call.reject("OWNED_CHOICE_UPDATE_REFUSED"); return
        }
        session.updateSequence = sequence; session.model.accent = theme.accent
        session.controller.overrideUserInterfaceStyle = theme.style; session.controller.view.tintColor = theme.accent
        session.presenter?.update(theme: theme, value: nil, enabled: true, sequence: sequence)
        call.resolve(session.state.receipt("active", sequence: sequence))
    }
    func retire(_ call: CAPPluginCall) {
        guard let identity = decode(call, keys: NativeOwnedChoiceIdentity.keys, as: NativeOwnedChoiceIdentity.self), identity.valid else {
            call.reject("OWNED_CHOICE_RETIRE_INVALID"); return
        }
        retired[key(identity)] = max(retired[key(identity)] ?? 0, identity.revision)
        if let current, current.state.identity == identity {
            current.retirements.append(call); retire(); return
        }
        if let receipt = retiredReceipt(identity) { call.resolve(receipt); return }
        call.resolve(absentReceipt(identity))
    }
    private func absentReceipt(_ identity: NativeOwnedChoiceIdentity) -> [String: Any] {
        ["documentId": identity.documentId, "ownerEpoch": identity.ownerEpoch,
            "ownerGeneration": identity.ownerGeneration, "visitId": identity.visitId, "revision": identity.revision,
            "privacyGeneration": privacyShield.snapshot().generation, "updateSequence": 0, "phase": "retired"]
    }
    func retire() {
        guard let current, !current.retiring else { return }
        current.retiring = true; current.handle = nil; current.model.clear()
        current.state.title = ""; current.state.options = []
        current.presenter?.retire {}
    }
    private func retiredReceipt(_ identity: NativeOwnedChoiceIdentity) -> [String: Any]? {
        guard let lastReceipt, lastReceipt["visitId"] as? String == identity.visitId,
              lastReceipt["documentId"] as? String == identity.documentId, lastReceipt["revision"] as? Int == identity.revision,
              lastReceipt["ownerEpoch"] as? String == identity.ownerEpoch,
              lastReceipt["ownerGeneration"] as? Int == identity.ownerGeneration else { return nil }
        return lastReceipt
    }
    func readState(_ call: CAPPluginCall) {
        guard let identity = decode(call, keys: NativeOwnedChoiceIdentity.keys, as: NativeOwnedChoiceIdentity.self), identity.valid else {
            call.reject("OWNED_CHOICE_STATE_INVALID"); return
        }
        if let current, current.state.identity == identity {
            // A retirement tombstone rejects late preparation; it is not proof
            // that the visible controller has finished dismissal.
            guard current.active, !current.retiring else {
                call.reject("OWNED_CHOICE_TRANSITION_PENDING"); return
            }
            call.resolve(current.state.receipt("active", sequence: current.updateSequence)); return
        }
        guard var receipt = retiredReceipt(identity) else {
            if identity.revision <= (retired[key(identity)] ?? 0) { call.resolve(absentReceipt(identity)) }
            else { call.reject("OWNED_CHOICE_STATE_UNAVAILABLE") }
            return
        }
        let privacy = privacyShield.snapshot()
        if privacy.appIsActive, !privacy.shielded, currentOwner(identity),
           receipt["privacyGeneration"] as? Int == privacy.generation, let lastEvent { receipt["choice"] = lastEvent }
        call.resolve(receipt)
    }
    private func finish(_ session: Session) {
        guard current === session else { return }
        retired[key(session.state.identity)] = max(retired[key(session.state.identity)] ?? 0, session.state.revision)
        if retired.count > 64 { retired = [key(session.state.identity): session.state.revision] }
        let valid = session.active && !session.retiring && permitted(session.state)
        let handle = session.handle
        let receipt = session.state.receipt("retired", sequence: session.updateSequence)
        lastReceipt = receipt; lastEvent = nil; current = nil; session.model.clear()
        session.state.title = ""; session.state.options = []; changed()
        let pending = session.pending; session.pending = []
        pending.forEach { $0.reject("OWNED_CHOICE_RETIRED") }
        session.retirements.forEach { $0.resolve(receipt) }; session.retirements = []
        if valid {
            var event = receipt; event.removeValue(forKey: "phase")
            event["sequence"] = 1; event["outcome"] = handle == nil ? "cancelled" : "selected"
            if let handle { event["handle"] = handle }
            lastEvent = event
            emit(event)
        }
    }
}
