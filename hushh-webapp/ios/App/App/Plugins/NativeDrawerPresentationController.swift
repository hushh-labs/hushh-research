import SwiftUI
import UIKit
import ImageIO

enum NativeDrawerLayout {
    static func travel(family: String, frame: CGRect, in bounds: CGRect) -> CGFloat {
        max(1, family == "history" ? frame.maxX - bounds.minX : bounds.maxX - frame.minX)
    }
    static func frame(family: String, in bounds: CGRect, phone: Bool) -> CGRect {
        if phone || bounds.width < 640 { return bounds }
        if family != "history" {
            let gutter: CGFloat = 18
            let width = min(430, max(0, bounds.width - 2 * gutter))
            return CGRect(x: bounds.maxX - gutter - width, y: bounds.minY,
                          width: width, height: bounds.height)
        }
        return CGRect(x: bounds.minX, y: bounds.minY,
                      width: min(360, bounds.width * 0.88), height: bounds.height)
    }
}

@MainActor
final class NativeDrawerModel: ObservableObject {
    @Published private(set) var projection: NativeDrawerProjection
    @Published var interactionEnabled = false
    // Motion/privacy quarantine affects hit testing, not authored appearance.
    var controlsEnabled: Bool { projection.enabled }
    @Published var search = ""
    @Published var detailRow: String?
    @Published var detailMode = "actions"
    @Published var renameDraft = ""
    @Published var choicePending = false
    @Published var headerInsets = EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16)
    @Published var panelCornerRadius: CGFloat = 0
    @Published private(set) var navigationPath: [String] = []
    @Published private var backPending = false
    var navigationTransitioning = false
    var awaitingBackAcknowledgement: Bool { backPending }
    var allowsPageInteraction: Bool { !backPending && !navigationTransitioning }
    weak var profileNavigationController: NativeProfileNavigationController?
    var navigationDidSettle: (() -> Void)?
    private var navigationPages = [String: NativeProfilePage]()
    #if DEBUG
    var profileAccountAppeared = false
    #endif
    func page(_ id: String) -> NativeProfilePage? { navigationPages[id] }
    fileprivate func completeNativePop(_ path: [String], from state: NativeDrawerProjection) {
        // Only UIKit's completed pop may reconcile a compatible refresh. Old
        // setters and arbitrary callbacks still require the exact projection.
        // A new visit, owner or privacy generation is never compatible.
        guard state.identity == projection.identity,
              state.updateSequence <= projection.updateSequence,
              state.privacyGeneration == projection.privacyGeneration,
              state.profileDestinationId == projection.profileDestinationId,
              state.profileSupportDestinationId == projection.profileSupportDestinationId,
              state.profileStack?.map(\.id) == projection.profileStack?.map(\.id),
              state.open, projection.open, state.enabled, projection.enabled,
              state.surfaceOpen == projection.surfaceOpen else { return }
        requestPath(path, from: projection)
    }
    func requestPath(_ path: [String], from state: NativeDrawerProjection) {
        // UIKit owns presentation/pop motion. The authored React Back owner
        // commits the route; an arbitrary path cannot dispatch an operation.
        let deviceAncestor = [["security", "devices", "device-unlink"], ["security", "vault", "vault-method"], ["security", "vault", "vault-remove"]].contains(navigationPath) && path == ["security"]
        let workspaceAncestor = (NativeDrawerProjection.validAgentSettingsPath(navigationPath) || NativeDrawerProjection.validPayoutPath(navigationPath) || NativeDrawerProjection.validMemoryPath(navigationPath) || NativeDrawerProjection.validFinancePath(navigationPath) || NativeDrawerProjection.validWorldModelPath(navigationPath) || NativeDrawerProjection.validConnectorPath(navigationPath)) && !path.isEmpty && path.count + 1 < navigationPath.count
        guard interactionEnabled, projection.navigationLocked != true, !navigationTransitioning, !choicePending, !backPending, projection.identity == state.identity,
              projection.updateSequence == state.updateSequence, projection.privacyGeneration == state.privacyGeneration,
              projection.profileDestinationId == state.profileDestinationId,
              path.count + 1 == navigationPath.count || path.isEmpty && navigationPath.count > 1 || deviceAncestor || workspaceAncestor,
              Array(navigationPath.prefix(path.count)) == path else { return }
        guard choice(deviceAncestor || workspaceAncestor ? "ancestor" : path.isEmpty && navigationPath.count > 1 ? "root" : "back",
                     row: deviceAncestor ? "security" : workspaceAncestor ? path.last : nil) else { return }
        backPending = true
        // The native pop has committed. React still owns the route and
        // confirms the existing Back event; never replay UIKit's transition.
        navigationPath = path
    }
    var pendingSequence: Int?
    var choose: ((String, String?, String?) -> Bool)?
    var close: (() -> Void)?
    var requestDelete: ((NativeDrawerRow, NativeDrawerProjection) -> Void)?
    private let menus = NSHashTable<NativeDrawerMenuControl>.weakObjects()
    private var retiringMenus = [ObjectIdentifier: NativeDrawerMenuControl]()
    func registerMenu(_ menu: NativeDrawerMenuControl) { menus.add(menu) }
    func retireMenu(_ menu: NativeDrawerMenuControl) {
        // Filtering/removing a List row can dismantle its trigger while UIKit
        // still presents its menu. Retain that owner until actual disappearance;
        // privacy/drawer retirement must still be able to find and dismiss it.
        let id = ObjectIdentifier(menu)
        retiringMenus[id] = menu
        menu.isEnabled = false
        menu.dismissOwnedMenu { [weak self] in self?.retiringMenus.removeValue(forKey: id) }
        menu.menu = nil
    }
    func dismissMenus(completion: @escaping () -> Void = {}) {
        let active = menus.allObjects.filter { $0.menuVisible }
        guard !active.isEmpty else { completion(); return }
        var remaining = active.count
        for menu in active {
            menu.dismissOwnedMenu {
                remaining -= 1
                if remaining == 0 { completion() }
            }
        }
    }
    init(_ projection: NativeDrawerProjection) {
        self.projection = projection
        navigationPath = projection.profileStack?.map(\.id) ?? []
        projection.profileStack?.forEach { navigationPages[$0.id] = $0 }
    }
    func update(_ projection: NativeDrawerProjection) {
        if projection.profileDestinationId != self.projection.profileDestinationId ||
            projection.open != self.projection.open || projection.privacyGeneration != self.projection.privacyGeneration || !projection.enabled {
            backPending = false
        }
        self.projection = projection
        if let pages = projection.profileStack {
            pages.forEach { navigationPages[$0.id] = $0 }
            let next = pages.map(\.id)
            if !backPending, next != navigationPath { navigationPath = next }
        } else {
            navigationPath = []; navigationPages.removeAll()
        }
        if !projection.open || !projection.enabled || detailRow.map({ id in !projection.sections.contains { $0.rows.contains { $0.id == id } } }) == true {
            dismissMenus()
            clearDetails()
        }
        if !projection.enabled { search = "" }
    }
    func clearDetails() { detailRow = nil; renameDraft = ""; detailMode = "actions"; pendingSequence = nil; choicePending = false }
    func settle(sequence: Int, success: Bool) {
        guard pendingSequence == sequence else { return }
        if backPending {
            pendingSequence = nil
            if !success { rejectBack() }
            return
        }
        pendingSequence = nil; choicePending = false
        if success { clearDetails() }
    }
    private func rejectBack() {
        backPending = false
        let committed = projection.profileStack?.map(\.id) ?? []
        if committed != navigationPath { navigationPath = committed }
    }
    func details(_ row: NativeDrawerRow) {
        guard interactionEnabled, !choicePending, row.enabled, row.pending != true else { return }
        detailRow = row.id; detailMode = "actions"; renameDraft = row.label
    }
    func showDetails(_ row: NativeDrawerRow, mode: String, from state: NativeDrawerProjection) {
        guard projection.identity == state.identity, projection.privacyGeneration == state.privacyGeneration,
              projection.updateSequence == state.updateSequence,
              projection.sections.contains(where: { $0.rows.contains(where: { $0.id == row.id && $0.enabled && $0.pending != true }) }) else { return }
        if mode == "delete" {
            guard row.deleteActionId != nil, interactionEnabled, !choicePending else { return }
            requestDelete?(row, state)
            return
        }
        details(row)
        if detailRow == row.id { detailMode = mode }
    }
    @discardableResult func choice(_ action: String, row: String? = nil, text: String? = nil) -> Bool {
        guard projection.allows(action: action, row: row, text: text) else { return false }
        guard action != "row" || allowsPageInteraction else { return false }
        guard action == "open" || action == "close" || interactionEnabled else { return false }
        guard (action != "row" || !choicePending), choose?(action, row, text) == true else { return false }
        if action == "row" { choicePending = true }
        return true
    }
}

/// The navigation item belongs to UIKit, not the hosted SwiftUI body's
/// navigation environment. Both lifetimes are retained through push/pop.
@MainActor
private final class NativeProfilePageController: UIViewController {
    private let bodyHost: UIHostingController<NativeProfilePageBody>

    init(model: NativeDrawerModel, pageID: String?, observer: ((String, CGRect, Bool) -> Void)?) {
        bodyHost = UIHostingController(rootView: NativeProfilePageBody(model: model, pageID: pageID, observer: observer))
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("Native Profile pages are programmatic") }

    override func viewDidLoad() {
        super.viewDidLoad()
        // A newly pushed SwiftUI body may draw after UIKit starts its native
        // transition. Its owning page must already be opaque, like Settings;
        // otherwise the route behind the drawer flashes through that frame.
        view.backgroundColor = .systemGroupedBackground
        addChild(bodyHost)
        bodyHost.view.backgroundColor = .systemGroupedBackground
        bodyHost.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bodyHost.view)
        NSLayoutConstraint.activate([
            bodyHost.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bodyHost.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bodyHost.view.topAnchor.constraint(equalTo: view.topAnchor),
            bodyHost.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        bodyHost.didMove(toParent: self)
    }
}

/// UIKit owns the complete push/pop transition. The model projects React's
/// route and emits the existing Back intent only after a user pop commits.
/// No asynchronous bridge receipt decides whether UIKit finished animating.
@MainActor
final class NativeProfileNavigationController: UINavigationController, UINavigationControllerDelegate {
    private let model: NativeDrawerModel
    private let rootPage: NativeProfilePageController
    private var pages = [String: NativeProfilePageController]()
    private let rowObserver: ((String, CGRect, Bool) -> Void)?
    private var transitioning = false
    private var applyingProjection = false
    private var nativePopCallDepth = 0
    private var retired = false
    private weak var lastVisiblePage: UIViewController?
    private var outgoingUserPop: NativeDrawerProjection?
    private var popEnabledBeforeNavigationLock: Bool?

    init(model: NativeDrawerModel, observer: ((String, CGRect, Bool) -> Void)?) {
        self.model = model
        rowObserver = observer
        rootPage = NativeProfilePageController(model: model, pageID: nil, observer: observer)
        super.init(rootViewController: rootPage)
        delegate = self
        model.profileNavigationController = self
        configure(rootPage)
        reconcile()
    }
    private func configure(_ page: NativeProfilePageController) {
            // Use UIKit's compact Back indicator on every nesting level. The
            // labelled glass button morphs the previous title during push/pop;
            // keeping page titles as navigation metadata avoids that visual
            // expansion without custom drawing or a second Back handler.
            page.navigationItem.backButtonDisplayMode = .minimal
            let close = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in
                guard let self, !self.retired, self.model.profileNavigationController === self,
                      self.model.interactionEnabled, self.model.allowsPageInteraction, !self.model.choicePending else { return }
                self.model.close?()
            })
            close.accessibilityLabel = "Close Profile"
            close.accessibilityIdentifier = "native-profile-drawer-close"
            page.navigationItem.rightBarButtonItem = close
    }
    required init?(coder: NSCoder) { fatalError("Native Profile navigation is programmatic") }

    private func performNativePop<T>(_ operation: () -> T?) -> T? {
        if applyingProjection || nativePopCallDepth > 0 { return operation() }
        guard !retired, model.profileNavigationController === self, !transitioning else { return nil }
        // UIKit may defer willShow until after popViewController returns. Fence
        // reconciliation before calling super, or a compatible SwiftUI update
        // can restore the outgoing stack and misclassify the pop as projected.
        outgoingUserPop = model.projection
        transitioning = true; model.navigationTransitioning = true
        reconcileInteraction()
        nativePopCallDepth += 1
        let result = operation()
        nativePopCallDepth -= 1
        if result == nil {
            outgoingUserPop = nil
            transitioning = false; model.navigationTransitioning = false
            reconcileInteraction()
        }
        return result
    }
    override func popViewController(animated: Bool) -> UIViewController? {
        guard viewControllers.count > 1 else { return nil }
        return performNativePop { super.popViewController(animated: animated) }
    }
    override func popToViewController(_ viewController: UIViewController, animated: Bool) -> [UIViewController]? {
        guard viewControllers.last !== viewController, viewControllers.contains(where: { $0 === viewController }) else { return nil }
        return performNativePop { super.popToViewController(viewController, animated: animated) }
    }
    override func popToRootViewController(animated: Bool) -> [UIViewController]? {
        guard viewControllers.count > 1 else { return nil }
        return performNativePop { super.popToRootViewController(animated: animated) }
    }

    var hasCompletedProjectedDestination: Bool {
        guard !retired, !transitioning, !applyingProjection,
              model.profileNavigationController === self,
              model.navigationPath == (model.projection.profileStack?.map(\.id) ?? []) else { return false }
        let expected: [UIViewController] = [rootPage] + model.navigationPath.compactMap { pages[$0] }
        return expected.count == model.navigationPath.count + 1 && viewControllers.count == expected.count &&
            zip(viewControllers, expected).allSatisfy({ $0.0 === $0.1 }) &&
            visibleViewController === expected.last && lastVisiblePage === expected.last
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
    }

    func reconcile() {
        guard !retired, model.profileNavigationController === self else { return }
        reconcileInteraction()
        // UIKit owns the active navigation transition, including its Back
        // label. Reapplying metadata (even the same text) invalidates that
        // presentation on ordinary SwiftUI/model refreshes. Reconcile only
        // actual changes, after UIKit has finished the current transition.
        guard !transitioning else { return } // didShow applies the latest state.
        updateTitles(rootPage, title: model.projection.title, back: model.projection.title)
        for id in model.navigationPath where pages[id] == nil {
            let page = NativeProfilePageController(model: model, pageID: id, observer: rowObserver)
            configure(page)
            pages[id] = page
        }
        for (id, page) in pages {
            let title = model.page(id)?.title
            updateTitles(page, title: title, back: id == "preferences" ? "Preferences" : title)
        }
        let tint = HushhNativeControlAppearance.color(model.projection.accentHex) ?? .label
        if !navigationBar.tintColor.isEqual(tint) { navigationBar.tintColor = tint }
        let destinations: [UIViewController] = [rootPage] + model.navigationPath.compactMap { pages[$0] }
        guard destinations.count == model.navigationPath.count + 1,
              viewControllers.count != destinations.count || !zip(viewControllers, destinations).allSatisfy({ $0.0 === $0.1 }) else { return }
        applyingProjection = true
        let animated = viewIfLoaded?.window != nil && model.projection.open && !UIAccessibility.isReduceMotionEnabled
        setViewControllers(destinations, animated: animated)
    }
    private func updateTitles(_ page: UIViewController, title: String?, back: String?) {
        if page.title != title { page.title = title }
        if page.navigationItem.backButtonTitle != back { page.navigationItem.backButtonTitle = back }
    }

    func navigationController(_ navigationController: UINavigationController, willShow viewController: UIViewController, animated: Bool) {
        guard !retired, model.profileNavigationController === self else { return }
        if applyingProjection { outgoingUserPop = nil }
        else if outgoingUserPop == nil, lastVisiblePage !== viewController { outgoingUserPop = model.projection }
        transitioning = true
        model.navigationTransitioning = true
        reconcileInteraction()
    }
    func navigationController(_ navigationController: UINavigationController, didShow viewController: UIViewController, animated: Bool) {
        guard !retired, model.profileNavigationController === self else { return }
        let projected = applyingProjection
        let outgoing = outgoingUserPop
        outgoingUserPop = nil
        applyingProjection = false
        transitioning = false
        model.navigationTransitioning = false
        lastVisiblePage = viewController
        #if DEBUG
        model.profileAccountAppeared = viewController === pages["account"]
        #endif
        // An interrupted edge swipe returns to Account and emits no Back.
        // Programmatic projection changes are never echoed as user operations.
        let visiblePath = viewControllers.dropFirst().compactMap { controller in pages.first { $0.value === controller }?.key }
        if !projected, let outgoing, visiblePath.count < model.navigationPath.count {
            model.completeNativePop(visiblePath, from: outgoing)
        }
        reconcile()
        model.navigationDidSettle?()
    }
    private func reconcileInteraction() {
        let admitted = model.interactionEnabled && model.allowsPageInteraction
        if model.projection.navigationLocked == true {
            if popEnabledBeforeNavigationLock == nil { popEnabledBeforeNavigationLock = interactivePopGestureRecognizer?.isEnabled }
            interactivePopGestureRecognizer?.isEnabled = false
        } else if let previous = popEnabledBeforeNavigationLock {
            interactivePopGestureRecognizer?.isEnabled = previous
            popEnabledBeforeNavigationLock = nil
        }
        let barInteractive = admitted && !model.choicePending && model.projection.navigationLocked != true
        if navigationBar.isUserInteractionEnabled != barInteractive {
            navigationBar.isUserInteractionEnabled = barInteractive
        }
        if navigationBar.accessibilityElementsHidden != !barInteractive {
            navigationBar.accessibilityElementsHidden = !barInteractive
        }
        for page in [rootPage] + Array(pages.values) {
            // Retention preserves the presentation, not interaction ownership.
            // Covered and cached destinations must not compete with the
            // visible page for touch or accessibility, including after a pop.
            let active = admitted && page === visibleViewController
            guard let view = page.viewIfLoaded else { continue }
            // UIKit owns these retained controls. Compatible refreshes must
            // not invalidate their presentation with identical state writes.
            if view.isUserInteractionEnabled != active { view.isUserInteractionEnabled = active }
            if view.accessibilityElementsHidden != !active { view.accessibilityElementsHidden = !active }
        }
    }
    func retire() {
        guard !retired else { return }
        retired = true
        delegate = nil
        outgoingUserPop = nil
        if model.profileNavigationController === self {
            model.profileNavigationController = nil
            model.navigationTransitioning = false
        }
    }
}

private struct NativeProfilePageBody: View {
    @ObservedObject var model: NativeDrawerModel
    let pageID: String?
    var observer: ((String, CGRect, Bool) -> Void)?
    var body: some View {
        // Install the actual View, not a helper called on an uninstalled View:
        // its ScaledMetric and environment properties need SwiftUI ownership.
        NativeDrawerContent(model: model, profileRowObserver: observer, profilePage: pageID.map { .page($0) } ?? .menu)
            // SwiftUI owns the body controls' accent, not the surrounding
            // UIKit navigation bar. Keep its environment below that boundary.
            .tint(Color(uiColor: HushhNativeControlAppearance.color(model.projection.accentHex) ?? .label))
    }
}

private struct NativeProfileNavigation: UIViewControllerRepresentable {
    @ObservedObject var model: NativeDrawerModel
    var observer: ((String, CGRect, Bool) -> Void)?
    func makeUIViewController(context: Context) -> NativeProfileNavigationController {
        NativeProfileNavigationController(model: model, observer: observer)
    }
    func updateUIViewController(_ controller: NativeProfileNavigationController, context: Context) { controller.reconcile() }
    static func dismantleUIViewController(_ controller: NativeProfileNavigationController, coordinator: ()) { controller.retire() }
}

/// Native body, moving header, scrim and motion share one presentation owner.
/// The controller never hides/removes base glass or sends frame poses to React.
@MainActor
final class NativeDrawerPresentationController: UIViewController, UIGestureRecognizerDelegate {
    let model: NativeDrawerModel
    private(set) var motion = NativeDrawerMotion()
    private(set) var host: UIHostingController<NativeDrawerContent>!
    private let scrim = UIView()
    private var animator: UIViewPropertyAnimator?
    private var lastSize: CGSize = .zero
    private var origin: CGFloat = 0
    private var intentPending = false
    private var closeIntent: (sequence: Int, generation: Int, privacy: Int)?
    private var dragging = false
    private var awaitingReadmission = false
    private var formCovered = false
    private var intentTimeout: DispatchWorkItem?
    private var readmissionTimeout: DispatchWorkItem?
    private var retirementCompletions = [() -> Void]()
    private var detached = false
    private var deleteConfirmation: HushhNativeChromePresenter?
    var isolation: ((Bool) -> Void)?
    var invalidateInteractions: (() -> Void)?
    var requestReadmission: (() -> Void)?
    var requestRecovery: (() -> Void)?
    var presentationDidSettle: ((NativeDrawerProjection) -> Void)?
    func recordCloseIntent(sequence: Int) {
        closeIntent = (sequence, motion.generation, model.projection.privacyGeneration)
    }
    func settleClose(sequence: Int, success: Bool) {
        guard let intent = closeIntent, intent.sequence == sequence,
              intent.generation == motion.generation, intent.privacy == model.projection.privacyGeneration,
              !motion.retired, intentPending else { return }
        closeIntent = nil
        // Acceptance is not an authored closed projection. Keep coverage until
        // update() observes that state; only known rejection restores it now.
        guard !success else { return }
        intentTimeout?.cancel(); intentTimeout = nil
        readmissionTimeout?.cancel(); readmissionTimeout = nil
        intentPending = false; awaitingReadmission = false
        settle(open: model.projection.open, userIntent: false)
    }
    private var settledUpdateSequence = 0
    var presentationSettled: Bool {
        presentationLayoutSettled && model.allowsPageInteraction
    }
    var presentationLayoutSettled: Bool {
        !motion.retired && viewIfLoaded?.window != nil && !view.bounds.isEmpty && animator == nil && !dragging && !intentPending && !awaitingReadmission &&
            !model.navigationTransitioning && settledUpdateSequence == model.projection.updateSequence &&
            (!model.projection.open || model.projection.profileStack == nil ||
                model.profileNavigationController?.hasCompletedProjectedDestination == true)
    }
    #if DEBUG
    private var observedCloseSequence = 0
    private var observedCloseStage = "none"
    func observeClose(sequence: Int, confirmed: Bool? = nil) {
        if let confirmed {
            guard sequence == observedCloseSequence else { return }
            observedCloseStage = confirmed ? "confirmed" : "rejected"
        } else {
            observedCloseSequence = sequence
            observedCloseStage = "emitted"
        }
    }
    var closeDiagnostic: String {
        "drawerCloseStage=\(observedCloseStage);drawerOpen=\(model.projection.open);drawerInteractive=\(model.interactionEnabled);drawerAwaiting=\(awaitingReadmission);drawerProjectedDepth=\(model.projection.profileStack?.count ?? -1);drawerPathDepth=\(model.navigationPath.count);drawerChoicePending=\(model.choicePending);drawerAccountAppeared=\(model.profileAccountAppeared)"
    }
    #endif
    var leadingHeaderFrame: (() -> CGRect?)?
    private var privacyQuarantined = false
    func setPrivacyQuarantined(_ quarantined: Bool) {
        guard privacyQuarantined != quarantined else { return }
        privacyQuarantined = quarantined
        view.endEditing(true)
        reconcileIsolation()
    }
    func setFormCoverage(_ covered: Bool) {
        guard formCovered != covered else { return }
        formCovered = covered
        if covered { invalidateInteractions?() }
        reconcileIsolation()
    }
    private var direction: CGFloat { model.projection.family == "history" ? -1 : 1 }
    // Keep the last committed layout's travel while reconstructing a drag
    // during resize. Reading the new viewport against the old frame would
    // reinterpret the same visual pose and jump its edge on rotation.
    private var travel: CGFloat = 1

    init(_ projection: NativeDrawerProjection) {
        model = NativeDrawerModel(projection)
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("Native drawer is programmatic") }

    override func loadView() {
        let surface = NativeDrawerHitSurface()
        surface.covered = { [weak self] in self?.covered == true }
        view = surface
    }
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        view.accessibilityIdentifier = "native-private-drawer"
        scrim.backgroundColor = .black
        scrim.alpha = 0
        scrim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(close)))
        view.addSubview(scrim)
        host = UIHostingController(rootView: NativeDrawerContent(model: model))
        addChild(host)
        // History's rounded edge belongs to its SwiftUI background, not an
        // ancestor mask that would also clip/disable effect-bearing controls.
        host.view.backgroundColor = .clear
        host.view.accessibilityIdentifier = "native-\(model.projection.family)-drawer-body"
        view.addSubview(host.view)
        host.didMove(toParent: self)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(drag(_:)))
        pan.delegate = self
        view.addGestureRecognizer(pan)
        model.close = { [weak self] in self?.close() }
        model.navigationDidSettle = { [weak self] in self?.schedulePresentationCompletion() }
        model.requestDelete = { [weak self] row, state in self?.confirmDelete(row, from: state) }
        applyAppearance()
        pose(0)
    }

    private var covered: Bool { motion.progress > 0 || animator != nil || intentPending || model.projection.open }
    var coversUnderlyingPresentation: Bool { !detached && (motion.retired || covered) }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard !motion.retired else { return }
        let changed = lastSize != view.bounds.size
        if changed {
            let initial = lastSize == .zero
            let previousWidth = travel
            let transform = host.view.layer.presentation()?.affineTransform() ?? host.view.transform
            let visible = initial ? motion.progress : min(1, max(0, 1 - abs(transform.tx) / previousWidth))
            _ = motion.begin(at: visible)
            invalidateInteractions?()
            intentTimeout?.cancel(); intentTimeout = nil
            dragging = false
            intentPending = false
            animator?.stopAnimation(true); animator = nil
            lastSize = view.bounds.size
            host.view.transform = .identity
            host.view.frame = NativeDrawerLayout.frame(family: model.projection.family, in: view.bounds,
                phone: UIDevice.current.userInterfaceIdiom == .phone)
            travel = NativeDrawerLayout.travel(family: model.projection.family, frame: host.view.frame, in: view.bounds)
            model.panelCornerRadius = host.view.frame == view.bounds ? 0 : model.projection.family == "history" ? 24 : 25
            pose(visible)
            // Invalidating geometry cancels a drag without committing its
            // unconfirmed intent or snapping the visible edge to an endpoint.
            if !initial { settle(open: model.projection.open, userIntent: false) }
        }
        scrim.frame = view.bounds
        alignHeader()
        // Compatible theme/content layouts never rewind an active drag/settle.
        if changed || animator == nil { pose(motion.progress) }
        reportPresentationCompletion()
    }

    private func schedulePresentationCompletion() {
        // SwiftUI may not have attached its navigation controller during apply.
        // The next layout and UIKit didShow are completion evidence, not the
        // bridge's admission receipt or a guessed animation delay.
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.motion.retired else { return }
            self.view.layoutIfNeeded()
            self.reportPresentationCompletion()
        }
    }
    private func reportPresentationCompletion() {
        let state = model.projection
        guard !motion.retired, viewIfLoaded?.window != nil, !view.bounds.isEmpty,
              animator == nil, !dragging, !intentPending, !awaitingReadmission,
              !model.navigationTransitioning, motion.committedOpen == state.open,
              model.navigationPath == (state.profileStack?.map(\.id) ?? []),
              !state.open || state.profileStack == nil || model.profileNavigationController != nil else { return }
        if state.open, state.profileStack != nil,
           model.profileNavigationController?.hasCompletedProjectedDestination != true { return }
        guard settledUpdateSequence != state.updateSequence else { return }
        settledUpdateSequence = state.updateSequence
        presentationDidSettle?(state)
    }

    func update(_ projection: NativeDrawerProjection) {
        guard !motion.retired, model.projection.identity == projection.identity else { return }
        if projection.updateSequence != model.projection.updateSequence || !projection.open || !projection.enabled {
            deleteConfirmation?.retire {}
        }
        let changedOpen = model.projection.open != projection.open
        let contentHandoff = changedOpen && projection.family == "profile" &&
            model.projection.surfaceOpen == true && projection.surfaceOpen == true &&
            model.projection.enabled && projection.enabled &&
            model.projection.privacyGeneration == projection.privacyGeneration
        if changedOpen { view.endEditing(true) }
        let withdrawn = model.projection.enabled && !projection.enabled
        let compatibleTerminal = intentPending && !changedOpen && model.projection.enabled == projection.enabled &&
            model.projection.privacyGeneration == projection.privacyGeneration
        model.update(projection)
        schedulePresentationCompletion()
        applyAppearance()
        alignHeader()
        if compatibleTerminal {
            // Content/theme refresh is not acknowledgement of the terminal
            // intent. Keep its pose, token and original bounded deadline.
            reconcileIsolation()
            return
        }
        closeIntent = nil
        intentTimeout?.cancel(); intentTimeout = nil
        readmissionTimeout?.cancel(); readmissionTimeout = nil
        awaitingReadmission = false
        if contentHandoff {
            // The acknowledged detail plane replaces menu content inside the
            // same Profile lifetime. Never replay the outer drawer's slide.
            intentPending = false
            dragging = false
            beginDrag()
            let target: CGFloat = projection.open ? 1 : 0
            guard motion.commit(open: projection.open, generation: motion.generation) else { return }
            pose(target)
            reportPresentationCompletion()
            return
        }
        if intentPending && projection.open == motion.committedOpen && animator == nil {
            intentPending = false; pose(motion.progress)
        } else if changedOpen || intentPending || withdrawn { intentPending = false; settle(open: projection.open, userIntent: false) }
        else { reconcileIsolation() }
    }
    func activateInitialPresentation() {
        loadViewIfNeeded()
        view.layoutIfNeeded()
        // Preparing a closed drawer must not briefly block the existing page.
        if model.projection.open { settle(open: true, userIntent: false) }
        else { pose(0) }
        schedulePresentationCompletion()
    }
    private func applyAppearance() {
        guard let theme = HushhNativeControlAppearance(appearance: model.projection.appearance,
            accentHex: model.projection.accentHex, foregroundHex: model.projection.foregroundHex) else { return }
        // A content/acknowledgement update is not an appearance change.
        // Reassigning an ancestor's tint propagates rendering invalidation to
        // the retained navigation bar, even though its own tint is unchanged.
        if overrideUserInterfaceStyle != theme.style { overrideUserInterfaceStyle = theme.style }
        if let host {
            if host.overrideUserInterfaceStyle != theme.style { host.overrideUserInterfaceStyle = theme.style }
            if !host.view.tintColor.isEqual(theme.accent) { host.view.tintColor = theme.accent }
        }
    }
    private func alignHeader() {
        guard model.projection.family == "history", !dragging,
              let frame = leadingHeaderFrame?(), view.bounds.contains(frame),
              frame.width == 44, frame.height == 44 else { return }
        let next = EdgeInsets(top: max(0, frame.minY - view.safeAreaInsets.top),
            leading: frame.minX, bottom: 8, trailing: 16)
        if model.headerInsets != next { model.headerInsets = next }
    }
    func beginDrag() {
        guard !motion.retired else { return }
        settledUpdateSequence = 0
        let width = travel
        let transform = host.view.layer.presentation()?.affineTransform() ?? host.view.transform
        let current = min(1, max(0, 1 - abs(transform.tx) / width))
        _ = motion.begin(at: current)
        model.dismissMenus()
        invalidateInteractions?()
        animator?.stopAnimation(true); animator = nil
        origin = current
        pose(current)
    }
    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard !privacyQuarantined, !motion.retired, !intentPending, !awaitingReadmission, model.projection.enabled, model.projection.navigationLocked != true, model.allowsPageInteraction, covered,
              let pan = gesture as? UIPanGestureRecognizer else { return false }
        let velocity = pan.velocity(in: view)
        // A nested native page owns its system edge-pop. The outer drawer's
        // drag-to-close must not steal that gesture or dismiss the whole stack.
        if !model.navigationPath.isEmpty { return false }
        return abs(velocity.x) > abs(velocity.y)
    }
    func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var target = touch.view
        while let current = target, current !== view {
            if current is UIControl || current is UITextView || current is UITextField { return false }
            target = current.superview
        }
        return !motion.retired
    }
    @objc private func drag(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began: beginDrag(); dragging = true
        case .changed:
            guard dragging else { return }
            motion.move(to: origin - direction * pan.translation(in: view).x / travel)
            pose(motion.progress)
        case .ended:
            guard dragging else { return }
            dragging = false
            settle(open: motion.destination(velocity: -direction * pan.velocity(in: view).x, cancelled: false), userIntent: true)
        case .cancelled, .failed:
            guard dragging else { return }
            dragging = false
            settle(open: motion.destination(velocity: 0, cancelled: true), userIntent: false)
        default: break
        }
    }
    @objc private func close() {
        guard !intentPending, !awaitingReadmission, model.projection.allows(action: "close", row: nil) else { return }
        settle(open: false, userIntent: true)
    }
    private func confirmDelete(_ row: NativeDrawerRow, from state: NativeDrawerProjection) {
        guard deleteConfirmation == nil, presentedViewController == nil, model.interactionEnabled,
              let action = row.deleteActionId, model.projection.allows(action: "row", row: action) else { return }
        view.endEditing(true)
        let alert = UIAlertController(title: "Delete chat?", message: "This chat will be removed from your history.", preferredStyle: .alert)
        let presenter = HushhNativeChromePresenter(parent: self, controller: alert, updateSequence: state.updateSequence) { [weak self] _, sequence in
            guard let self, !self.motion.retired, self.model.interactionEnabled,
                  self.model.projection.identity == state.identity,
                  self.model.projection.privacyGeneration == state.privacyGeneration,
                  self.model.projection.updateSequence == sequence else { return }
            _ = self.model.choice("row", row: action)
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak presenter] _ in presenter?.choose(nil) })
        alert.addAction(UIAlertAction(title: "Delete chat", style: .destructive) { [weak presenter] _ in presenter?.choose("delete") })
        alert.overrideUserInterfaceStyle = model.projection.appearance == "dark" ? .dark : .light
        deleteConfirmation = presenter
        presenter.didRetire = { [weak self, weak presenter] in
            if self?.deleteConfirmation === presenter { self?.deleteConfirmation = nil }
        }
        presenter.present()
    }
    func settle(open: Bool, userIntent: Bool) {
        guard !motion.retired, !userIntent || model.projection.enabled else { return }
        dragging = false
        beginDrag()
        let generation = motion.generation
        let target: CGFloat = open ? 1 : 0
        let duration: TimeInterval = UIAccessibility.isReduceMotionEnabled ? 0 : 0.15
        let next = UIViewPropertyAnimator(duration: duration, curve: .easeOut) { [weak self] in self?.pose(target) }
        next.addCompletion { [weak self] _ in
            guard let self, self.motion.commit(open: open, generation: generation) else { return }
            self.animator = nil
            if userIntent && open != self.model.projection.open {
                if self.model.choice(open ? "open" : "close") {
                    self.intentPending = true
                    self.boundTerminalIntent(generation)
                }
                else {
                    // A disable/owner change during settlement cannot leave a
                    // blank, pending drawer that will never receive an ack.
                    self.settle(open: self.model.projection.open, userIntent: false)
                    return
                }
            }
            self.pose(target)
            self.reportPresentationCompletion()
            if !HushhSessionPrivacyShield.shared.snapshot().shielded {
                UIAccessibility.post(notification: .screenChanged, argument: open ? self.host.view : nil)
            }
        }
        animator = next
        reconcileIsolation()
        next.startAnimation()
    }
    private func pose(_ progress: CGFloat) {
        host.view.transform = CGAffineTransform(translationX: direction * (1 - progress) * travel, y: 0)
        scrim.alpha = progress * 0.24
        reconcileIsolation()
    }
    private func reconcileIsolation() {
        let covered = covered
        scrim.isUserInteractionEnabled = covered && !privacyQuarantined
        view.accessibilityViewIsModal = covered
        host.view.accessibilityElementsHidden = !covered || formCovered || privacyQuarantined
        let interactive = covered && !formCovered && !privacyQuarantined && model.projection.enabled && !intentPending && !awaitingReadmission && !dragging && animator == nil
        host.view.isUserInteractionEnabled = interactive
        if model.interactionEnabled != interactive { model.interactionEnabled = interactive }
        isolation?(covered)
    }
    func allowsInteraction(_ action: String, row: String?, text: String? = nil) -> Bool {
        guard !motion.retired, !privacyQuarantined, !formCovered, !awaitingReadmission, !dragging, animator == nil,
              model.projection.allows(action: action, row: row, text: text) else { return false }
        return !intentPending || action == "open" || action == "close"
    }
    private func boundTerminalIntent(_ generation: Int) {
        intentTimeout?.cancel()
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, !self.motion.retired, self.motion.generation == generation, self.intentPending else { return }
            self.intentPending = false
            self.awaitingReadmission = true
            self.invalidateInteractions?()
            // If JavaScript is stalled, restore a visible authored surface but
            // never revive its action eligibility or replay the terminal intent.
            self.settle(open: self.model.projection.open, userIntent: false)
            self.requestReadmission?()
            self.boundReadmissionRecovery()
        }
        intentTimeout = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: deadline)
    }
    private func boundReadmissionRecovery() {
        guard !motion.retired, awaitingReadmission else { return }
        readmissionTimeout?.cancel()
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, !self.motion.retired, self.awaitingReadmission else { return }
            self.readmissionTimeout = nil
            self.requestRecovery?()
        }
        readmissionTimeout = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: deadline)
    }
    /// Clears the private model and callbacks only after child detachment.
    func retire(completion: @escaping () -> Void = {}) {
        if detached { completion(); return }
        retirementCompletions.append(completion)
        guard !motion.retired else { return }
        motion.retire()
        closeIntent = nil
        model.profileNavigationController?.retire()
        intentTimeout?.cancel(); intentTimeout = nil
        readmissionTimeout?.cancel(); readmissionTimeout = nil
        animator?.stopAnimation(true); animator = nil
        view.endEditing(true)
        model.choose = nil
        model.close = nil
        model.navigationDidSettle = nil
        presentationDidSettle = nil
        requestReadmission = nil
        requestRecovery = nil
        model.requestDelete = nil
        model.search = ""; model.clearDetails()
        invalidateInteractions = nil
        model.update(model.projection.cleared)
        model.interactionEnabled = false
        // Removing a trigger/host does not prove UIKit's menu disappeared.
        // Keep containment until its disappearance animator completes.
        model.dismissMenus { [self] in
            if let deleteConfirmation { deleteConfirmation.retire { [self] in detachRetiredPresentation() } }
            else { detachRetiredPresentation() }
        }
    }
    private func detachRetiredPresentation() {
        host.willMove(toParent: nil)
        host.view.removeFromSuperview()
        host.removeFromParent()
        willMove(toParent: nil)
        view.removeFromSuperview()
        removeFromParent()
        detached = true
        isolation?(false); isolation = nil
        let completions = retirementCompletions
        retirementCompletions.removeAll()
        for completion in completions { completion() }
    }
}

private final class NativeDrawerHitSurface: UIView {
    var covered: (() -> Bool)?
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard covered?() == true else { return nil }
        return super.hitTest(point, with: event)
    }
}

// An injected, public-fixture-only layout sink measures rendered Text rather
// than relying on SwiftUI's combined Button accessibility implementation.
// Product hosts never inject it; no private row or drag-frame telemetry exists.
struct NativeHistoryRowLayout: Equatable {
    let title: CGRect
    let row: CGRect
    let more: CGRect
}

enum NativeHistoryLayoutPart: Hashable { case title, row, more }
private struct NativeHistoryLayoutMeasurement: ViewModifier {
    let observe: ((String, NativeHistoryLayoutPart, CGRect) -> Void)?
    let row: String
    let part: NativeHistoryLayoutPart
    @ViewBuilder func body(content: Content) -> some View {
        if let observe {
            // List cells own separate hosting boundaries. Measure locally in
            // the shared window space instead of bubbling preferences through
            // List, which need not forward the cell's anchors to its parent.
            content.background {
                GeometryReader { geometry in
                    let frame = geometry.frame(in: .global)
                    Color.clear.allowsHitTesting(false).accessibilityHidden(true)
                        .onAppear { observe(row, part, frame) }
                        .onChange(of: frame) { _, next in observe(row, part, next) }
                }
            }
        } else { content }
    }
}

struct NativeDrawerContent: View {
    enum ProfilePage { case menu, page(String) }
    @ObservedObject var model: NativeDrawerModel
    var historyLayoutObserver: ((String, NativeHistoryLayoutPart, CGRect) -> Void)? = nil
    // Public-fixture-only measurement, never installed by a product host.
    var profileRowObserver: ((String, CGRect, Bool) -> Void)? = nil
    var profilePage: ProfilePage? = nil
    @ScaledMetric(relativeTo: .body) private var profileRowFont: CGFloat = 16
    @ScaledMetric(relativeTo: .subheadline) private var profileGroupFont: CGFloat = 14
    @ScaledMetric(relativeTo: .title3) private var profileNameFont: CGFloat = 19
    @ScaledMetric(relativeTo: .footnote) private var profileIdentityDetailFont: CGFloat = 10.5
    @ScaledMetric(relativeTo: .body) private var historyTitleFont: CGFloat = 15
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var renameFocused: String?
    var body: some View {
        if let profilePage {
            switch profilePage {
            case .menu: profileContent(model.projection.sections)
            case .page(let id):
                if let document = model.page(id)?.legalDocument {
                    NativeProfileLegalReader(model: model, document: document)
                } else {
                    VStack(spacing: 0) {
                        if let search = model.page(id)?.memorySearch {
                            NativeMemorySearchControl(model: model, search: search, connectors: id == "connectors")
                                .padding(.horizontal, 16).padding(.vertical, 8)
                        }
                        profileContent(model.page(id)?.sections ?? [])
                    }
                }
            }
        } else if model.projection.family == "profile", model.projection.profileStack != nil {
            profileNavigation
        } else {
            legacyContent
        }
    }
    private var profileNavigation: some View {
        NativeProfileNavigation(model: model, observer: profileRowObserver)
            // The navigation envelope fills the panel, just like History.
            // UIKit still owns its navigation-bar and scroll content insets.
            // The drawer shell stays full height while an owned editor or the
            // underlying dock has a keyboard. Each native content/editor owner
            // handles its own keyboard clearance; SwiftUI must not shrink this
            // UIKit navigation envelope and expose the route behind it.
            .ignoresSafeArea(.all, edges: .vertical)
            .allowsHitTesting(model.interactionEnabled)
            .accessibilityHidden(!model.interactionEnabled)
    }
    private var legacyContent: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                if model.projection.family == "history" {
                    control("xmark", "Close chat history") { model.close?() }
                }
                if model.projection.backEnabled {
                    control("arrow.left", "Back") { model.choice("back") }
                }
                Text(model.projection.title).font(.title2.bold()).frame(maxWidth: .infinity, alignment: .leading)
                if model.projection.family != "history" {
                    control("xmark", model.projection.family == "agent-profile" ? "Close One profile" : "Close Profile",
                        identifier: "native-\(model.projection.family)-drawer-close") { model.close?() }
                }
            }.padding(model.projection.family == "history" ? model.headerInsets :
                EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
            if model.projection.family != "history" {
                profileContent(model.projection.sections)
            } else {
                ForEach(model.projection.sections.filter { $0.id == "create" }) { section in
                    ForEach(section.rows) { historyRow($0) }
                }.padding(.horizontal, 16).padding(.bottom, 8)
                if model.projection.searchable == true {
                    searchField.padding(.horizontal, 16).padding(.bottom, 4)
                }
                if model.projection.loading == true { ProgressView("Loading chats").padding() }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(model.projection.sections.filter { !["create", "footer"].contains($0.id) }) { section in
                            VStack(alignment: .leading, spacing: 2) {
                                if let title = section.title {
                                    Text(title).font(.caption).foregroundStyle(.secondary)
                                        .padding(.horizontal, 12).padding(.top, 6)
                                        .accessibilityAddTraits(.isHeader)
                                }
                                ForEach(section.rows.filter { row in row.id == model.detailRow || model.search.isEmpty || row.renameActionId == nil || row.label.localizedCaseInsensitiveContains(model.search) }) { historyRow($0) }
                            }
                        }
                    }.padding(.horizontal, 16).padding(.vertical, 4)
                }.accessibilityIdentifier("native-history-chats-scroll")
                    .scrollDismissesKeyboard(.interactively)
                ForEach(model.projection.sections.filter { $0.id == "footer" }) { section in
                    VStack(spacing: 0) {
                        Divider()
                        ForEach(section.rows) { historyRow($0) }
                    }.padding(.horizontal, 16).padding(.vertical, 8)
                        // Keep this group's ID on its container, not inherited
                        // by the authored Connectors/Drive/To-do buttons.
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("native-history-footer")
                }
            }
        }.allowsHitTesting(model.interactionEnabled)
            .accessibilityHidden(!model.interactionEnabled)
            .background {
            if model.projection.family == "history" {
                UnevenRoundedRectangle(topLeadingRadius: 0, bottomLeadingRadius: 0,
                    bottomTrailingRadius: model.panelCornerRadius, topTrailingRadius: model.panelCornerRadius, style: .continuous)
                    .fill(Color(uiColor: .systemBackground))
                    .ignoresSafeArea()
            } else {
                RoundedRectangle(cornerRadius: model.panelCornerRadius, style: .continuous)
                    .fill(Color(uiColor: .systemGroupedBackground))
                    .ignoresSafeArea()
            }
        }
    }
    private func historyAge(_ detail: String?) -> Text {
        guard let detail, !detail.isEmpty else { return Text("") }
        return Text("  \(detail)").font(.caption2).foregroundStyle(.secondary)
    }
    @ViewBuilder private func historyRow(_ row: NativeDrawerRow) -> some View {
        if row.id == model.detailRow, model.detailMode == "rename", let action = row.renameActionId {
            VStack(alignment: .leading, spacing: 4) {
                TextField("Chat name", text: $model.renameDraft)
                    .textFieldStyle(.plain).font(.system(size: historyTitleFont))
                    .padding(.horizontal, 12).frame(minHeight: 44)
                    .focused($renameFocused, equals: row.id)
                    .accessibilityLabel("Rename chat").accessibilityIdentifier("native-history-rename")
                    .submitLabel(.done).onSubmit { saveRename(action) }
                HStack(spacing: 12) {
                    Button("Cancel") { model.clearDetails() }.frame(minWidth: 44, minHeight: 44)
                    Spacer(minLength: 0)
                    Button("Save chat name") { saveRename(action) }.frame(minWidth: 44, minHeight: 44)
                        .disabled(!renameValid)
                }.padding(.horizontal, 12)
            }.buttonStyle(.borderless)
                .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
                .disabled(!model.controlsEnabled || model.choicePending || !row.enabled || row.pending == true)
                .onAppear { renameFocused = row.id }
        } else {
        HStack(spacing: 0) {
            Button { model.choice("row", row: row.id) } label: {
                HStack(spacing: 12) {
                    if let symbol = row.symbol { Image(systemName: symbol).frame(width: 22).accessibilityHidden(true) }
                    // One compact baseline at standard text sizes. Age never
                    // creates another padding track; AX retains the full label.
                    Text("\(Text(row.label).foregroundStyle(row.destructive == true ? Color.red : Color.primary))\(historyAge(row.detail))")
                        .font(.system(size: historyTitleFont))
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                        .fixedSize(horizontal: false, vertical: true)
                        .modifier(NativeHistoryLayoutMeasurement(observe: historyLayoutObserver, row: row.id, part: .title))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if row.pending == true { ProgressView() }
                }.padding(.leading, 12).padding(.trailing, 4)
                    .frame(minHeight: 44).contentShape(Rectangle())
            }.disabled(!row.enabled || row.pending == true || !model.controlsEnabled)
                .accessibilityLabel(row.label).accessibilityValue(row.detail ?? "")
                .accessibilityAddTraits(row.selected == true ? .isSelected : [])
                .accessibilityIdentifier("native-\(model.projection.family)-row-\(row.id)")
                .modifier(NativeHistoryLayoutMeasurement(observe: historyLayoutObserver, row: row.id, part: .row))
            if row.renameActionId != nil || row.deleteActionId != nil {
                NativeDrawerRowMenu(model: model, row: row).frame(width: 44, height: 44)
                    .modifier(NativeHistoryLayoutMeasurement(observe: historyLayoutObserver, row: row.id, part: .more))
            }
        }.buttonStyle(.borderless)
            .background(row.selected == true ? Color(uiColor: .tertiarySystemFill) : .clear, in: RoundedRectangle(cornerRadius: 12))
        }
    }
    private var renameValid: Bool {
        !model.renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.renameDraft.utf16.count <= 160
    }
    private func saveRename(_ action: String) {
        guard renameValid, model.interactionEnabled, !model.choicePending else { return }
        _ = model.choice("row", row: action, text: model.renameDraft)
    }
    /// Mirrors the shared Profile roster, not List's platform-specific default
    /// paddings. React owns grouping, availability and actions; native owns its
    /// scroll/presentation. Dynamic Type may grow rows beyond the 56pt minimum.
    private func profileContent(_ sections: [NativeDrawerSection]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                ForEach(sections) { section in
                    if section.id == "identity-section" {
                        ForEach(section.rows) { row in
                            profileIdentityHeader(row, photoOptions: false)
                        }
                    } else if section.id == "account-portrait", let row = section.rows.first, row.portrait == true {
                        profileIdentityHeader(row, photoOptions: true)
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            if let title = section.title {
                                Text(title).font(.system(size: profileGroupFont, weight: .medium)).foregroundStyle(.secondary)
                                    .padding(.horizontal, 6).accessibilityAddTraits(.isHeader)
                                    .accessibilityIdentifier("native-profile-group-\(section.id)")
                            }
                            VStack(spacing: 0) {
                                if section.id == "referral-link", let link = section.rows.first {
                                    profileRow(link)
                                    HStack(spacing: 12) {
                                        ForEach(section.rows.filter { ["referral-copy", "referral-share"].contains($0.id) }) { row in
                                            Button { model.choice("row", row: row.id) } label: {
                                                Label(row.label, systemImage: row.id == "referral-copy" ? "doc.on.doc" : "square.and.arrow.up")
                                                    .frame(maxWidth: .infinity, minHeight: 44)
                                            }.buttonStyle(.bordered)
                                                .disabled(!row.enabled || !model.controlsEnabled || model.choicePending)
                                                .accessibilityIdentifier("native-profile-row-\(row.id)")
                                        }
                                    }.padding(.horizontal, 16).padding(.bottom, 12)
                                    ForEach(section.rows.filter { $0.id == "referral-copy-error" }) { row in profileRow(row) }
                                } else {
                                ForEach(Array(section.rows.enumerated()), id: \.element.id) { index, row in
                                    profileRow(row)
                                    if index < section.rows.count - 1 {
                                        Divider().padding(.leading, NativeProfileArtwork.resolve(row.artworkId ?? row.id) != nil || row.symbol != nil ? 60 : 16).padding(.trailing, 16)
                                    }
                                }
                                }
                            }.background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 18))
                        }
                    }
                }
            }.padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 24)
        }.background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
            // UIKit owns transition gating and restores it in didShow.
            // Only this published route-acknowledgement state belongs here;
            // sampling UIKit's transient flag can leave SwiftUI permanently inert.
            .allowsHitTesting(!model.awaitingBackAcknowledgement)
            .accessibilityHidden(model.awaitingBackAcknowledgement)
            .accessibilityIdentifier("native-profile-menu-scroll")
    }
    private func profileInitials(_ name: String) -> String {
        name.split(whereSeparator: { $0.isWhitespace }).prefix(2).compactMap { $0.first }.map(String.init).joined().uppercased()
    }
    /// The web pane's top identity hero: 44pt portrait, 13pt column gap and
    /// leading name/email. It is not a settings row or a second photo picker.
    /// Both destinations retain their authored action; only the portrait is a
    /// button. Text grows with Dynamic Type instead of becoming an ellipsis.
    private func profileIdentityHeader(_ row: NativeDrawerRow, photoOptions: Bool) -> some View {
        HStack(spacing: 13) {
            Button { model.choice("row", row: row.id) } label: {
                NativeProfilePortraitImage(data: row.portraitData, initials: profileInitials(row.label))
                    .frame(width: 44, height: 44).contentShape(Circle())
            }.buttonStyle(.plain)
                .accessibilityLabel(photoOptions ? "Profile photo options" : "Your account")
                .accessibilityIdentifier("native-profile-row-\(row.id)")
                .modifier(NativeProfileRowMeasurement(observe: profileRowObserver, row: "\(row.id)-portrait"))
                .disabled(!row.enabled || !model.controlsEnabled)
                .modifier(NativeDrawerPendingChoice(pending: model.choicePending))
            VStack(alignment: .leading, spacing: 4) {
                Text(row.label).font(.system(size: profileNameFont, weight: .semibold))
                    .foregroundStyle(.primary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("native-profile-\(row.id)-name")
                if let detail = row.detail {
                    Text(detail).font(.system(size: profileIdentityDetailFont)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("native-profile-\(row.id)-email")
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
                .modifier(NativeProfileRowMeasurement(observe: profileRowObserver, row: "\(row.id)-copy"))
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 4)
            .modifier(NativeProfileRowMeasurement(observe: profileRowObserver, row: row.id))
    }
    @ViewBuilder private func profileRow(_ row: NativeDrawerRow) -> some View {
        if row.toggle == true, let options = row.options, options.count == 2 {
            Toggle(isOn: Binding(get: { options[0].selected }, set: { enabled in
                model.choice("row", row: options[enabled ? 0 : 1].id)
            })) { profileRowLabel(row) }
                .tint(Color(uiColor: HushhNativeControlAppearance.color(model.projection.accentHex) ?? .label))
                .padding(.trailing, 16)
                .disabled(!row.enabled || row.pending == true || !model.controlsEnabled || model.choicePending)
                .accessibilityIdentifier("native-profile-row-\(row.id)")
        } else if row.options != nil {
            NativeProfileChoiceMenu(model: model, row: row)
                .frame(minHeight: 56)
                .padding(.horizontal, 16)
                .modifier(NativeProfileRowMeasurement(observe: profileRowObserver, row: row.id))
        } else if row.readOnly == true {
            profileRowLabel(row).accessibilityElement(children: .combine)
                .accessibilityIdentifier("native-profile-row-\(row.id)")
        } else {
            Button { model.choice("row", row: row.id) } label: { profileRowLabel(row) }
                .buttonStyle(.plain)
                .accessibilityLabel(row.label)
                .accessibilityValue([row.detail, row.trailing].compactMap { $0 }.joined(separator: ", "))
                .modifier(NativeProfileRowMeasurement(observe: profileRowObserver, row: row.id))
                .disabled(!row.enabled || row.pending == true || !model.controlsEnabled)
                .modifier(NativeDrawerPendingChoice(pending: model.choicePending))
                .accessibilityIdentifier("native-profile-row-\(row.id)")
        }
    }
    private func profileRowLabel(_ row: NativeDrawerRow) -> some View {
        NativeSettingsRowLabel(row: row, accentHex: model.projection.accentHex)
    }
    private var searchContent: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
            TextField("Search chats", text: $model.search)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityIdentifier("native-history-search")
            if !model.search.isEmpty {
                Button { model.search = "" } label: {
                    Image(systemName: "xmark.circle.fill").frame(width: 44, height: 44).contentShape(Rectangle())
                }.buttonStyle(.borderless).accessibilityLabel("Clear chat search")
            }
        }.padding(.horizontal, 14).frame(minHeight: 44).disabled(!model.controlsEnabled)
    }
    @ViewBuilder private var searchField: some View {
        if #available(iOS 26.0, *) {
            searchContent.glassEffect(.regular, in: Capsule())
        } else { searchContent.background(.regularMaterial, in: Capsule()) }
    }
    @ViewBuilder private func control(_ symbol: String, _ label: String, identifier: String = "", action: @escaping () -> Void) -> some View {
        if #available(iOS 26.0, *) {
            Button(action: action) {
                Image(systemName: symbol).font(.system(size: 18))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .contentShape([.interaction, .hoverEffect], Circle())
            }
                .buttonStyle(.glass).buttonBorderShape(.circle).frame(width: 44, height: 44).accessibilityLabel(label)
                .accessibilityIdentifier(identifier)
                .disabled(!model.controlsEnabled)
        } else {
            Button(action: action) { Image(systemName: symbol) }.frame(width: 44, height: 44)
                .accessibilityLabel(label).disabled(!model.controlsEnabled)
                .accessibilityIdentifier(identifier)
        }
    }
}

/// Shared Profile/workspace columns. No callbacks, authority or persistence.
struct NativeSettingsRowLabel: View {
    let row: NativeDrawerRow
    let accentHex: String
    @ScaledMetric(relativeTo: .body) private var rowFont: CGFloat = 16
    var body: some View {
            HStack(spacing: 12) {
                if let artwork = NativeProfileArtwork.resolve(row.artworkId ?? row.id) {
                    ZStack {
                        Image(uiImage: artwork.base).resizable()
                            .foregroundStyle(Color(uiColor: HushhNativeControlAppearance.color(artwork.colorHex) ?? .label))
                        if let accent = artwork.accent {
                            Image(uiImage: accent).resizable()
                                .foregroundStyle(Color(uiColor: HushhNativeControlAppearance.color(artwork.accentColorHex ?? accentHex) ?? .label))
                        }
                    }.frame(width: artwork.base.size.width, height: artwork.base.size.height)
                        .frame(width: 32, height: 32).accessibilityHidden(true)
                } else if let symbol = row.symbol {
                    Image(systemName: symbol).symbolRenderingMode(.hierarchical).font(.system(size: 28))
                        .foregroundStyle(Color(uiColor: HushhNativeControlAppearance.color(row.iconHex) ?? .label))
                        .frame(width: 32, height: 28).accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.label).font(.system(size: rowFont, weight: .medium))
                        .foregroundStyle(row.destructive == true ? Color(uiColor: .systemRed) : .primary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = row.detail {
                        Text(detail).font(.subheadline).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    if let progress = row.progress {
                        ProgressView(value: progress.value, total: progress.total)
                            .accessibilityLabel(row.label)
                            .accessibilityValue("\(progress.value.formatted()) of \(progress.total.formatted())")
                    }
                }
                Spacer(minLength: 8)
                if let trailing = row.trailing {
                    Text(trailing).font(.caption).foregroundStyle(.secondary)
                }
                if row.pending == true { ProgressView() }
                else if row.selected == true { Image(systemName: "checkmark").accessibilityHidden(true) }
                else if row.chevron == true {
                    Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold))
                        .frame(width: 16).foregroundStyle(.secondary).accessibilityHidden(true)
                }
            }.frame(maxWidth: .infinity, alignment: .leading).frame(minHeight: 56)
                .padding(.horizontal, 16).padding(.vertical, row.detail == nil ? 0 : 8).contentShape(Rectangle())
    }
}

/// Private, local filter draft. Submit searches the complete React-owned
/// category model, not just the currently projected pagination window. Nothing
/// is bridged per keystroke or stored outside this retained presentation.
private struct NativeMemorySearchControl: View {
    @ObservedObject var model: NativeDrawerModel
    let search: NativeMemorySearch
    var connectors = false
    @State private var draft = ""
    @State private var acknowledged = ""
    private func submit(_ value: String) {
        guard value.utf16.count <= 256 else { return }
        _ = model.choice("row", row: search.id, text: value)
    }
    private var content: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
            TextField(connectors ? "Search connectors" : "Search saved details", text: $draft)
                .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
                .onSubmit { submit(draft) }.accessibilityIdentifier(connectors ? "native-connectors-search" : "native-memory-search")
            if !draft.isEmpty {
                Button { draft = ""; submit("") } label: {
                    Image(systemName: "xmark.circle.fill").frame(width: 44, height: 44).contentShape(Rectangle())
                }.buttonStyle(.borderless).accessibilityLabel(connectors ? "Clear connectors search" : "Clear saved details search")
            }
        }.padding(.horizontal, 14).frame(minHeight: 44)
            .disabled(!model.controlsEnabled || model.choicePending || !model.interactionEnabled)
            .onAppear { draft = search.query; acknowledged = search.query }
            .onChange(of: search.query) { _, next in
                if draft == acknowledged { draft = next }
                acknowledged = next
            }
            .onChange(of: model.projection.enabled) { _, enabled in
                draft = enabled ? search.query : ""
                acknowledged = enabled ? search.query : ""
            }
    }
    var body: some View {
        if #available(iOS 26.0, *) { content.glassEffect(.regular, in: Capsule()) }
        else { content.background(.regularMaterial, in: Capsule()) }
    }
}

/// Bounded raster replica; no URLSession, disk cache or provider authority.
private struct NativeProfilePortraitImage: View {
    let data: String?
    let initials: String
    @State private var decoded: UIImage?
    @State private var decodedSource: String?
    var body: some View {
        ZStack {
            Circle().fill(Color(uiColor: .tertiarySystemFill))
            if decodedSource == data, let decoded {
                Image(uiImage: decoded).resizable().scaledToFill()
            } else { Text(initials).font(.title3.weight(.medium)) }
        }.clipShape(Circle())
            .onAppear(perform: decode)
            .onChange(of: data) { _, _ in decode() }
    }
    private func decode() {
        decoded = nil; decodedSource = nil
        guard let data, data.utf16.count <= 100_000, data.hasPrefix("data:image/jpeg;base64,"),
              let bytes = Data(base64Encoded: String(data.dropFirst("data:image/jpeg;base64,".count))),
              let source = CGImageSourceCreateWithData(bytes as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 1024, height <= 1024,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 256,
              ] as CFDictionary) else { return }
        decoded = UIImage(cgImage: image); decodedSource = data
    }
}

/// A bridge acknowledgement is not an authored disabled state. Keep the row's
/// native appearance while refusing repeat pointer and accessibility actions;
/// NativeDrawerModel and the lease still enforce one-shot operation admission.
private struct NativeDrawerPendingChoice: ViewModifier {
    let pending: Bool
    func body(content: Content) -> some View {
        content.allowsHitTesting(!pending)
            .accessibilityRespondsToUserInteraction(!pending)
    }
}

private struct NativeProfileRowMeasurement: ViewModifier {
    let observe: ((String, CGRect, Bool) -> Void)?
    let row: String
    @Environment(\.isEnabled) private var enabled
    @ViewBuilder func body(content: Content) -> some View {
        if let observe {
            content.background {
                GeometryReader { geometry in
                    let frame = geometry.frame(in: .global)
                    Color.clear.allowsHitTesting(false).accessibilityHidden(true)
                        .onAppear { observe(row, frame, enabled) }
                        .onChange(of: frame) { _, next in observe(row, next, enabled) }
                        .onChange(of: enabled) { _, next in observe(row, frame, next) }
                        .onDisappear { observe(row, .zero, false) }
                }
            }
        } else { content }
    }
}

/// Standard UIKit compact menu embedded in the SwiftUI row. UIKit owns its
/// material and animation; retirement is acknowledged only after willEnd's
/// completion. Menu actions carry the exact projection, never ambient rows.
@MainActor final class NativeDrawerMenuControl: UIButton {
    private(set) var menuVisible = false
    var visibilityChanged: (() -> Void)?
    private var completions = [() -> Void]()
    private var pendingChoice: (() -> Void)?
    func afterDismissal(_ choice: @escaping () -> Void) {
        if menuVisible { pendingChoice = choice } else { choice() }
    }
    func dismissOwnedMenu(completion: @escaping () -> Void) {
        pendingChoice = nil
        guard menuVisible else { completion(); return }
        completions.append(completion)
        contextMenuInteraction?.dismissMenu()
    }
    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
        willDisplayMenuFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
        super.contextMenuInteraction(interaction, willDisplayMenuFor: configuration, animator: animator)
        menuVisible = true
        visibilityChanged?()
    }
    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction,
        willEndFor configuration: UIContextMenuConfiguration, animator: UIContextMenuInteractionAnimating?) {
        super.contextMenuInteraction(interaction, willEndFor: configuration, animator: animator)
        let finish = { [self] in
            menuVisible = false
            let choice = pendingChoice; pendingChoice = nil
            let retired = completions; completions.removeAll()
            for completion in retired { completion() }
            if retired.isEmpty { choice?() }
            visibilityChanged?()
        }
        if let animator { animator.addCompletion(finish) } else { finish() }
    }
}

struct NativeDrawerRowMenu: UIViewRepresentable {
    // A reference-only child can retain its old UIAction closures when the
    // row is unchanged but the applied projection advances. Observe the
    // presentation so menu bindings refresh without weakening the fence.
    @ObservedObject var model: NativeDrawerModel
    let row: NativeDrawerRow
    func makeCoordinator() -> NativeDrawerModel { model }
    static func dismantleUIView(_ button: NativeDrawerMenuControl, coordinator: NativeDrawerModel) {
        coordinator.retireMenu(button)
    }
    func makeUIView(context: Context) -> NativeDrawerMenuControl {
        let button = NativeDrawerMenuControl(type: .system)
        button.setImage(UIImage(systemName: "ellipsis"), for: .normal)
        button.showsMenuAsPrimaryAction = true
        model.registerMenu(button)
        return button
    }
    func updateUIView(_ button: NativeDrawerMenuControl, context: Context) {
        button.accessibilityLabel = "Open actions for \(row.label)"
        button.accessibilityIdentifier = "native-\(model.projection.family)-actions-\(row.id)"
        button.isEnabled = row.enabled && row.pending != true && model.controlsEnabled
        button.isUserInteractionEnabled = model.interactionEnabled
        button.accessibilityElementsHidden = !model.interactionEnabled
        if !button.isEnabled { button.dismissOwnedMenu {} }
        let state = model.projection
        var actions = [UIAction]()
        if row.renameActionId != nil {
            actions.append(UIAction(title: "Rename", image: UIImage(systemName: "pencil")) { [weak button, weak model] _ in
                button?.afterDismissal { model?.showDetails(row, mode: "rename", from: state) }
            })
        }
        if row.deleteActionId != nil {
            actions.append(UIAction(title: "Delete", image: UIImage(systemName: "trash"), attributes: .destructive) { [weak button, weak model] _ in
                button?.afterDismissal { model?.showDetails(row, mode: "delete", from: state) }
            })
        }
        button.menu = UIMenu(children: actions)
    }
}

/// A whole native finite-choice presentation. The menu uses the same owned
/// dismissal completion as History, and binds each option to its exact lease.
/// Values are committed only by the existing React callback after confirmation.
struct NativeProfileChoiceMenu: UIViewRepresentable {
    @ObservedObject var model: NativeDrawerModel
    let row: NativeDrawerRow
    func makeCoordinator() -> NativeDrawerModel { model }
    func makeUIView(context: Context) -> NativeDrawerMenuControl {
        let button = NativeDrawerMenuControl(type: .system)
        button.showsMenuAsPrimaryAction = true
        button.contentHorizontalAlignment = .leading
        model.registerMenu(button)
        return button
    }
    static func dismantleUIView(_ button: NativeDrawerMenuControl, coordinator: NativeDrawerModel) {
        coordinator.retireMenu(button)
    }
    func updateUIView(_ button: NativeDrawerMenuControl, context: Context) {
        let state = model.projection
        let options = row.options ?? []
        var configuration = UIButton.Configuration.plain()
        configuration.title = row.label
        configuration.subtitle = options.first(where: \.selected)?.label
        configuration.titleAlignment = .leading
        configuration.imagePadding = 12
        configuration.contentInsets = .init(top: 8, leading: 0, bottom: 8, trailing: 0)
        configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var attributes = incoming
            attributes.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 16, weight: .medium))
            return attributes
        }
        configuration.subtitleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var attributes = incoming
            attributes.font = UIFont.preferredFont(forTextStyle: .subheadline)
            attributes.foregroundColor = .secondaryLabel
            return attributes
        }
        if let artwork = NativeProfileArtwork.resolve(row.artworkId ?? row.id) {
            let icon = artwork.base.renderingMode == .alwaysOriginal ? artwork.base :
                artwork.base.withTintColor(HushhNativeControlAppearance.color(artwork.colorHex) ?? .label, renderingMode: .alwaysOriginal)
            // Preserve the authored glyph's size inside the shared 32pt well.
            let iconFrame = CGRect(x: (32 - icon.size.width) / 2, y: (32 - icon.size.height) / 2,
                width: icon.size.width, height: icon.size.height)
            configuration.image = UIGraphicsImageRenderer(size: CGSize(width: 32, height: 32)).image { _ in
                icon.draw(in: iconFrame)
                artwork.accent?.withTintColor(HushhNativeControlAppearance.color(artwork.accentColorHex ?? state.accentHex) ?? .label,
                    renderingMode: .alwaysOriginal).draw(in: iconFrame)
            }.withRenderingMode(.alwaysOriginal)
        } else if let symbol = row.symbol { configuration.image = UIImage(systemName: symbol) }
        configuration.preferredSymbolConfigurationForImage = .init(pointSize: 24)
        configuration.baseForegroundColor = .label
        button.configuration = configuration
        button.accessibilityLabel = row.label
        button.accessibilityValue = configuration.subtitle
        button.accessibilityIdentifier = "native-profile-row-\(row.id)"
        button.isEnabled = row.enabled && row.pending != true && model.controlsEnabled && !model.choicePending
        // UIKit gates the complete page while its push/pop is in flight and
        // restores that ancestor in didShow. Do not copy its non-published
        // transient flag into a retained child: no later body update is owed.
        button.isUserInteractionEnabled = model.interactionEnabled && !model.awaitingBackAcknowledgement
        button.accessibilityElementsHidden = !button.isUserInteractionEnabled
        if !button.isEnabled || !button.isUserInteractionEnabled { button.dismissOwnedMenu {} }
        let actions = options.map { option in
            var image = option.symbol.flatMap { UIImage(systemName: $0) }
            if let color = HushhNativeControlAppearance.color(option.colorHex) {
                image = UIImage(systemName: "circle.fill")?.withTintColor(color, renderingMode: .alwaysOriginal)
            }
            return UIAction(title: option.label, image: image, state: option.selected ? .on : .off) { [weak button, weak model] _ in
                button?.afterDismissal {
                    guard let model, model.projection.identity == state.identity,
                          model.projection.updateSequence == state.updateSequence,
                          model.projection.privacyGeneration == state.privacyGeneration else { return }
                    model.choice("row", row: option.id)
                }
            }
        }
        button.menu = UIMenu(title: row.label, options: .singleSelection, children: actions)
    }
}
