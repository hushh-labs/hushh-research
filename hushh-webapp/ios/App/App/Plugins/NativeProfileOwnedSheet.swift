import UIKit

/// Presentation lifetime only; feature models and their private schemas remain
/// separate. The Drawers plugin retains the current/retiring form instances.
@MainActor protocol NativeProfileOwnedForm: AnyObject {
    var coversPresentation: Bool { get }
    var presentationSettled: Bool { get }
    var feedbackPresenter: UIViewController? { get }
    func refreshPrivacy()
    var identity: NativeDrawerIdentity { get }
    var sceneName: String { get }
    func receipt(_ phase: String) -> [String: Any]
    func retire(completion: @escaping () -> Void)
}

/// UIKit supplies sheet-local keyboard geometry to every ordinary form.
/// SwiftUI's form viewport must end above the keyboard before it reveals focus.
@MainActor
private final class NativeProfileKeyboardHost: UIViewController {
    init(content: UIViewController) {
        super.init(nibName: nil, bundle: nil)
        view.backgroundColor = .systemGroupedBackground
        addChild(content)
        view.addSubview(content.view)
        content.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            content.view.topAnchor.constraint(equalTo: view.topAnchor),
            content.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            content.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            content.view.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        ])
        content.didMove(toParent: self)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard view.keyboardLayoutGuide.layoutFrame.minY < view.bounds.maxY - view.safeAreaInsets.bottom - 1 else { return }
        children.first?.view.layoutIfNeeded()
        guard let editor = focusedView(in: view) else { return }
        var ancestor = editor.superview
        while let current = ancestor {
            if let scroll = current as? UIScrollView {
                let rect = editor.convert(editor.bounds, to: scroll)
                if !scroll.bounds.insetBy(dx: 0, dy: 12).contains(rect) {
                    scroll.scrollRectToVisible(rect.insetBy(dx: 0, dy: -12), animated: false)
                }
                return
            }
            ancestor = current.superview
        }
    }
    private func focusedView(in root: UIView) -> UIView? {
        if root.isFirstResponder { return root }
        for child in root.subviews {
            if let focused = focusedView(in: child) { return focused }
        }
        return nil
    }
}

@MainActor
final class NativeProfileOwnedSheet: NSObject, UIAdaptivePresentationControllerDelegate {
    private let makeHost: () -> UIViewController?
    private let canPresent: () -> Bool
    private let canDismiss: () -> Bool
    private let hasPending: () -> Bool
    private let appearance: () -> HushhNativeControlAppearance?
    private let cancel: () -> Void
    private let clear: () -> Void
    private let dismissPopups: (@escaping () -> Void) -> Void
    private let initialDetent: UISheetPresentationController.Detent.Identifier
    private var host: UIViewController?
    private var presenting = false
    private var presentationCompleted = false
    private var layoutPending = true
    private var layoutGeneration = 0
    private var retiring = false
    private var popupsRetired = false
    private var dismissing = false
    private var completions = [() -> Void]()
    private weak var expectedPresenter: UIViewController?
    var coverage: (() -> Void)?
    // A retained sheet remains an interaction owner during an acknowledged
    // content relayout. Revoking it between keystrokes clears native editors.
    // Initial admission and bridge receipts still require a settled layout.
    var presentationAttached: Bool {
        guard let host, let parent = expectedPresenter, presentationCompleted, !presenting, !retiring, !dismissing,
              host.presentingViewController === parent, parent.presentedViewController === host,
              let window = host.viewIfLoaded?.window, parent.viewIfLoaded?.window === window,
              host.view.bounds.width > 0, host.view.bounds.height > 0,
              !host.isBeingPresented, !host.isBeingDismissed else { return false }
        return true
    }
    var presentationSettled: Bool { presentationAttached && !layoutPending }
    var feedbackPresenter: UIViewController? { presentationSettled ? host : nil }
    var coversPresentation: Bool {
        host?.presentingViewController != nil || presenting || retiring || hasPending()
    }

    init(makeHost: @escaping () -> UIViewController?, canPresent: @escaping () -> Bool,
         canDismiss: @escaping () -> Bool, hasPending: @escaping () -> Bool,
         appearance: @escaping () -> HushhNativeControlAppearance?,
         cancel: @escaping () -> Void, clear: @escaping () -> Void,
         initialDetent: UISheetPresentationController.Detent.Identifier = .medium,
         dismissPopups: @escaping (@escaping () -> Void) -> Void = { $0() }) {
        self.makeHost = makeHost; self.canPresent = canPresent; self.canDismiss = canDismiss
        self.hasPending = hasPending; self.appearance = appearance; self.cancel = cancel
        self.clear = clear; self.dismissPopups = dismissPopups; self.initialDetent = initialDetent
    }
    func present(from parent: UIViewController, completion: @escaping (Bool) -> Void) -> Bool {
        guard host == nil, parent.presentedViewController == nil, parent.view.window != nil,
              canPresent(), let content = makeHost() else { return false }
        let controller = NativeProfileKeyboardHost(content: content)
        applyAppearance(controller)
        controller.modalPresentationStyle = .pageSheet
        let medium = UISheetPresentationController.Detent.medium()
        let large = UISheetPresentationController.Detent.large()
        if #available(iOS 26.1, *) {
            // Keep the system material consistent while changing sheet detents.
            let material = UIBlurEffect(style: .systemMaterial)
            medium.backgroundEffect = material
            large.backgroundEffect = material
        }
        controller.sheetPresentationController?.detents = [medium, large]
        controller.sheetPresentationController?.selectedDetentIdentifier = initialDetent
        controller.sheetPresentationController?.prefersGrabberVisible = true
        controller.sheetPresentationController?.prefersScrollingExpandsWhenScrolledToEdge = true
        controller.presentationController?.delegate = self
        host = controller; expectedPresenter = parent; presenting = true; presentationCompleted = false
        coverage?()
        parent.present(controller, animated: true) { [weak self] in
            guard let self else { return }
            self.presenting = false
            self.presentationCompleted = true
            self.host?.view.layoutIfNeeded()
            self.layoutPending = false
            HushhSessionPrivacyShield.shared.reassertCover()
            completion(self.presentationSettled)
            self.coverage?()
            self.dismissIfReady()
        }
        HushhSessionPrivacyShield.shared.reassertCover()
        return true
    }
    func refresh() {
        // Host destruction can synchronously withdraw SwiftUI menu controls.
        // Reject their refresh before reading host during its exclusive release.
        guard !retiring, let host else { return }
        applyAppearance(host)
        layoutPending = true
        layoutGeneration += 1
        let generation = layoutGeneration
        DispatchQueue.main.async { [weak self, weak host] in
            guard let self, let host, self.host === host, !self.retiring,
                  self.layoutGeneration == generation else { return }
            host.view.setNeedsLayout()
            host.view.layoutIfNeeded()
            self.layoutPending = false
            self.coverage?()
        }
    }
    private func applyAppearance(_ host: UIViewController) {
        if let appearance = appearance() {
            host.overrideUserInterfaceStyle = appearance.style
            host.view.tintColor = appearance.accent
        }
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        let quarantined = privacy.shielded || !privacy.appIsActive
        host.view.isUserInteractionEnabled = !quarantined
        host.view.accessibilityElementsHidden = quarantined
        if quarantined { host.view.endEditing(true) }
        host.isModalInPresentation = quarantined || !canDismiss()
    }
    func presentationControllerShouldDismiss(_ presentationController: UIPresentationController) -> Bool {
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        return privacy.appIsActive && !privacy.shielded && canDismiss()
    }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        expectedPresenter = nil
        presentationCompleted = false
        cancel()
        coverage?()
    }
    func retire(completion: @escaping () -> Void) {
        completions.append(completion)
        guard !retiring else { return }
        retiring = true
        layoutGeneration += 1
        layoutPending = true
        presentationCompleted = false
        clear() // Conceal private fields before waiting for any UI completion.
        coverage?()
        dismissPopups { [self] in popupsRetired = true; dismissIfReady() }
    }
    private func dismissIfReady() {
        guard retiring, popupsRetired, !presenting, !dismissing else { return }
        dismissing = true
        let finish = { [self] in
            host = nil; expectedPresenter = nil; retiring = false; dismissing = false; presentationCompleted = false
            coverage?()
            let callbacks = completions; completions.removeAll()
            callbacks.forEach { $0() }
        }
        guard let host, host.presentingViewController != nil else { finish(); return }
        host.dismiss(animated: UIApplication.shared.applicationState == .active, completion: finish)
    }
}
