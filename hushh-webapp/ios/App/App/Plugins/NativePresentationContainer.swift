import UIKit
import WebKit

/// Presentation metadata only; never routes, account identifiers or editor content.
struct NativePanelPose: Equatable {
    let document: String
    let ownerEpoch: String
    let generation: Int
    let sequence: Int
    let privacyGeneration: Int
    let frame: CGRect
    let offset: CGFloat
    let opacity: CGFloat
    let settled: Bool
}

struct NativePanelPoseFence {
    private(set) var pose: NativePanelPose?
    private(set) var retiredGeneration = -1

    mutating func apply(_ next: NativePanelPose, privacy: Int) -> Bool {
        guard next.generation > retiredGeneration, next.sequence > 0,
              next.privacyGeneration == privacy,
              next.frame.width > 0, next.frame.height > 0,
              [next.frame.minX, next.frame.minY, next.frame.width, next.frame.height,
               next.offset, next.opacity].allSatisfy({ $0.isFinite }),
              (0...1).contains(next.opacity), abs(next.offset) <= next.frame.width else { return false }
        if let previous = pose {
            guard next.document == previous.document,
                  next.generation >= previous.generation,
                  next.generation != previous.generation ||
                    (next.ownerEpoch == previous.ownerEpoch && next.sequence > previous.sequence) else { return false }
        }
        pose = next
        return true
    }

    mutating func retire(document: String, ownerEpoch: String, generation: Int) -> Bool {
        guard let pose, pose.document == document, pose.ownerEpoch == ownerEpoch,
              pose.generation == generation else { return false }
        retiredGeneration = max(retiredGeneration, generation)
        self.pose = nil
        return true
    }
}

/// One WebView, retained native base plane, bounded overlay groups. The outer
/// container routes only explicitly admitted hits; Maps keeps its WK hit path.
final class NativePresentationContainer: UIView {
    enum BasePresentation { case underlay, contentBacked }
    let webView: WKWebView
    let basePresentation: BasePresentation
    var contentBackedPresentation: Bool { basePresentation == .contentBacked }
    let drawerClipping: Bool
    private let baseViewport = UIView()
    // Retain the legacy name for the independently reversible underlay pilot.
    let underlay = UIView()
    private var groups: [String: UIView] = [:]
    private var fences: [String: NativePanelPoseFence] = [:]
    private var controls: [String: (view: UIView, group: String?, admitted: Bool)] = [:]
    private var regionDocument: String?
    private var regionRevision = -1
    private var regionPrivacyGeneration: Int?
    private var regionDrawer: String?
    private var coverageRevision: Int?
    private(set) var overlayTop: CGFloat = 0
    private(set) var overlayBottom: CGFloat = 0
    private(set) var overlayIsolated = false
    private(set) var fullWindowCovered = false
    private var privacyConcealed = false

    func setRegions(document: String, revision: Int, viewport: CGSize, top: CGFloat, bottom: CGFloat, isolated: Bool, covered: Bool = false, privacyGeneration: Int? = nil, drawer: String? = nil, initialPose: NativePanelPose? = nil) -> Bool {
        guard contentBackedPresentation, viewport == bounds.size,
              revision >= 0, regionDocument != document || revision > regionRevision,
              top.isFinite, bottom.isFinite, top >= 0, bottom >= 0,
              top + bottom < viewport.height, !covered || isolated && privacyGeneration != nil,
              regionDocument != document || regionPrivacyGeneration == nil || privacyGeneration != nil,
              drawer == nil || drawerClipping && covered && ["profile", "history"].contains(drawer!) else { return false }
        // Stage both fences before changing the visible plane. Invalid initial
        // geometry must not partially commit coverage or a newer revision.
        var stagedFence: NativePanelPoseFence?
        if let initialPose {
            guard let drawer, let privacyGeneration, covered, isolated, !privacyConcealed,
                  initialPose.document == document,
                  privacyGeneration == HushhSessionPrivacyShield.shared.snapshot().generation,
                  bounds.contains(initialPose.frame),
                  abs(initialPose.frame.minY) <= 1, abs(initialPose.frame.maxY - bounds.height) <= 1,
                  initialPose.opacity == 0 || initialPose.opacity == 1 else { return false }
            var fence = fences[drawer] ?? NativePanelPoseFence()
            guard fence.apply(initialPose, privacy: privacyGeneration) else { return false }
            stagedFence = fence
        }
        // Compatible layout/admission updates do not change the last displayed
        // rectangle. Retain those pixels while rejecting choices/poses bound to
        // the old revision; unrelated ownership or privacy never inherits them.
        if drawerClipping, regionDocument == document, regionDrawer == drawer,
           fullWindowCovered == covered, regionPrivacyGeneration == privacyGeneration,
           coverageRevision == regionRevision {
            coverageRevision = revision
        }
        regionDocument = document; regionRevision = revision
        regionPrivacyGeneration = privacyGeneration
        regionDrawer = drawer
        overlayTop = top; overlayBottom = bottom; overlayIsolated = isolated
        fullWindowCovered = covered
        if let drawer, let stagedFence {
            fences[drawer] = stagedFence
            coverageRevision = revision
        }
        reconcileBaseVisibility()
        if isolated {
            for id in Array(controls.keys) { setAdmission(id, admitted: false) }
        }
        return true
    }

    func containsStationaryControl(_ frame: CGRect, document: String) -> Bool {
        guard contentBackedPresentation, regionDocument == document, bounds.contains(frame) else { return false }
        return frame.maxY <= overlayTop || frame.minY >= bounds.height - overlayBottom
    }
    func acceptsPresentationRevision(_ revision: Int?, privacyGeneration: Int?) -> Bool {
        regionPrivacyGeneration == nil ||
            (revision == regionRevision && privacyGeneration == regionPrivacyGeneration &&
                privacyGeneration == HushhSessionPrivacyShield.shared.snapshot().generation)
    }
    #if DEBUG
    private var continuity: NativePanelContinuityProbe?
    #endif

    init(webView: WKWebView, basePresentation: BasePresentation = .underlay, drawerClipping: Bool = false) {
        self.webView = webView
        self.basePresentation = basePresentation
        self.drawerClipping = drawerClipping && basePresentation == .contentBacked
        super.init(frame: webView.frame)
        backgroundColor = .systemBackground
        underlay.frame = bounds
        underlay.isOpaque = false
        underlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.removeFromSuperview()
        webView.frame = bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(webView)
        // Keep native accessibility in front of WK's full rectangular view.
        // DOM paint apertures are not UIKit accessibility apertures. Separate
        // sibling traversal from paint order instead of forcing focus or
        // bypassing the owning control's admission fence.
        if self.drawerClipping {
            // Rectangular viewport only: no ancestor mask, material opacity,
            // resized editor coordinates, snapshots or additional WebView.
            baseViewport.frame = bounds
            baseViewport.backgroundColor = .clear
            baseViewport.clipsToBounds = true
            addSubview(baseViewport)
            baseViewport.addSubview(underlay)
        } else { addSubview(underlay) }
        underlay.layer.zPosition = contentBackedPresentation ? 0 : -1
        // DOM aperture ownership is explicit; this does not clear page CSS.
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--hushh-native-chrome-diagnostics") {
            continuity = NativePanelContinuityProbe(host: self)
        }
        #endif
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is unsupported") }

    func setCanvas(_ color: UIColor, appearance: UIUserInterfaceStyle? = nil) {
        backgroundColor = color
        // Foreground glass must sample the actual WK page, not an opaque
        // native canvas painted between the page and its material.
        underlay.backgroundColor = contentBackedPresentation ? .clear : color
        if let appearance { overrideUserInterfaceStyle = appearance }
    }

    func install(_ view: UIView, id: String, group: String?) {
        if let group {
            let host = groupHost(group)
            host.addSubview(view)
        } else { underlay.addSubview(view) }
        controls[id] = (view, group, false)
    }

    func setAdmission(_ id: String, admitted: Bool, presentationRegionRevision: Int? = nil, privacyGeneration: Int? = nil) {
        guard var control = controls[id] else { return }
        let currentRegion = acceptsPresentationRevision(presentationRegionRevision, privacyGeneration: privacyGeneration)
        let admitted = admitted && currentRegion && !privacyConcealed && !(contentBackedPresentation && overlayIsolated)
        control.admitted = admitted
        controls[id] = control
        control.view.isUserInteractionEnabled = admitted
        control.view.accessibilityElementsHidden = !admitted
    }

    func remove(_ id: String) { controls.removeValue(forKey: id)?.view.removeFromSuperview() }

    func groupPose(_ id: String) -> NativePanelPose? { fences[id]?.pose }

    /// Mirror the authored drawer's rectangular coverage, not its decisions or
    /// its scrim. A missing/currently unconfirmed pose exposes no base pixels.
    func applyDrawerCoverage(_ pose: NativePanelPose, group: String, privacy: Int, revision: Int) -> Bool {
        guard drawerClipping, fullWindowCovered, overlayIsolated, regionDrawer == group,
              regionDocument == pose.document, revision == regionRevision,
              regionPrivacyGeneration == privacy, !privacyConcealed,
              abs(pose.frame.minY) <= 1, abs(pose.frame.maxY - bounds.height) <= 1,
              pose.opacity == 0 || pose.opacity == 1 else { return false }
        var fence = fences[group] ?? NativePanelPoseFence()
        guard fence.apply(pose, privacy: privacy) else { return false }
        fences[group] = fence
        coverageRevision = revision
        reconcileBaseVisibility()
        return true
    }

    var baseVisibleFrame: CGRect {
        guard !privacyConcealed else { return .zero }
        guard drawerClipping else { return fullWindowCovered ? .zero : bounds }
        guard fullWindowCovered else { return bounds }
        guard coverageRevision == regionRevision, let group = regionDrawer,
              let pose = fences[group]?.pose, pose.document == regionDocument,
              pose.privacyGeneration == regionPrivacyGeneration,
              abs(pose.frame.minY) <= 1, abs(pose.frame.maxY - bounds.height) <= 1 else { return .zero }
        guard pose.opacity > 0 else { return bounds }
        let edge = min(bounds.width, max(0, group == "profile"
            ? pose.frame.minX + pose.offset : pose.frame.maxX + pose.offset))
        return group == "profile" ? CGRect(x: 0, y: 0, width: edge, height: bounds.height)
            : CGRect(x: edge, y: 0, width: bounds.width - edge, height: bounds.height)
    }

    func apply(_ pose: NativePanelPose, group: String, privacy: Int) -> Bool {
        guard !contentBackedPresentation, ["profile", "history"].contains(group) else { return false }
        var fence = fences[group] ?? NativePanelPoseFence()
        guard fence.apply(pose, privacy: privacy) else { return false }
        fences[group] = fence
        let host = groupHost(group)
        host.transform = .identity
        host.frame = pose.frame
        host.transform = CGAffineTransform(translationX: pose.offset, y: 0)
        host.alpha = pose.opacity
        host.isHidden = false
        // Movement never acquires interaction; existing owner re-admits only
        // once terminal layout is acknowledged.
        if !pose.settled {
            for id in controls.filter({ $0.value.group == group }).map(\.key) { setAdmission(id, admitted: false) }
        }
        return true
    }

    func retire(group: String, document: String, ownerEpoch: String, generation: Int) -> Bool {
        guard var fence = fences[group], fence.retire(document: document, ownerEpoch: ownerEpoch, generation: generation) else { return false }
        fences[group] = fence
        if drawerClipping { reconcileBaseVisibility() }
        groups[group]?.isHidden = true
        #if DEBUG
        continuity?.discard(group: group)
        #endif
        for id in controls.filter({ $0.value.group == group }).map(\.key) { setAdmission(id, admitted: false) }
        return true
    }

    func conceal() {
        #if DEBUG
        continuity?.discard()
        #endif
        privacyConcealed = true
        reconcileBaseVisibility()
        groups.values.forEach { $0.isHidden = true }
        for id in Array(controls.keys) { setAdmission(id, admitted: false) }
    }

    func revealUnderlay(presentationRegionRevision: Int? = nil, privacyGeneration: Int? = nil) {
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        guard privacy.appIsActive, !privacy.shielded,
              acceptsPresentationRevision(presentationRegionRevision, privacyGeneration: privacyGeneration) else { return }
        privacyConcealed = false
        reconcileBaseVisibility()
    }

    private func reconcileBaseVisibility() {
        // Retain hosts, models and the editor; coverage never means retirement.
        underlay.isHidden = privacyConcealed || fullWindowCovered && !drawerClipping
        if drawerClipping {
            let exposed = baseVisibleFrame
            baseViewport.frame = exposed
            // Keep every existing child/layout guide in full-window coordinates.
            underlay.frame = CGRect(origin: CGPoint(x: -exposed.minX, y: -exposed.minY), size: bounds.size)
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        if drawerClipping { reconcileBaseVisibility() }
    }

    func resetGroups() {
        #if DEBUG
        continuity?.discard()
        #endif
        fences.removeAll()
        groups.values.forEach { $0.isHidden = true }
    }

    /// Numeric, opt-in timing evidence only. Never admission or action authority.
    func recordPoseTiming(group: String, sampledAtMs: Double?) {
        #if DEBUG
        guard let pose = fences[group]?.pose else { return }
        guard !pose.settled, pose.opacity > 0, abs(pose.offset) < pose.frame.width else {
            continuity?.discard(group: group)
            return
        }
        continuity?.record(group: group, sampledAtMs: sampledAtMs)
        #endif
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard !isHidden, alpha > 0.01, isUserInteractionEnabled, bounds.contains(point) else { return nil }
        // Privacy/launch covers and standard UIKit presentations always win.
        for child in subviews.reversed() where child !== webView && child !== underlay && child !== baseViewport && !groups.values.contains(where: { $0 === child }) {
            if let hit = child.hitTest(child.convert(point, from: self), with: event) { return hit }
        }
        // Follow actual UIKit stacking, not dictionary enumeration. The host
        // hit test enforces clipping, ancestor visibility and disabled state.
        let presentationHosts = subviews.map { $0 === baseViewport ? underlay : $0 }
        for host in presentationHosts.reversed() where host === underlay || groups.values.contains(where: { $0 === host }) {
            if host === underlay && drawerClipping && !baseVisibleFrame.contains(point) { continue }
            if let group = groups.first(where: { $0.value === host })?.key,
               fences[group]?.pose?.settled != true { continue }
            let local = host.convert(point, from: self)
            guard host.bounds.contains(local), let hit = host.hitTest(local, with: event) else { continue }
            if controls.values.contains(where: { control in
                control.admitted && (hit === control.view || hit.isDescendant(of: control.view))
            }) { return hit }
        }
        // An isolated reserved strip must not pass a tap to underlying DOM
        // controls. The central region still reaches its React modal owner.
        if contentBackedPresentation && overlayIsolated && !fullWindowCovered &&
            (point.y < overlayTop || point.y >= bounds.height - overlayBottom) { return self }
        return webView.hitTest(webView.convert(point, from: self), with: event)
    }

    private func groupHost(_ id: String) -> UIView {
        if let host = groups[id] { return host }
        let host = UIView(frame: bounds)
        host.backgroundColor = .clear
        host.clipsToBounds = true
        host.isHidden = true
        addSubview(host)
        groups[id] = host
        return host
    }
}

#if DEBUG
/// Compare JS and native epoch milliseconds on the same device. Only the latest
/// pose displayed per group is sampled; no per-pose queue or protected payload.
final class NativePanelContinuityProbe: NSObject {
    private final class Target: NSObject {
        weak var probe: NativePanelContinuityProbe?
        @objc func sample(_ link: CADisplayLink) { probe?.sample(link) }
    }
    private let label = NativeTestStatusLabel(frame: .zero, showOverlay: false)
    private let target = Target()
    private var link: CADisplayLink?
    private var pending = [String: Double]()
    private var frames = 0, staleFrames = 0, invalidSamples = 0
    private var maxAgeMs = 0.0, maxAgeIntervals = 0.0

    init(host: UIView) {
        super.init()
        label.accessibilityIdentifier = "native-panel-continuity"
        label.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            label.topAnchor.constraint(equalTo: host.safeAreaLayoutGuide.topAnchor),
            label.widthAnchor.constraint(equalToConstant: 1), label.heightAnchor.constraint(equalToConstant: 1),
        ])
        target.probe = self
        let display = CADisplayLink(target: target, selector: #selector(Target.sample(_:)))
        display.add(to: .main, forMode: .common)
        link = display
        publish()
    }
    deinit { link?.invalidate(); label.removeFromSuperview() }

    func record(group: String, sampledAtMs: Double?) {
        guard let sampledAtMs, sampledAtMs.isFinite else { invalidSamples += 1; publish(); return }
        pending[group] = sampledAtMs
    }
    func discard(group: String? = nil) {
        if let group { pending.removeValue(forKey: group) }
        else { pending.removeAll() }
    }
    private func sample(_ display: CADisplayLink) {
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        label.accessibilityElementsHidden = !privacy.appIsActive || privacy.shielded
        guard privacy.appIsActive, !privacy.shielded else { pending.removeAll(); return }
        let interval = (display.targetTimestamp - display.timestamp) * 1000
        guard interval > 0, interval.isFinite else { return }
        // The target timestamp accounts for the next actual display, rather
        // than mistaking a bridge acknowledgement for a rendered frame.
        let renderedAt = Date().timeIntervalSince1970 * 1000 + max(0, display.targetTimestamp - CACurrentMediaTime()) * 1000
        for sampledAt in pending.values {
            let age = renderedAt - sampledAt
            guard age >= 0, age < 3000 else { invalidSamples += 1; continue }
            frames += 1
            maxAgeMs = max(maxAgeMs, age)
            maxAgeIntervals = max(maxAgeIntervals, age / interval)
            if age > interval { staleFrames += 1 }
        }
        if !pending.isEmpty { pending.removeAll(); publish() }
    }
    private func publish() {
        let values: [String: Double] = ["motionFrames": Double(frames), "staleFrames": Double(staleFrames),
            "invalidSamples": Double(invalidSamples), "maxPoseAgeMs": maxAgeMs,
            "maxPoseAgeIntervals": maxAgeIntervals]
        guard let data = try? JSONSerialization.data(withJSONObject: values, options: [.sortedKeys]),
              let json = String(data: data, encoding: .utf8) else { return }
        label.update(status: json)
    }
}
#endif
