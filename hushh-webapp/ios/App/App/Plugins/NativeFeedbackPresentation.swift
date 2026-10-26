import SwiftUI
import UIKit

/// Private transient text, never chrome metadata, persistence or an operation.
struct NativeFeedbackProjection: Decodable {
    let documentId: String
    let ownerEpoch: String
    let ownerGeneration: Int
    let revision: Int
    let family: String
    let privacyGeneration: Int
    let feedbackId: String
    let feedbackRevision: Int
    let feedbackSequence: Int
    let destinationId: String?
    let supportDestinationId: String?
    let formScene: String?
    let formRevision: Int?
    let message: String
    let tone: String
    let duration: Double
    let dismissible: Bool
    var identity: NativeDrawerIdentity {
        NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch,
            ownerGeneration: ownerGeneration, revision: revision, family: family)
    }
    var valid: Bool {
        identity.valid && NativeDrawerIdentity.identifier(feedbackId) && feedbackRevision > 0 &&
            feedbackRevision <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration &&
            feedbackSequence > 0 && feedbackSequence <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration &&
            ((formScene == nil && formRevision == nil) || (formScene != nil && (formRevision ?? 0) > 0)) &&
            privacyGeneration >= 0 && privacyGeneration <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration &&
            !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && message.utf16.count <= 2048 &&
            ["normal", "loading", "success", "error", "warning", "info"].contains(tone) &&
            duration.isFinite && (duration == 0 || (1000...30000).contains(duration)) &&
            (destinationId == nil || NativeDrawerIdentity.identifier(destinationId!)) &&
            (supportDestinationId == nil || NativeDrawerIdentity.identifier(supportDestinationId!)) &&
            (formScene == nil || NativeProfilePreparationTarget.scenes.contains(formScene!))
    }
    static let keys: Set<String> = ["documentId", "ownerEpoch", "ownerGeneration", "revision", "family",
        "privacyGeneration", "feedbackId", "feedbackRevision", "feedbackSequence", "destinationId", "supportDestinationId", "formScene", "formRevision",
        "message", "tone", "duration", "dismissible"]
    var receipt: [String: Any] {
        ["documentId": documentId, "ownerEpoch": ownerEpoch, "ownerGeneration": ownerGeneration,
         "revision": revision, "family": family, "privacyGeneration": privacyGeneration,
         "feedbackId": feedbackId, "feedbackRevision": feedbackRevision, "feedbackSequence": feedbackSequence,
         "destinationId": destinationId as Any? ?? NSNull(), "supportDestinationId": supportDestinationId as Any? ?? NSNull(),
         "formScene": formScene as Any? ?? NSNull(), "formRevision": formRevision as Any? ?? NSNull()]
    }
    func belongs(to state: NativeDrawerProjection) -> Bool {
        identity == state.identity && privacyGeneration == state.privacyGeneration && state.open &&
            destinationId == state.profileDestinationId && supportDestinationId == state.profileSupportDestinationId
    }
}

/// A retired notification cannot return after a delayed loading/settlement call.
struct NativeFeedbackFence {
    private var owner: NativeDrawerIdentity?
    private var id = ""
    private var sequence = 0
    private var revision = 0
    private var terminal = false
    mutating func apply(_ state: NativeFeedbackProjection) -> Bool {
        guard state.valid else { return false }
        if owner?.documentId != state.documentId || owner?.ownerEpoch != state.ownerEpoch || owner?.ownerGeneration != state.ownerGeneration {
            owner = state.identity; sequence = 0; revision = 0; terminal = false
        }
        guard state.feedbackSequence > sequence || state.feedbackSequence == sequence &&
            state.feedbackId == id && !terminal && state.feedbackRevision > revision else { return false }
        id = state.feedbackId; sequence = state.feedbackSequence; revision = state.feedbackRevision; terminal = false
        return true
    }
    mutating func retire(id requested: String, sequence requestedSequence: Int, revision requestedRevision: Int,
                         owner requestedOwner: NativeDrawerIdentity, terminal: Bool = true) -> Bool {
        guard requestedOwner.valid else { return false }
        if let owner {
            guard owner.documentId == requestedOwner.documentId && owner.ownerEpoch == requestedOwner.ownerEpoch &&
                owner.ownerGeneration == requestedOwner.ownerGeneration else { return false }
        } else { owner = requestedOwner }
        guard requestedSequence > sequence || requestedSequence == sequence && requested == id && requestedRevision >= revision else { return false }
        id = requested; sequence = requestedSequence; revision = requestedRevision; self.terminal = terminal
        return true
    }
}

@MainActor private final class NativeFeedbackModel: ObservableObject {
    @Published var messages = [NativeFeedbackProjection]()
    var dismiss: ((NativeFeedbackProjection) -> Void)?
}
private struct NativeFeedbackView: View {
    @ObservedObject var model: NativeFeedbackModel
    var body: some View {
        VStack(spacing: 8) {
            ForEach(model.messages, id: \.feedbackId) { state in
                HStack(spacing: 10) {
                    if state.tone == "loading" { ProgressView().controlSize(.small) }
                    else { Image(systemName: symbol(state.tone)).imageScale(.medium).accessibilityHidden(true) }
                    Text(state.message).font(.subheadline).foregroundStyle(.primary)
                        .lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
                    if state.dismissible {
                        Button { model.dismiss?(state) } label: {
                            Image(systemName: "xmark").font(.system(size: 13, weight: .medium))
                                .frame(width: 44, height: 44)
                        }.buttonStyle(.plain).accessibilityLabel("Dismiss notification")
                    }
                }.padding(.leading, 16).padding(.trailing, state.dismissible ? 0 : 16)
                    .padding(.vertical, state.dismissible ? 4 : 14)
                    .background { material }
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("native-feedback-banner")
            }
        }
    }
    @ViewBuilder private var material: some View {
        if #available(iOS 26.0, *) { RoundedRectangle(cornerRadius: 20).fill(.clear).glassEffect(.regular, in: .rect(cornerRadius: 20)) }
        else { RoundedRectangle(cornerRadius: 20).fill(.regularMaterial) }
    }
    private func symbol(_ tone: String) -> String {
        switch tone { case "success": "checkmark.circle"; case "error": "exclamationmark.circle"
        case "warning": "exclamationmark.triangle"; default: "info.circle" }
    }
}

/// A bounded child of the acknowledged native presenter, never a window-level
/// overlay or modal. It cannot isolate the page, steal focus or change key windows.
@MainActor final class NativeFeedbackPresentation {
    private let model = NativeFeedbackModel()
    private var host: UIHostingController<NativeFeedbackView>?
    private var timers = [String: DispatchWorkItem]()
    private var fence = NativeFeedbackFence()
    private var lastReceipt: [String: Any]?
    var ended: (([String: Any]) -> Void)?

    init() { model.dismiss = { [weak self] state in self?.dismiss(state) } }
    func apply(_ state: NativeFeedbackProjection, to parent: UIViewController) -> Bool {
        guard parent.view.window != nil, fence.apply(state) else { return false }
        lastReceipt = state.receipt
        if let existing = host, existing.parent !== parent { detach() }
        timers.removeValue(forKey: state.feedbackId)?.cancel()
        let changedText = model.messages.first(where: { $0.feedbackId == state.feedbackId })?.message != state.message
        let replaced = model.messages.filter { $0.feedbackId != state.feedbackId }
        for previous in replaced { timers.removeValue(forKey: previous.feedbackId)?.cancel() }
        model.messages = [state] // Atomic replacement keeps the hosting controller attached.
        replaced.forEach { ended?($0.receipt) }
        if host == nil {
            let next = UIHostingController(rootView: NativeFeedbackView(model: model))
            next.view.backgroundColor = .clear
            next.view.accessibilityIdentifier = "native-feedback-host"
            next.sizingOptions = [.intrinsicContentSize]
            parent.addChild(next)
            next.view.translatesAutoresizingMaskIntoConstraints = false
            parent.view.addSubview(next.view)
            NSLayoutConstraint.activate([
                next.view.topAnchor.constraint(equalTo: parent.view.safeAreaLayoutGuide.topAnchor, constant: 8),
                next.view.centerXAnchor.constraint(equalTo: parent.view.centerXAnchor),
                next.view.widthAnchor.constraint(equalTo: parent.view.widthAnchor, constant: -32),
            ])
            next.didMove(toParent: parent)
            host = next
        }
        parent.view.layoutIfNeeded()
        host?.view.layoutIfNeeded()
        if changedText { UIAccessibility.post(notification: .announcement, argument: state.message) }
        if state.duration > 0 {
            let id = state.feedbackId, revision = state.feedbackRevision
            let timer = DispatchWorkItem { [weak self] in
                guard let self, let current = self.model.messages.first(where: { $0.feedbackId == id && $0.feedbackRevision == revision }) else { return }
                self.dismiss(current, terminal: false)
            }
            timers[state.feedbackId] = timer
            DispatchQueue.main.asyncAfter(deadline: .now() + state.duration / 1000, execute: timer)
        }
        return true
    }
    func retire(id: String, sequence: Int, revision: Int, owner: NativeDrawerIdentity, context: [String: Any]) {
        if let lastReceipt, sequence == lastReceipt["feedbackSequence"] as? Int {
            var expected = lastReceipt, requested = context
            expected.removeValue(forKey: "feedbackRevision"); requested.removeValue(forKey: "feedbackRevision")
            guard NSDictionary(dictionary: expected).isEqual(to: requested) else { return }
        }
        guard fence.retire(id: id, sequence: sequence, revision: revision, owner: owner) else { return }
        if let state = model.messages.first(where: { $0.feedbackId == id && $0.feedbackRevision <= revision }) { dismiss(state) }
    }
    func retainOnly(_ state: NativeDrawerProjection) {
        for message in model.messages where message.family == state.family && !message.belongs(to: state) { dismiss(message) }
    }
    func retireFamily(_ family: String) {
        for message in model.messages where message.family == family { dismiss(message) }
    }
    func clear() {
        let previous = model.messages
        for state in previous { _ = fence.retire(id: state.feedbackId, sequence: state.feedbackSequence, revision: state.feedbackRevision, owner: state.identity) }
        timers.values.forEach { $0.cancel() }; timers.removeAll()
        model.messages = [] // Scrub before any removal/event delivery.
        detach()
        // The plugin calls this at an invalidated document/owner/privacy
        // lifetime. Its lease fence rejects all previous-lifetime deliveries.
        fence = NativeFeedbackFence(); lastReceipt = nil
        previous.forEach { ended?($0.receipt) }
    }
    func dismiss(_ state: NativeFeedbackProjection, terminal: Bool = true) {
        // A button closure can outlive its rendered revision. Reject it before
        // touching the newer result's timer, hosting view or end receipt.
        guard model.messages.contains(where: {
            NSDictionary(dictionary: $0.receipt).isEqual(to: state.receipt)
        }) else { return }
        _ = fence.retire(id: state.feedbackId, sequence: state.feedbackSequence, revision: state.feedbackRevision, owner: state.identity, terminal: terminal)
        timers.removeValue(forKey: state.feedbackId)?.cancel()
        model.messages.removeAll { $0.feedbackId == state.feedbackId }
        if model.messages.isEmpty { detach() }
        ended?(state.receipt)
    }
    private func detach() {
        host?.willMove(toParent: nil)
        host?.view.removeFromSuperview()
        host?.removeFromParent()
        host = nil
    }
}
