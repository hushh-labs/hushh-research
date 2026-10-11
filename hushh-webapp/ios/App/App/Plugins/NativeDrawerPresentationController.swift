import SwiftUI
import UIKit

@MainActor
final class NativeDrawerModel: ObservableObject {
    @Published private(set) var projection: NativeDrawerProjection
    @Published var interactionEnabled = false
    @Published var search = ""
    @Published var detailRow: String?
    @Published var detailMode = "actions"
    @Published var renameDraft = ""
    @Published var choicePending = false
    var pendingSequence: Int?
    var choose: ((String, String?, String?) -> Bool)?
    var close: (() -> Void)?
    init(_ projection: NativeDrawerProjection) { self.projection = projection }
    func update(_ projection: NativeDrawerProjection) {
        self.projection = projection
        if !projection.open || !projection.enabled || detailRow.map({ id in !projection.sections.contains { $0.rows.contains { $0.id == id } } }) == true {
            clearDetails()
        }
        if !projection.enabled { search = "" }
    }
    func clearDetails() { detailRow = nil; renameDraft = ""; detailMode = "actions"; pendingSequence = nil; choicePending = false }
    func settle(sequence: Int, success: Bool) {
        guard pendingSequence == sequence else { return }
        pendingSequence = nil; choicePending = false
        if success { clearDetails() }
    }
    func details(_ row: NativeDrawerRow) {
        guard interactionEnabled, !choicePending, row.enabled, row.pending != true else { return }
        detailRow = row.id; detailMode = "actions"; renameDraft = row.label
    }
    @discardableResult func choice(_ action: String, row: String? = nil, text: String? = nil) -> Bool {
        guard projection.allows(action: action, row: row, text: text) else { return false }
        guard (action != "row" || !choicePending), choose?(action, row, text) == true else { return false }
        if action == "row" { choicePending = true }
        return true
    }
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
    private var dragging = false
    private var awaitingReadmission = false
    private var intentTimeout: DispatchWorkItem?
    var isolation: ((Bool) -> Void)?
    var invalidateInteractions: (() -> Void)?
    private var direction: CGFloat { model.projection.family == "history" ? -1 : 1 }

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
        host.view.backgroundColor = .systemBackground
        view.addSubview(host.view)
        host.didMove(toParent: self)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(drag(_:)))
        pan.delegate = self
        view.addGestureRecognizer(pan)
        model.close = { [weak self] in self?.close() }
        applyAppearance()
        pose(0)
    }

    private var covered: Bool { motion.progress > 0 || animator != nil || intentPending || model.projection.open }
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        guard !motion.retired else { return }
        let changed = lastSize != view.bounds.size
        if changed {
            let initial = lastSize == .zero
            let previousWidth = max(1, host.view.bounds.width)
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
            let width = min(360, view.bounds.width * 0.88)
            host.view.frame = CGRect(x: direction > 0 ? view.bounds.width - width : 0,
                y: 0, width: width, height: view.bounds.height)
            pose(visible)
            // Invalidating geometry cancels a drag without committing its
            // unconfirmed intent or snapping the visible edge to an endpoint.
            if !initial { settle(open: model.projection.open, userIntent: false) }
        }
        scrim.frame = view.bounds
        // Compatible theme/content layouts never rewind an active drag/settle.
        if changed || animator == nil { pose(motion.progress) }
    }

    func update(_ projection: NativeDrawerProjection) {
        guard !motion.retired, model.projection.identity == projection.identity else { return }
        let changedOpen = model.projection.open != projection.open
        let withdrawn = model.projection.enabled && !projection.enabled
        model.update(projection)
        intentTimeout?.cancel(); intentTimeout = nil
        awaitingReadmission = false
        applyAppearance()
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
    }
    private func applyAppearance() {
        guard let theme = HushhNativeControlAppearance(appearance: model.projection.appearance,
            accentHex: model.projection.accentHex, foregroundHex: model.projection.foregroundHex) else { return }
        overrideUserInterfaceStyle = theme.style
        host?.overrideUserInterfaceStyle = theme.style
        host?.view.tintColor = theme.accent
    }
    func beginDrag() {
        guard !motion.retired else { return }
        let width = max(1, host.view.bounds.width)
        let transform = host.view.layer.presentation()?.affineTransform() ?? host.view.transform
        let current = min(1, max(0, 1 - abs(transform.tx) / width))
        _ = motion.begin(at: current)
        invalidateInteractions?()
        animator?.stopAnimation(true); animator = nil
        origin = current
        pose(current)
    }
    func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        guard !motion.retired, !intentPending, !awaitingReadmission, model.projection.enabled, covered,
              let pan = gesture as? UIPanGestureRecognizer else { return false }
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
    @objc private func drag(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began: beginDrag(); dragging = true
        case .changed:
            guard dragging else { return }
            motion.move(to: origin - direction * pan.translation(in: view).x / max(1, host.view.bounds.width))
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
            UIAccessibility.post(notification: .screenChanged, argument: open ? self.host.view : nil)
        }
        animator = next
        reconcileIsolation()
        next.startAnimation()
    }
    private func pose(_ progress: CGFloat) {
        host.view.transform = CGAffineTransform(translationX: direction * (1 - progress) * host.view.bounds.width, y: 0)
        scrim.alpha = progress * 0.24
        reconcileIsolation()
    }
    private func reconcileIsolation() {
        let covered = covered
        scrim.isUserInteractionEnabled = covered
        view.accessibilityViewIsModal = covered
        host.view.accessibilityElementsHidden = !covered
        let interactive = covered && model.projection.enabled && !intentPending && !awaitingReadmission && !dragging && animator == nil
        host.view.isUserInteractionEnabled = interactive
        if model.interactionEnabled != interactive { model.interactionEnabled = interactive }
        isolation?(covered)
    }
    func allowsInteraction(_ action: String, row: String?, text: String? = nil) -> Bool {
        guard !motion.retired, !awaitingReadmission, !dragging, animator == nil,
              model.projection.allows(action: action, row: row, text: text) else { return false }
        return !intentPending || action == "open" || action == "close"
    }
    private func boundTerminalIntent(_ generation: Int) {
        intentTimeout?.cancel()
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, !self.motion.retired, self.motion.generation == generation, self.intentPending else { return }
            self.intentPending = false
            self.awaitingReadmission = true
            // If JavaScript is stalled, restore a visible authored surface but
            // never revive its action eligibility or replay the terminal intent.
            self.settle(open: self.model.projection.open, userIntent: false)
        }
        intentTimeout = deadline
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: deadline)
    }
    /// Clears the private model and callbacks only after child detachment.
    func retire() {
        guard !motion.retired else { return }
        motion.retire()
        intentTimeout?.cancel(); intentTimeout = nil
        animator?.stopAnimation(true); animator = nil
        view.endEditing(true)
        model.choose = nil
        model.close = nil
        model.search = ""; model.clearDetails()
        invalidateInteractions = nil
        model.update(model.projection.cleared)
        model.interactionEnabled = false
        host.willMove(toParent: nil)
        host.view.removeFromSuperview()
        host.removeFromParent()
        willMove(toParent: nil)
        view.removeFromSuperview()
        removeFromParent()
        isolation?(false); isolation = nil
    }
}

private final class NativeDrawerHitSurface: UIView {
    var covered: (() -> Bool)?
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard covered?() == true else { return nil }
        return super.hitTest(point, with: event)
    }
}

struct NativeDrawerContent: View {
    @ObservedObject var model: NativeDrawerModel
    private var detailedRow: NativeDrawerRow? {
        model.projection.sections.flatMap(\.rows).first { $0.id == model.detailRow }
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                if model.detailRow != nil {
                    control("arrow.left", "Back") { model.clearDetails() }
                } else if model.projection.backEnabled {
                    control("arrow.left", "Back") { model.choice("back") }
                }
                Text(model.projection.title).font(.title2.bold()).frame(maxWidth: .infinity, alignment: .leading)
                control("xmark", model.projection.family == "history" ? "Close chat history" : "Close Profile") { model.close?() }
            }.padding(.horizontal, 16).padding(.vertical, 12)
            if let row = detailedRow {
                details(row)
            } else {
                if model.projection.searchable == true {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
                        TextField("Search chats", text: $model.search)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .accessibilityIdentifier("native-history-search")
                        if !model.search.isEmpty {
                            Button { model.search = "" } label: { Image(systemName: "xmark.circle.fill") }
                                .frame(width: 44, height: 44).accessibilityLabel("Clear chat search")
                        }
                    }.padding(.horizontal, 16).frame(minHeight: 44)
                        .disabled(!model.interactionEnabled)
                }
                if model.projection.loading == true { ProgressView("Loading chats").padding() }
                List {
                ForEach(model.projection.sections) { section in
                    Section {
                        ForEach(section.rows.filter { row in model.search.isEmpty || row.renameActionId == nil || row.label.localizedCaseInsensitiveContains(model.search) }) { row in
                          HStack(spacing: 0) {
                            Button { model.choice("row", row: row.id) } label: {
                                HStack(spacing: 12) {
                                    if let symbol = row.symbol { Image(systemName: symbol).frame(width: 24).accessibilityHidden(true) }
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(row.label).foregroundStyle(row.destructive == true ? Color.red : Color.primary).lineLimit(2)
                                        if let detail = row.detail { Text(detail).font(.subheadline).foregroundStyle(.secondary) }
                                    }
                                    Spacer(minLength: 8)
                                    if row.pending == true { ProgressView() }
                                    else if row.selected == true { Image(systemName: "checkmark").accessibilityHidden(true) }
                                }.frame(minHeight: 44).contentShape(Rectangle())
                            }.disabled(!row.enabled || row.pending == true || !model.interactionEnabled)
                                .accessibilityAddTraits(row.selected == true ? .isSelected : [])
                            if row.renameActionId != nil || row.deleteActionId != nil {
                                Button { model.details(row) } label: { Image(systemName: "ellipsis") }
                                    .frame(width: 44, height: 44).accessibilityLabel("Open actions for \(row.label)")
                                    .disabled(!row.enabled || row.pending == true || !model.interactionEnabled)
                            }
                          }
                        }
                    } header: { if let title = section.title { Text(title) } }
                }
                }.listStyle(.insetGrouped)
            }
        }.background(Color(uiColor: .systemBackground))
    }
    private func details(_ row: NativeDrawerRow) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(row.label).font(.headline).lineLimit(3)
            if model.detailMode == "rename", let action = row.renameActionId {
                TextField("Chat name", text: $model.renameDraft).textFieldStyle(.roundedBorder)
                    .accessibilityLabel("Rename chat").accessibilityIdentifier("native-history-rename")
                Button("Save chat name") { _ = model.choice("row", row: action, text: model.renameDraft) }
                    .disabled(model.renameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.renameDraft.utf16.count > 160)
            } else if model.detailMode == "delete", let action = row.deleteActionId {
                Text("This chat will be removed from your history.").foregroundStyle(.secondary)
            Button("Delete chat", role: .destructive) { _ = model.choice("row", row: action) }
            } else {
                if row.renameActionId != nil { Button("Rename") { model.detailMode = "rename" } }
                if row.deleteActionId != nil { Button("Delete", role: .destructive) { model.detailMode = "delete" } }
            }
            Button("Cancel") { model.clearDetails() }
            Spacer(minLength: 0)
        }.buttonStyle(.borderless).padding(16)
            .frame(maxWidth: .infinity, alignment: .leading).disabled(!model.interactionEnabled || model.choicePending || !row.enabled || row.pending == true)
    }
    @ViewBuilder private func control(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        if #available(iOS 26.0, *) {
            Button(action: action) { Image(systemName: symbol).font(.system(size: 18)) }
                .frame(width: 44, height: 44).buttonStyle(.glass).accessibilityLabel(label)
                .disabled(!model.interactionEnabled)
        } else {
            Button(action: action) { Image(systemName: symbol) }.frame(width: 44, height: 44)
                .accessibilityLabel(label).disabled(!model.interactionEnabled)
        }
    }
}
