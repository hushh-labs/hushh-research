#if DEBUG
import SwiftUI
import UIKit

/// Public, opt-in composition study. No product history, editor, routing,
/// credentials, plugin actions or persistence enters this presentation.
enum NativeHistoryQualification {
    static let argument = "--hushh-native-history-qualification"

    static func admits(arguments: [String], phone: Bool, supported: Bool) -> Bool {
        phone && supported && arguments.contains(argument)
    }
}

struct NativeHistoryQualificationMotion {
    private(set) var generation = 0
    private(set) var committedOpen = false
    private(set) var progress: CGFloat = 0
    private(set) var retired = false

    @discardableResult mutating func begin(at progress: CGFloat) -> Int {
        guard !retired else { return generation }
        generation += 1
        self.progress = min(1, max(0, progress))
        return generation
    }

    mutating func move(to progress: CGFloat) {
        guard !retired else { return }
        self.progress = min(1, max(0, progress))
    }

    func destination(velocity: CGFloat, cancelled: Bool) -> Bool {
        if cancelled { return committedOpen }
        if abs(velocity) > 350 { return velocity > 0 }
        return progress >= 0.5
    }

    @discardableResult mutating func commit(open: Bool, generation: Int) -> Bool {
        guard !retired, generation == self.generation else { return false }
        committedOpen = open
        progress = open ? 1 : 0
        return true
    }

    mutating func retire() {
        generation += 1
        retired = true
    }
}

@available(iOS 26.0, *)
final class NativeHistoryQualificationAppearance: ObservableObject {
    @Published var dark = false { didSet { changed?() } }
    @Published var gold = false
    var changed: (() -> Void)?
    var accent: Color { gold ? Color(red: 0.72, green: 0.49, blue: 0.14) : .blue }
}

/// All moving views and their material backdrop share this native owner.
/// UIKit's owned over-full-screen presentation isolates the existing WK root;
/// it is not a native plane coordinated with a moving React layer.
@available(iOS 26.0, *)
final class NativeHistoryQualificationController: UIViewController, UIGestureRecognizerDelegate {
    let appearance = NativeHistoryQualificationAppearance()
    private(set) var motion = NativeHistoryQualificationMotion()
    private(set) var baseHost: UIHostingController<NativeHistoryQualificationBase>!
    private(set) var drawerHost: UIHostingController<NativeHistoryQualificationDrawer>!
    private let scrim = UIView()
    private var animator: UIViewPropertyAnimator?
    private var dragOrigin: CGFloat = 0
    private var lastSize: CGSize = .zero
    private var privacyObserver: NSObjectProtocol?
    var onRetired: (() -> Void)?

    init() {
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
        isModalInPresentation = true
    }

    required init?(coder: NSCoder) { fatalError("Programmatic qualification only") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.accessibilityIdentifier = "native-history-qualification"
        view.accessibilityViewIsModal = true
        view.backgroundColor = .systemBackground
        overrideUserInterfaceStyle = .light
        appearance.changed = { [weak self] in
            guard let self, !self.motion.retired else { return }
            self.overrideUserInterfaceStyle = self.appearance.dark ? .dark : .light
        }
        baseHost = UIHostingController(rootView: NativeHistoryQualificationBase(appearance: appearance,
            open: { [weak self] in self?.settle(open: true) }, exit: { [weak self] in self?.retire() }))
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
        applyPose(0)
    }

    deinit {
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
            if open { UIAccessibility.post(notification: .screenChanged, argument: self.drawerHost.view) }
        }
        animator = next
        next.startAnimation()
    }

    private func applyPose(_ progress: CGFloat) {
        drawerHost.view.transform = CGAffineTransform(translationX: -(1 - progress) * drawerHost.view.bounds.width, y: 0)
        scrim.alpha = progress * 0.24
        scrim.isUserInteractionEnabled = progress > 0
        baseHost.view.isUserInteractionEnabled = progress == 0
        baseHost.view.accessibilityElementsHidden = progress != 0
        drawerHost.view.isUserInteractionEnabled = progress > 0
        drawerHost.view.accessibilityElementsHidden = progress == 0
    }

    func retire() {
        guard !motion.retired else { return }
        motion.retire()
        animator?.stopAnimation(true)
        animator = nil
        view.endEditing(true)
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
}

@available(iOS 26.0, *)
struct NativeHistoryQualificationBase: View {
    @ObservedObject var appearance: NativeHistoryQualificationAppearance
    let open: () -> Void
    let exit: () -> Void

    var body: some View {
        ZStack {
            // Page content actually continues behind the native material.
            // Putting the dock below a ScrollView would only back it with canvas.
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Public fixture — not your Chat").font(.subheadline).foregroundStyle(.secondary)
                    Picker("Fixture appearance", selection: $appearance.dark) {
                        Text("Light").tag(false); Text("Dark").tag(true)
                    }.pickerStyle(.segmented)
                    Picker("Fixture accent", selection: $appearance.gold) {
                        Text("Blue").tag(false); Text("Molten Gold").tag(true)
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
                    Button(action: open) { Image(systemName: "line.3.horizontal").frame(width: 44, height: 44) }
                        .buttonStyle(.glass).accessibilityLabel("Open synthetic History")
                        .accessibilityIdentifier("qualification-history-open")
                    Spacer()
                    Text("Native study").font(.headline)
                    Spacer()
                    Button(action: exit) { Image(systemName: "xmark").frame(width: 44, height: 44) }
                        .buttonStyle(.glass).accessibilityLabel("Exit qualification")
                        .accessibilityIdentifier("qualification-exit")
                }
                Spacer()
                HStack(spacing: 0) {
                    Text("Message One").foregroundStyle(.secondary).padding(.leading, 16)
                    Spacer(minLength: 8)
                    Image(systemName: "mic").font(.system(size: 18)).frame(width: 44, height: 44)
                    Image(systemName: "arrow.up").font(.system(size: 18)).frame(width: 44, height: 44)
                }.frame(height: 52).glassEffect(.regular, in: RoundedRectangle(cornerRadius: 26))
                    .accessibilityLabel("Synthetic dock preview, no editor or voice operation")
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
                Text("History").font(.largeTitle.bold())
                Spacer()
                Button(action: close) { Image(systemName: "xmark").frame(width: 44, height: 44) }
                    .buttonStyle(.glass).accessibilityLabel("Close synthetic History")
                    .accessibilityIdentifier("qualification-history-close")
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
