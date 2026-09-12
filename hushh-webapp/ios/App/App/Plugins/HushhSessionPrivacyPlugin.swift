import UIKit
import Capacitor

/**
 * Pure lifecycle state for the native privacy cover.
 *
 * Keeping generation acceptance separate from UIKit makes the fail-closed
 * rules executable in AppTests while the shield remains responsible only for
 * presenting and removing the overlay.
 */
struct HushhSessionPrivacyState {
    static let maximumJavaScriptSafeGeneration = 9_007_199_254_740_000

    private(set) var shielded = false
    private(set) var generation = 0
    private(set) var cause = "inactive"
    private var inactiveCycleOpen = false

    mutating func protectForAppInactive() {
        // UIKit can report more than one inactive/background callback for one
        // transition. Keep installation idempotent without weakening the token
        // boundary between distinct foreground cycles.
        if !inactiveCycleOpen {
            generation = generation >= Self.maximumJavaScriptSafeGeneration
                ? 1
                : generation + 1
            inactiveCycleOpen = true
        }
        shielded = true
    }

    mutating func markAppBackgrounded() {
        protectForAppInactive()
        // An unresolved background check survives a later permission sheet.
        if cause != "restart" { cause = "background" }
    }

    mutating func restartSession() {
        generation = generation >= Self.maximumJavaScriptSafeGeneration ? 1 : generation + 1
        shielded = true
        cause = "restart"
    }

    mutating func markAppActive() {
        inactiveCycleOpen = false
    }

    @discardableResult
    mutating func completeSessionValidation(
        generation requestedGeneration: Int,
        appIsActive: Bool
    ) -> Bool {
        guard
            appIsActive,
            shielded,
            requestedGeneration > 0,
            requestedGeneration == generation
        else {
            return false
        }

        shielded = false
        cause = "inactive"
        return true
    }
}

/// Generation alone cannot reject an old document that reads a new restart
/// generation while WKWebView.reload is still navigating. Bind acknowledgments
/// to observed JS runtime IDs, and retire them before requesting navigation.
struct HushhSessionPrivacyDocumentState {
    private var observed = Set<String>()
    private var retired = Set<String>()

    mutating func observe(_ documentId: String) {
        if !documentId.isEmpty && !retired.contains(documentId) { observed.insert(documentId) }
    }

    mutating func restart() {
        retired.formUnion(observed)
        observed.removeAll()
    }

    func accepts(_ documentId: String) -> Bool {
        observed.contains(documentId) && !retired.contains(documentId)
    }
}

/**
 * Native, process-local cover for the WebView while a resumed session is being
 * checked. The cover is deliberately not persisted: a fresh process starts
 * unshielded so an anonymous cold launch can always reach Login.
 *
 * Every inactive -> active cycle owns a monotonically increasing generation.
 * JavaScript must acknowledge the exact generation it validated; a late
 * completion from an older cycle can therefore never uncover a newer one.
 */
final class HushhSessionPrivacyShield: NSObject {
    static let shared = HushhSessionPrivacyShield()
    static let accessibilityIdentifier = "session-privacy-shield"

    struct Snapshot {
        let shielded: Bool
        let generation: Int
        let cause: String
        let appIsActive: Bool

        var payload: [String: Any] {
            ["shielded": shielded, "generation": generation,
             "cause": cause, "appIsActive": appIsActive]
        }
    }

    private weak var hostView: UIView?
    private var overlayView: UIView?
    private var state = HushhSessionPrivacyState()
    private var documents = HushhSessionPrivacyDocumentState()
    private var lifecycleIsActive = false
    private var recoveryWorkItem: DispatchWorkItem?
    private weak var recoveryActions: UIStackView?
    private weak var recoveryProgress: UIActivityIndicatorView?
    private weak var recoveryTitle: UILabel?
    private weak var recoveryDetail: UILabel?
    var onStateChanged: ((Snapshot, String) -> Void)?
    var reloadDocument: (() -> Void)?

    private override init() { super.init() }

    func attach(to hostView: UIView) {
        dispatchPrecondition(condition: .onQueue(.main))

        if self.hostView !== hostView {
            overlayView?.removeFromSuperview()
            overlayView = nil
            self.hostView = hostView
        }

        if state.shielded {
            installOverlayIfNeeded()
            if UIApplication.shared.applicationState == .active { scheduleRecovery() }
        }
    }

    func protectForAppInactive() {
        dispatchPrecondition(condition: .onQueue(.main))

        lifecycleIsActive = false
        state.protectForAppInactive()
        recoveryWorkItem?.cancel()
        installOverlayIfNeeded()
        publishState()
    }

    func markAppBackgrounded() {
        dispatchPrecondition(condition: .onQueue(.main))
        lifecycleIsActive = false
        state.markAppBackgrounded()
        installOverlayIfNeeded()
        publishState()
    }

    func markAppActive() {
        dispatchPrecondition(condition: .onQueue(.main))
        lifecycleIsActive = true
        state.markAppActive()
        // Never remove the cover here. The resumed JavaScript document owns
        // account validation and must explicitly acknowledge this generation.
        if state.shielded {
            installOverlayIfNeeded()
            scheduleRecovery()
        }
        publishState()
    }

    func snapshot() -> Snapshot {
        dispatchPrecondition(condition: .onQueue(.main))
        return Snapshot(shielded: state.shielded, generation: state.generation,
                        cause: state.cause,
                        appIsActive: lifecycleIsActive && UIApplication.shared.applicationState == .active)
    }

    func observeDocument(_ documentId: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        documents.observe(documentId)
    }

    @discardableResult
    func completeSessionValidation(
        generation requestedGeneration: Int,
        documentId: String,
        appIsActive: Bool
    ) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))

        guard documents.accepts(documentId), state.completeSessionValidation(
            generation: requestedGeneration,
            appIsActive: lifecycleIsActive && appIsActive
        ) else {
            return false
        }

        overlayView?.removeFromSuperview()
        overlayView = nil
        recoveryWorkItem?.cancel()
        recoveryWorkItem = nil
        return true
    }

    private func publishState(action: String = "state") {
        onStateChanged?(snapshot(), action)
    }

    private func scheduleRecovery() {
        recoveryWorkItem?.cancel()
        recoveryTitle?.text = "Checking your session\u{2026}"
        recoveryDetail?.text = "Your private information stays hidden while we verify access."
        recoveryProgress?.isHidden = false
        recoveryProgress?.startAnimating()
        let generation = state.generation
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.state.shielded, self.state.generation == generation else { return }
            self.recoveryProgress?.stopAnimating()
            self.recoveryProgress?.isHidden = true
            self.recoveryTitle?.text = "Unable to verify your session"
            self.recoveryDetail?.text = "Your private information is still hidden. Try again, or restart this session."
            self.recoveryActions?.isHidden = false
            UIAccessibility.post(notification: .layoutChanged, argument: self.recoveryActions)
        }
        recoveryWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
    }

    @objc private func retryValidation() {
        guard state.shielded else { return }
        scheduleRecovery()
        publishState(action: "retry")
    }

    @objc private func restartDocument() {
        guard state.shielded else { return }
        // Invalidate acknowledgements from the old document before reloading.
        // Firebase identity persists; the new JS runtime has no decrypted vault.
        state.restartSession()
        documents.restart()
        recoveryWorkItem?.cancel()
        reloadDocument?()
        scheduleRecovery()
    }

    private func installOverlayIfNeeded() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let hostView else { return }

        if let overlayView {
            overlayView.isHidden = false
            overlayView.alpha = 1
            hostView.bringSubviewToFront(overlayView)
            hostView.layoutIfNeeded()
            return
        }

        let overlay = UIView(frame: .zero)
        overlay.translatesAutoresizingMaskIntoConstraints = false
        overlay.backgroundColor = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0.035, green: 0.035, blue: 0.045, alpha: 1)
                : UIColor(red: 0.965, green: 0.965, blue: 0.98, alpha: 1)
        }
        overlay.isOpaque = true
        overlay.isUserInteractionEnabled = true
        overlay.accessibilityViewIsModal = true
        overlay.accessibilityIdentifier = Self.accessibilityIdentifier

        let icon = UIImageView(image: UIImage(systemName: "lock.shield.fill"))
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.tintColor = .secondaryLabel
        icon.contentMode = .scaleAspectFit
        icon.isAccessibilityElement = false

        let title = UILabel(frame: .zero)
        title.translatesAutoresizingMaskIntoConstraints = false
        title.text = "Checking your session\u{2026}"
        title.textColor = .label
        title.font = .preferredFont(forTextStyle: .headline)
        title.adjustsFontForContentSizeCategory = true
        title.numberOfLines = 0
        title.textAlignment = .center

        let detail = UILabel(frame: .zero)
        detail.translatesAutoresizingMaskIntoConstraints = false
        detail.text = "Your private information stays hidden while we verify access."
        detail.textColor = .secondaryLabel
        detail.font = .preferredFont(forTextStyle: .subheadline)
        detail.adjustsFontForContentSizeCategory = true
        detail.numberOfLines = 0
        detail.textAlignment = .center

        let progress = UIActivityIndicatorView(style: .medium)
        progress.translatesAutoresizingMaskIntoConstraints = false
        progress.color = .secondaryLabel
        progress.startAnimating()
        recoveryTitle = title
        recoveryDetail = detail
        recoveryProgress = progress

        let stack = UIStackView(arrangedSubviews: [icon, title, detail, progress])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.setCustomSpacing(16, after: icon)

        let retry = UIButton(type: .system)
        retry.setTitle("Try again", for: .normal)
        retry.accessibilityIdentifier = "session-privacy-retry"
        retry.titleLabel?.font = .preferredFont(forTextStyle: .body)
        retry.titleLabel?.adjustsFontForContentSizeCategory = true
        retry.addTarget(self, action: #selector(retryValidation), for: .touchUpInside)
        let restart = UIButton(type: .system)
        restart.setTitle("Restart session", for: .normal)
        restart.accessibilityIdentifier = "session-privacy-restart"
        restart.titleLabel?.font = .preferredFont(forTextStyle: .body)
        restart.titleLabel?.adjustsFontForContentSizeCategory = true
        restart.addTarget(self, action: #selector(restartDocument), for: .touchUpInside)
        let actions = UIStackView(arrangedSubviews: [retry, restart])
        actions.axis = .vertical
        actions.spacing = 8
        actions.isHidden = true
        stack.addArrangedSubview(actions)
        recoveryActions = actions

        overlay.addSubview(stack)
        hostView.addSubview(overlay)
        NSLayoutConstraint.activate([
            retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            restart.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            overlay.leadingAnchor.constraint(equalTo: hostView.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: hostView.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: hostView.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: hostView.bottomAnchor),
            stack.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: overlay.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: overlay.trailingAnchor, constant: -32),
            icon.widthAnchor.constraint(equalToConstant: 34),
            icon.heightAnchor.constraint(equalToConstant: 34),
        ])

        overlayView = overlay
        hostView.bringSubviewToFront(overlay)
        hostView.layoutIfNeeded()
        UIAccessibility.post(notification: .screenChanged, argument: title)
    }
}

/** Capacitor acknowledgement bridge for HushhSessionPrivacyShield. */
@objc(HushhSessionPrivacyPlugin)
public class HushhSessionPrivacyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HushhSessionPrivacyPlugin"
    public let jsName = "HushhSessionPrivacy"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "completeSessionValidation", returnType: CAPPluginReturnPromise),
    ]

    override public func load() {
        onMain { [weak self] in
            HushhSessionPrivacyShield.shared.onStateChanged = { [weak self] snapshot, action in
                var payload = snapshot.payload
                payload["action"] = action
                self?.notifyListeners("privacyStateChanged", data: payload, retainUntilConsumed: true)
            }
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        guard let documentId = call.getString("documentId"), !documentId.isEmpty else {
            call.reject("A session document is required.", "INVALID_DOCUMENT")
            return
        }
        onMain {
            HushhSessionPrivacyShield.shared.observeDocument(documentId)
            let snapshot = HushhSessionPrivacyShield.shared.snapshot()
            call.resolve(snapshot.payload)
        }
    }

    @objc func completeSessionValidation(_ call: CAPPluginCall) {
        guard let requestedGeneration = call.getInt("generation"),
              let documentId = call.getString("documentId"), !documentId.isEmpty else {
            call.reject("A session shield generation is required.", "INVALID_GENERATION")
            return
        }

        onMain {
            let released = HushhSessionPrivacyShield.shared.completeSessionValidation(
                generation: requestedGeneration,
                documentId: documentId,
                appIsActive: UIApplication.shared.applicationState == .active
            )
            let snapshot = HushhSessionPrivacyShield.shared.snapshot()
            var payload = snapshot.payload
            payload["released"] = released
            call.resolve(payload)
        }
    }

    private func onMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }
}
