#if DEBUG || HUSHH_NATIVE_HISTORY_STUDY
import SwiftUI
import UIKit
import os

/// Public, opt-in composition study. No product history, private draft, routing,
/// credentials, plugin actions or persistence enters this presentation.
enum NativeHistoryQualification {
    static let argument = "--hushh-native-history-qualification"

    static func admits(arguments: [String], phone: Bool, supported: Bool) -> Bool {
        phone && supported && arguments.contains(argument)
    }
}

// The public study and product owner exercise the same cancellation/regrab gene.
typealias NativeHistoryQualificationMotion = NativeDrawerMotion

@available(iOS 26.0, *)
final class NativeHistoryQualificationAppearance: ObservableObject {
    @Published var dark = false { didSet { changed?() } }
    @Published var gold = false { didSet { changed?() } }
    @Published var messageMode = true { didSet { changed?() } }
    @Published var agentSurface = "one" { didSet { changed?() } }
    var changed: (() -> Void)?
    var accent: Color { gold ? Color(red: 0.72, green: 0.49, blue: 0.14) : .blue }
}

/// All moving views and their material backdrop share this native owner.
/// The opaque, public-only fullscreen study has no backdrop dependency on WK.
/// UIKit removes the covered root's views from the presentation hierarchy while
/// retaining its controller/document; no React/native motion is coordinated.
@available(iOS 26.0, *)
final class NativeHistoryQualificationController: UIViewController, UIGestureRecognizerDelegate {
    private final class FrameTarget: NSObject {
        weak var owner: NativeHistoryQualificationController?
        @objc func tick(_ display: CADisplayLink) { owner?.sampleFrame(display.timestamp) }
    }
    let appearance = NativeHistoryQualificationAppearance()
    let dock = NativeDockModel()
    private(set) var motion = NativeHistoryQualificationMotion()
    private(set) var baseHost: UIHostingController<NativeHistoryQualificationBase>!
    private(set) var drawerHost: UIHostingController<NativeHistoryQualificationDrawer>!
    private let scrim = UIView()
    private var animator: UIViewPropertyAnimator?
    private var dragOrigin: CGFloat = 0
    private var lastSize: CGSize = .zero
    private var privacyObserver: NSObjectProtocol?
    private let frameTarget = FrameTarget()
    private var displayLink: CADisplayLink?
    private var previousFrame: CFTimeInterval?
    private var frameCount = 0, slowFrames = 0
    private var maxFrameMs = 0.0, measuredMs = 0.0
    private let motionLog = OSLog(subsystem: "ai.hushh.native-study", category: .pointsOfInterest)
    var onRetired: (() -> Void)?

    init() {
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
        modalPresentationCapturesStatusBarAppearance = true
        isModalInPresentation = true
    }

    required init?(coder: NSCoder) { fatalError("Programmatic qualification only") }

    override var preferredStatusBarStyle: UIStatusBarStyle {
        appearance.dark ? .lightContent : .darkContent
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "native-history-qualification"
        view.accessibilityViewIsModal = true
        view.backgroundColor = .systemBackground
        overrideUserInterfaceStyle = .light
        appearance.changed = { [weak self] in
            guard let self, !self.motion.retired else { return }
            self.overrideUserInterfaceStyle = self.appearance.dark ? .dark : .light
            self.setNeedsStatusBarAppearanceUpdate()
            self.dock.accent = self.appearance.gold ? UIColor(red: 0.72, green: 0.49, blue: 0.14, alpha: 1) : .systemBlue
            self.dock.mode = self.appearance.messageMode ? "text" : "voice"
            self.dock.placeholder = self.appearance.messageMode ? "Message One" : "Talk to One"
        }
        dock.mode = "text"
        dock.placeholder = "Message One"
        dock.editable = true
        dock.visible = true
        dock.interactionEnabled = true
        dock.accent = .systemBlue
        // Exercise the existing retained editor without installing a plugin,
        // second product composer, transport, or submission authority. Sample
        // actions have no application effect; text remains in this model only.
        baseHost = UIHostingController(rootView: NativeHistoryQualificationBase(appearance: appearance, dock: dock,
            open: { [weak self] in self?.settle(open: true) }, exit: { [weak self] in self?.retire() },
            reset: { [weak self] in self?.resetPublicSamples() }))
        drawerHost = UIHostingController(rootView: NativeHistoryQualificationDrawer(appearance: appearance,
            close: { [weak self] in self?.settle(open: false) }))
        install(baseHost)
        scrim.backgroundColor = .black
        scrim.alpha = 0
        scrim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(closeDrawer)))
        view.addSubview(scrim)
        install(drawerHost)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panDrawer(_:)))
        pan.delegate = self
        view.addGestureRecognizer(pan)
        privacyObserver = NotificationCenter.default.addObserver(
            forName: HushhSessionPrivacyShield.presentationDidChange, object: nil, queue: .main
        ) { [weak self] _ in
            if HushhSessionPrivacyShield.shared.snapshot().shielded { self?.retire() }
        }
        frameTarget.owner = self
        let display = CADisplayLink(target: frameTarget, selector: #selector(FrameTarget.tick(_:)))
        display.isPaused = true
        display.add(to: .main, forMode: .common)
        displayLink = display
        applyPose(0)
    }

    deinit {
        displayLink?.invalidate()
        if let privacyObserver { NotificationCenter.default.removeObserver(privacyObserver) }
    }

    private func install(_ host: UIViewController) {
        addChild(host)
        host.view.backgroundColor = .clear
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard !motion.retired else { return }
        let geometryChanged = lastSize != view.bounds.size
        if geometryChanged {
            finishFrameWindow()
            _ = motion.begin(at: motion.committedOpen ? 1 : 0)
            animator?.stopAnimation(true)
            animator = nil
            motion.move(to: motion.committedOpen ? 1 : 0)
            lastSize = view.bounds.size
        }
        baseHost.view.frame = view.bounds
        scrim.frame = view.bounds
        // Qualification geometry, not a replacement product-layout contract.
        let width = min(420, view.bounds.width * 0.9)
        if geometryChanged {
            drawerHost.view.transform = .identity
            drawerHost.view.frame = CGRect(x: 0, y: 0, width: width, height: view.bounds.height)
        }
        // A theme/content layout pass must not reset an in-flight native pose.
        if geometryChanged || animator == nil { applyPose(motion.progress) }
    }

    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard !motion.retired, let pan = gesture as? UIPanGestureRecognizer else { return false }
        let velocity = pan.velocity(in: view)
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

    @objc private func panDrawer(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began: beginDrag()
        case .changed:
            motion.move(to: dragOrigin + pan.translation(in: view).x / max(1, drawerHost.view.bounds.width))
            applyPose(motion.progress)
        case .ended: settle(open: motion.destination(velocity: pan.velocity(in: view).x, cancelled: false))
        case .cancelled, .failed: settle(open: motion.destination(velocity: 0, cancelled: true))
        default: break
        }
    }

    func beginDrag() {
        guard !motion.retired else { return }
        if previousFrame == nil {
            previousFrame = CACurrentMediaTime()
            displayLink?.isPaused = false
            // SDK os_signpost_animation_interval_begin uses this exact tag.
            // XCTest then records rendered animation hitches, not just time.
            os_signpost(.begin, log: motionLog, name: "PublicDrawerMotion", signpostID: .exclusive, "isAnimation=YES")
        }
        let width = max(1, drawerHost.view.bounds.width)
        let transform = drawerHost.view.layer.presentation()?.affineTransform() ?? drawerHost.view.transform
        let visible = min(1, max(0, 1 + transform.tx / width))
        // Invalidate old completion before stopping an interrupted settlement.
        _ = motion.begin(at: visible)
        animator?.stopAnimation(true)
        animator = nil
        dragOrigin = visible
        applyPose(visible)
    }

    @objc private func closeDrawer() { settle(open: false) }

    func settle(open: Bool) {
        guard !motion.retired else { return }
        beginDrag()
        let generation = motion.generation
        let target: CGFloat = open ? 1 : 0
        let duration: TimeInterval = UIAccessibility.isReduceMotionEnabled ? 0 : 0.15
        let next = UIViewPropertyAnimator(duration: duration, curve: .easeOut) { [weak self] in
            self?.applyPose(target)
        }
        next.addCompletion { [weak self] _ in
            guard let self, self.motion.commit(open: open, generation: generation) else { return }
            self.animator = nil
            self.applyPose(target)
            self.finishFrameWindow()
            UIAccessibility.post(notification: .screenChanged,
                argument: open ? self.drawerHost.view : self.baseHost.view)
        }
        animator = next
        next.startAnimation()
    }

    private func applyPose(_ progress: CGFloat) {
        drawerHost.view.transform = CGAffineTransform(translationX: -(1 - progress) * drawerHost.view.bounds.width, y: 0)
        scrim.alpha = progress * 0.24
        // An animation block applies its target values immediately. The closing
        // target is not proof that the visible drawer has finished retiring.
        // Keep input and accessibility isolated until this generation completes.
        let covered = progress > 0 || animator != nil
        if dock.interactionEnabled == covered { dock.interactionEnabled = !covered }
        if dock.editable == covered { dock.editable = !covered }
        if covered, dock.editor?.isFirstResponder == true { dock.editor?.resignFirstResponder() }
        scrim.isUserInteractionEnabled = covered
        baseHost.view.isUserInteractionEnabled = !covered
        baseHost.view.accessibilityElementsHidden = covered
        drawerHost.view.isUserInteractionEnabled = covered
        drawerHost.view.accessibilityElementsHidden = !covered
    }

    func retire() {
        guard !motion.retired else { return }
        finishFrameWindow()
        displayLink?.invalidate()
        displayLink = nil
        motion.retire()
        animator?.stopAnimation(true)
        animator = nil
        view.endEditing(true)
        dock.emit = nil
        dock.clear()
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        appearance.changed = nil
        if let privacyObserver { NotificationCenter.default.removeObserver(privacyObserver) }
        privacyObserver = nil
        let shield = HushhSessionPrivacyShield.shared
        let token = shield.beginPresentationRetirement()
        let finish = {
            for child in self.children {
                child.willMove(toParent: nil)
                child.view.removeFromSuperview()
                child.removeFromParent()
            }
            shield.completePresentationRetirement(token)
            self.onRetired?()
            self.onRetired = nil
        }
        if presentingViewController != nil { dismiss(animated: false, completion: finish) }
        else { finish() }
        // Never restore captured WK eligibility or release the privacy shield.
        // UIKit retires modal isolation; existing owners keep their latest state.
    }

    private func sampleFrame(_ timestamp: CFTimeInterval) {
        guard !motion.retired, let previousFrame, timestamp > previousFrame else { return }
        let interval = (timestamp - previousFrame) * 1000
        self.previousFrame = timestamp
        frameCount += 1
        measuredMs += interval
        maxFrameMs = max(maxFrameMs, interval)
        if interval > 50 { slowFrames += 1 }
    }

    private func finishFrameWindow() {
        guard previousFrame != nil else { return }
        previousFrame = nil
        displayLink?.isPaused = true
        os_signpost(.end, log: motionLog, name: "PublicDrawerMotion", signpostID: .exclusive)
        publishFrameReceipt()
    }

    private func resetPublicSamples() {
        guard !motion.retired, motion.progress == 0, animator == nil, previousFrame == nil else { return }
        dock.editor?.resignFirstResponder()
        dock.consumeText()
        frameCount = 0; slowFrames = 0; maxFrameMs = 0; measuredMs = 0
        publishFrameReceipt()
    }

    private func publishFrameReceipt() {
        // Public sample timings only; not a proxy for Instruments render hitches.
        // Publish after settlement, never invalidate SwiftUI/AX on every frame.
        let packet: [String: Double] = ["frames": Double(frameCount), "over50": Double(slowFrames),
            "maxFrameMs": maxFrameMs, "measuredMs": measuredMs]
        if let data = try? JSONSerialization.data(withJSONObject: packet, options: [.sortedKeys]),
           let receipt = String(data: data, encoding: .utf8) { view.accessibilityValue = receipt }
    }
}

@available(iOS 26.0, *)
struct NativeHistoryQualificationButton: View {
    @ObservedObject var appearance: NativeHistoryQualificationAppearance
    @StateObject private var focus = ChromeFocusRequest()
    let symbol: String
    let label: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        if let theme = HushhNativeControlAppearance(appearance: appearance.dark ? "dark" : "light",
            accentHex: appearance.gold ? "#b87d24" : "#007aff",
            foregroundHex: appearance.dark ? "#ffffff" : "#000000") {
            NativeChromeButton(label: label, controlId: identifier, symbol: symbol,
                theme: theme, action: action, layout: { _ in }, focus: focus)
        }
    }
}

@available(iOS 26.0, *)
struct NativeHistoryQualificationBase: View {
    @ObservedObject var appearance: NativeHistoryQualificationAppearance
    @ObservedObject var dock: NativeDockModel
    let open: () -> Void
    let exit: () -> Void
    let reset: () -> Void

    var body: some View {
        ZStack {
            // Page content actually continues behind the native material.
            // Putting the dock below a ScrollView would only back it with canvas.
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Public fixture — not your Chat").font(.subheadline).foregroundStyle(.primary)
                    Button("Exit qualification", action: exit).frame(minHeight: 44)
                        .accessibilityIdentifier("qualification-exit")
                    Button("Reset public samples", action: reset).frame(minHeight: 44)
                        .foregroundStyle(.primary)
                        .accessibilityIdentifier("qualification-reset")
                    Picker("Fixture appearance", selection: $appearance.dark) {
                        Text("Light").tag(false); Text("Dark").tag(true)
                    }.pickerStyle(.segmented)
                    Picker("Fixture accent", selection: $appearance.gold) {
                        Text("Blue").tag(false); Text("Molten Gold").tag(true)
                    }.pickerStyle(.segmented)
                    Picker("Fixture dock mode", selection: $appearance.messageMode) {
                        Text("Talk").tag(false); Text("Message").tag(true)
                    }.pickerStyle(.segmented)
                    ForEach(["A weekend idea", "A place to explore", "A simple dinner"], id: \.self) { title in
                        Text(title).font(.title2).frame(maxWidth: .infinity, minHeight: 140, alignment: .leading)
                            .padding(16).background(LinearGradient(colors: [.cyan.opacity(0.35), .purple.opacity(0.25)],
                                startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 20))
                    }
                }.padding(16).padding(.top, 64).padding(.bottom, 84)
            }
            VStack {
                HStack {
                    NativeHistoryQualificationButton(appearance: appearance, symbol: "line.3.horizontal",
                        label: "Open synthetic History", identifier: "qualification-history-open", action: open)
                    Spacer()
                    Text("Native study").font(.headline)
                    Spacer()
                    if let theme = HushhNativeControlAppearance(appearance: appearance.dark ? "dark" : "light",
                        accentHex: appearance.gold ? "#b87d24" : "#007aff",
                        foregroundHex: appearance.dark ? "#ffffff" : "#000000") {
                        // Reuse the product selector, not a decorative replica.
                        // This choice is synthetic and grants no product action.
                        NativeAgentSurfaceSelector(selected: appearance.agentSurface, width: 96, theme: theme,
                            action: { appearance.agentSurface = $0 }, layout: { _ in })
                    }
                }
                Spacer()
                NativeAgentDockView(model: dock)
                    .accessibilityIdentifier("qualification-dock")
            }.padding(16)
        }.background(.background).tint(appearance.accent)
            .preferredColorScheme(appearance.dark ? .dark : .light)
    }
}

@available(iOS 26.0, *)
struct NativeHistoryQualificationDrawer: View {
    @ObservedObject var appearance: NativeHistoryQualificationAppearance
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                NativeHistoryQualificationButton(appearance: appearance, symbol: "xmark",
                    label: "Close synthetic History", identifier: "qualification-history-close", action: close)
                Text("History").font(.title2.bold())
                Spacer()
            }
            Text("Synthetic conversations").foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(["Weekend plans", "Dinner ideas", "Places to explore", "A reading list"], id: \.self) { title in
                        Text(title).frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                        Divider()
                    }
                }
            }
        }.padding(16).background(.background).tint(appearance.accent)
            .preferredColorScheme(appearance.dark ? .dark : .light)
    }
}
#endif
