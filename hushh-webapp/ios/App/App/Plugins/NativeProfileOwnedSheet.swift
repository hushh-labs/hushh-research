import UIKit

/// Presentation lifetime only; feature models and their private schemas remain
/// separate. The Drawers plugin retains the current/retiring form instances.
@MainActor protocol NativeProfileOwnedForm: AnyObject {
    var coversPresentation: Bool { get }
    var identity: NativeDrawerIdentity { get }
    var sceneName: String { get }
    func receipt(_ phase: String) -> [String: Any]
    func retire(completion: @escaping () -> Void)
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
    private var host: UIViewController?
    private var presenting = false
    private var retiring = false
    private var popupsRetired = false
    private var dismissing = false
    private var completions = [() -> Void]()
    var coverage: (() -> Void)?
    var coversPresentation: Bool {
        host?.presentingViewController != nil || presenting || retiring || hasPending()
    }

    init(makeHost: @escaping () -> UIViewController?, canPresent: @escaping () -> Bool,
         canDismiss: @escaping () -> Bool, hasPending: @escaping () -> Bool,
         appearance: @escaping () -> HushhNativeControlAppearance?,
         cancel: @escaping () -> Void, clear: @escaping () -> Void,
         dismissPopups: @escaping (@escaping () -> Void) -> Void = { $0() }) {
        self.makeHost = makeHost; self.canPresent = canPresent; self.canDismiss = canDismiss
        self.hasPending = hasPending; self.appearance = appearance; self.cancel = cancel
        self.clear = clear; self.dismissPopups = dismissPopups
    }
    func present(from parent: UIViewController, completion: @escaping (Bool) -> Void) -> Bool {
        guard host == nil, parent.presentedViewController == nil, parent.view.window != nil,
              canPresent(), let controller = makeHost() else { return false }
        applyAppearance(controller)
        controller.modalPresentationStyle = .pageSheet
        controller.sheetPresentationController?.detents = [.medium(), .large()]
        controller.sheetPresentationController?.prefersGrabberVisible = true
        controller.sheetPresentationController?.prefersScrollingExpandsWhenScrolledToEdge = true
        controller.presentationController?.delegate = self
        host = controller; presenting = true
        coverage?()
        parent.present(controller, animated: true) { [weak self] in
            guard let self else { return }
            self.presenting = false
            completion(!self.retiring)
            self.dismissIfReady()
        }
        return true
    }
    func refresh() { if let host { applyAppearance(host) } }
    private func applyAppearance(_ host: UIViewController) {
        if let appearance = appearance() {
            host.overrideUserInterfaceStyle = appearance.style
            host.view.tintColor = appearance.accent
        }
        host.isModalInPresentation = !canDismiss()
    }
    func presentationControllerShouldDismiss(_ presentationController: UIPresentationController) -> Bool { canDismiss() }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        cancel()
        coverage?()
    }
    func retire(completion: @escaping () -> Void) {
        completions.append(completion)
        guard !retiring else { return }
        retiring = true
        clear() // Conceal private fields before waiting for any UI completion.
        coverage?()
        dismissPopups { [self] in popupsRetired = true; dismissIfReady() }
    }
    private func dismissIfReady() {
        guard retiring, popupsRetired, !presenting, !dismissing else { return }
        dismissing = true
        let finish = { [self] in
            host = nil; retiring = false; dismissing = false
            coverage?()
            let callbacks = completions; completions.removeAll()
            callbacks.forEach { $0() }
        }
        guard let host, host.presentingViewController != nil else { finish(); return }
        host.dismiss(animated: UIApplication.shared.applicationState == .active, completion: finish)
    }
}
