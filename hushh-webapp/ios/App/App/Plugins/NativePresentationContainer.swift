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

/// One WebView, retained native underlay, bounded overlay groups. The outer
/// container routes only explicitly admitted hits; Maps keeps its WK hit path.
final class NativePresentationContainer: UIView {
    let webView: WKWebView
    let underlay = UIView()
    private var groups: [String: UIView] = [:]
    private var fences: [String: NativePanelPoseFence] = [:]
    private var controls: [String: (view: UIView, group: String?, admitted: Bool)] = [:]
    #if DEBUG
    private var continuity: NativePanelContinuityProbe?
    #endif

    init(webView: WKWebView) {
        self.webView = webView
        super.init(frame: webView.frame)
        backgroundColor = .systemBackground
        underlay.frame = bounds
        underlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.removeFromSuperview()
        webView.frame = bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(webView)
        // Keep native accessibility in front of WK's full rectangular view.
        // DOM paint apertures are not UIKit accessibility apertures. Separate
        // sibling traversal from paint order instead of forcing focus or
        // bypassing the owning control's admission fence.
        addSubview(underlay)
        underlay.layer.zPosition = -1
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

    func setCanvas(_ color: UIColor) { backgroundColor = color; underlay.backgroundColor = color }

    func install(_ view: UIView, id: String, group: String?) {
        if let group {
            let host = groupHost(group)
            host.addSubview(view)
        } else { underlay.addSubview(view) }
        controls[id] = (view, group, false)
    }

    func setAdmission(_ id: String, admitted: Bool) {
        guard var control = controls[id] else { return }
        control.admitted = admitted
        controls[id] = control
        control.view.isUserInteractionEnabled = admitted
        control.view.accessibilityElementsHidden = !admitted
    }

    func remove(_ id: String) { controls.removeValue(forKey: id)?.view.removeFromSuperview() }

    func groupPose(_ id: String) -> NativePanelPose? { fences[id]?.pose }

    func apply(_ pose: NativePanelPose, group: String, privacy: Int) -> Bool {
        guard ["profile", "history"].contains(group) else { return false }
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
        underlay.isHidden = true
        groups.values.forEach { $0.isHidden = true }
        for id in Array(controls.keys) { setAdmission(id, admitted: false) }
    }

    func revealUnderlay() { underlay.isHidden = false }

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
        for child in subviews.reversed() where child !== webView && child !== underlay && !groups.values.contains(where: { $0 === child }) {
            if let hit = child.hitTest(child.convert(point, from: self), with: event) { return hit }
        }
        // Follow actual UIKit stacking, not dictionary enumeration. The host
        // hit test enforces clipping, ancestor visibility and disabled state.
        for host in subviews.reversed() where host === underlay || groups.values.contains(where: { $0 === host }) {
            if let group = groups.first(where: { $0.value === host })?.key,
               fences[group]?.pose?.settled != true { continue }
            let local = host.convert(point, from: self)
            guard host.bounds.contains(local), let hit = host.hitTest(local, with: event) else { continue }
            if controls.values.contains(where: { control in
                control.admitted && (hit === control.view || hit.isDescendant(of: control.view))
            }) { return hit }
        }
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
