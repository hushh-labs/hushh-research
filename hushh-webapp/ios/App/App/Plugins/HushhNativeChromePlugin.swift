import Capacitor
import SwiftUI
import UIKit

/// Recovery default. The standard UITabBar and privacy shield are independent.
/// Legacy Debug flags are not qualification of a complete overlapping family.
enum HushhNativePresentationPolicy {
    static var customControlsEnabled: Bool { NativeDrawerQualificationPolicy.coherentShell }
}

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
    mutating func suspend(_ requested: Identity) -> Bool {
        guard identity == requested, ["active", "prepared", "suspended"].contains(phase) else { return false }
        phase = "suspended"
        return true
    }
    mutating func prepareBackReplacement(_ next: Identity, previousRevision: Int) -> Bool {
        guard ["top-shell-back", "profile-back"].contains(next.controlId) else { return false }
        return prepareReplacement(next, previousRevision: previousRevision, controlId: next.controlId)
    }
    mutating func prepareHistoryReplacement(_ next: Identity, previousRevision: Int) -> Bool {
        prepareReplacement(next, previousRevision: previousRevision, controlId: "chat-history-toggle")
    }
    private mutating func prepareReplacement(_ next: Identity, previousRevision: Int, controlId: String) -> Bool {
        guard phase == "active", let previous = identity,
              previous.controlId == controlId, next.controlId == previous.controlId,
              previous.revision == previousRevision, previous.document == next.document,
              previous.ownerEpoch == next.ownerEpoch else { return false }
        return prepare(next)
    }
    mutating func retire(_ requested: Identity, targetRevision: Int? = nil) -> Bool {
        if let targetRevision, let identity, targetRevision != identity.revision { return false }
        guard acceptRevision(requested) else { return false }
        identity = nil
        phase = "retired"
        return true
    }
    mutating func invalidate() { identity = nil; phase = "retired" }
    mutating func invalidateChoices(through sequence: Int) { confirmedSequence = max(confirmedSequence, sequence) }
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
struct NativeChromeButton: View {
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
                // The symbol and empty label area invoke the same Button.
                // Stay inside its reserved host; never add a second tap handler.
                .contentShape(.interaction, Rectangle())
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

@available(iOS 26.0, *)
private struct NativeAccentTrigger: View {
    let selected: String
    let width: CGFloat
    let theme: HushhNativeControlAppearance
    let action: () -> Void
    let layout: (CGSize) -> Void
    @ObservedObject var focus: ChromeFocusRequest
    @AccessibilityFocusState private var accessibilityFocused: Bool
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Circle().fill(Color(uiColor: theme.accent)).frame(width: 12, height: 12).accessibilityHidden(true)
                Text(selected == "gold" ? "Molten Gold" : "Blue").lineLimit(1)
                Spacer(minLength: 0)
                Image(systemName: "chevron.down").font(.caption).accessibilityHidden(true)
            }.padding(.horizontal, 12).frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Rectangle())
        }
        .buttonStyle(.glass).tint(Color(uiColor: theme.accent))
        .foregroundStyle(Color(uiColor: theme.foreground))
        .accessibilityLabel("App accent color").accessibilityValue(selected == "gold" ? "Molten Gold" : "Blue")
        .accessibilityIdentifier("profile-accent")
        .accessibilityFocused($accessibilityFocused)
        .onChange(of: focus.sequence) { _, _ in accessibilityFocused = true }
        .frame(width: width, height: 44)
        .onGeometryChange(for: CGSize.self, of: { $0.size }, action: layout)
    }
}

/// Transient presentation intent, never a route or operation. The plugin
/// acknowledges assistive focus from UIKit's actual focused-element event.
final class ChromeFocusRequest: ObservableObject {
    @Published var sequence = 0
}

/// One renderer for bounded radio choices; route/swipe tabs keep their pager.
/// All values/actions are projected from the existing React operation owner.
@available(iOS 26.0, *)
private struct NativeFiniteSegmentedPicker: View {
    struct Option: Identifiable {
        let id: String
        let symbol: String
        let label: String
    }
    let label: String
    let identifier: String
    let options: [Option]
    let selected: String
    let width: CGFloat
    let theme: HushhNativeControlAppearance
    let action: (String) -> Void
    let layout: (CGSize) -> Void
    var body: some View {
        Picker(label, selection: Binding(get: { selected }, set: { value in
            guard value != selected, options.contains(where: { $0.id == value }) else { return }
            action(value)
        })) {
            ForEach(options) { option in
                Image(systemName: option.symbol).tag(option.id).accessibilityLabel(option.label)
            }
        }
        .pickerStyle(.segmented)
        .controlSize(.large)
        .tint(Color(uiColor: theme.accent))
        .accessibilityIdentifier(identifier)
        .frame(width: width, height: 44)
        .onGeometryChange(for: CGSize.self, of: { $0.size }, action: layout)
    }
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
        NativeFiniteSegmentedPicker(label: "Agent", identifier: "chat-agent-surface", options: [
            .init(id: "one", symbol: "cloud", label: "One, your cloud agent"),
            .init(id: "puppy", symbol: "laptopcomputer", label: "Puppy One, on your machine, with its own conversation")
        ], selected: selected, width: width, theme: theme, action: action, layout: layout)
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
    var swatches = [String: UIColor]()
    func matches(_ other: Self) -> Bool {
        options.count == other.options.count && zip(options, other.options).allSatisfy { pair in
            pair.0.value == pair.1.value && pair.0.label == pair.1.label && pair.0.disabled == pair.1.disabled
        } && dateBounds == other.dateBounds && swatches == other.swatches
    }

    mutating func prepare(_ identity: HushhNativeChromeState.Identity, parsed: Self?, state: inout HushhNativeChromeState) -> Bool {
        guard let parsed, state.prepare(identity) else { return false }
        self = parsed
        return true
    }

    static func parse(kind: String, value: String?, options: [JSObject]?, minimum: String?, maximum: String?, palette: JSObject? = nil) -> Self? {
        var result = Self()
        if kind == "appearance" { return ["light", "dark", "system"].contains(value ?? "") ? result : nil }
        if kind == "accent" {
            guard ["blue", "gold"].contains(value ?? "") else { return nil }
            result.options = [.init(value: "blue", label: "iOS Blue", disabled: false), .init(value: "gold", label: "Molten Gold", disabled: false)]
            if let palette {
                guard Set(palette.keys) == Set(["blue", "gold"]),
                      let blue = HushhNativeControlAppearance.color(palette["blue"] as? String),
                      let gold = HushhNativeControlAppearance.color(palette["gold"] as? String) else { return nil }
                result.swatches = ["blue": blue, "gold": gold]
            }
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
    var controlId = ""
    var group: String?
    var groupGeneration: Int?
    var authoredFrame = CGRect.zero
    var layoutConfirmed = false
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
    var fullAccentTrigger = false
    var presentation: ChromePresentation?
    var configuration = HushhChromeConfiguration()
    var options: [HushhChromeOption] { configuration.options }
    var dateBounds: ClosedRange<Date>? { configuration.dateBounds }
    var presenter: HushhNativeChromePresenter?
    var presentationRegionRevision: Int?
    var privacyGeneration: Int?
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
        CAPPluginMethod(name: "setPresentationRegions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCanvasAppearance", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareBackReplacement", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareHistoryReplacement", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "activate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retire", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "suspend", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmChoice", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restoreFocus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyPanelPose", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retirePanel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "interactionFeedback", returnType: CAPPluginReturnPromise),
    ]
    private var slots = [String: ChromeSlot]()
    private var document: String?
    private var retiredDocuments = Set<String>()
    private var observers = [NSObjectProtocol]()
    private(set) var keyboardVisible = false
    private var keyboardHidePending = false
    private var interactionGeneration = 0
    #if DEBUG
    private(set) var presentationInvalidations = 0
    #endif
    // Reuse the existing monotonic document/retirement fence. A prior page's
    // delayed appearance must not repaint the current document.
    private var canvasState = HushhNativeChromeState()
    private var compositor: NativePresentationContainer? { bridge?.viewController?.view as? NativePresentationContainer }
    #if DEBUG
    private var backContinuity: NativeBackContinuityProbe?
    private var historyContinuity: NativeBackContinuityProbe?
    private var profileBackContinuity: NativeBackContinuityProbe?
    private var profileBackAdmission: NativeTestStatusLabel?
    private var profileBackAdmissionTimer: Timer?
    private var profileBackAdmissionInFlight = false
    private var historyChoiceStage = "none"
    #endif

    override func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            #if DEBUG
            if self.backAdmitted, ProcessInfo.processInfo.arguments.contains("--hushh-native-chrome-diagnostics"),
               let host = self.bridge?.viewController?.view {
                self.backContinuity = NativeBackContinuityProbe(host: host)
                if self.chatControlsAdmitted {
                    self.historyContinuity = NativeBackContinuityProbe(host: host, identifier: "native-history-continuity")
                    self.profileBackContinuity = NativeBackContinuityProbe(host: host, identifier: "native-profile-back-continuity")
                    let admission = NativeTestStatusLabel(frame: .zero, showOverlay: false)
                    admission.accessibilityIdentifier = "native-profile-back-admission"
                    admission.translatesAutoresizingMaskIntoConstraints = false
                    host.addSubview(admission)
                    NSLayoutConstraint.activate([
                        admission.leadingAnchor.constraint(equalTo: host.leadingAnchor),
                        admission.topAnchor.constraint(equalTo: host.safeAreaLayoutGuide.topAnchor),
                        admission.widthAnchor.constraint(equalToConstant: 1), admission.heightAnchor.constraint(equalToConstant: 1),
                    ])
                    self.profileBackAdmission = admission
                    self.profileBackAdmissionTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                        self?.sampleProfileBackAdmission()
                    }
                }
            }
            #endif
            for name in [UIApplication.willResignActiveNotification,
                         HushhSessionPrivacyShield.presentationDidChange,
                         UIResponder.keyboardWillShowNotification, UIResponder.keyboardWillHideNotification,
                         UIResponder.keyboardDidHideNotification, NativePresentationContainer.isolationDidChange] {
                self.observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                    guard let self else { return }
                    if note.name == NativePresentationContainer.isolationDidChange {
                        guard note.object as? NativePresentationContainer === self.compositor else { return }
                        self.interactionGeneration += 1
                        for slot in self.slots.values { slot.state.invalidateChoices(through: slot.sequence) }
                        // Retain hosts/materials. Isolation only withdraws choices.
                        if self.compositor?.interactionIsolated == false {
                            self.notifyListeners("readmissionRequested", data: [:], retainUntilConsumed: false)
                        }
                        return
                    }
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
                    if note.name == UIApplication.willResignActiveNotification ||
                        note.name == HushhSessionPrivacyShield.presentationDidChange {
                        self.invalidatePresentation(conceal: true)
                    } else {
                        // Keyboard movement changes action eligibility, not
                        // ownership or material identity. Keep every host.
                        self.interactionGeneration += 1
                        self.reconcileKeyboardInteraction()
                    }
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

    #if DEBUG
    /// Read only the authored diagnostic/slot, including while a native menu
    /// legitimately excludes WK from AX. No DOM body, identity, draft or URL.
    private func sampleProfileBackAdmission() {
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        profileBackAdmission?.accessibilityElementsHidden = !privacy.appIsActive || privacy.shielded
        guard privacy.appIsActive, !privacy.shielded, !profileBackAdmissionInFlight, let web = bridge?.webView else { return }
        profileBackAdmissionInFlight = true
        web.evaluateJavaScript("""
        (() => {
          const slot = document.querySelector('[data-native-chrome-slot="profile-back"]');
          const status = document.getElementById('native-control-status-profile-back');
          let state = {};
          try { if (status?.textContent.startsWith('NATIVE_SELECTOR_STATUS ')) state = JSON.parse(status.textContent.slice(23)); } catch (_) {}
          const rect = slot?.getBoundingClientRect();
          const historySlot = document.querySelector('[data-native-chrome-slot="chat-history-toggle"]');
          const historyStatus = document.getElementById('native-control-status-chat-history-toggle');
          let history = {};
          try { if (historyStatus?.textContent.startsWith('NATIVE_SELECTOR_STATUS ')) history = JSON.parse(historyStatus.textContent.slice(23)); } catch (_) {}
          return JSON.stringify({stage: state.stage, outcome: state.outcome, code: state.code,
            present: !!slot, focused: !!slot?.contains(document.activeElement), inert: !!slot?.closest('[inert]'),
            width: rect?.width ?? 0, height: rect?.height ?? 0, top: rect?.top ?? 0,
            historyStage: history.stage, historyOutcome: history.outcome, historyCode: history.code, historyChoice: history.choice,
            historyAllowed: history.allowed === true, historyPresent: !!historySlot, historyInert: !!historySlot?.closest('[inert]')});
        })()
        """) { [weak self] result, _ in
            guard let self else { return }
            self.profileBackAdmissionInFlight = false
            guard let raw = result as? String, raw.utf8.count <= 1024,
                  let bytes = raw.data(using: .utf8), let packet = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return }
            let current = HushhSessionPrivacyShield.shared.snapshot()
            guard current.appIsActive, !current.shielded, current.generation == privacy.generation else { return }
            func choice(_ key: String, _ allowed: [String]) -> String {
                guard let value = packet[key] as? String, allowed.contains(value) else { return "none" }
                return value
            }
            func dimension(_ key: String) -> Int {
                guard let value = packet[key] as? Double, value.isFinite, abs(value) <= 10_000 else { return 0 }
                return Int(value.rounded())
            }
            let stage = choice("stage", ["skip", "retire", "prepare", "activate", "update"])
            let outcome = choice("outcome", ["pending", "acknowledged", "rejected"])
            let code = choice("code", ["none", "other", "not-admitted", "focused", "geometry", "NATIVE_CHROME_ACK_UNCERTAIN",
                "NATIVE_CHROME_PREPARE_REFUSED", "NATIVE_CHROME_DOCUMENT_OR_GEOMETRY_STALE", "NATIVE_CHROME_OVERLAPPING_CONTROLS",
                "NATIVE_CHROME_OPTIONS_INVALID", "NATIVE_CHROME_LAYOUT_UNCONFIRMED", "NATIVE_CHROME_LAYOUT_RETIRED",
                "NATIVE_CHROME_ACTIVATE_REFUSED", "NATIVE_CHROME_ACTIVATE_UNCONFIRMED", "NATIVE_CHROME_RETIRE_UNCONFIRMED",
                "NATIVE_CHROME_UPDATE_INVALID", "NATIVE_CHROME_UPDATE_UNCONFIRMED"])
            let historyStage = choice("historyStage", ["skip", "retire", "prepare", "activate", "update"])
            let historyOutcome = choice("historyOutcome", ["pending", "acknowledged", "rejected"])
            let historyCode = choice("historyCode", ["none", "other", "NATIVE_CHROME_ACK_UNCERTAIN", "NATIVE_CHROME_RETIRE_STALE", "NATIVE_CHROME_RETIRE_UNCONFIRMED", "NATIVE_CHROME_SUSPEND_REFUSED", "NATIVE_CHROME_SUSPEND_UNCONFIRMED"])
            let historyChoice = choice("historyChoice", ["applied", "inactive", "disabled", "not-allowed", "update-pending", "identity-stale",
                "sequence-stale", "value-refused", "confirmation-refused", "isolation-changed", "uncertain"])
            self.profileBackAdmission?.update(status: "stage=\(stage);outcome=\(outcome);code=\(code);present=\(packet["present"] as? Bool == true);focused=\(packet["focused"] as? Bool == true);inert=\(packet["inert"] as? Bool == true);width=\(dimension("width"));height=\(dimension("height"));top=\(dimension("top"));historyStage=\(historyStage);historyOutcome=\(historyOutcome);historyCode=\(historyCode);historyChoice=\(historyChoice);historyAllowed=\(packet["historyAllowed"] as? Bool == true);historyPresent=\(packet["historyPresent"] as? Bool == true);historyInert=\(packet["historyInert"] as? Bool == true);historyNative=\(self.historyChoiceStage)")
        }
    }
    #endif
    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        #if DEBUG
        profileBackAdmissionTimer?.invalidate()
        profileBackAdmission?.removeFromSuperview()
        #endif
    }

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
            let contentBacked = self?.compositor?.contentBackedPresentation == true
            var families = contentBacked ? [String]() : HushhNativePreferencePresentation.families

            let legacyRegions = self?.compositor?.legacyRegionPresentation == true
            if contentBacked {
                if self?.backAdmitted == true { families.append("back") }
                if self?.chatControlsAdmitted == true { families += Self.stationaryChatControlIds.keys.sorted() }
                if self?.chatControlsAdmitted == true, self?.compositor?.wholeNativeDrawers == true { families.append("profile-back") }
            } else if self?.backAdmitted == true {
                families.append("back")
                if self?.chatControlsAdmitted == true { families += ["history", "agent-surface", "close", "profile-back", "more", "selection", "date"] }
            }
            if !contentBacked, self?.compositor != nil, self?.chatControlsAdmitted == true { families.append("history-close") }
            call.resolve(["contractVersion": HushhNativeControlAppearance.contractVersion,
                          "families": families, "canvasAppearance": true, "independentControls": true,
                          "inPlaceUpdates": true,
                          "panelPresentation": self?.compositor != nil && !contentBacked,
                          "contentBackedPresentation": contentBacked,
                          "coherentPresentation": self?.compositor?.wholeNativeDrawers == true && NativeDrawerQualificationPolicy.coherentShell,
                          "reservedPresentationRegions": legacyRegions,
                          "fullWindowOverlays": legacyRegions,
                          "drawerClipping": self?.compositor?.drawerClipping == true,
                          "atomicDrawerCoverage": self?.compositor?.drawerClipping == true,
                          "interactionFeedback": true,
                          "fullAccentTrigger": !contentBacked && self?.chatControlsAdmitted == true,
                          "retainedControls": self?.chatControlsAdmitted == true,
                          "backReplacement": self?.backAdmitted == true,
                          "profileBackReplacement": !contentBacked && self?.chatControlsAdmitted == true,
                          "historyReplacement": self?.chatControlsAdmitted == true,
                          "focusReturn": true,
                          "rehearsalDiagnostics": self?.chatControlsAdmitted == true &&
                              ProcessInfo.processInfo.arguments.contains("--hushh-native-chrome-diagnostics")])
        }
    }

    @objc func setPresentationRegions(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let compositor = self.compositor, compositor.contentBackedPresentation,
                  let document = call.getString("documentId"), !document.isEmpty, document.count <= 128,
                  let revision = call.getInt("revision"), revision >= 0,
                  revision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
                  let viewport = self.viewport(call), let top = call.getDouble("top"), let bottom = call.getDouble("bottom"),
                  let isolated = call.getBool("isolated") else { call.reject("NATIVE_REGIONS_INVALID"); return }
            let shield = HushhSessionPrivacyShield.shared
            shield.observeDocument(document)
            guard shield.acceptsDocument(document), !self.retiredDocuments.contains(document) else {
                call.reject("NATIVE_REGIONS_STALE"); return
            }
            self.acceptDocument(document)
            let covered = call.getBool("covered") ?? false
            let drawer = call.getString("drawer")
            let privacyGeneration = call.getInt("privacyGeneration")
            guard privacyGeneration == nil || privacyGeneration == shield.snapshot().generation else {
                call.reject("NATIVE_REGIONS_PRIVACY_STALE"); return
            }
            var initialPose: NativePanelPose?
            if let initial = call.getObject("initialDrawerPose") {
                guard compositor.drawerClipping, let drawer,
                      initial["documentId"] as? String == document,
                      initial["group"] as? String == drawer,
                      let owner = initial["ownerEpoch"] as? String, !owner.isEmpty, owner.count <= 128,
                      let generation = initial["generation"] as? Int, generation >= 0,
                      generation < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
                      let sequence = initial["sequence"] as? Int, sequence > 0,
                      sequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
                      let privacy = initial["privacyGeneration"] as? Int, privacy == privacyGeneration,
                      let frame = initial["frame"] as? JSObject,
                      let x = frame["x"] as? Double, let y = frame["y"] as? Double,
                      let width = frame["width"] as? Double, let height = frame["height"] as? Double,
                      let offset = initial["offset"] as? Double, let opacity = initial["opacity"] as? Double,
                      let settled = initial["settled"] as? Bool else {
                    call.reject("NATIVE_REGIONS_INITIAL_POSE_INVALID"); return
                }
                initialPose = NativePanelPose(document: document, ownerEpoch: owner, generation: generation,
                    sequence: sequence, privacyGeneration: privacy,
                    frame: CGRect(x: x, y: y, width: width, height: height),
                    offset: offset, opacity: opacity, settled: settled)
            }
            guard compositor.setRegions(document: document, revision: revision, viewport: viewport,
                top: CGFloat(top), bottom: CGFloat(bottom), isolated: isolated, covered: covered,
                privacyGeneration: privacyGeneration, drawer: drawer, initialPose: initialPose) else { call.reject("NATIVE_REGIONS_STALE"); return }
            var receipt: [String: Any] = ["documentId": document, "revision": revision, "top": top, "bottom": bottom,
                "isolated": isolated, "viewport": ["width": Double(viewport.width), "height": Double(viewport.height)]]
            if call.getBool("covered") != nil { receipt["covered"] = covered }
            if let privacyGeneration { receipt["privacyGeneration"] = privacyGeneration }
            if let drawer { receipt["drawer"] = drawer }
            if let initialPose {
                // Request binding is echoed below; distinguish actually applied
                // initial geometry from a newer same-owner pose retained by the
                // ordered region commit.
                receipt["initialDrawerPoseApplied"] = compositor.groupPose(drawer!) == initialPose
                receipt["initialDrawerPose"] = ["documentId": initialPose.document, "ownerEpoch": initialPose.ownerEpoch,
                    "group": drawer!, "generation": initialPose.generation, "sequence": initialPose.sequence,
                    "privacyGeneration": initialPose.privacyGeneration,
                    "frame": ["x": Double(initialPose.frame.minX), "y": Double(initialPose.frame.minY),
                        "width": Double(initialPose.frame.width), "height": Double(initialPose.frame.height)],
                    "offset": Double(initialPose.offset), "opacity": Double(initialPose.opacity), "settled": initialPose.settled]
            }
            call.resolve(receipt)
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
            let appearance: UIUserInterfaceStyle?
            if self.compositor?.contentBackedPresentation == true {
                guard let value = call.getString("appearance"), ["light", "dark"].contains(value) else {
                    call.reject("NATIVE_CANVAS_INVALID_STATE"); return
                }
                appearance = value == "dark" ? .dark : .light
            } else { appearance = nil }
            shield.observeDocument(document)
            guard shield.acceptsDocument(document), !self.retiredDocuments.contains(document),
                  self.canvasState.prepare(.init(document: document, ownerEpoch: "app-canvas", revision: revision)) else {
                call.reject("NATIVE_CANVAS_STALE_STATE"); return
            }
            self.acceptDocument(document)
            // Capacitor's bridge root can be the WebView itself. In that case
            // respect the same transparency guard as its backing canvas.
            if let compositor = self.compositor { compositor.setCanvas(color, appearance: appearance) }
            else if host !== webView { host.backgroundColor = color }
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

    /// Preferences use the same renderer for preparation and in-place updates.
    /// Navigation and chat keep their existing admission and availability gates.
    private func controlRoot(kind: String, controlId: String, label: String, width: CGFloat,
                             presentation: ChromePresentation, focus: ChromeFocusRequest,
                             layout: @escaping (CGSize) -> Void) -> AnyView? {
        let theme = presentation.theme
        if let preference = HushhNativePreferencePresentation.control(
            kind: kind, value: presentation.value, width: width, theme: theme, focus: focus,
            select: { [weak self] value in self?.requestChoice(controlId, value: value) },
            open: { [weak self] in self?.activateControl(controlId) }, layout: layout
        ) { return AnyView(preference.disabled(!presentation.enabled)) }
        guard #available(iOS 26.0, *) else { return nil }
        if kind == "agent-surface" {
            return AnyView(NativeAgentSurfaceSelector(selected: presentation.value ?? "one", width: width,
                theme: theme, action: { [weak self] value in self?.requestChoice(controlId, value: value) },
                layout: layout).disabled(!presentation.enabled))
        }
        return AnyView(NativeChromeButton(
            label: kind == "history" ? (presentation.expanded ? "Close chat history" : "Open chat history") : label,
            controlId: controlId,
            value: kind == "accent" ? (presentation.value == "gold" ? "Molten Gold" : "iOS Blue") : nil,
            symbol: symbol(kind, expanded: presentation.expanded), theme: theme,
            action: { [weak self] in self?.activateControl(controlId) }, layout: layout,
            focus: focus).disabled(!presentation.enabled))
    }

    @objc func prepare(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let parent = self.bridge?.viewController, let identity = self.identity(call),
                  let kind = call.getString("kind"), self.admits(kind, controlId: identity.controlId),
                  self.compositor?.contentBackedPresentation != true ||
                    (call.getString("presentationGroup") == nil && call.getBool("expanded") != true),
                  call.getBool("enabled") == true,
                  let label = call.getString("label"), !label.isEmpty, label.count <= 80,
                  let presentation = ChromePresentation(call),
                  let frame = self.frame(call, kind: kind), let bounds = self.presentationViewport(call),
                  self.compositor?.contentBackedPresentation != true ||
                    self.compositor?.containsStationaryControl(frame, document: identity.document) == true,
                  self.canMirrorPresentation,
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
            let group = call.getString("presentationGroup")
            let groupPose = group.flatMap { self.compositor?.groupPose($0) }
            if let group {
                guard ["profile", "history"].contains(group), let groupPose,
                      groupPose.document == identity.document,
                      groupPose.ownerEpoch == call.getString("presentationOwnerEpoch"),
                      groupPose.generation == call.getInt("presentationGeneration") else {
                    call.reject("NATIVE_CHROME_PANEL_STALE"); return
                }
            }
            let localFrame = groupPose.map { frame.offsetBy(dx: -$0.frame.minX, dy: -$0.frame.minY) } ?? frame
            guard !self.slots.contains(where: { id, slot in
                id != identity.controlId && slot.state.phase == "active" && slot.group == group && slot.authoredFrame.intersects(frame)
            }) else { call.reject("NATIVE_CHROME_OVERLAPPING_CONTROLS"); return }
            let slot = self.slot(identity.controlId)
            guard slot.presenter == nil, let configuration = self.readOptions(call, kind: kind) else {
                call.reject("NATIVE_CHROME_OPTIONS_INVALID"); return
            }
            guard kind != "accent" || call.getBool("fullTrigger") != true || configuration.swatches.count == 2 else {
                call.reject("NATIVE_CHROME_OPTIONS_INVALID"); return
            }
            let previous = slot.state.identity
            let retained = slot.layoutConfirmed && slot.state.phase == "suspended" && previous?.document == identity.document &&
                previous?.ownerEpoch == identity.ownerEpoch && slot.kind == kind && slot.label == label &&
                slot.fullAccentTrigger == (kind == "accent" && call.getBool("fullTrigger") == true) &&
                slot.authoredFrame == frame && slot.group == group && slot.viewport == bounds && slot.configuration.matches(configuration)
            // Reopening grants fresh authority, not a fresh SwiftUI tree.
            // Button callbacks resolve the current slot; no old lease is kept.
            let retainRoot = retained && slot.presentation == presentation && slot.focus.sequence == 0
            guard slot.configuration.prepare(identity, parsed: configuration, state: &slot.state) else { call.reject("NATIVE_CHROME_PREPARE_REFUSED"); return }
            if !retained { self.removeHosting(slot) }
            slot.kind = kind
            slot.group = group
            slot.groupGeneration = groupPose?.generation
            slot.authoredFrame = frame
            slot.label = label
            slot.fullAccentTrigger = kind == "accent" && call.getBool("fullTrigger") == true
            slot.presentation = presentation
            if !retainRoot { slot.focus = ChromeFocusRequest() }
            slot.viewport = parent.view.bounds.size
            var swiftUILayout = retained
            let layout: (CGSize) -> Void = { [weak slot] size in
                swiftUILayout = size == frame.size
                slot?.hosting?.view.setNeedsLayout()
            }
            guard let root = self.controlRoot(kind: kind, controlId: identity.controlId, label: label,
                width: frame.width, presentation: presentation, focus: slot.focus, layout: layout) else {
                call.reject("NATIVE_CHROME_PREPARE_REFUSED"); return
            }
            let controller = retained ? slot.hosting! : ChromeHostingController(rootView: root)
            if retained && !retainRoot { controller.rootView = root }
            slot.hosting = controller
            controller.overrideUserInterfaceStyle = presentation.theme.style
            controller.view.backgroundColor = .clear
            controller.view.isHidden = !retained
            controller.view.isUserInteractionEnabled = false
            controller.view.accessibilityElementsHidden = true
            // The web shell has already applied safe-area clearance. SwiftUI
            // must not apply a second inherited inset to this 44pt slot.
            controller.safeAreaRegions = []
            if !retained {
                parent.addChild(controller)
                if let compositor = self.compositor {
                    compositor.install(controller.view, id: identity.controlId, group: group)
                } else if let cover = parent.view.subviews.first(where: { $0.accessibilityIdentifier == HushhSessionPrivacyShield.accessibilityIdentifier }) {
                    parent.view.insertSubview(controller.view, belowSubview: cover)
                } else { parent.view.addSubview(controller.view) }
            }
            controller.view.frame = localFrame
            if !retained { controller.didMove(toParent: parent) }
            #if DEBUG
            if !retained {
                if kind == "back" { self.backContinuity?.installed(controller.view) }
                if kind == "history" { self.historyContinuity?.installed(controller.view) }
                if kind == "profile-back" { self.profileBackContinuity?.installed(controller.view) }
            } else {
                if kind == "back" { self.backContinuity?.replaced(controller.view, rootUpdated: !retainRoot) }
                if kind == "history" { self.historyContinuity?.replaced(controller.view, rootUpdated: !retainRoot) }
                if kind == "profile-back" { self.profileBackContinuity?.replaced(controller.view, rootUpdated: !retainRoot) }
            }
            #endif
            slot.pendingLayout = call
            controller.didLayout = { [weak self, weak slot, weak controller] in
                guard let self, let slot, let controller, slot.hosting === controller,
                      slot.state.identity == identity, let pending = slot.pendingLayout else { return }
                guard swiftUILayout, controller.view.bounds.size == frame.size, controller.view.superview != nil else { return }
                slot.pendingLayout = nil
                slot.layoutConfirmed = true
                controller.didLayout = nil
                pending.resolve(self.payload(identity, phase: "prepared", frame: frame))
            }
            controller.view.setNeedsLayout()
            controller.view.layoutIfNeeded()
        }
    }

    /// Route meaning may change while the public Back frame remains identical.
    /// Reuse its host, not its authority. The prepared view remains visible but
    /// noninteractive and accessibility-hidden until fresh activation. Normal
    /// retire acknowledgements continue to prove physical removal.
    @objc func prepareBackReplacement(_ call: CAPPluginCall) {
        // Additive v2 capability; an ordinary Back lease never becomes Profile
        // Back. Keep each family's own slot, owner and fresh action revision.
        if call.getString("kind") == "profile-back" {
            prepareReplacement(call, kind: "profile-back", controlId: "profile-back")
        } else {
            prepareReplacement(call, kind: "back", controlId: "top-shell-back")
        }
    }
    @objc func prepareHistoryReplacement(_ call: CAPPluginCall) {
        prepareReplacement(call, kind: "history", controlId: "chat-history-toggle")
    }
    private func prepareReplacement(_ call: CAPPluginCall, kind: String, controlId: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self, #available(iOS 26.0, *), self.admits(kind, controlId: controlId),
                  let identity = self.identity(call), identity.controlId == controlId,
                  call.getString("kind") == kind, call.getBool("enabled") == true,
                  let previousRevision = call.getInt("previousRevision"),
                  let slot = self.slots[identity.controlId], slot.kind == kind,
                  slot.pendingLayout == nil, slot.pendingFocus == nil, slot.presenter == nil,
                  let hosting = slot.hosting, !hosting.view.isHidden,
                  hosting.view.superview != nil, hosting.parent === self.bridge?.viewController,
                  let label = call.getString("label"), label == slot.label,
                  let presentation = ChromePresentation(call), presentation.value == nil,
                  presentation.expanded == slot.presentation?.expanded,
                  let frame = self.frame(call, kind: kind), slot.authoredFrame == frame,
                  let viewport = self.presentationViewport(call), viewport == slot.viewport,
                  self.geometryIsCurrent(slot), self.canMirrorPresentation, self.document == identity.document,
                  HushhSessionPrivacyShield.shared.acceptsDocument(identity.document),
                  !self.retiredDocuments.contains(identity.document) else {
                call.reject("NATIVE_CHROME_REPLACEMENT_REFUSED"); return
            }
            let accepted = kind == "back" || kind == "profile-back"
                ? slot.state.prepareBackReplacement(identity, previousRevision: previousRevision)
                : slot.state.prepareHistoryReplacement(identity, previousRevision: previousRevision)
            guard accepted else { call.reject("NATIVE_CHROME_REPLACEMENT_REFUSED"); return }
            // Route authority lives in state, not the SwiftUI root. Avoid
            // rebinding an identical presentation while keeping focus-sequence
            // reset for a previously used focus object on the new JS lease.
            let retainRoot = slot.presentation == presentation && slot.focus.sequence == 0
            hosting.view.isUserInteractionEnabled = false
            hosting.view.accessibilityElementsHidden = true
            slot.choiceValue = nil
            slot.presentation = presentation
            if !retainRoot {
                slot.focus = ChromeFocusRequest()
                hosting.overrideUserInterfaceStyle = presentation.theme.style
                hosting.rootView = AnyView(NativeChromeButton(label: kind == "history" ? (presentation.expanded ? "Close chat history" : "Open chat history") : label, controlId: identity.controlId,
                    symbol: self.symbol(kind, expanded: presentation.expanded), theme: presentation.theme,
                    action: { [weak self] in self?.activateControl(identity.controlId) },
                    layout: { _ in }, focus: slot.focus).disabled(!presentation.enabled))
            }
            hosting.view.layoutIfNeeded()
            // The already-qualified host is unchanged. A moved/detached view
            // cannot claim layout acknowledgement or retain this presentation.
            guard hosting.view.bounds.size == frame.size,
                  hosting.view.superview != nil else {
                slot.state.invalidate(); self.removeHosting(slot)
                call.reject("NATIVE_CHROME_LAYOUT_UNCONFIRMED"); return
            }
            #if DEBUG
            if kind == "back" { self.backContinuity?.replaced(hosting.view, rootUpdated: !retainRoot) }
            if kind == "history" { self.historyContinuity?.replaced(hosting.view, rootUpdated: !retainRoot) }
            if kind == "profile-back" { self.profileBackContinuity?.replaced(hosting.view, rootUpdated: !retainRoot) }
            #endif
            call.resolve(self.payload(identity, phase: "prepared", frame: frame))
        }
    }

    @objc func activate(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard let identity = self.identity(call), let slot = self.slots[identity.controlId],
                  self.canMirrorPresentation, self.geometryIsCurrent(slot), self.document == identity.document,
                  slot.pendingLayout == nil, let hosting = slot.hosting,
                  HushhSessionPrivacyShield.shared.acceptsDocument(identity.document),
                  !self.slots.contains(where: { id, other in
                      id != identity.controlId && other.state.phase == "active" && other.group == slot.group &&
                          other.authoredFrame.intersects(slot.authoredFrame)
                  }) else { call.reject("NATIVE_CHROME_ACTIVATE_REFUSED"); return }
            guard self.compositor?.acceptsPresentationRevision(call.getInt("presentationRegionRevision"),
                privacyGeneration: call.getInt("privacyGeneration")) != false else {
                var ack = self.payload(identity, phase: "active")
                ack["presentationApplied"] = false
                call.resolve(ack); return
            }
            guard slot.state.activate(identity) else { call.reject("NATIVE_CHROME_ACTIVATE_REFUSED"); return }
            hosting.view.isHidden = false
            slot.presentationRegionRevision = call.getInt("presentationRegionRevision")
            slot.privacyGeneration = call.getInt("privacyGeneration")
            hosting.view.isUserInteractionEnabled = self.canPresent
            hosting.view.accessibilityElementsHidden = !self.canPresent
            self.compositor?.revealUnderlay(presentationRegionRevision: call.getInt("presentationRegionRevision"),
                privacyGeneration: call.getInt("privacyGeneration"))
            self.compositor?.setAdmission(identity.controlId, admitted: self.canPresent && self.panelIsSettled(slot),
                presentationRegionRevision: call.getInt("presentationRegionRevision"), privacyGeneration: call.getInt("privacyGeneration"))
            #if DEBUG
            if slot.kind == "back" { self.backContinuity?.activated() }
            if slot.kind == "history" { self.historyContinuity?.activated() }
            if slot.kind == "profile-back" { self.profileBackContinuity?.activated() }
            #endif
            call.resolve(self.payload(identity, phase: "active"))
        }
    }

    @objc func suspend(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.chatControlsAdmitted, let identity = self.identity(call),
                  let slot = self.slots[identity.controlId], slot.state.suspend(identity) else {
                call.reject("NATIVE_CHROME_SUSPEND_REFUSED"); return
            }
            // Overlay isolation revokes interaction, not retained pixels.
            slot.hosting?.view.isHidden = self.compositor == nil
            self.compositor?.setAdmission(identity.controlId, admitted: false)
            slot.hosting?.view.isUserInteractionEnabled = false
            slot.hosting?.view.accessibilityElementsHidden = true
            slot.hosting?.didLayout = nil
            slot.pendingLayout?.reject("NATIVE_CHROME_LAYOUT_RETIRED"); slot.pendingLayout = nil
            slot.pendingFocus?.reject("NATIVE_CHROME_FOCUS_RETIRED"); slot.pendingFocus = nil
            slot.choiceValue = nil
            if let presenter = slot.presenter {
                presenter.retire { call.resolve(self.payload(identity, phase: "suspended")) }
            } else { call.resolve(self.payload(identity, phase: "suspended")) }
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
                  self.canMirrorPresentation, self.geometryIsCurrent(slot), self.document == identity.document,
                  HushhSessionPrivacyShield.shared.acceptsDocument(identity.document),
                  slot.state.identity == identity, slot.state.phase == "active", let hosting = slot.hosting,
                  self.admittedValue(presentation.value, slot: slot, forUpdate: true) else {
                call.reject("NATIVE_CHROME_UPDATE_REFUSED"); return
            }
            // Duplicates acknowledge only the identical complete snapshot.
            guard self.compositor?.acceptsPresentationRevision(call.getInt("presentationRegionRevision"),
                privacyGeneration: call.getInt("privacyGeneration")) != false else {
                var ack = self.payload(identity, phase: "active")
                ack["updateSequence"] = sequence; ack["presentationApplied"] = false
                call.resolve(ack); return
            }
            if sequence == slot.state.updateSequence && slot.presentation == presentation {
                var ack = self.payload(identity, phase: "active")
                ack["updateSequence"] = sequence
                call.resolve(ack); return
            }
            guard let root = self.controlRoot(kind: slot.kind, controlId: identity.controlId, label: slot.label,
                width: hosting.view.frame.width, presentation: presentation, focus: slot.focus, layout: { _ in }) else {
                call.reject("NATIVE_CHROME_UPDATE_REFUSED"); return
            }
            guard slot.state.update(identity, sequence: sequence) else {
                call.reject("NATIVE_CHROME_UPDATE_STALE"); return
            }
            slot.presenter?.update(theme: presentation.theme, value: presentation.value, enabled: presentation.enabled, sequence: sequence)
            let presentationChanged = slot.presentation != presentation
            slot.presentation = presentation
            slot.choiceValue = nil
            if presentationChanged {
                hosting.overrideUserInterfaceStyle = presentation.theme.style
                hosting.rootView = root
            }
            slot.presentationRegionRevision = call.getInt("presentationRegionRevision")
            slot.privacyGeneration = call.getInt("privacyGeneration")
            hosting.view.isUserInteractionEnabled = presentation.enabled && self.canPresent
            hosting.view.accessibilityElementsHidden = !presentation.enabled || !self.canPresent
            self.compositor?.setAdmission(identity.controlId, admitted: presentation.enabled && self.canPresent && self.panelIsSettled(slot),
                presentationRegionRevision: call.getInt("presentationRegionRevision"), privacyGeneration: call.getInt("privacyGeneration"))
            hosting.view.layoutIfNeeded()
            var ack = self.payload(identity, phase: "active")
            ack["updateSequence"] = sequence
            call.resolve(ack)
        }
    }

    @objc func restoreFocus(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            if let self, self.keyboardVisible, let identity = self.identity(call),
               let slot = self.slots[identity.controlId], slot.state.identity == identity,
               slot.state.phase == "active", self.canMirrorPresentation,
               HushhSessionPrivacyShield.shared.acceptsDocument(identity.document),
               call.getInt("updateSequence") == slot.state.updateSequence {
                self.resolveKeyboardFocus(call, identity: identity); return
            }
            guard let self, let identity = self.identity(call), let slot = self.slots[identity.controlId],
                  slot.kind != "agent-surface", self.canPresent, self.compositor?.interactionIsolated != true, self.geometryIsCurrent(slot),
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

    private func resolveKeyboardFocus(_ call: CAPPluginCall, identity: HushhNativeChromeState.Identity) {
        var ack = payload(identity, phase: "active")
        ack["updateSequence"] = call.getInt("updateSequence") ?? -1
        ack["focusSequence"] = call.getInt("focusSequence") ?? -1
        ack["restored"] = false; ack["cancellation"] = "keyboard"
        call.resolve(ack)
    }

    private func completeFocus(_ controlId: String) {
        guard let slot = slots[controlId], let call = slot.pendingFocus else { return }
        guard let identity = identity(call), slot.state.identity == identity, slot.state.phase == "active",
              canPresent, compositor?.interactionIsolated != true, geometryIsCurrent(slot), slot.presentation?.enabled == true,
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
                    allowed: self.canPresent && self.compositor?.interactionIsolated != true && self.panelIsSettled(slot) &&
                    (slot.group == nil || (call.getInt("presentationGeneration") == slot.groupGeneration &&
                        call.getInt("presentationSequence") == self.compositor?.groupPose(slot.group!)?.sequence)) &&
                    slot.presentation?.enabled == true && self.geometryIsCurrent(slot) && self.document == identity.document &&
                    HushhSessionPrivacyShield.shared.acceptsDocument(identity.document) &&
                    call.getString("value") == slot.choiceValue && call.getInt("privacyGeneration") == privacy.generation,
                    updateSequence: call.getInt("updateSequence") ?? 0)
            }
            #if DEBUG
            if call.getString("controlId") == "chat-history-toggle" { self.historyChoiceStage = valid ? "confirmed" : "confirmation-refused" }
            #endif
            call.resolve(["valid": valid])
        }
    }

    func layoutControls() {
        guard slots.values.contains(where: { $0.hosting != nil && !geometryIsCurrent($0) }) else { return }
        invalidatePresentation()
    }

    @objc func applyPanelPose(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let compositor = self.compositor,
                  !compositor.contentBackedPresentation || compositor.drawerClipping,
                  let group = call.getString("group"), ["profile", "history"].contains(group),
                  let document = call.getString("documentId"), !document.isEmpty, document.count <= 128,
                  let owner = call.getString("ownerEpoch"), !owner.isEmpty, owner.count <= 128,
                  let generation = call.getInt("generation"), generation >= 0, generation < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
                  let sequence = call.getInt("sequence"), sequence > 0, sequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
                  let privacy = call.getInt("privacyGeneration"),
                  let rect = call.getObject("frame"), let x = rect["x"] as? Double, let y = rect["y"] as? Double,
                  let width = rect["width"] as? Double, let height = rect["height"] as? Double,
                  let offset = call.getDouble("offset"), let opacity = call.getDouble("opacity"),
                  let settled = call.getBool("settled"),
                  self.canMirrorPresentation, HushhSessionPrivacyShield.shared.acceptsDocument(document),
                  !self.retiredDocuments.contains(document),
                  x.isFinite, y.isFinite, width.isFinite, height.isFinite,
                  x >= -1, y >= -1, x + width <= compositor.bounds.width + 1,
                  y + height <= compositor.bounds.height + 1 else {
                call.reject("NATIVE_PANEL_POSE_REFUSED"); return
            }
            self.acceptDocument(document)
            let pose = NativePanelPose(document: document, ownerEpoch: owner, generation: generation,
                sequence: sequence, privacyGeneration: privacy,
                frame: CGRect(x: x, y: y, width: width, height: height),
                offset: offset, opacity: opacity, settled: settled)
            let currentPrivacy = HushhSessionPrivacyShield.shared.snapshot().generation
            let regionRevision = call.getInt("presentationRegionRevision")
            if compositor.drawerClipping && (!compositor.acceptsPresentationRevision(regionRevision, privacyGeneration: privacy) ||
                regionRevision.map { compositor.drawerCoverageIsSuperseded(pose, group: group, privacy: currentPrivacy, revision: $0) } == true) {
                call.resolve(["documentId": document, "ownerEpoch": owner, "group": group,
                    "generation": generation, "sequence": sequence, "privacyGeneration": privacy,
                    "presentationRegionRevision": regionRevision ?? -1, "presentationApplied": false])
                return // Superseded layout only; never replay an operation.
            }
            let applied = compositor.drawerClipping
                ? regionRevision.map { compositor.applyDrawerCoverage(pose, group: group, privacy: currentPrivacy, revision: $0) } == true
                : compositor.apply(pose, group: group, privacy: currentPrivacy)
            guard applied else {
                call.reject("NATIVE_PANEL_POSE_STALE"); return
            }
            compositor.recordPoseTiming(group: group, sampledAtMs: call.getDouble("sampledAtMs"))
            for (id, slot) in self.slots where slot.group == group {
                compositor.setAdmission(id, admitted: self.canPresent && slot.state.phase == "active" && self.panelIsSettled(slot))
                if !pose.settled { slot.choiceValue = nil; slot.presenter?.retire {} }
            }
            var receipt: [String: Any] = ["documentId": document, "ownerEpoch": owner, "group": group,
                "generation": generation, "sequence": sequence, "privacyGeneration": privacy]
            if let regionRevision { receipt["presentationRegionRevision"] = regionRevision }
            call.resolve(receipt)
        }
    }

    @objc func retirePanel(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let compositor = self.compositor, let document = call.getString("documentId"),
                  let owner = call.getString("ownerEpoch"), let group = call.getString("group"),
                  let generation = call.getInt("generation"),
                  compositor.retire(group: group, document: document, ownerEpoch: owner, generation: generation) else {
                call.reject("NATIVE_PANEL_RETIRE_STALE"); return
            }
            let completed = DispatchGroup()
            for slot in self.slots.values where slot.group == group && slot.groupGeneration == generation {
                slot.choiceValue = nil
                if let identity = slot.state.identity { _ = slot.state.suspend(identity) }
                if let presenter = slot.presenter {
                    completed.enter()
                    presenter.retire { completed.leave() }
                }
            }
            completed.notify(queue: .main) {
                call.resolve(["documentId": document, "ownerEpoch": owner, "group": group, "generation": generation])
            }
        }
    }

    @objc func interactionFeedback(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["played": HushhAppHaptics.accept(call)]) }
    }
    // Preserve the owning host's existing entrypoint while covering every slot.
    func layoutBackControl() { layoutControls() }
    private func geometryIsCurrent(_ slot: ChromeSlot) -> Bool { bridge?.viewController?.view.bounds.size == slot.viewport }
    private func panelIsSettled(_ slot: ChromeSlot) -> Bool {
        guard let group = slot.group else { return true }
        let pose = compositor?.groupPose(group)
        return pose?.generation == slot.groupGeneration && pose?.settled == true
    }
    private var backAdmitted: Bool {
        guard HushhNativePresentationPolicy.customControlsEnabled else { return false }
        // Debug pilot only; release and iPad retain accepted controls until
        // their physical visual/accessibility acceptance has been recorded.
        #if DEBUG || HUSHH_NATIVE_SHELL_QUALIFICATION
        if #available(iOS 26.0, *) { return UIDevice.current.userInterfaceIdiom == .phone }
        #endif
        return false
    }
    private var canPresent: Bool {
        return canMirrorPresentation && (compositor?.wholeNativeDrawers == true || !keyboardVisible)
    }
    private var canMirrorPresentation: Bool {
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        return privacy.appIsActive && !privacy.shielded
    }
    private var chatControlsAdmitted: Bool {
        // Explicit Debug rehearsal opt-in; this is not promotion of an audited family.
        #if DEBUG || HUSHH_NATIVE_SHELL_QUALIFICATION
        return backAdmitted && NativeDrawerQualificationPolicy.coherentShell
        #else
        return false
        #endif
    }
    // Capability discovery and preparation share the same stationary admission
    // policy. Moving drawer controls deliberately keep their React renderer.
    static let stationaryChatControlIds = [
        "history": "chat-history-toggle", "agent-surface": "chat-agent-surface",
        "more": "stationary-more", "selection": "bounded-selection", "date": "bounded-date"
    ]
    private func admits(_ kind: String, controlId: String) -> Bool {
        if compositor?.contentBackedPresentation == true {
            if kind == "back" { return backAdmitted && controlId == "top-shell-back" }
            if kind == "profile-back" && compositor?.wholeNativeDrawers == true {
                return chatControlsAdmitted && controlId == "profile-back"
            }
            return chatControlsAdmitted && Self.stationaryChatControlIds[kind] == controlId
        }
        if kind == "back" { return backAdmitted && controlId == "top-shell-back" }
        if HushhNativePreferencePresentation.families.contains(kind) {
            return (kind == "appearance" && controlId == "profile-appearance") || (kind == "accent" && controlId == "profile-accent")
        }
        return chatControlsAdmitted && ((kind == "history" && controlId == "chat-history-toggle") ||
            (kind == "history-close" && compositor != nil && controlId == "chat-history-close") ||
            (kind == "agent-surface" && controlId == "chat-agent-surface") ||
            (kind == "more" && controlId == "stationary-more") || (kind == "selection" && controlId == "bounded-selection") ||
            (kind == "date" && controlId == "bounded-date") || (kind == "close" && controlId == "profile-close") ||
            (kind == "profile-back" && controlId == "profile-back"))
    }
    private func slot(_ id: String) -> ChromeSlot {
        if let slot = slots[id] { return slot }
        let slot = ChromeSlot()
        slot.controlId = id
        slots[id] = slot
        return slot
    }
    private func symbol(_ kind: String, expanded: Bool) -> String {
        switch kind {
        case "back", "profile-back": return "chevron.backward"
        case "close", "history-close": return "xmark"
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
            options: call.getArray("options", JSObject.self), minimum: call.getString("minimum"), maximum: call.getString("maximum"), palette: call.getObject("palette"))
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
        #if DEBUG
        if controlId == "chat-history-toggle" { historyChoiceStage = "tap" }
        #endif
        guard let slot = slots[controlId], let identity = slot.state.identity, let presentation = slot.presentation,
              slot.state.phase == "active", presentation.enabled, canPresent, compositor?.interactionIsolated != true,
              geometryIsCurrent(slot), panelIsSettled(slot) else {
            #if DEBUG
            if controlId == "chat-history-toggle" { historyChoiceStage = "refused" }
            #endif
            return
        }
        guard ["more", "selection", "date", "accent"].contains(slot.kind) else { requestChoice(controlId); return }
        guard slot.presenter == nil, let parent = bridge?.viewController, let source = slot.hosting?.view,
              parent.presentedViewController == nil else { return }
        let privacyGeneration = HushhSessionPrivacyShield.shared.snapshot().generation
        let interactionGeneration = self.interactionGeneration
        let presentationPose = slot.group.flatMap { compositor?.groupPose($0) }
        let choose: (String, Int) -> Void = { [weak self, weak slot] value, sequence in
            guard let self, let slot, slot.state.identity == identity, slot.state.updateSequence == sequence,
                  self.interactionGeneration == interactionGeneration,
                  HushhSessionPrivacyShield.shared.snapshot().generation == privacyGeneration,
                  slot.group.flatMap({ self.compositor?.groupPose($0) }) == presentationPose else { return }
            self.requestChoice(controlId, value: value)
        }
        let presenter: HushhNativeChromePresenter
        if slot.kind == "accent", !slot.configuration.swatches.isEmpty, let value = presentation.value {
            presenter = .accent(parent: parent, value: value, options: slot.options, swatches: slot.configuration.swatches,
                theme: presentation.theme, sequence: slot.state.updateSequence, onChoice: choose)
        } else if slot.kind == "more" || slot.kind == "accent" {
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
            compositor?.resetGroups()
        }
        document = next
    }
    private func requestChoice(_ controlId: String, value: String? = nil) {
        guard let slot = slots[controlId], slot.presentation?.enabled == true, canPresent, compositor?.interactionIsolated != true, geometryIsCurrent(slot), slot.state.phase == "active",
              panelIsSettled(slot),
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
        if let group = slot.group, let pose = compositor?.groupPose(group) {
            event["presentationGeneration"] = pose.generation
            event["presentationSequence"] = pose.sequence
        }
        notifyListeners("choiceRequested", data: event)
        #if DEBUG
        if controlId == "chat-history-toggle" { historyChoiceStage = "emitted" }
        #endif
    }
    private func invalidatePresentation(conceal: Bool = false) {
        #if DEBUG
        presentationInvalidations += 1
        #endif
        if conceal { compositor?.conceal() }
        for slot in slots.values {
            slot.state.invalidate()
            removeHosting(slot)
            slot.presenter?.retire {}
        }
        notifyListeners("invalidated", data: [:])
    }
    private func reconcileKeyboardInteraction() {
        for (id, slot) in slots {
            let admitted = canPresent && slot.state.phase == "active" && slot.presentation?.enabled == true &&
                geometryIsCurrent(slot) && panelIsSettled(slot) &&
                slot.state.identity.map { HushhSessionPrivacyShield.shared.acceptsDocument($0.document) } == true
            slot.hosting?.view.isUserInteractionEnabled = admitted
            slot.hosting?.view.accessibilityElementsHidden = !admitted
            compositor?.setAdmission(id, admitted: admitted,
                presentationRegionRevision: slot.presentationRegionRevision, privacyGeneration: slot.privacyGeneration)
            if keyboardVisible && compositor?.wholeNativeDrawers != true {
                // Invalidate even nil-valued button choices, not only menus.
                slot.sequence += 1
                slot.choiceValue = nil
                if let focus = slot.pendingFocus, let identity = slot.state.identity {
                    resolveKeyboardFocus(focus, identity: identity)
                }
                slot.pendingFocus = nil
                slot.presenter?.retire {}
            }
        }
    }
    private func removeHosting(_ slot: ChromeSlot) {
        slot.layoutConfirmed = false
        slot.pendingLayout?.reject("NATIVE_CHROME_LAYOUT_RETIRED")
        slot.pendingLayout = nil
        slot.pendingFocus?.reject("NATIVE_CHROME_FOCUS_RETIRED")
        slot.pendingFocus = nil
        slot.choiceValue = nil
        guard let hosting = slot.hosting else { return }
        compositor?.remove(slot.controlId)
        #if DEBUG
        if slot.kind == "back" { backContinuity?.removed() }
        if slot.kind == "history" { historyContinuity?.removed() }
        if slot.kind == "profile-back" { profileBackContinuity?.removed() }
        #endif
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
              ["top-shell-back", "profile-back", "chat-history-toggle", "chat-history-close", "chat-agent-surface", "stationary-more", "bounded-selection", "bounded-date", "profile-close", "profile-appearance", "profile-accent"].contains(controlId),
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
    private func presentationViewport(_ call: CAPPluginCall) -> CGSize? {
        guard let authored = viewport(call), let host = bridge?.viewController?.view.bounds.size,
              let web = bridge?.webView?.bounds.size else { return nil }
        return NativeChromeViewport.resolve(authored: authored, host: host, web: web,
            coherent: compositor?.wholeNativeDrawers == true, keyboard: keyboardVisible)
    }
    private func frame(_ call: CAPPluginCall, kind: String) -> CGRect? {
        guard let value = call.getObject("frame"), let x = value["x"] as? Double, let y = value["y"] as? Double,
              let width = value["width"] as? Double, let height = value["height"] as? Double,
              let viewport = viewport(call), [x, y, width, height].allSatisfy({ $0.isFinite }),
              (kind == "appearance" || kind == "accent" ? HushhNativePreferencePresentation.admitsWidth(width, kind: kind) : kind == "agent-surface" ? width >= 88 && width <= 320 : width == 44),
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

#if DEBUG
/// Opt-in physical continuity evidence, never routing or protected content.
/// Counters distinguish actual retained UIKit hosts from hidden DOM fallbacks.
final class NativeBackContinuityProbe: NSObject {
    private final class FrameTarget: NSObject {
        weak var probe: NativeBackContinuityProbe?
        @objc func sample() { probe?.sample() }
    }
    private let label = NativeTestStatusLabel(frame: .zero, showOverlay: false)
    private let target = FrameTarget()
    private var displayLink: CADisplayLink?
    private weak var control: UIView?
    private var admittedFrame: CGRect?
    private var expected = false
    private var installs = 0, removals = 0, replacements = 0
    private(set) var sampledFrames = 0, missingFrames = 0
    private var rootUpdates = 0

    init(host: UIView, identifier: String = "native-back-continuity") {
        super.init()
        label.accessibilityIdentifier = identifier
        label.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            label.topAnchor.constraint(equalTo: host.safeAreaLayoutGuide.topAnchor),
            label.widthAnchor.constraint(equalToConstant: 1), label.heightAnchor.constraint(equalToConstant: 1),
        ])
        target.probe = self
        let link = CADisplayLink(target: target, selector: #selector(FrameTarget.sample))
        link.add(to: .main, forMode: .common)
        displayLink = link
        publish()
    }
    deinit { displayLink?.invalidate(); label.removeFromSuperview() }

    func installed(_ view: UIView) { control = view; admittedFrame = view.frame; installs = min(installs + 1, 100_000); publish() }
    func activated() { expected = true; publish() }
    func replaced(_ view: UIView, rootUpdated: Bool) {
        if control !== view { missingFrames += 1 }
        if rootUpdated { rootUpdates = min(rootUpdates + 1, 100_000) }
        replacements = min(replacements + 1, 100_000); publish()
    }
    func removed() {
        expected = false; control = nil; admittedFrame = nil; removals = min(removals + 1, 100_000); publish()
    }
    private func sample() {
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        label.accessibilityElementsHidden = !privacy.appIsActive || privacy.shielded
        guard expected, privacy.appIsActive, !privacy.shielded else { return }
        recordFrame(isMissing: control?.window == nil || control?.superview == nil || control?.isHidden != false ||
            control?.alpha != 1 || control?.frame != admittedFrame || control?.bounds.size != CGSize(width: 44, height: 44))
    }
    func recordFrame(isMissing: Bool) {
        // A warm 60 Hz session passes 100,000 frames in under half an hour.
        // Saturation makes fresh-sample checks impossible and hides new gaps.
        // These opt-in, numeric-only Int counters retain monotonic deltas.
        sampledFrames += 1
        if isMissing { missingFrames += 1 }
        // Sampling never updates SwiftUI or the route; only this 1pt probe.
        if sampledFrames % 10 == 0 { publish() }
    }
    private func publish() {
        let values = ["installs": installs, "removals": removals, "replacements": replacements, "rootUpdates": rootUpdates,
                      "sampledFrames": sampledFrames, "missingFrames": missingFrames]
        guard let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return }
        label.update(status: json)
    }
}
#endif
