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
    private var presentationRetirements = Set<UUID>()
    var hasPendingPresentationRetirement: Bool { !presentationRetirements.isEmpty }
    var shouldPublishRetirementCompletion: Bool { shielded }
    mutating func beginPresentationRetirement() -> UUID {
        let token = UUID()
        presentationRetirements.insert(token)
        return token
    }
    mutating func completePresentationRetirement(_ token: UUID) -> Bool {
        presentationRetirements.remove(token) != nil
    }

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

    mutating func protectForPresentationRecovery() {
        guard !shielded else { return }
        protectForAppInactive()
        markAppActive() // This is an active-app failure, not a fabricated lifecycle event.
    }

    func canCompleteSessionValidation(
        generation requestedGeneration: Int,
        appIsActive: Bool
    ) -> Bool {
        presentationRetirements.isEmpty && appIsActive && shielded &&
            requestedGeneration > 0 && requestedGeneration == generation
    }

    @discardableResult
    mutating func completeSessionValidation(generation requestedGeneration: Int, appIsActive: Bool) -> Bool {
        guard canCompleteSessionValidation(generation: requestedGeneration, appIsActive: appIsActive) else { return false }
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

/// Only nonsecret targets cross this boundary. An absent form is explicit;
/// a settled parent must never stand in for an expected editor.
struct NativeProfilePreparationTarget: Equatable, Decodable {
    let documentId: String
    let ownerEpoch: String
    let ownerGeneration: Int
    let revision: Int
    let updateSequence: Int
    let privacyGeneration: Int
    let visitId: String
    let destinationId: String?
    let supportDestinationId: String?
    let formScene: String?
    var identity: NativeDrawerIdentity {
        NativeDrawerIdentity(documentId: documentId, ownerEpoch: ownerEpoch,
            ownerGeneration: ownerGeneration, revision: revision, family: "profile")
    }
    static let scenes: Set<String> = ["account-name", "referral-handle", "phone", "writing-style", "support",
        "vault-passphrase", "request-price", "world-model-fact-edit", "world-model-sources", "world-model-public-profiles", "world-model-invitation",
        "runtime-provider", "connector-custom-server", "connector-profile-link", "connector-packet-price", "memory-financial-context", "payment-funding", "payment-country"]
    var valid: Bool {
        identity.valid && NativeDrawerIdentity.identifier(visitId) && updateSequence > 0 &&
            updateSequence <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration &&
            privacyGeneration > 0 && privacyGeneration <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration &&
            (destinationId == nil || NativeDrawerIdentity.identifier(destinationId!)) &&
            (supportDestinationId == nil || NativeDrawerIdentity.identifier(supportDestinationId!)) &&
            (destinationId == nil || supportDestinationId == nil) &&
            (formScene == nil || Self.scenes.contains(formScene!) && (destinationId != nil || supportDestinationId != nil))
    }
    func matches(_ projection: NativeDrawerProjection) -> Bool {
        projection.identity == identity && projection.privacyGeneration == privacyGeneration &&
            projection.updateSequence == updateSequence && projection.open &&
            projection.profileDestinationId == destinationId && projection.profileSupportDestinationId == supportDestinationId &&
            projection.profilePreparation?.visitId == visitId && projection.profilePreparation?.formScene == formScene
    }
    func matchesForm(_ identity: NativeDrawerIdentity, scene: String, destination: String?, privacy: Int) -> Bool {
        identity.documentId == documentId && identity.ownerEpoch == ownerEpoch && identity.ownerGeneration == ownerGeneration &&
            identity.family == "profile" && privacy == privacyGeneration && scene == formScene &&
            destination != nil && destination == (destinationId ?? supportDestinationId)
    }
}

#if DEBUG
private final class HushhPrivacyDiagnosticOverlay: UIView {
    var readStatus: (() -> String?)?
    override var accessibilityValue: String? {
        get { readStatus?() }
        set { /* Diagnostics are a read-only projection, never an unlock port. */ }
    }
}
#endif

/**
 * Native, process-local cover for the WebView while the app returns from the
 * background. The cover is deliberately not persisted: a fresh process starts
 * unshielded so an anonymous cold launch can always reach Login.
 *
 * Every inactive -> active cycle owns a monotonically increasing generation.
 * JavaScript must acknowledge the exact generation it rendered; a late
 * completion from an older cycle can therefore never uncover a newer one.
 */
final class HushhSessionPrivacyShield: NSObject {
    static let shared = HushhSessionPrivacyShield()
    static let accessibilityIdentifier = "session-privacy-shield"
    static let presentationDidChange = Notification.Name("HushhSessionPrivacyPresentationDidChange")
    /// The cover is always the silent launch-screen surface (app switcher,
    /// Control Center, system alerts, resume). It never shows a loading state;
    /// only a release that is still refused after `recoveryDelay` exposes the
    /// recovery controls.
    static let recoveryDelay: TimeInterval = 8
    static let releaseFadeDuration: TimeInterval = 0.12

    struct Snapshot {
        let shielded: Bool
        let generation: Int
        let cause: String
        let appIsActive: Bool
        var preparationAuthorized = false
        var preparationRevision: Int? = nil
        var preparationVisitId: String? = nil
        var preparationFormScene: String? = nil
        var preparationBody: String? = nil
        var profileMenuConcealed = false
        var profilePreparationId: String? = nil
        var presentationsRetiring = false

        var payload: [String: Any] {
            var result: [String: Any] = ["shielded": shielded, "generation": generation,
                "cause": cause, "appIsActive": appIsActive, "profilePreparation": true,
                "preparationAuthorized": preparationAuthorized, "presentationsRetiring": presentationsRetiring,
                "profileMenuConcealed": profileMenuConcealed]
            if let preparationBody { result["preparationBody"] = preparationBody }
            if let profilePreparationId { result["profilePreparationId"] = profilePreparationId }
            if let preparationRevision { result["preparationRevision"] = preparationRevision }
            if let preparationVisitId {
                result["preparationVisitId"] = preparationVisitId
                result["preparationFormScene"] = preparationFormScene as Any? ?? NSNull()
            }
            return result
        }
    }

    private weak var hostView: UIView?
    private var overlayView: UIView?
    private weak var visualCover: UIView?
    private var state = HushhSessionPrivacyState()
    private var documents = HushhSessionPrivacyDocumentState()
    private var lifecycleIsActive = false
    private var recoveryWorkItem: DispatchWorkItem?
    private weak var recoveryPanel: UIStackView?
    private weak var recoveryTitle: UILabel?
    private var pendingRelease: (id: UUID, completion: (Bool) -> Void)?
    private var preparationAuthorization: (document: String, generation: Int, sessionRevision: Int, profile: Bool,
        compositionRevision: Int, visitId: String?, formScene: String?, body: String)?
    private var profilePreparation: (id: String, target: NativeProfilePreparationTarget, ready: () -> Bool)?
    private var panePreparation: (id: String, identity: NativeContentPaneIdentity, visit: String, viewport: CGSize, painted: Bool, ready: () -> Bool)?
    var profilePresentationsConcealed: (() -> Bool)?
    private var profilePreparationWasReady = false
    private var profilePreparationRequired = false
    var onStateChanged: ((Snapshot, String) -> Void)?
    var reloadDocument: (() -> Void)?

    // Production adapters use shared. Host tests own an isolated window/shield
    // so the real WebView's Auth receipts cannot retarget a synthetic document.
    override init() { super.init() }

    func attach(to hostView: UIView) {
        dispatchPrecondition(condition: .onQueue(.main))

        if self.hostView !== hostView {
            invalidatePreparation()
            cancelPendingRelease()
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
        let previousGeneration = state.generation
        state.protectForAppInactive()
        if state.generation != previousGeneration { profilePreparationRequired = false }
        invalidatePreparation()
        cancelPendingRelease()
        cancelRecovery()
        installOverlayIfNeeded()
        hideRecoveryPanel()
        publishState()
    }

    func markAppBackgrounded() {
        dispatchPrecondition(condition: .onQueue(.main))
        lifecycleIsActive = false
        state.markAppBackgrounded()
        invalidatePreparation()
        cancelPendingRelease()
        installOverlayIfNeeded()
        publishState()
    }

    func markAppActive() {
        dispatchPrecondition(condition: .onQueue(.main))
        lifecycleIsActive = true
        state.markAppActive()
        // Never remove the cover here. The resumed JavaScript document owns the
        // privacy acknowledgement and must explicitly acknowledge this generation.
        if state.shielded {
            installOverlayIfNeeded()
            scheduleRecovery()
        }
        publishState()
    }

    /// Escalate a stalled native presentation into the existing user-controlled
    /// recovery surface. Never reload, sign out or replay a feature operation.
    func protectForPresentationRecovery() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard lifecycleIsActive, UIApplication.shared.applicationState == .active, !state.shielded else { return }
        state.protectForPresentationRecovery()
        invalidatePreparation()
        cancelRecovery()
        installOverlayIfNeeded() // Cover the actual window before retiring private presenters.
        recoveryPanel?.isHidden = false
        publishState()
        UIAccessibility.post(notification: .screenChanged, argument: recoveryTitle)
    }

    func snapshot() -> Snapshot {
        dispatchPrecondition(condition: .onQueue(.main))
        return Snapshot(shielded: state.shielded, generation: state.generation,
                        cause: state.cause,
                        appIsActive: lifecycleIsActive && UIApplication.shared.applicationState == .active,
                        preparationAuthorized: preparationAuthorization != nil,
                        preparationRevision: preparationAuthorization?.compositionRevision,
                        preparationVisitId: preparationAuthorization?.visitId,
                        preparationFormScene: preparationAuthorization?.formScene,
                        preparationBody: preparationAuthorization?.body,
                        profileMenuConcealed: profilePresentationsConcealed?() == true,
                        profilePreparationId: profilePreparation?.id ?? panePreparation?.id,
                        presentationsRetiring: state.hasPendingPresentationRetirement)
    }

    func observeDocument(_ documentId: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        documents.observe(documentId)
    }

    func acceptsDocument(_ documentId: String) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        return documents.accepts(documentId)
    }

    private var hasWindowCover: Bool {
        guard let window = hostView?.window, let overlay = overlayView else { return false }
        return overlay.superview === window && !overlay.isHidden && overlay.alpha == 1
    }

    /// Auth owns this authorization after rendering its validated destination.
    /// It permits layout only. Raw shield state continues to revoke operations.
    func authorizePreparation(document: String, generation: Int, sessionRevision: Int, profile: Bool,
        compositionRevision: Int, visitId: String?, formScene: String?, body: String = "drawer") -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard documents.accepts(document), snapshot().appIsActive, state.shielded,
              generation == state.generation, sessionRevision >= 0,
              compositionRevision >= 0, !profile || sessionRevision > 0 && visitId.map(NativeDrawerIdentity.identifier) == true,
              formScene == nil || NativeProfilePreparationTarget.scenes.contains(formScene!),
              ["drawer", "pane"].contains(body), body != "pane" || profile && formScene == nil,
              profile || visitId == nil && formScene == nil, hasWindowCover,
              !state.hasPendingPresentationRetirement else { return false }
        let previous = preparationAuthorization
        if previous?.document == document && previous?.generation == generation &&
            previous?.sessionRevision == sessionRevision && previous?.profile == profile &&
            previous?.compositionRevision == compositionRevision && previous?.visitId == visitId && previous?.formScene == formScene && previous?.body == body { return true }
        if let previous, previous.document == document, previous.generation == generation {
            guard sessionRevision > previous.sessionRevision || sessionRevision == previous.sessionRevision && compositionRevision > previous.compositionRevision else { return false }
        }
        invalidatePreparation()
        preparationAuthorization = (document, generation, sessionRevision, profile, compositionRevision, visitId, formScene, body)
        profilePreparationRequired = profile
        publishState()
        return true
    }

    var coveredProfilePreparationIsAuthorized: Bool {
        preparationAuthorization?.profile == true && snapshot().appIsActive && state.shielded && hasWindowCover
    }

    func requireProfilePreparation() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard state.shielded else { return }
        profilePreparationRequired = true
        cancelPendingRelease()
    }

    func canBeginProfilePreparation(_ target: NativeProfilePreparationTarget) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))
        guard target.valid, coveredProfilePreparationIsAuthorized, !state.hasPendingPresentationRetirement,
              preparationAuthorization?.body == "drawer",
              preparationAuthorization?.document == target.documentId,
              preparationAuthorization?.generation == target.privacyGeneration,
              preparationAuthorization?.visitId == target.visitId,
              preparationAuthorization?.formScene == target.formScene else { return false }
        if let current = profilePreparation, current.target == target { return true }
        if let current = profilePreparation, current.target.identity == target.identity {
            guard target.updateSequence > current.target.updateSequence else { return false }
        }
        return true
    }

    func beginProfilePreparation(_ target: NativeProfilePreparationTarget, ready: @escaping () -> Bool) -> String? {
        guard canBeginProfilePreparation(target) else { return nil }
        if let current = profilePreparation, current.target == target { return current.id }
        cancelPendingRelease()
        let id = UUID().uuidString
        profilePreparation = (id, target, ready)
        profilePreparationWasReady = false
        return id
    }

    func acceptsPreparedDrawer(_ state: NativeDrawerProjection) -> Bool {
        coveredProfilePreparationIsAuthorized && profilePreparation?.target.matches(state) == true
    }

    func acceptsPreparedForm(_ identity: NativeDrawerIdentity, scene: String, destination: String?, privacy: Int) -> Bool {
        coveredProfilePreparationIsAuthorized && !state.hasPendingPresentationRetirement &&
            profilePreparation?.target.matchesForm(identity, scene: scene, destination: destination, privacy: privacy) == true
    }

    func profilePreparationDidChange() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard state.shielded, profilePreparation != nil || panePreparation != nil else { return }
        let ready = coveredProfilePreparationIsAuthorized && !state.hasPendingPresentationRetirement &&
            (profilePreparation?.ready() ?? (panePreparation.map { $0.painted && $0.ready() && profilePresentationsConcealed?() == true } ?? false))
        guard ready != profilePreparationWasReady else { return }
        profilePreparationWasReady = ready
        if !ready { cancelPendingRelease(); reassertCover() }
        // Retry is a validation request, never an operation retry.
        publishState(action: "retry")
    }

    private func invalidatePreparation() {
        cancelPendingRelease()
        preparationAuthorization = nil
        profilePreparation = nil
        panePreparation = nil
        profilePreparationWasReady = false
    }

    private func compositionAllowsRelease(document: String, generation: Int, sessionRevision: Int?, compositionRevision: Int?, preparationId: String?) -> Bool {
        guard let authorization = preparationAuthorization else { return !profilePreparationRequired && preparationId == nil }
        guard authorization.document == document, authorization.generation == generation,
              authorization.sessionRevision == sessionRevision, authorization.compositionRevision == compositionRevision else { return false }
        if !authorization.profile { return preparationId == nil }
        if authorization.body == "pane" {
            guard let preparation = panePreparation, preparation.id == preparationId,
                  preparation.identity.document == document, preparation.identity.privacyGeneration == generation,
                  preparation.visit == authorization.visitId, preparation.painted, hasWindowCover,
                  profilePresentationsConcealed?() == true else { return false }
            return preparation.ready()
        }
        guard let preparation = profilePreparation, preparation.id == preparationId,
              preparation.target.documentId == document, preparation.target.privacyGeneration == generation,
              hasWindowCover else { return false }
        return preparation.ready()
    }

    /// One complete React Profile pane, not independently admitted native
    /// buttons. Layout can occur behind the window cover; actions cannot.
    func canPrepareProfilePane(_ identity: NativeContentPaneIdentity, visit: String) -> Bool {
        identity.valid && coveredProfilePreparationIsAuthorized && !state.hasPendingPresentationRetirement &&
            preparationAuthorization?.body == "pane" && preparationAuthorization?.document == identity.document &&
            preparationAuthorization?.generation == identity.privacyGeneration && preparationAuthorization?.visitId == visit
    }

    func beginProfilePanePreparation(_ identity: NativeContentPaneIdentity, visit: String, viewport: CGSize, ready: @escaping () -> Bool) -> Bool {
        guard canPrepareProfilePane(identity, visit: visit) else { return false }
        if let current = panePreparation, current.identity == identity && current.visit == visit && current.viewport == viewport { return true }
        cancelPendingRelease()
        panePreparation = (UUID().uuidString, identity, visit, viewport, false, ready)
        profilePreparationWasReady = false
        publishState()
        return true
    }

    func retireProfilePanePreparation(_ identity: NativeContentPaneIdentity) {
        guard let current = panePreparation, current.identity.sameLifetime(as: identity) else { return }
        cancelPendingRelease()
        panePreparation = nil
        profilePreparationWasReady = false
        if state.shielded { reassertCover(); publishState(action: "retry") }
    }

    func confirmProfilePanePreparation(_ identity: NativeContentPaneIdentity, visit: String, id: String) -> Bool {
        guard canPrepareProfilePane(identity, visit: visit), let current = panePreparation,
              current.identity == identity, current.visit == visit, current.id == id,
              current.ready(), profilePresentationsConcealed?() == true else { return false }
        panePreparation?.painted = true
        profilePreparationDidChange()
        return true
    }

    /// Native presenters above the bridge must be detached before private
    /// content can be uncovered. This is process-local presentation ownership.
    func beginPresentationRetirement() -> UUID {
        dispatchPrecondition(condition: .onQueue(.main))
        let token = state.beginPresentationRetirement()
        cancelPendingRelease()
        if state.shielded { publishState() }
        return token
    }

    func completePresentationRetirement(_ token: UUID) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard state.completePresentationRetirement(token) else { return }
        // A normal Done/Cancel is not a privacy invalidation. Publishing it
        // would retire its owning control before the detached popup's choice.
        if state.shouldPublishRetirementCompletion { publishState() }
    }

    func reassertCover() {
        dispatchPrecondition(condition: .onQueue(.main))
        if state.shielded { installOverlayIfNeeded() }
    }

    func completeSessionValidation(
        generation requestedGeneration: Int,
        documentId: String,
        appIsActive: Bool,
        sessionRevision: Int? = nil,
        compositionRevision: Int? = nil,
        preparationId: String? = nil,
        completion: @escaping (Bool) -> Void
    ) {
        dispatchPrecondition(condition: .onQueue(.main))

        guard pendingRelease == nil, documents.accepts(documentId),
              compositionAllowsRelease(document: documentId, generation: requestedGeneration,
                sessionRevision: sessionRevision, compositionRevision: compositionRevision, preparationId: preparationId), state.canCompleteSessionValidation(
            generation: requestedGeneration,
            appIsActive: lifecycleIsActive && appIsActive
        ), let overlay = overlayView, let visual = visualCover, overlay.superview != nil else {
            completion(false); return
        }

        let release = UUID()
        pendingRelease = (release, completion)
        // Keep interaction/AX and privacy admission covered through the actual
        // animation. A receipt must never announce release while its cover still
        // intercepts touches. Revalidate at completion, not just at admission.
        UIView.animate(withDuration: Self.releaseFadeDuration, delay: 0,
            options: [.beginFromCurrentState, .curveEaseOut], animations: { visual.alpha = 0 }
        ) { [weak self, weak overlay, weak visual] finished in
            guard let self, self.pendingRelease?.id == release else { return }
            guard finished, let overlay, let visual, self.overlayView === overlay, self.visualCover === visual,
                  self.documents.accepts(documentId), UIApplication.shared.applicationState == .active,
                  self.compositionAllowsRelease(document: documentId, generation: requestedGeneration,
                    sessionRevision: sessionRevision, compositionRevision: compositionRevision, preparationId: preparationId),
                  self.state.canCompleteSessionValidation(
                    generation: requestedGeneration, appIsActive: self.lifecycleIsActive && appIsActive
                  ) else { self.cancelPendingRelease(); self.reassertCover(); return }
            overlay.removeFromSuperview()
            self.overlayView = nil
            self.visualCover = nil
            let released = self.state.completeSessionValidation(
                generation: requestedGeneration, appIsActive: self.lifecycleIsActive && appIsActive)
            self.pendingRelease = nil
            if released {
                self.cancelRecovery()
                (self.hostView as? NativePresentationContainer)?.releasePrivacyIsolation()
            }
            else { self.installOverlayIfNeeded() }
            self.publishState()
            completion(released)
        }
    }

    private func cancelPendingRelease() {
        guard let pending = pendingRelease else { return }
        pendingRelease = nil
        visualCover?.layer.removeAllAnimations()
        visualCover?.alpha = 1
        pending.completion(false)
    }

    private func publishState(action: String = "state") {
        NotificationCenter.default.post(name: Self.presentationDidChange, object: self)
        onStateChanged?(snapshot(), action)
    }

    private func cancelRecovery() {
        recoveryWorkItem?.cancel()
        recoveryWorkItem = nil
    }

    private func hideRecoveryPanel() {
        recoveryPanel?.isHidden = true
    }

    /// Keep the neutral launch-screen cover while the resumed document
    /// acknowledges. Only a release still missing after `recoveryDelay`
    /// exposes the explanation and the Try again / Restart session controls;
    /// once exposed, Retry and Restart keep those escape controls visible.
    private func scheduleRecovery(keepRecoveryPanel: Bool = false) {
        cancelRecovery()
        if !keepRecoveryPanel { hideRecoveryPanel() }
        let generation = state.generation
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.state.shielded, self.state.generation == generation else { return }
            self.recoveryPanel?.isHidden = false
            UIAccessibility.post(notification: .screenChanged, argument: self.recoveryTitle)
        }
        recoveryWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.recoveryDelay, execute: work)
    }

    @objc private func retryValidation() {
        guard state.shielded else { return }
        scheduleRecovery(keepRecoveryPanel: true)
        publishState(action: "retry")
    }

    @objc private func restartDocument() {
        guard state.shielded else { return }
        // Invalidate acknowledgements from the old document before reloading.
        // Firebase identity persists; the new JS runtime has no decrypted vault.
        state.restartSession()
        invalidatePreparation()
        documents.restart()
        cancelPendingRelease()
        cancelRecovery()
        // Retire sibling native presentation before a replacement document can configure it.
        publishState()
        reloadDocument?()
        scheduleRecovery(keepRecoveryPanel: true)
    }

    private func installOverlayIfNeeded() {
        dispatchPrecondition(condition: .onQueue(.main))
        guard let hostView else { return }
        // The bridge's view does not cover UIKit modals. Use its actual scene
        // window (never another window/scene), falling back only before attachment.
        let coverHost: UIView = hostView.window ?? hostView
        if let overlayView, overlayView.superview !== coverHost {
            overlayView.removeFromSuperview()
            self.overlayView = nil
        }

        if let overlayView {
            overlayView.isHidden = false
            overlayView.alpha = 1
            coverHost.bringSubviewToFront(overlayView)
            coverHost.layoutIfNeeded()
            return
        }

        #if DEBUG
        let overlay = HushhPrivacyDiagnosticOverlay(frame: .zero)
        overlay.readStatus = { [weak self] in
            guard let self else { return nil }
            // Read at observation time: a missing foreground callback must not
            // make an earlier cached application-state value look current.
            return "NATIVE_PRIVACY_STATE shielded=\(self.state.shielded) lifecycle_active=\(self.lifecycleIsActive) application_active=\(UIApplication.shared.applicationState == .active) recovery_visible=\(self.recoveryPanel?.isHidden == false) recovery_scheduled=\(self.recoveryWorkItem != nil) retirement_pending=\(self.state.hasPendingPresentationRetirement)"
        }
        #else
        let overlay = UIView(frame: .zero)
        #endif
        overlay.translatesAutoresizingMaskIntoConstraints = false
        // Match LaunchScreen.storyboard exactly so the cover reads as the app
        // itself rather than a loading state.
        // The full-window modal blocker never fades. Fade only its visual
        // child, so UIKit cannot pass touches through a near-zero-alpha cover.
        overlay.backgroundColor = .clear
        overlay.isOpaque = false
        overlay.isUserInteractionEnabled = true
        overlay.accessibilityViewIsModal = true
        overlay.accessibilityIdentifier = Self.accessibilityIdentifier

        let visual = UIView(frame: .zero)
        visual.translatesAutoresizingMaskIntoConstraints = false
        visual.backgroundColor = .systemBackground
        visual.isOpaque = true
        visualCover = visual
        overlay.addSubview(visual)

        let splash = UIImageView(image: UIImage(named: "Splash"))
        splash.translatesAutoresizingMaskIntoConstraints = false
        splash.contentMode = .scaleAspectFill
        splash.clipsToBounds = true
        splash.isAccessibilityElement = true
        splash.accessibilityLabel = "Hussh"
        visual.addSubview(splash)

        let title = UILabel(frame: .zero)
        title.translatesAutoresizingMaskIntoConstraints = false
        title.text = "Unable to restore the private view"
        title.textColor = .label
        title.font = .preferredFont(forTextStyle: .headline)
        title.adjustsFontForContentSizeCategory = true
        title.numberOfLines = 0
        title.textAlignment = .center
        recoveryTitle = title

        let detail = UILabel(frame: .zero)
        detail.translatesAutoresizingMaskIntoConstraints = false
        detail.text = "Your private information is hidden. Try again. Restarting locks the vault and may discard unsent drafts."
        detail.textColor = .secondaryLabel
        detail.font = .preferredFont(forTextStyle: .subheadline)
        detail.adjustsFontForContentSizeCategory = true
        detail.numberOfLines = 0
        detail.textAlignment = .center

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

        let stack = UIStackView(arrangedSubviews: [title, detail, actions])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.setCustomSpacing(20, after: detail)
        stack.backgroundColor = .systemBackground
        stack.accessibilityIdentifier = "session-privacy-recovery"
        stack.isHidden = true
        recoveryPanel = stack

        visual.addSubview(stack)
        coverHost.addSubview(overlay)
        NSLayoutConstraint.activate([
            retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            restart.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
            overlay.leadingAnchor.constraint(equalTo: coverHost.leadingAnchor),
            overlay.trailingAnchor.constraint(equalTo: coverHost.trailingAnchor),
            overlay.topAnchor.constraint(equalTo: coverHost.topAnchor),
            overlay.bottomAnchor.constraint(equalTo: coverHost.bottomAnchor),
            visual.leadingAnchor.constraint(equalTo: overlay.leadingAnchor),
            visual.trailingAnchor.constraint(equalTo: overlay.trailingAnchor),
            visual.topAnchor.constraint(equalTo: overlay.topAnchor),
            visual.bottomAnchor.constraint(equalTo: overlay.bottomAnchor),
            splash.leadingAnchor.constraint(equalTo: overlay.leadingAnchor),
            splash.trailingAnchor.constraint(equalTo: overlay.trailingAnchor),
            splash.topAnchor.constraint(equalTo: overlay.topAnchor),
            splash.bottomAnchor.constraint(equalTo: overlay.bottomAnchor),
            stack.centerXAnchor.constraint(equalTo: overlay.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: overlay.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: overlay.leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: overlay.trailingAnchor, constant: -32),
        ])

        overlayView = overlay
        coverHost.bringSubviewToFront(overlay)
        coverHost.layoutIfNeeded()
    }
}

/** Capacitor acknowledgement bridge for HushhSessionPrivacyShield. */
@objc(HushhSessionPrivacyPlugin)
public class HushhSessionPrivacyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HushhSessionPrivacyPlugin"
    public let jsName = "HushhSessionPrivacy"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareSessionValidation", returnType: CAPPluginReturnPromise),
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

    @objc func prepareSessionValidation(_ call: CAPPluginCall) {
        guard Set(call.options.keys).isSubset(of: ["generation", "documentId", "sessionRevision", "profile", "compositionRevision", "visitId", "formScene", "body"]),
              let generation = call.getInt("generation"), let document = call.getString("documentId"),
              NativeDrawerIdentity.identifier(document), let revision = call.getInt("sessionRevision"),
              revision >= 0, revision <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
              let composition = call.getInt("compositionRevision"), composition >= 0,
              composition <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
              let profile = call.getBool("profile"), !profile || call.options.keys.contains("formScene"),
              call.options["body"] == nil || call.options["body"] is String,
              call.options["formScene"] == nil || call.options["formScene"] is NSNull || call.options["formScene"] is String
        else { call.reject("INVALID_PREPARATION"); return }
        onMain {
            let shield = HushhSessionPrivacyShield.shared
            guard shield.authorizePreparation(document: document, generation: generation,
                sessionRevision: revision, profile: profile, compositionRevision: composition,
                visitId: call.getString("visitId"), formScene: call.getString("formScene"), body: call.getString("body") ?? "drawer") else { call.reject("PREPARATION_REFUSED"); return }
            call.resolve(shield.snapshot().payload)
        }
    }

    @objc func completeSessionValidation(_ call: CAPPluginCall) {
        guard let requestedGeneration = call.getInt("generation"),
              let documentId = call.getString("documentId"), !documentId.isEmpty else {
            call.reject("A session shield generation is required.", "INVALID_GENERATION")
            return
        }

        onMain {
            HushhSessionPrivacyShield.shared.completeSessionValidation(
                generation: requestedGeneration,
                documentId: documentId,
                appIsActive: UIApplication.shared.applicationState == .active,
                sessionRevision: call.getInt("sessionRevision"), compositionRevision: call.getInt("compositionRevision"),
                preparationId: call.getString("preparationId")
            ) { released in
                var payload = HushhSessionPrivacyShield.shared.snapshot().payload
                payload["released"] = released
                call.resolve(payload)
            }
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
