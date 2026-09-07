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
        return true
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
final class HushhSessionPrivacyShield {
    static let shared = HushhSessionPrivacyShield()
    static let accessibilityIdentifier = "session-privacy-shield"

    struct Snapshot {
        let shielded: Bool
        let generation: Int
    }

    private weak var hostView: UIView?
    private var overlayView: UIView?
    private var state = HushhSessionPrivacyState()

    private init() {}

    func attach(to hostView: UIView) {
        dispatchPrecondition(condition: .onQueue(.main))

        if self.hostView !== hostView {
            overlayView?.removeFromSuperview()
            overlayView = nil
            self.hostView = hostView
        }

        if state.shielded {
            installOverlayIfNeeded()
        }
    }

    func protectForAppInactive() {
        dispatchPrecondition(condition: .onQueue(.main))

        state.protectForAppInactive()
        installOverlayIfNeeded()
    }

    func markAppActive() {
        dispatchPrecondition(condition: .onQueue(.main))
        state.markAppActive()
        // Never remove the cover here. The resumed JavaScript document owns
        // account validation and must explicitly acknowledge this generation.
        if state.shielded {
            installOverlayIfNeeded()
        }
    }

    func snapshot() -> Snapshot {
        dispatchPrecondition(condition: .onQueue(.main))
        return Snapshot(shielded: state.shielded, generation: state.generation)
    }

    @discardableResult
    func completeSessionValidation(
        generation requestedGeneration: Int,
        appIsActive: Bool
    ) -> Bool {
        dispatchPrecondition(condition: .onQueue(.main))

        guard state.completeSessionValidation(
            generation: requestedGeneration,
            appIsActive: appIsActive
        ) else {
            return false
        }

        overlayView?.removeFromSuperview()
        overlayView = nil
        return true
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

        let stack = UIStackView(arrangedSubviews: [icon, title, detail, progress])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        stack.setCustomSpacing(16, after: icon)

        overlay.addSubview(stack)
        hostView.addSubview(overlay)
        NSLayoutConstraint.activate([
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

    @objc func getState(_ call: CAPPluginCall) {
        onMain {
            let snapshot = HushhSessionPrivacyShield.shared.snapshot()
            call.resolve([
                "shielded": snapshot.shielded,
                "generation": snapshot.generation,
            ])
        }
    }

    @objc func completeSessionValidation(_ call: CAPPluginCall) {
        guard let requestedGeneration = call.getInt("generation") else {
            call.reject("A session shield generation is required.", "INVALID_GENERATION")
            return
        }

        onMain {
            let released = HushhSessionPrivacyShield.shared.completeSessionValidation(
                generation: requestedGeneration,
                appIsActive: UIApplication.shared.applicationState == .active
            )
            let snapshot = HushhSessionPrivacyShield.shared.snapshot()
            call.resolve([
                "released": released,
                "shielded": snapshot.shielded,
                "generation": snapshot.generation,
            ])
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
