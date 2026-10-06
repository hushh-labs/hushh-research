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
        let controlId: String
        init(document: String, ownerEpoch: String, revision: Int, controlId: String = "top-shell-back") {
            self.document = document
            self.ownerEpoch = ownerEpoch
            self.revision = revision
            self.controlId = controlId
        }
    }
    private(set) var identity: Identity?
    private(set) var phase = "retired"
    private var document: String?
    private var revision = -1
    private var retiredDocuments = Set<String>()
    private var confirmedSequence = 0
    private(set) var updateSequence = 0

    mutating func prepare(_ next: Identity) -> Bool {
        guard acceptRevision(next) else { return false }
        identity = next
        phase = "prepared"
        updateSequence = 0
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
    mutating func update(_ requested: Identity, sequence: Int) -> Bool {
        guard phase == "active", identity == requested, sequence > updateSequence,
              sequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return false }
        updateSequence = sequence
        return true
    }
    mutating func confirm(_ requested: Identity, sequence: Int, latestSequence: Int, allowed: Bool,
                          updateSequence requestedUpdate: Int = 0) -> Bool {
        guard allowed, phase == "active", identity == requested,
              requestedUpdate == updateSequence,
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
private struct NativeChromeButton: View {
    let label: String
    let controlId: String
    var value: String? = nil
    let symbol: String
    let theme: HushhNativeControlAppearance
    let action: () -> Void
    let layout: (CGSize) -> Void
    @ObservedObject var focus: ChromeFocusRequest
    @AccessibilityFocusState private var accessibilityFocused: Bool
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
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
        .accessibilityValue(value ?? "")
        .accessibilityIdentifier(controlId)
        .accessibilityFocused($accessibilityFocused)
        .onChange(of: focus.sequence) { _, _ in accessibilityFocused = true }
        .frame(width: 44, height: 44)
        .onGeometryChange(for: CGSize.self, of: { $0.size }, action: layout)
    }
}

/// Transient presentation intent, never a route or operation. The plugin
/// acknowledges assistive focus from UIKit's actual focused-element event.
private final class ChromeFocusRequest: ObservableObject {
    @Published var sequence = 0
}

/// Apple's segmented Picker, with no second selection store. React owns value.
/// The 44pt host is a reservation, not proof of each system segment's hit region.
/// Characterize large-control hit geometry on iPhone before family promotion.
@available(iOS 26.0, *)
struct NativeAgentSurfaceSelector: View {
    let selected: String
    let width: CGFloat
    let theme: HushhNativeControlAppearance
    let action: (String) -> Void
    let layout: (CGSize) -> Void
    var body: some View {
        Picker("Agent", selection: Binding(get: { selected }, set: action)) {
            Image(systemName: "cloud").tag("one")
                .accessibilityLabel("One, your cloud agent")
            Image(systemName: "laptopcomputer").tag("puppy")
                .accessibilityLabel("Puppy One, on your machine, with its own conversation")
        }
        .pickerStyle(.segmented)
        .controlSize(.large)
        .tint(Color(uiColor: theme.accent))
        .accessibilityIdentifier("chat-agent-surface")
        .frame(width: width, height: 44)
        .onGeometryChange(for: CGSize.self, of: { $0.size }, action: layout)
    }
}

/// Public app preference only. System is a preference, not resolved darkness.
@available(iOS 26.0, *)
struct NativeAppearanceSelector: View {
    let selected: String
    let width: CGFloat
    let theme: HushhNativeControlAppearance
    let action: (String) -> Void
    let layout: (CGSize) -> Void
    var body: some View {
        Picker("Appearance", selection: Binding(get: { selected }, set: action)) {
            Image(systemName: "sun.max").tag("light").accessibilityLabel("Light")
            Image(systemName: "moon").tag("dark").accessibilityLabel("Dark")
            Image(systemName: "desktopcomputer").tag("system").accessibilityLabel("System")
        }
        .pickerStyle(.segmented)
        .controlSize(.large)
        .tint(Color(uiColor: theme.accent))
        .accessibilityIdentifier("profile-appearance")
        .frame(width: width, height: 44)
        .onGeometryChange(for: CGSize.self, of: { $0.size }, action: layout)
    }
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

/// Validated immutable input is committed only with its accepted revision.
/// Rejected preparation must leave the active popup's configuration intact.
struct HushhChromeConfiguration {
    var options = [HushhChromeOption]()
    var dateBounds: ClosedRange<Date>?

    mutating func prepare(_ identity: HushhNativeChromeState.Identity, parsed: Self?, state: inout HushhNativeChromeState) -> Bool {
        guard let parsed, state.prepare(identity) else { return false }
        self = parsed
        return true
    }

    static func parse(kind: String, value: String?, options: [JSObject]?, minimum: String?, maximum: String?) -> Self? {
        var result = Self()
        if kind == "appearance" { return ["light", "dark", "system"].contains(value ?? "") ? result : nil }
        if kind == "accent" {
            guard ["blue", "gold"].contains(value ?? "") else { return nil }
            result.options = [.init(value: "blue", label: "iOS Blue", disabled: false), .init(value: "gold", label: "Molten Gold", disabled: false)]
            return result
        }
        if kind == "date" {
            guard let minimum = HushhNativeChromePresenter.parseDate(minimum),
                  let maximum = HushhNativeChromePresenter.parseDate(maximum), minimum <= maximum,
                  let value = HushhNativeChromePresenter.parseDate(value),
                  (minimum...maximum).contains(value) else { return nil }
            result.dateBounds = minimum...maximum
            return result
        }
        guard kind == "more" || kind == "selection" else { return result }
        guard let options, !options.isEmpty, options.count <= 32 else { return nil }
        var ids = Set<String>()
        for option in options {
            guard let value = option["value"] as? String, !value.isEmpty, value.count <= 64,
                  value.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0) || $0 == 45 || $0 == 95 }),
                  ids.insert(value).inserted, let label = option["label"] as? String,
                  !label.isEmpty, label.count <= 80 else { return nil }
            result.options.append(.init(value: value, label: label, disabled: option["disabled"] as? Bool ?? false))
        }
        guard kind == "more" || result.options.contains(where: { $0.value == value && !$0.disabled }) else { return nil }
        return result
    }
}

private final class ChromeSlot {
    var state = HushhNativeChromeState()
    var hosting: ChromeHostingController?
    var pendingLayout: CAPPluginCall?
    var pendingFocus: CAPPluginCall?
    var focus = ChromeFocusRequest()
    var focusPrivacyGeneration = -1
    var viewport = CGSize.zero
    var sequence = 0
    var choiceValue: String?
    var kind = "back"
    var label = ""
    var presentation: ChromePresentation?
    var configuration = HushhChromeConfiguration()
    var options: [HushhChromeOption] { configuration.options }
    var dateBounds: ClosedRange<Date>? { configuration.dateBounds }
    var presenter: HushhNativeChromePresenter?
}

private struct ChromePresentation: Equatable {
    let appearance: String
    let accentHex: String
    let foregroundHex: String
    let enabled: Bool
    let value: String?
    let expanded: Bool

    init?(_ call: CAPPluginCall) {
        guard let appearance = call.getString("appearance"), let accent = call.getString("accentHex"),
              let foreground = call.getString("foregroundHex"), let enabled = call.getBool("enabled"),
              HushhNativeControlAppearance(appearance: appearance, accentHex: accent, foregroundHex: foreground) != nil else { return nil }
        self.appearance = appearance
        accentHex = accent
        foregroundHex = foreground
        self.enabled = enabled
        value = call.getString("value")
        expanded = call.getBool("expanded") ?? false
    }
    var theme: HushhNativeControlAppearance {
        // Only validated snapshots can be constructed.
        HushhNativeControlAppearance(appearance: appearance, accentHex: accentHex, foregroundHex: foregroundHex)!
    }
}

@objc(HushhNativeChromePlugin)
final class HushhNativeChromePlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "HushhNativeChromePlugin"
    let jsName = "HushhNativeChrome"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCanvasAppearance", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retire", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmChoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restoreFocus", returnType: CAPPluginReturnPromise),
    ]
    private var slots = [String: ChromeSlot]()
    private var document: String?
    private var retiredDocuments = Set<String>()
    private var observers = [NSObjectProtocol]()
    private(set) var keyboardVisible = false
    private var keyboardHidePending = false
    // Reuse the existing monotonic document/retirement fence. A prior page's
    // delayed appearance must not repaint the current document.
    private var canvasState = HushhNativeChromeState()

    override func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            for name in [UIApplication.willResignActiveNotification,
                         HushhSessionPrivacyShield.presentationDidChange,
                         UIResponder.keyboardWillShowNotification, UIResponder.keyboardWillHideNotification,
                         UIResponder.keyboardDidHideNotification] {
                self.observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                    guard let self else { return }
                    if note.name == UIResponder.keyboardWillShowNotification {
                        self.keyboardVisible = true
                        self.keyboardHidePending = false
                    }
                    if note.name == UIResponder.keyboardWillHideNotification {
                        // WillHide still has an animating keyboard and stale web
                        // geometry. Keep the fence until UIKit's completion.
                        self.keyboardVisible = true
                        self.keyboardHidePending = true
                    }
                    if note.name == UIResponder.keyboardDidHideNotification {
                        guard self.keyboardHidePending else { return }
                        self.keyboardHidePending = false
                        self.keyboardVisible = false
                    }
                    // Synchronously remove every owned control beneath privacy/IME.
                    self.invalidatePresentation()
                })
            }
            self.observers.append(NotificationCenter.default.addObserver(forName: UIAccessibility.elementFocusedNotification,
                object: nil, queue: .main) { [weak self] note in
                    guard let element = note.userInfo?[UIAccessibility.focusedElementUserInfoKey] as? UIAccessibilityIdentification,
                          let controlId = element.accessibilityIdentifier,
                          let host = self?.slots[controlId]?.hosting?.view,
                          Self.focusedElement(element, belongsTo: host) else { return }
                    self?.completeFocus(controlId)
                })
        }
    }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    private static func focusedElement(_ element: Any, belongsTo host: UIView) -> Bool {
        var current: Any? = element
        // Only walk public UIKit containers; unknown SwiftUI accessibility
        // representations fail closed and preserve the web focus fallback.
        for _ in 0..<16 {
            if let view = current as? UIView { return view === host || view.isDescendant(of: host) }
            guard let accessible = current as? UIAccessibilityElement else { return false }
            current = accessible.accessibilityContainer
        }
        return false
    }

    @objc func getCapabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            var families = [String]()
            if self?.backAdmitted == true {
                families.append("back")
                if self?.chatControlsAdmitted == true { families += ["history", "agent-surface", "close", "more", "selection", "date", "appearance", "accent"] }
            }
            call.resolve(["contractVersion": HushhNativeControlAppearance.contractVersion,
                          "families": families, "canvasAppearance": true, "independentControls": true,
                          "inPlaceUpdates": true,
                          "focusReturn": true,
                          "rehearsalDiagnostics": self?.chatControlsAdmitted == true &&
                              ProcessInfo.processInfo.arguments.contains("--hushh-native-chrome-diagnostics")])
        }
    }

    /// App-authored canvas only, including pages without admitted navigation.
    /// Never restyle the window, alter WebView opacity or uncover privacy/maps.
    @objc func setCanvasAppearance(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let document = call.getString("documentId"),
                  !document.isEmpty, document.count <= 128,
                  let revision = call.getInt("revision"), revision >= 0,
                  revision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
                  let color = HushhNativeControlAppearance.color(call.getString("backgroundHex")),
                  color.cgColor.alpha == 1, let host = self.bridge?.viewController?.view,
                  let webView = self.bridge?.webView else {
                call.reject("NATIVE_CANVAS_INVALID_STATE"); return
            }
            let shield = HushhSessionPrivacyShield.shared
            shield.observeDocument(document)
            guard shield.acceptsDocument(document), !self.retiredDocuments.contains(document),
                  self.canvasState.prepare(.init(document: document, ownerEpoch: "app-canvas", revision: revision)) else {
                call.reject("NATIVE_CANVAS_STALE_STATE"); return
            }
            self.acceptDocument(document)
            // Capacitor's bridge root can be the WebView itself. In that case
            // respect the same transparency guard as its backing canvas.
            if host !== webView { host.backgroundColor = color }
            // Google Maps may own a transparent WebView. Preserve that mode;
            // the opaque page's backing and overscroll canvas follow CSS.
            if webView.isOpaque {
                webView.backgroundColor = color
                webView.scrollView.backgroundColor = color
                webView.underPageBackgroundColor = color
            }
            call.resolve(["documentId": document, "revision": revision])
        }
    }

    @objc func prepare(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard #available(iOS 26.0, *), UIDevice.current.userInterfaceIdiom == .phone,
                  let parent = self.bridge?.viewController, let identity = self.identity(call),
                  let kind = call.getString("kind"), self.admits(kind, controlId: identity.controlId),
                  call.getBool("enabled") == true,
                  let label = call.getString("label"), !label.isEmpty, label.count <= 80,
                  let theme = HushhNativeControlAppearance(appearance: call.getString("appearance"),
                    accentHex: call.getString("accentHex"), foregroundHex: call.getString("foregroundHex")),
                  let frame = self.frame(call, kind: kind), let bounds = self.viewport(call),
                  self.canPresent,
                  kind != "agent-surface" || ["one", "puppy"].contains(call.getString("value") ?? "") else {
                call.reject("NATIVE_CHROME_PREPARE_REFUSED"); return
            }
            let shield = HushhSessionPrivacyShield.shared
            shield.observeDocument(identity.document)
            guard shield.acceptsDocument(identity.document),
                  !self.retiredDocuments.contains(identity.document),
                  abs(parent.view.bounds.width - bounds.width) < 1,
                  abs(parent.view.bounds.height - bounds.height) < 1 else {
                call.reject("NATIVE_CHROME_DOCUMENT_OR_GEOMETRY_STALE"); return
            }
            self.acceptDocument(identity.document)
            guard !self.slots.contains(where: { id, slot in
                id != identity.controlId && slot.hosting?.view.frame.intersects(frame) == true
            }) else { call.reject("NATIVE_CHROME_OVERLAPPING_CONTROLS"); return }
            let slot = self.slot(identity.controlId)
            guard slot.presenter == nil, let configuration = self.readOptions(call, kind: kind) else {
                call.reject("NATIVE_CHROME_OPTIONS_INVALID"); return
            }
            guard slot.configuration.prepare(identity, parsed: configuration, state: &slot.state) else { call.reject("NATIVE_CHROME_PREPARE_REFUSED"); return }
            self.removeHosting(slot)
            slot.kind = kind
            slot.label = label
            slot.presentation = ChromePresentation(call)
            slot.focus = ChromeFocusRequest()
            slot.viewport = parent.view.bounds.size
            var swiftUILayout = false
            let layout: (CGSize) -> Void = { [weak slot] size in
                swiftUILayout = size == frame.size
                slot?.hosting?.view.setNeedsLayout()
            }
            let root: AnyView
            if kind == "agent-surface" {
                root = AnyView(NativeAgentSurfaceSelector(selected: call.getString("value") ?? "one", width: frame.width,
                    theme: theme, action: { [weak self] value in self?.requestChoice(identity.controlId, value: value) }, layout: layout))
            } else if kind == "appearance" {
                root = AnyView(NativeAppearanceSelector(selected: call.getString("value") ?? "system", width: frame.width,
                    theme: theme, action: { [weak self] value in self?.requestChoice(identity.controlId, value: value) }, layout: layout))
            } else {
                root = AnyView(NativeChromeButton(label: kind == "history" ? (call.getBool("expanded") == true ? "Close chat history" : "Open chat history") : label, controlId: identity.controlId,
                    value: kind == "accent" ? (call.getString("value") == "gold" ? "Molten Gold" : "iOS Blue") : nil,
                    symbol: self.symbol(kind, expanded: call.getBool("expanded") == true), theme: theme,
                    action: { [weak self] in self?.activateControl(identity.controlId) }, layout: layout, focus: slot.focus))
            }
            let controller = ChromeHostingController(rootView: root)
            slot.hosting = controller
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
            slot.pendingLayout = call
            controller.didLayout = { [weak self, weak slot, weak controller] in
                guard let self, let slot, let controller, slot.hosting === controller,
                      slot.state.identity == identity, let pending = slot.pendingLayout else { return }
                guard swiftUILayout, controller.view.bounds.size == frame.size, controller.view.superview != nil else { return }
                slot.pendingLayout = nil
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
            guard let identity = self.identity(call), let slot = self.slots[identity.controlId],
                  self.canPresent, self.geometryIsCurrent(slot), self.document == identity.document,
                  slot.pendingLayout == nil, let hosting = slot.hosting,
                  HushhSessionPrivacyShield.shared.acceptsDocument(identity.document),
                  slot.state.activate(identity) else { call.reject("NATIVE_CHROME_ACTIVATE_REFUSED"); return }
            hosting.view.isHidden = false
            hosting.view.isUserInteractionEnabled = true
            hosting.view.accessibilityElementsHidden = false
            call.resolve(self.payload(identity, phase: "active"))
        }
    }

    @objc func retire(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let identity = self.identity(call), !self.retiredDocuments.contains(identity.document),
                  HushhSessionPrivacyShield.shared.acceptsDocument(identity.document) else {
                call.reject("NATIVE_CHROME_RETIRE_STALE"); return
            }
            self.acceptDocument(identity.document)
            let slot = self.slot(identity.controlId)
            guard slot.state.retire(identity, targetRevision: call.getInt("targetRevision")) else {
                call.reject("NATIVE_CHROME_RETIRE_STALE"); return
            }
            self.removeHosting(slot)
            // Removing a trigger does not prove its popup disappeared.
            if let presenter = slot.presenter {
                presenter.retire { call.resolve(self.payload(identity, phase: "retired")) }
            } else { call.resolve(self.payload(identity, phase: "retired")) }
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let slot = self.slots[identity.controlId],
                  let sequence = call.getInt("updateSequence"), let presentation = ChromePresentation(call),
                  self.canPresent, self.geometryIsCurrent(slot), self.document == identity.document,
                  HushhSessionPrivacyShield.shared.acceptsDocument(identity.document),
                  slot.state.identity == identity, slot.state.phase == "active", let hosting = slot.hosting,
                  self.admittedValue(presentation.value, slot: slot, forUpdate: true) else {
                call.reject("NATIVE_CHROME_UPDATE_REFUSED"); return
            }
            // Duplicates acknowledge only the identical complete snapshot.
            if sequence == slot.state.updateSequence && slot.presentation == presentation {
                var ack = self.payload(identity, phase: "active")
                ack["updateSequence"] = sequence
                call.resolve(ack); return
            }
            guard slot.state.update(identity, sequence: sequence) else {
                call.reject("NATIVE_CHROME_UPDATE_STALE"); return
            }
            slot.presenter?.update(theme: presentation.theme, value: presentation.value, enabled: presentation.enabled, sequence: sequence)
            let root: AnyView
            if #available(iOS 26.0, *) {
                if slot.kind == "agent-surface" {
                    root = AnyView(NativeAgentSurfaceSelector(selected: presentation.value ?? "one", width: hosting.view.frame.width,
                        theme: presentation.theme, action: { [weak self] value in self?.requestChoice(identity.controlId, value: value) },
                        layout: { _ in }).disabled(!presentation.enabled))
                } else if slot.kind == "appearance" {
                    root = AnyView(NativeAppearanceSelector(selected: presentation.value ?? "system", width: hosting.view.frame.width,
                        theme: presentation.theme, action: { [weak self] value in self?.requestChoice(identity.controlId, value: value) },
                        layout: { _ in }).disabled(!presentation.enabled))
                } else {
                    root = AnyView(NativeChromeButton(label: slot.kind == "history" ? (presentation.expanded ? "Close chat history" : "Open chat history") : slot.label, controlId: identity.controlId,
                        value: slot.kind == "accent" ? (presentation.value == "gold" ? "Molten Gold" : "iOS Blue") : nil,
                        symbol: self.symbol(slot.kind, expanded: presentation.expanded), theme: presentation.theme,
                        action: { [weak self] in self?.activateControl(identity.controlId) }, layout: { _ in }, focus: slot.focus).disabled(!presentation.enabled))
                }
            } else { call.reject("NATIVE_CHROME_UPDATE_REFUSED"); return }
            slot.presentation = presentation
            slot.choiceValue = nil
            hosting.overrideUserInterfaceStyle = presentation.theme.style
            hosting.rootView = root
            hosting.view.isUserInteractionEnabled = presentation.enabled
            hosting.view.layoutIfNeeded()
            var ack = self.payload(identity, phase: "active")
            ack["updateSequence"] = sequence
            call.resolve(ack)
        }
    }

    @objc func restoreFocus(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let slot = self.slots[identity.controlId],
                  slot.kind != "agent-surface", self.canPresent, self.geometryIsCurrent(slot),
                  slot.state.identity == identity, slot.state.phase == "active",
                  slot.presentation?.enabled == true, slot.pendingFocus == nil,
                  let sequence = call.getInt("focusSequence"), sequence > slot.focus.sequence,
                  sequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
                  call.getInt("updateSequence") == slot.state.updateSequence,
                  HushhSessionPrivacyShield.shared.acceptsDocument(identity.document) else {
                call.reject("NATIVE_CHROME_FOCUS_REFUSED"); return
            }
            slot.pendingFocus = call
            slot.focusPrivacyGeneration = HushhSessionPrivacyShield.shared.snapshot().generation
            slot.focus.sequence = sequence
            // Without assistive navigation the admitted native control itself
            // is the return target. Never manufacture DOM keyboard focus.
            if !UIAccessibility.isVoiceOverRunning && !UIAccessibility.isSwitchControlRunning {
                self.completeFocus(identity.controlId)
            }
        }
    }

    private func completeFocus(_ controlId: String) {
        guard let slot = slots[controlId], let call = slot.pendingFocus else { return }
        guard let identity = identity(call), slot.state.identity == identity, slot.state.phase == "active",
              canPresent, geometryIsCurrent(slot), slot.presentation?.enabled == true,
              slot.focus.sequence == call.getInt("focusSequence"),
              slot.state.updateSequence == call.getInt("updateSequence"),
              HushhSessionPrivacyShield.shared.acceptsDocument(identity.document),
              HushhSessionPrivacyShield.shared.snapshot().generation == slot.focusPrivacyGeneration else {
            slot.pendingFocus = nil
            call.reject("NATIVE_CHROME_FOCUS_RETIRED"); return
        }
        slot.pendingFocus = nil
        var ack = payload(identity, phase: "active")
        ack["updateSequence"] = slot.state.updateSequence
        ack["focusSequence"] = slot.focus.sequence
        ack["restored"] = true
        call.resolve(ack)
    }

    @objc func confirmChoice(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let privacy = HushhSessionPrivacyShield.shared.snapshot()
            var valid = false
            if let identity = self.identity(call), let slot = self.slots[identity.controlId] {
                valid = slot.state.confirm(identity, sequence: call.getInt("sequence") ?? -1, latestSequence: slot.sequence,
                    allowed: self.canPresent && slot.presentation?.enabled == true && self.geometryIsCurrent(slot) && self.document == identity.document &&
                    HushhSessionPrivacyShield.shared.acceptsDocument(identity.document) &&
                    call.getString("value") == slot.choiceValue && call.getInt("privacyGeneration") == privacy.generation,
                    updateSequence: call.getInt("updateSequence") ?? 0)
            }
            call.resolve(["valid": valid])
        }
    }

    func layoutControls() {
        guard slots.values.contains(where: { $0.hosting != nil && !geometryIsCurrent($0) }) else { return }
        invalidatePresentation()
    }
    // Preserve the owning host's existing entrypoint while covering every slot.
    func layoutBackControl() { layoutControls() }
    private func geometryIsCurrent(_ slot: ChromeSlot) -> Bool { bridge?.viewController?.view.bounds.size == slot.viewport }
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
    private var chatControlsAdmitted: Bool {
        // Explicit Debug rehearsal opt-in; this is not promotion of an audited family.
        #if DEBUG
        return backAdmitted && ProcessInfo.processInfo.arguments.contains("--hushh-native-chat-chrome")
        #else
        return false
        #endif
    }
    private func admits(_ kind: String, controlId: String) -> Bool {
        if kind == "back" { return backAdmitted && controlId == "top-shell-back" }
        return chatControlsAdmitted && ((kind == "history" && controlId == "chat-history-toggle") ||
            (kind == "agent-surface" && controlId == "chat-agent-surface") ||
            (kind == "more" && controlId == "stationary-more") || (kind == "selection" && controlId == "bounded-selection") ||
            (kind == "date" && controlId == "bounded-date") || (kind == "close" && controlId == "profile-close") ||
            (kind == "appearance" && controlId == "profile-appearance") || (kind == "accent" && controlId == "profile-accent"))
    }
    private func slot(_ id: String) -> ChromeSlot {
        if let slot = slots[id] { return slot }
        let slot = ChromeSlot()
        slots[id] = slot
        return slot
    }
    private func symbol(_ kind: String, expanded: Bool) -> String {
        switch kind {
        case "back": return "chevron.backward"
        case "close": return "xmark"
        case "history": return expanded ? "xmark" : "line.3.horizontal"
        case "more": return "ellipsis"
        case "selection": return "chevron.up.chevron.down"
        case "date": return "calendar"
        case "accent": return "circle.lefthalf.filled"
        default: return "line.3.horizontal"
        }
    }
    private func readOptions(_ call: CAPPluginCall, kind: String) -> HushhChromeConfiguration? {
        HushhChromeConfiguration.parse(kind: kind, value: call.getString("value"),
            options: call.getArray("options", JSObject.self), minimum: call.getString("minimum"), maximum: call.getString("maximum"))
    }
    private func admittedValue(_ value: String?, slot: ChromeSlot, forUpdate: Bool) -> Bool {
        switch slot.kind {
        case "agent-surface": return ["one", "puppy"].contains(value ?? "")
        case "appearance": return ["light", "dark", "system"].contains(value ?? "")
        case "accent": return ["blue", "gold"].contains(value ?? "")
        case "more": return forUpdate ? value == nil : slot.options.contains { $0.value == value && !$0.disabled }
        case "selection": return slot.options.contains { $0.value == value && !$0.disabled }
        case "date":
            guard let date = HushhNativeChromePresenter.parseDate(value), let bounds = slot.dateBounds else { return false }
            return bounds.contains(date)
        default: return value == nil
        }
    }
    private func activateControl(_ controlId: String) {
        guard let slot = slots[controlId], let identity = slot.state.identity, let presentation = slot.presentation,
              slot.state.phase == "active", presentation.enabled, canPresent, geometryIsCurrent(slot) else { return }
        guard ["more", "selection", "date", "accent"].contains(slot.kind) else { requestChoice(controlId); return }
        guard slot.presenter == nil, let parent = bridge?.viewController, parent.presentedViewController == nil,
              let source = slot.hosting?.view else { return }
        let privacyGeneration = HushhSessionPrivacyShield.shared.snapshot().generation
        let choose: (String, Int) -> Void = { [weak self, weak slot] value, sequence in
            guard let self, let slot, slot.state.identity == identity, slot.state.updateSequence == sequence,
                  HushhSessionPrivacyShield.shared.snapshot().generation == privacyGeneration else { return }
            self.requestChoice(controlId, value: value)
        }
        let presenter: HushhNativeChromePresenter
        if slot.kind == "more" || slot.kind == "accent" {
            presenter = .menu(parent: parent, source: source, title: slot.label, options: slot.options, theme: presentation.theme, sequence: slot.state.updateSequence, onChoice: choose)
        } else if slot.kind == "selection", let value = presentation.value {
            presenter = .selection(parent: parent, title: slot.label, value: value, options: slot.options, theme: presentation.theme, sequence: slot.state.updateSequence, onChoice: choose)
        } else if let value = HushhNativeChromePresenter.parseDate(presentation.value), let bounds = slot.dateBounds {
            presenter = .date(parent: parent, title: slot.label, value: value, bounds: bounds, theme: presentation.theme, sequence: slot.state.updateSequence, onChoice: choose)
        } else { return }
        presenter.didRetire = { [weak slot, weak presenter] in
            if slot?.presenter === presenter { slot?.presenter = nil }
        }
        slot.presenter = presenter
        presenter.present()
    }
    private func acceptDocument(_ next: String) {
        guard document != next else { return }
        if let document {
            retiredDocuments.insert(document)
            invalidatePresentation()
            slots.removeAll()
        }
        document = next
    }
    private func requestChoice(_ controlId: String, value: String? = nil) {
        guard let slot = slots[controlId], slot.presentation?.enabled == true, canPresent, geometryIsCurrent(slot), slot.state.phase == "active",
              let identity = slot.state.identity, document == identity.document,
              HushhSessionPrivacyShield.shared.acceptsDocument(identity.document) else { return }
        guard admittedValue(value, slot: slot, forUpdate: false) else { return }
        slot.sequence += 1
        slot.choiceValue = value
        var event = payload(identity, phase: "active")
        event.removeValue(forKey: "phase")
        event["sequence"] = slot.sequence
        event["updateSequence"] = slot.state.updateSequence
        if let value { event["value"] = value }
        event["privacyGeneration"] = HushhSessionPrivacyShield.shared.snapshot().generation
        notifyListeners("choiceRequested", data: event)
    }
    private func invalidatePresentation() {
        for slot in slots.values {
            slot.state.invalidate()
            removeHosting(slot)
            slot.presenter?.retire {}
        }
        notifyListeners("invalidated", data: [:])
    }
    private func removeHosting(_ slot: ChromeSlot) {
        slot.pendingLayout?.reject("NATIVE_CHROME_LAYOUT_RETIRED")
        slot.pendingLayout = nil
        slot.pendingFocus?.reject("NATIVE_CHROME_FOCUS_RETIRED")
        slot.pendingFocus = nil
        slot.choiceValue = nil
        guard let hosting = slot.hosting else { return }
        hosting.didLayout = nil
        hosting.view.isUserInteractionEnabled = false
        hosting.view.accessibilityElementsHidden = true
        hosting.willMove(toParent: nil)
        hosting.view.removeFromSuperview()
        hosting.removeFromParent()
        slot.hosting = nil
    }
    private func identity(_ call: CAPPluginCall) -> HushhNativeChromeState.Identity? {
        guard let controlId = call.getString("controlId"),
              ["top-shell-back", "chat-history-toggle", "chat-agent-surface", "stationary-more", "bounded-selection", "bounded-date", "profile-close", "profile-appearance", "profile-accent"].contains(controlId),
              let document = call.getString("documentId"), !document.isEmpty, document.count <= 128,
              let owner = call.getString("ownerEpoch"), !owner.isEmpty, owner.count <= 128,
              let revision = call.getInt("revision"), revision >= 0,
              revision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else { return nil }
        return .init(document: document, ownerEpoch: owner, revision: revision, controlId: controlId)
    }
    private func viewport(_ call: CAPPluginCall) -> CGSize? {
        guard let value = call.getObject("viewport"), let width = value["width"] as? Double,
              let height = value["height"] as? Double, width.isFinite, height.isFinite,
              width > 0, height > 0 else { return nil }
        return CGSize(width: width, height: height)
    }
    private func frame(_ call: CAPPluginCall, kind: String) -> CGRect? {
        guard let value = call.getObject("frame"), let x = value["x"] as? Double, let y = value["y"] as? Double,
              let width = value["width"] as? Double, let height = value["height"] as? Double,
              let viewport = viewport(call), [x, y, width, height].allSatisfy({ $0.isFinite }),
              (kind == "appearance" ? width >= 132 && width <= 320 : kind == "agent-surface" ? width >= 88 && width <= 320 : width == 44),
              height == 44, x >= 0, y >= 0,
              x + width <= viewport.width, y + height <= viewport.height else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }
    private func payload(_ identity: HushhNativeChromeState.Identity, phase: String, frame: CGRect? = nil) -> [String: Any] {
        var result: [String: Any] = ["documentId": identity.document, "ownerEpoch": identity.ownerEpoch,
            "controlId": identity.controlId, "revision": identity.revision, "phase": phase]
        if let frame { result["frame"] = ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height] }
        return result
    }
}
