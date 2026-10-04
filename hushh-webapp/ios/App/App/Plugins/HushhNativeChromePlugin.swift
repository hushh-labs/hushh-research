import Capacitor
import SwiftUI
import UIKit

/// Strict public presentation metadata, shared by UIKit and SwiftUI controls.
/// Colors come from React's canonical CSS tokens, not another native palette.
struct HushhNativeControlAppearance {
    static let contractVersion = 2
    let style: UIUserInterfaceStyle
    let accent: UIColor
    let foreground: UIColor

    init?(appearance: String?, accentHex: String?, foregroundHex: String?) {
        guard appearance == "light" || appearance == "dark",
              let accent = Self.color(accentHex), let foreground = Self.color(foregroundHex) else { return nil }
        style = appearance == "dark" ? .dark : .light
        self.accent = accent
        self.foreground = foreground
    }

    static func color(_ literal: String?) -> UIColor? {
        guard let literal, literal.first == "#", [4, 7, 9].contains(literal.utf8.count) else { return nil }
        let digits = literal.dropFirst()
        guard digits.utf8.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }) else { return nil }
        let expanded = digits.count == 3 ? digits.map { "\($0)\($0)" }.joined() : String(digits)
        guard let value = UInt32(expanded, radix: 16) else { return nil }
        let hasAlpha = expanded.count == 8
        let rgb = hasAlpha ? value >> 8 : value
        return UIColor(red: CGFloat((rgb >> 16) & 255) / 255,
                       green: CGFloat((rgb >> 8) & 255) / 255,
                       blue: CGFloat(rgb & 255) / 255,
                       alpha: hasAlpha ? CGFloat(value & 255) / 255 : 1)
    }
}

/// A presentation lease, not a navigation or information authority. Revision
/// tombstones reject late preparation even after an uncertain JS response.
struct HushhNativeChromeState {
    struct Identity: Equatable {
        let document: String
        let ownerEpoch: String
        let revision: Int
    }
    private(set) var identity: Identity?
    private(set) var phase = "retired"
    private var document: String?
    private var revision = -1
    private var retiredDocuments = Set<String>()
    private var confirmedSequence = 0

    mutating func prepare(_ next: Identity) -> Bool {
        guard acceptRevision(next) else { return false }
        identity = next
        phase = "prepared"
        return true
    }
    mutating func activate(_ requested: Identity) -> Bool {
        guard identity == requested, phase == "prepared" else { return false }
        phase = "active"
        return true
    }
    mutating func retire(_ requested: Identity, targetRevision: Int? = nil) -> Bool {
        if let targetRevision, let identity, targetRevision != identity.revision { return false }
        guard acceptRevision(requested) else { return false }
        identity = nil
        phase = "retired"
        return true
    }
    mutating func invalidate() { identity = nil; phase = "retired" }
    mutating func confirm(_ requested: Identity, sequence: Int, latestSequence: Int, allowed: Bool) -> Bool {
        guard allowed, phase == "active", identity == requested,
              sequence == latestSequence, sequence > confirmedSequence else { return false }
        confirmedSequence = sequence
        return true
    }
    private mutating func acceptRevision(_ next: Identity) -> Bool {
        guard !next.document.isEmpty, next.document.count <= 128,
              !next.ownerEpoch.isEmpty, next.ownerEpoch.count <= 128,
              next.revision >= 0, next.revision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
              !retiredDocuments.contains(next.document) else { return false }
        if document != next.document {
            if let document { retiredDocuments.insert(document) }
            document = next.document
            revision = -1
        }
        guard next.revision > revision else { return false }
        revision = next.revision
        return true
    }
}

@available(iOS 26.0, *)
private struct NativeBackButton: View {
    let label: String
    let theme: HushhNativeControlAppearance
    let action: () -> Void
    let layout: (CGSize) -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.backward")
                .font(.body.weight(.semibold))
                // Fill the proposed label size while retaining the 44pt host.
                // The accessible control and edge hit area still require device proof.
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .foregroundStyle(Color(uiColor: theme.foreground))
        }
        .buttonStyle(.glass)
        .tint(Color(uiColor: theme.accent))
        .buttonBorderShape(.circle)
        .accessibilityLabel(label)
        .accessibilityIdentifier("top-shell-back")
        .frame(width: 44, height: 44)
        .background(GeometryReader { proxy in
            Color.clear.preference(key: ChromeLayoutSize.self, value: proxy.size)
        })
        .onPreferenceChange(ChromeLayoutSize.self, perform: layout)
    }
}

private struct ChromeLayoutSize: PreferenceKey {
    static var defaultValue = CGSize.zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) { value = nextValue() }
}

/// UIKit containment and actual layout are the integration boundary. No full-
/// screen transparent hosting surface: only the bounded control can intercept touches.
private final class ChromeHostingController: UIHostingController<AnyView> {
    var didLayout: (() -> Void)?
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        didLayout?()
    }
}

@objc(HushhNativeChromePlugin)
final class HushhNativeChromePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "HushhNativeChromePlugin"
    let jsName = "HushhNativeChrome"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retire", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmChoice", returnType: CAPPluginReturnPromise),
    ]
    private var state = HushhNativeChromeState()
    private var hosting: ChromeHostingController?
    private var pendingLayout: CAPPluginCall?
    private var viewport = CGSize.zero
    private var observers = [NSObjectProtocol]()
    private var keyboardVisible = false
    private var sequence = 0

    override func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            for name in [UIApplication.willResignActiveNotification,
                         HushhSessionPrivacyShield.presentationDidChange,
                         UIResponder.keyboardWillShowNotification, UIResponder.keyboardWillHideNotification] {
                self.observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                    guard let self else { return }
                    if note.name == UIResponder.keyboardWillShowNotification { self.keyboardVisible = true }
                    if note.name == UIResponder.keyboardWillHideNotification { self.keyboardVisible = false }
                    // This pilot owns no popups. Additional families cannot be
                    // enabled until their presented-controller retirement is proved.
                    self.invalidatePresentation()
                })
            }
        }
    }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    @objc func getCapabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            call.resolve(["contractVersion": HushhNativeControlAppearance.contractVersion, "families": self?.backAdmitted == true ? ["back"] : []])
        }
    }

    @objc func prepare(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard #available(iOS 26.0, *), UIDevice.current.userInterfaceIdiom == .phone,
                  let parent = self.bridge?.viewController, let identity = self.identity(call),
                  call.getString("kind") == "back", call.getBool("enabled") == true,
                  let label = call.getString("label"), !label.isEmpty, label.count <= 80,
                  let theme = HushhNativeControlAppearance(appearance: call.getString("appearance"),
                    accentHex: call.getString("accentHex"), foregroundHex: call.getString("foregroundHex")),
                  let frame = self.frame(call), let bounds = self.viewport(call),
                  self.backAdmitted, self.canPresent, self.state.prepare(identity) else {
                call.reject("NATIVE_CHROME_PREPARE_REFUSED"); return
            }
            let shield = HushhSessionPrivacyShield.shared
            shield.observeDocument(identity.document)
            guard shield.acceptsDocument(identity.document),
                  abs(parent.view.bounds.width - bounds.width) < 1,
                  abs(parent.view.bounds.height - bounds.height) < 1 else {
                self.state.invalidate(); call.reject("NATIVE_CHROME_DOCUMENT_OR_GEOMETRY_STALE"); return
            }
            self.removeHosting()
            self.viewport = parent.view.bounds.size
            var swiftUILayout = false
            let controller = ChromeHostingController(rootView: AnyView(NativeBackButton(
                label: label, theme: theme, action: { [weak self] in self?.requestChoice() },
                layout: { [weak self] size in
                    swiftUILayout = size == frame.size
                    self?.hosting?.view.setNeedsLayout()
                }
            )))
            self.hosting = controller
            controller.overrideUserInterfaceStyle = theme.style
            controller.view.backgroundColor = .clear
            controller.view.isHidden = true
            controller.view.isUserInteractionEnabled = false
            controller.view.accessibilityElementsHidden = true
            // The web shell has already applied safe-area clearance. SwiftUI
            // must not apply a second inherited inset to this 44pt slot.
            controller.safeAreaRegions = []
            parent.addChild(controller)
            if let cover = parent.view.subviews.first(where: { $0.accessibilityIdentifier == HushhSessionPrivacyShield.accessibilityIdentifier }) {
                parent.view.insertSubview(controller.view, belowSubview: cover)
            } else { parent.view.addSubview(controller.view) }
            controller.view.frame = frame
            controller.didMove(toParent: parent)
            self.pendingLayout = call
            controller.didLayout = { [weak self, weak controller] in
                guard let self, let controller, self.hosting === controller,
                      self.state.identity == identity, let pending = self.pendingLayout else { return }
                guard swiftUILayout, controller.view.bounds.size == frame.size, controller.view.superview != nil else { return }
                self.pendingLayout = nil
                controller.didLayout = nil
                pending.resolve(self.payload(identity, phase: "prepared", frame: controller.view.frame))
            }
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
        }
    }

    @objc func activate(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let identity = self.identity(call), self.canPresent, self.geometryIsCurrent,
                  self.pendingLayout == nil, let hosting = self.hosting,
                  HushhSessionPrivacyShield.shared.acceptsDocument(identity.document),
                  self.state.activate(identity) else { call.reject("NATIVE_CHROME_ACTIVATE_REFUSED"); return }
            hosting.view.isHidden = false
            hosting.view.isUserInteractionEnabled = true
            hosting.view.accessibilityElementsHidden = false
            call.resolve(self.payload(identity, phase: "active"))
        }
    }

    @objc func retire(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let identity = self.identity(call), self.state.retire(identity, targetRevision: call.getInt("targetRevision")) else {
                call.reject("NATIVE_CHROME_RETIRE_STALE"); return
            }
            self.removeHosting()
            // Acknowledged only after touch, accessibility and child containment
            // have actually been removed. No owned popup exists in this family.
            call.resolve(self.payload(identity, phase: "retired"))
        }
    }

    @objc func confirmChoice(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let privacy = HushhSessionPrivacyShield.shared.snapshot()
            let valid = self.identity(call).map {
                self.state.confirm($0, sequence: call.getInt("sequence") ?? -1, latestSequence: self.sequence,
                    allowed: self.canPresent && self.geometryIsCurrent && call.getInt("privacyGeneration") == privacy.generation)
            } ?? false
            call.resolve(["valid": valid])
        }
    }

    func layoutControls() {
        guard hosting != nil, !geometryIsCurrent else { return }
        invalidatePresentation()
    }
    private var geometryIsCurrent: Bool { bridge?.viewController?.view.bounds.size == viewport }
    private var backAdmitted: Bool {
        // Debug pilot only; release and iPad retain accepted controls until
        // their physical visual/accessibility acceptance has been recorded.
        #if DEBUG
        if #available(iOS 26.0, *) { return UIDevice.current.userInterfaceIdiom == .phone }
        #endif
        return false
    }
    private var canPresent: Bool {
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        return privacy.appIsActive && !privacy.shielded && !keyboardVisible
    }
    private func requestChoice() {
        guard canPresent, geometryIsCurrent, state.phase == "active", let identity = state.identity else { return }
        sequence += 1
        var event = payload(identity, phase: "active")
        event.removeValue(forKey: "phase")
        event["sequence"] = sequence
        event["privacyGeneration"] = HushhSessionPrivacyShield.shared.snapshot().generation
        notifyListeners("choiceRequested", data: event)
    }
    private func invalidatePresentation() {
        state.invalidate()
        removeHosting()
        notifyListeners("invalidated", data: [:])
    }
    private func removeHosting() {
        pendingLayout?.reject("NATIVE_CHROME_LAYOUT_RETIRED")
        pendingLayout = nil
        guard let hosting else { return }
        hosting.didLayout = nil
        hosting.view.isUserInteractionEnabled = false
        hosting.view.accessibilityElementsHidden = true
        hosting.willMove(toParent: nil)
        hosting.view.removeFromSuperview()
        hosting.removeFromParent()
        self.hosting = nil
    }
    private func identity(_ call: CAPPluginCall) -> HushhNativeChromeState.Identity? {
        guard call.getString("controlId") == "top-shell-back", let document = call.getString("documentId"),
              let owner = call.getString("ownerEpoch"), let revision = call.getInt("revision") else { return nil }
        return .init(document: document, ownerEpoch: owner, revision: revision)
    }
    private func viewport(_ call: CAPPluginCall) -> CGSize? {
        guard let value = call.getObject("viewport"), let width = value["width"] as? Double,
              let height = value["height"] as? Double, width.isFinite, height.isFinite,
              width > 0, height > 0 else { return nil }
        return CGSize(width: width, height: height)
    }
    private func frame(_ call: CAPPluginCall) -> CGRect? {
        guard let value = call.getObject("frame"), let x = value["x"] as? Double, let y = value["y"] as? Double,
              let width = value["width"] as? Double, let height = value["height"] as? Double,
              let viewport = viewport(call), [x, y, width, height].allSatisfy({ $0.isFinite }),
              width == 44, height == 44, x >= 0, y >= 0,
              x + width <= viewport.width, y + height <= viewport.height else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }
    private func payload(_ identity: HushhNativeChromeState.Identity, phase: String, frame: CGRect? = nil) -> [String: Any] {
        var result: [String: Any] = ["documentId": identity.document, "ownerEpoch": identity.ownerEpoch,
            "controlId": "top-shell-back", "revision": identity.revision, "phase": phase]
        if let frame { result["frame"] = ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height] }
        return result
    }
}
