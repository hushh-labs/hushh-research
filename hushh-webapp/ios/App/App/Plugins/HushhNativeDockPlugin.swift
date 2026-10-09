import Capacitor
import SwiftUI
import UIKit

/// Geometry only. Equal-height keyboard movement still needs an ordered receipt.
struct NativeDockLayoutState {
    private(set) var sequence = 0
    private var frame: CGRect?
    private var update = -1
    private var privacy = -1
    mutating func record(_ next: CGRect, update: Int, privacy: Int) -> Bool {
        guard [next.minX, next.minY, next.width, next.height].allSatisfy(\.isFinite),
              sequence < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
              frame != next || self.update != update || self.privacy != privacy else { return false }
        frame = next; self.update = update; self.privacy = privacy; sequence += 1
        return true
    }
}

/// Input authority is distinct from public chrome. No draft persistence,
/// retained listener payloads, provider calls or diagnostic content.
struct HushhDockFence {
    struct Identity: Equatable {
        let document: String
        let owner: String
        let revision: Int
    }
    private(set) var identity: Identity?
    private(set) var update = 0
    private(set) var edit = 0
    private(set) var event = 0
    private var confirmed = 0
    private var retiredDocuments = Set<String>()
    private var latestDocument: String?
    private var latestRevision = -1
    private struct Emission { let update: Int; let edit: Int; let kind: String; let action: String? }
    private var emissions = [Int: Emission]()
    private var confirmedEmission: Emission?
    private var consumedSequence = 0
    var confirmedAction: String? { confirmedEmission?.action }
    func admitsEditingTransition(_ requested: Identity, sequence: Int, editRevision: Int) -> Bool {
        identity == requested && confirmed == sequence && edit == editRevision &&
            (confirmedEmission?.kind == "paste" || ["attachment-edit", "attachment-remove", "collapse"].contains(confirmedAction ?? ""))
    }
    mutating func apply(_ next: Identity, sequence: Int) -> Bool {
        guard !next.document.isEmpty, next.document.count <= 128, !next.owner.isEmpty, next.owner.count <= 128,
              next.revision > 0, next.revision <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
              sequence > 0, sequence <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
              !retiredDocuments.contains(next.document) else { return false }
        if let current = latestDocument, current != next.document { retiredDocuments.insert(current); latestRevision = -1 }
        latestDocument = next.document
        if next != identity {
            guard next.revision > latestRevision else { return false }
            latestRevision = next.revision
            identity = next; update = 0; edit = 0; event = 0; confirmed = 0; consumedSequence = 0; confirmedEmission = nil; emissions.removeAll()
        }
        guard sequence > update else { return false }
        update = sequence; return true
    }
    mutating func edited() { edit += 1 }
    mutating func emitted(kind: String, action: String? = nil) -> Int {
        event += 1
        emissions[event] = Emission(update: update, edit: edit, kind: kind, action: action)
        // Bound metadata, never retain private editor payloads.
        emissions.removeValue(forKey: event - 256)
        return event
    }
    mutating func confirm(_ requested: Identity, sequence: Int, applied: Int, editRevision: Int, kind: String, allowed: Bool) -> Bool {
        guard allowed, identity == requested, sequence > confirmed,
              let emission = emissions[sequence], emission.update == applied,
              emission.edit == editRevision, emission.kind == kind,
              kind != "action" || applied == update && editRevision == edit else { return false }
        confirmed = sequence
        confirmedEmission = emission
        emissions = emissions.filter { $0.key > sequence }
        return true
    }
    mutating func consume(_ requested: Identity, sequence: Int, editRevision: Int, allowed: Bool) -> Bool {
        guard allowed, identity == requested, sequence == confirmed, sequence > consumedSequence,
              confirmedEmission?.kind == "action", confirmedEmission?.action == "send",
              confirmedEmission?.edit == editRevision, edit == editRevision else { return false }
        consumedSequence = sequence
        edited()
        return true
    }
    mutating func retire(_ requested: Identity) -> Bool {
        guard identity == requested else { return false }
        identity = nil; emissions.removeAll(); return true
    }
}

final class NativeDockModel: ObservableObject {
    @Published var mode = "voice"
    @Published var text = ""
    @Published var placeholder = "Talk to One"
    @Published var expanded = false
    @Published var editable = false
    @Published var awaitingConsumption = false
    @Published var awaitingTransition = false
    @Published var sendEnabled = false
    @Published var micEnabled = false
    @Published var cancelEnabled = false
    @Published var recording = false
    @Published var recordingReady = false
    @Published var supportsHold = false
    @Published var muted = false
    @Published var visible = false
    @Published var attachments = [(String, String, Bool)]()
    @Published var accent = UIColor.tintColor
    weak var editor: DockTextView?
    var emit: ((String, String?, String?, String?, NSRange?) -> Void)?
    var changedHeight: (() -> Void)?
    func action(_ name: String, attachment: String? = nil) {
        guard visible, editor?.markedTextRange == nil else { return }
        emit?("action", name, attachment, nil, nil)
    }
    func clear() {
        editor?.resignFirstResponder()
        consumeText(); attachments = []; visible = false; awaitingConsumption = false; awaitingTransition = false
    }
    func consumeText() {
        editor?.text = ""; editor?.undoManager?.removeAllActions()
        editor?.refreshPlaceholder(); text = ""
    }
}

final class DockTextView: UITextView {
    var submit: (() -> Void)?
    let placeholderLabel = UILabel()
    private var placeholderEligible = false
    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        placeholderLabel.textColor = .secondaryLabel
        placeholderLabel.isUserInteractionEnabled = false
        placeholderLabel.isAccessibilityElement = false
        placeholderLabel.numberOfLines = 1
        addSubview(placeholderLabel)
    }
    required init?(coder: NSCoder) { fatalError("DockTextView is created programmatically") }
    func updatePlaceholder(_ value: String, visible: Bool) {
        placeholderLabel.text = value
        placeholderEligible = visible
        refreshPlaceholder()
    }
    func refreshPlaceholder() {
        placeholderLabel.isHidden = !placeholderEligible || !(text ?? "").isEmpty
        setNeedsLayout()
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        // Placeholder and entered text share the editor's actual font/insets,
        // including Dynamic Type. A separate SwiftUI overlay had a different
        // vertical centre as the editor grew or changed mode.
        placeholderLabel.font = font
        placeholderLabel.frame = CGRect(x: textContainerInset.left, y: textContainerInset.top,
            width: max(0, bounds.width - textContainerInset.left - textContainerInset.right),
            height: font?.lineHeight ?? 0)
    }
    override var keyCommands: [UIKeyCommand]? {
        [UIKeyCommand(input: "\r", modifierFlags: .command, action: #selector(sendFromKeyboard)),
         UIKeyCommand(input: UIKeyCommand.inputEscape, modifierFlags: [], action: #selector(dismissKeyboard))]
    }
    @objc private func sendFromKeyboard() { if markedTextRange == nil { submit?() } }
    @objc private func dismissKeyboard() { resignFirstResponder() }
}

/// Constraints follow UIKit's keyboard guide without a JavaScript resize or
/// a second keyboard offset. The retained host stays in the same containment.
@MainActor
final class NativeDockPlacement {
    private let leading: NSLayoutConstraint
    private let width: NSLayoutConstraint
    private let height: NSLayoutConstraint
    private let bottom: NSLayoutConstraint
    private let keyboardCeiling: NSLayoutConstraint
    init(parent: UIView, dock: UIView, keyboard: UILayoutGuide? = nil) {
        dock.translatesAutoresizingMaskIntoConstraints = false
        leading = dock.leadingAnchor.constraint(equalTo: parent.leadingAnchor)
        width = dock.widthAnchor.constraint(equalToConstant: 1)
        height = dock.heightAnchor.constraint(equalToConstant: 52)
        bottom = dock.bottomAnchor.constraint(equalTo: parent.topAnchor)
        // A short landscape viewport may compress the editor, but never push
        // it through the keyboard or above the safe header region.
        height.priority = UILayoutPriority(999)
        bottom.priority = UILayoutPriority(998)
        keyboardCeiling = dock.bottomAnchor.constraint(lessThanOrEqualTo: (keyboard ?? parent.keyboardLayoutGuide).topAnchor, constant: -8)
        NSLayoutConstraint.activate([leading, width, height, bottom,
            dock.topAnchor.constraint(greaterThanOrEqualTo: parent.safeAreaLayoutGuide.topAnchor)])
    }
    @discardableResult
    func update(frame: CGRect, height desired: CGFloat, editing: Bool) -> Bool {
        // The host calls this from viewDidLayoutSubviews. Reapplying unchanged
        // constraints must not request another parent layout indefinitely.
        guard leading.constant != frame.minX || width.constant != frame.width ||
              height.constant != desired || bottom.constant != frame.maxY ||
              keyboardCeiling.isActive != editing else { return false }
        leading.constant = frame.minX; width.constant = frame.width
        height.constant = desired; bottom.constant = frame.maxY
        keyboardCeiling.isActive = editing
        return true
    }
}

@available(iOS 26.0, *)
final class NativeDockHostingController: UIHostingController<NativeAgentDockView> {
    var layoutChanged: (() -> Void)?
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutChanged?()
    }
}

@available(iOS 26.0, *)
struct NativeDockEditor: UIViewRepresentable {
    @ObservedObject var model: NativeDockModel
    func makeUIView(context: Context) -> DockTextView {
        let editor = DockTextView()
        editor.delegate = context.coordinator
        editor.backgroundColor = .clear
        editor.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 16))
        editor.adjustsFontForContentSizeCategory = true
        editor.textContainerInset = UIEdgeInsets(top: 12, left: 16, bottom: 12, right: 8)
        editor.textContainer.lineFragmentPadding = 0
        editor.accessibilityLabel = "Message One"
        editor.accessibilityIdentifier = "native-dock-editor"
        editor.returnKeyType = .default
        editor.keyboardDismissMode = .interactive
        editor.submit = { [weak model] in if model?.sendEnabled == true { model?.action("send") } }
        model.editor = editor
        return editor
    }
    func updateUIView(_ editor: DockTextView, context: Context) {
        editor.isEditable = model.editable && model.visible && !model.awaitingConsumption && !model.awaitingTransition
        editor.isSelectable = model.visible
        editor.textColor = .label
        editor.tintColor = model.accent
        editor.updatePlaceholder(model.placeholder, visible: model.mode == "text" && model.visible)
        // Never destroy marked text, selection or undo on a theme/geometry echo.
        if editor.markedTextRange == nil && editor.text != model.text {
            let selection = editor.selectedRange
            editor.text = model.text
            let count = (model.text as NSString).length
            editor.selectedRange = NSRange(location: min(selection.location, count), length: min(selection.length, max(0, count - selection.location)))
            editor.refreshPlaceholder()
        }
        if model.mode != "text" || !model.visible { editor.resignFirstResponder() }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: DockTextView, context: Context) -> CGSize? {
        guard let width = proposal.width else { return nil }
        let size = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: min(model.expanded ? 260 : 144, max(44, size.height)))
    }
    func makeCoordinator() -> Coordinator { Coordinator(model) }
    static func dismantleUIView(_ editor: DockTextView, coordinator: Coordinator) {
        editor.resignFirstResponder(); editor.text = ""; editor.undoManager?.removeAllActions()
        editor.delegate = nil; editor.submit = nil
    }
    final class Coordinator: NSObject, UITextViewDelegate {
        private let model: NativeDockModel
        init(_ model: NativeDockModel) { self.model = model }
        func textViewDidChange(_ textView: UITextView) {
            (textView as? DockTextView)?.refreshPlaceholder()
            model.text = textView.text
            model.emit?("edit", nil, nil, textView.text, textView.selectedRange)
            model.changedHeight?()
        }
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            // Large paste goes through the owning feature's existing attachment
            // policy; a memory-only input event never becomes a provider send.
            if text.utf16.count >= 1200 || text.components(separatedBy: "\n").count >= 12 {
                model.emit?("paste", nil, nil, text, range); return false
            }
            return model.editable && model.visible
        }
    }
}

@available(iOS 26.0, *)
struct NativeAgentDockView: View {
    @ObservedObject var model: NativeDockModel
    @Namespace private var glass
    @State private var pressStarted: Date?
    @State private var cancelled = false
    @State private var pressWasActive = false
    @ScaledMetric(relativeTo: .body) private var glyphSize = 16
    @ScaledMetric(relativeTo: .body) private var actionSize = 32
    var body: some View {
        GlassEffectContainer(spacing: 8) {
            VStack(spacing: 0) {
                if model.mode == "text" && !model.attachments.isEmpty {
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(model.attachments, id: \.0) { id, label, editable in
                                HStack(spacing: 0) {
                                    if editable {
                                        Button { model.action("attachment-edit", attachment: id) } label: {
                                            Label(label, systemImage: "doc.text").lineLimit(1).frame(minHeight: 44)
                                        }
                                    } else {
                                        Label(label, systemImage: "doc.text").lineLimit(1).frame(minHeight: 44)
                                    }
                                    Button { model.action("attachment-remove", attachment: id) } label: { Image(systemName: "xmark") }
                                        .accessibilityLabel("Remove attachment")
                                        .frame(minWidth: 44, minHeight: 44)
                                }
                            }
                        }
                    }.scrollIndicators(.hidden).padding(.horizontal, 12)
                }
                HStack(alignment: .bottom, spacing: 0) {
                    // The editor always keeps its SwiftUI identity and UIView.
                    NativeDockEditor(model: model)
                        .opacity(model.mode == "text" ? 1 : 0)
                        .accessibilityHidden(model.mode != "text")
                        .allowsHitTesting(model.mode == "text")
                        .frame(maxWidth: model.mode == "text" ? .infinity : 0)
                        .frame(height: model.mode == "text" ? nil : 0)
                    if model.mode == "voice" {
                        Text(model.placeholder)
                            .font(Font(UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 16))))
                            .lineLimit(1).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .padding(.horizontal, 16).contentShape(Rectangle())
                            .accessibilityAddTraits(.isButton).accessibilityLabel(model.placeholder)
                            .accessibilityAction { model.action("voice-tap") }
                            .gesture(DragGesture(minimumDistance: 0)
                                .onChanged { value in
                                    guard model.visible else { return }
                                    if pressStarted == nil {
                                        pressStarted = Date(); cancelled = false; pressWasActive = model.cancelEnabled
                                        if model.supportsHold && !model.cancelEnabled { model.action("capture-start") }
                                    }
                                    if value.translation.width < -64 { cancelled = true }
                                }
                                .onEnded { _ in
                                    defer { pressStarted = nil; cancelled = false }
                                    guard let began = pressStarted, model.visible else { return }
                                    if cancelled { model.action("capture-cancel") }
                                    else if pressWasActive || !model.supportsHold { model.action("voice-tap") }
                                    else if Date().timeIntervalSince(began) >= 0.25 { model.action("capture-finish") }
                                })
                    }
                    if model.micEnabled {
                        dockButton(model.muted ? "mic.slash" : "mic", "Microphone") { model.action(model.mode == "text" ? "mic" : "mute") }
                    }
                    if model.sendEnabled || model.mode == "text" || model.recording {
                        dockButton("arrow.up", model.mode == "text" ? "Send message" : "Send recording") {
                            model.action(model.mode == "text" ? "send" : "capture-finish")
                        }.disabled(model.mode == "text" ? !model.sendEnabled : !model.recordingReady)
                    }
                    if model.cancelEnabled {
                        dockButton("xmark", "Cancel") { model.action("cancel") }
                    }
                    if model.mode == "text" && model.expanded {
                        dockButton("arrow.down.right.and.arrow.up.left", "Finish editing") { model.action("collapse") }
                    }
                }.padding(.vertical, 4).padding(.trailing, 6)
            }
            .glassEffect(.regular, in: .rect(cornerRadius: 24))
            .glassEffectID("agent-dock", in: glass)
        }
        .tint(Color(uiColor: model.accent))
        .accessibilityIdentifier("native-agent-dock")
    }
    private func dockButton(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: glyphSize, weight: .semibold))
                .foregroundStyle(.tint)
                .frame(width: actionSize, height: actionSize)
                .glassEffect(.regular.interactive(), in: .circle)
                // Compact visible material; the entire 44-point slot still
                // belongs to the button, including its transparent perimeter.
                .frame(width: max(44, actionSize), height: max(44, actionSize))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel(label)
    }
}

@objc(HushhNativeDockPlugin)
final class HushhNativeDockPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "HushhNativeDockPlugin"
    let jsName = "HushhNativeDock"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "apply", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retire", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "suspend", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "consumeDraft", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beginEditingTransition", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmEvent", returnType: CAPPluginReturnPromise),
    ]
    private var fence = HushhDockFence()
    private var context = ""
    private var editorContext = ""
    private var editorRevision = 0
    private var hosting: UIViewController?
    private var placement: NativeDockPlacement?
    private var frame = CGRect.zero
    private var viewport = CGSize.zero
    private var observers = [NSObjectProtocol]()
    private var requestedVisible = false
    private var layoutState = NativeDockLayoutState()
    private lazy var model = NativeDockModel()
    private var admitted: Bool {
        #if DEBUG
        if #available(iOS 26.0, *), UIDevice.current.userInterfaceIdiom == .phone {
            return ProcessInfo.processInfo.arguments.contains("--hushh-native-agent-dock")
        }
        #endif
        return false // Physical qualification precedes Release/iPad promotion.
    }
    private var safe: Bool {
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        return privacy.appIsActive && !privacy.shielded && fence.identity.map { HushhSessionPrivacyShield.shared.acceptsDocument($0.document) } == true
    }
    override func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            for name in [UIApplication.willResignActiveNotification, HushhSessionPrivacyShield.presentationDidChange] {
                self.observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                    guard let self, #available(iOS 26.0, *) else { return }
                    // Release is not admission. A fresh owner-fenced apply is
                    // required; a queued JS revocation must never flash text.
                    self.requestedVisible = false; self.model.visible = false
                    self.model.editor?.resignFirstResponder()
                    self.hosting?.view.isHidden = true
                    self.hosting?.view.accessibilityElementsHidden = true
                    if HushhSessionPrivacyShield.shared.snapshot().cause == "restart" {
                        // A retired document cannot keep a private editor
                        // replica or regain admission through its old lease.
                        if let identity = self.fence.identity { _ = self.fence.retire(identity) }
                        self.model.clear(); self.editorContext = ""
                    }
                    // The cover owner's release notification does not itself
                    // publish a JS state event. Request fresh admission using
                    // metadata only; native still never auto-reveals content.
                    self.notifyListeners("readmissionRequested", data: [:], retainUntilConsumed: false)
                })
            }
        }
    }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }
    @objc func getCapabilities(_ call: CAPPluginCall) { call.resolve(["contractVersion": 1, "supported": admitted]) }
    @objc func apply(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, #available(iOS 26.0, *), self.admitted,
                  let identity = self.identity(call), let sequence = call.getInt("updateSequence"),
                  let input = call.getString("text"), input.utf16.count <= 1_000_000,
                  let context = call.getString("context"), !context.isEmpty, context.count <= 128,
                  let mode = call.getString("mode"), ["text", "voice"].contains(mode),
                  let theme = HushhNativeControlAppearance(appearance: call.getString("appearance"), accentHex: call.getString("accentHex"), foregroundHex: call.getString("foregroundHex")),
                  let bounds = call.getObject("frame"), let screen = call.getObject("viewport"),
                  let x = bounds["x"] as? Double, let y = bounds["y"] as? Double,
                  let width = bounds["width"] as? Double, let height = bounds["height"] as? Double,
                  let vw = screen["width"] as? Double, let vh = screen["height"] as? Double,
                  [x,y,width,height,vw,vh].allSatisfy(\.isFinite), width >= 88, height >= 44,
                  x >= 0, y >= 0, x + width <= vw + 1, y + height <= vh + 1,
                  let acknowledgedEdit = call.getInt("acknowledgedEdit"), acknowledgedEdit >= 0,
                  let editorRevision = call.getInt("editorRevision"), editorRevision >= 0,
                  editorRevision < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration else {
                call.reject("NATIVE_DOCK_INVALID"); return
            }
            let shield = HushhSessionPrivacyShield.shared
            shield.observeDocument(identity.document)
            let privacy = shield.snapshot()
            guard shield.acceptsDocument(identity.document), privacy.appIsActive, !privacy.shielded,
                  call.getInt("privacyGeneration") == privacy.generation else { call.reject("NATIVE_DOCK_DOCUMENT_RETIRED"); return }
            let replacing = self.fence.identity != identity
            let changingEditor = mode == "text" && self.editorContext != context
            let replacingText = mode == "text" && self.editorRevision != editorRevision
            guard self.fence.apply(identity, sequence: sequence) else { call.reject("NATIVE_DOCK_STALE"); return }
            if replacing || changingEditor { self.model.clear() }
            if mode == "text" { self.editorContext = context; self.editorRevision = editorRevision }
            self.context = context
            self.frame = CGRect(x: x, y: y, width: width, height: height)
            self.viewport = CGSize(width: vw, height: vh)
            self.model.mode = mode
            if mode == "text", replacing || changingEditor || replacingText || acknowledgedEdit == self.fence.edit && self.model.editor?.markedTextRange == nil {
                // Purpose/value transitions commit together. Old-purpose edits
                // cannot become the attachment being opened for editing.
                if replacingText { self.model.editor?.unmarkText(); self.model.editor?.undoManager?.removeAllActions() }
                self.model.text = input
            }
            if replacing || changingEditor || acknowledgedEdit == self.fence.edit && call.getInt("settledConsumption") == self.fence.edit {
                self.model.awaitingConsumption = false
            }
            if replacing || changingEditor || replacingText { self.model.awaitingTransition = false }
            self.model.placeholder = call.getString("placeholder") ?? ""
            self.model.expanded = call.getBool("expanded") ?? false
            self.model.editable = call.getBool("editable") ?? false
            self.model.sendEnabled = call.getBool("sendEnabled") ?? false
            self.model.micEnabled = call.getBool("micEnabled") ?? false
            self.model.cancelEnabled = call.getBool("cancelEnabled") ?? false
            self.model.recording = call.getBool("recording") ?? false
            self.model.recordingReady = call.getBool("recordingReady") ?? false
            self.model.supportsHold = call.getBool("supportsHold") ?? false
            self.model.muted = call.getBool("muted") ?? false
            self.model.accent = theme.accent
            self.model.attachments = (call.getArray("attachments", JSObject.self) ?? []).prefix(16).compactMap { item in
                guard let id = item["id"] as? String, id.count <= 128, let label = item["label"] as? String, label.count <= 256 else { return nil }
                return (id, label, item["editable"] as? Bool ?? false)
            }
            self.model.emit = { [weak self] kind, action, attachment, text, range in self?.emit(kind: kind, action: action, attachment: attachment, text: text, range: range) }
            self.model.changedHeight = { [weak self] in self?.layoutDock() }
            guard let parent = self.bridge?.viewController else { call.reject("NATIVE_DOCK_HOST_MISSING"); return }
            if self.hosting == nil {
                let host = NativeDockHostingController(rootView: NativeAgentDockView(model: self.model))
                host.safeAreaRegions = []
                parent.addChild(host); parent.view.addSubview(host.view); host.didMove(toParent: parent)
                host.view.backgroundColor = .clear
                self.hosting = host
                self.placement = NativeDockPlacement(parent: parent.view, dock: host.view)
                host.layoutChanged = { [weak self] in self?.publishLayout() }
                shield.reassertCover()
            }
            self.hosting?.overrideUserInterfaceStyle = theme.style
            self.requestedVisible = call.getBool("visible") ?? false
            self.model.visible = self.requestedVisible && self.safe
            self.hosting?.view.isHidden = !self.model.visible
            self.hosting?.view.accessibilityElementsHidden = !self.model.visible
            self.layoutDock()
            // Commit actual native layout before transferring the web input.
            parent.view.layoutIfNeeded()
            call.resolve(self.ack(identity, sequence: sequence, phase: "active"))
        }
    }
    @MainActor
    func layoutDock() {
        guard #available(iOS 26.0, *), let parent = bridge?.viewController, let host = hosting else { return }
        let scale = parent.view.bounds.width / max(1, viewport.width)
        guard let dockHost = host as? NativeDockHostingController else { return }
        let desired = min(340, max(52, dockHost.sizeThatFits(in: CGSize(width: frame.width * scale, height: 340)).height))
        if placement?.update(frame: CGRect(x: frame.minX * scale, y: frame.minY * scale,
            width: frame.width * scale, height: frame.height * scale), height: desired, editing: model.mode == "text") == true {
            parent.view.setNeedsLayout()
        }
    }
    @MainActor
    private func publishLayout() {
        let previous = layoutState.sequence
        guard let receipt = currentLayout(), layoutState.sequence != previous else { return }
        notifyListeners("layout", data: receipt)
    }
    @MainActor
    private func currentLayout() -> JSObject? {
        guard #available(iOS 26.0, *), safe, requestedVisible, model.visible,
              let identity = fence.identity, let host = hosting, !host.view.isHidden,
              let parent = bridge?.viewController, viewport.width > 0 else { return nil }
        let scale = parent.view.bounds.width / viewport.width
        guard scale.isFinite, scale > 0 else { return nil }
        let bounds = host.view.convert(host.view.bounds, to: parent.view)
        let actual = CGRect(x: bounds.minX / scale, y: bounds.minY / scale,
            width: bounds.width / scale, height: bounds.height / scale)
        guard actual.height >= 44, actual.height <= 340 else { return nil }
        let privacy = HushhSessionPrivacyShield.shared.snapshot().generation
        _ = layoutState.record(actual, update: fence.update, privacy: privacy)
        var receipt = identityPayload(identity)
        receipt["updateSequence"] = fence.update
        receipt["privacyGeneration"] = privacy
        receipt["layoutSequence"] = layoutState.sequence
        receipt["frame"] = ["x": Double(actual.minX), "y": Double(actual.minY),
            "width": Double(actual.width), "height": Double(actual.height)]
        receipt["viewport"] = ["width": Double(viewport.width), "height": Double(viewport.height)]
        return receipt
    }
    @objc func suspend(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), self.fence.identity == identity,
                  #available(iOS 26.0, *) else { call.reject("NATIVE_DOCK_STALE"); return }
            self.requestedVisible = false; self.model.visible = false
            self.model.editor?.resignFirstResponder()
            self.hosting?.view.isHidden = true; self.hosting?.view.accessibilityElementsHidden = true
            call.resolve(self.ack(identity, sequence: self.fence.update, phase: "active"))
        }
    }
    @objc func retire(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call) else { call.reject("NATIVE_DOCK_INVALID"); return }
            var result = self.ack(identity, sequence: 0, phase: "retired")
            if self.fence.identity == identity, self.fence.retire(identity), #available(iOS 26.0, *) {
                if call.getBool("preserveDraft") == true, self.model.mode == "text" {
                    // Private recovery is returned to the current owner only;
                    // never retained, persisted or placed in diagnostics.
                    result["recovery"] = ["text": self.model.text, "context": self.editorContext,
                        "editorRevision": self.editorRevision, "consumed": self.model.awaitingConsumption] as JSObject
                }
                self.model.clear()
                self.editorContext = ""
                self.hosting?.willMove(toParent: nil); self.hosting?.view.removeFromSuperview(); self.hosting?.removeFromParent(); self.hosting = nil
                self.placement = nil
                self.layoutState = NativeDockLayoutState()
            }
            call.resolve(result)
        }
    }
    @objc func confirmEvent(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let sequence = call.getInt("sequence"),
                  let applied = call.getInt("updateSequence"), let editRevision = call.getInt("editRevision"),
                  let kind = call.getString("kind") else { call.resolve(["valid": false]); return }
            let privacy = HushhSessionPrivacyShield.shared.snapshot()
            let valid = self.fence.confirm(identity, sequence: sequence, applied: applied, editRevision: editRevision, kind: kind,
                allowed: self.safe && self.requestedVisible && call.getString("context") == self.context &&
                    call.getInt("editorRevision") == (self.model.mode == "text" ? self.editorRevision : 0) &&
                    call.getInt("privacyGeneration") == privacy.generation)
            call.resolve(["valid": valid])
        }
    }
    @objc func consumeDraft(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, #available(iOS 26.0, *), let identity = self.identity(call),
                  let sequence = call.getInt("sequence"), let edit = call.getInt("editRevision") else {
                call.resolve(["consumed": false, "editRevision": 0]); return
            }
            let privacy = HushhSessionPrivacyShield.shared.snapshot()
            let consumed = self.fence.consume(identity, sequence: sequence, editRevision: edit,
                allowed: self.safe && self.model.visible && self.model.mode == "text" && self.model.sendEnabled &&
                    self.model.editor?.markedTextRange == nil && call.getString("context") == self.context &&
                    call.getInt("privacyGeneration") == privacy.generation)
            if consumed {
                self.model.awaitingConsumption = true
                self.model.editor?.isEditable = false
                self.model.consumeText(); self.layoutDock()
            }
            call.resolve(["consumed": consumed, "editRevision": self.fence.edit])
        }
    }
    @objc func beginEditingTransition(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let identity = self.identity(call), let sequence = call.getInt("sequence"),
                  let edit = call.getInt("editRevision"), self.safe, self.model.visible,
                  self.model.mode == "text", !self.model.awaitingConsumption, !self.model.awaitingTransition,
                  self.model.editor?.markedTextRange == nil,
                  call.getString("context") == self.context, call.getInt("editorRevision") == self.editorRevision,
                  call.getInt("privacyGeneration") == HushhSessionPrivacyShield.shared.snapshot().generation,
                  self.fence.admitsEditingTransition(identity, sequence: sequence, editRevision: edit) else {
                call.resolve(["accepted": false]); return
            }
            self.model.awaitingTransition = true
            self.model.editor?.isEditable = false
            call.resolve(["accepted": true])
        }
    }
    private func emit(kind: String, action: String?, attachment: String?, text: String?, range: NSRange?) {
        guard #available(iOS 26.0, *), safe, model.visible, !model.awaitingConsumption, !model.awaitingTransition, let identity = fence.identity else { return }
        if kind == "edit" { fence.edited() }
        let selection = range ?? model.editor?.selectedRange ?? NSRange(location: 0, length: 0)
        var payload = identityPayload(identity)
        payload.merge(["kind": kind, "sequence": fence.emitted(kind: kind, action: action), "editRevision": fence.edit,
                       "updateSequence": fence.update, "privacyGeneration": HushhSessionPrivacyShield.shared.snapshot().generation,
                       "context": context, "editorRevision": model.mode == "text" ? editorRevision : 0,
                       "text": text ?? (model.mode == "text" ? model.text : ""),
                       "selectionStart": model.mode == "text" ? selection.location : 0,
                       "selectionEnd": model.mode == "text" ? selection.location + selection.length : 0]) { _, new in new }
        if let action { payload["action"] = action }
        if let attachment { payload["attachmentId"] = attachment }
        notifyListeners("input", data: payload, retainUntilConsumed: false)
    }
    private func identity(_ call: CAPPluginCall) -> HushhDockFence.Identity? {
        guard let document = call.getString("documentId"), let owner = call.getString("ownerEpoch"), let revision = call.getInt("revision") else { return nil }
        return .init(document: document, owner: owner, revision: revision)
    }
    private func identityPayload(_ identity: HushhDockFence.Identity) -> JSObject {
        ["documentId": identity.document, "ownerEpoch": identity.owner, "revision": identity.revision]
    }
    @MainActor
    private func ack(_ identity: HushhDockFence.Identity, sequence: Int, phase: String) -> JSObject {
        var result = identityPayload(identity)
        result["updateSequence"] = sequence
        result["phase"] = phase
        result["height"] = Double(hosting?.view.bounds.height ?? 52)
        if phase == "active", let layout = currentLayout() { result["layout"] = layout }
        return result
    }
}
