import UIKit
import WebKit

/// Opaque presentation ownership, never an account, route, or private payload.
struct NativeContentPaneIdentity: Equatable {
    let document: String
    let ownerEpoch: String
    let generation: Int
    let privacyGeneration: Int
    func sameLifetime(as other: NativeContentPaneIdentity) -> Bool {
        document == other.document && ownerEpoch == other.ownerEpoch && generation == other.generation
    }
    var valid: Bool {
        !document.isEmpty && document.count <= 128 && !ownerEpoch.isEmpty && ownerEpoch.count <= 128 &&
            generation > 0 && generation < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration &&
            privacyGeneration >= 0 && privacyGeneration < HushhSessionPrivacyState.maximumJavaScriptSafeGeneration
    }
}

struct NativeContentPaneFence {
    private(set) var identity: NativeContentPaneIdentity?
    private(set) var retiring = false
    private var retiredGeneration = 0
    mutating func acquire(_ next: NativeContentPaneIdentity) -> Bool {
        guard next.valid, next.generation > retiredGeneration else { return false }
        if let identity {
            guard !retiring, identity.document == next.document, identity.ownerEpoch == next.ownerEpoch,
                  identity.generation == next.generation, next.privacyGeneration >= identity.privacyGeneration else { return false }
        }
        identity = next
        return true
    }
    mutating func beginRetirement(_ requested: NativeContentPaneIdentity) -> Bool {
        guard requested.valid, identity == nil || identity?.sameLifetime(as: requested) == true else { return false }
        retiredGeneration = max(retiredGeneration, requested.generation)
        retiring = true
        return true
    }
    mutating func release(_ requested: NativeContentPaneIdentity) -> Bool {
        // Tombstone a not-yet-delivered acquisition as well as an installed one.
        guard requested.valid, identity == nil || identity?.sameLifetime(as: requested) == true else { return false }
        retiredGeneration = max(retiredGeneration, requested.generation)
        identity = nil
        retiring = false
        return true
    }
}

/// Capacitor resizes only WK for the keyboard. Stationary native chrome stays
/// in host coordinates; only an actual WK-sized keyboard viewport may inherit
/// the host height. Arbitrary/stale geometry is never normalized.
enum NativeChromeViewport {
    static func resolve(authored: CGSize, host: CGSize, web: CGSize, coherent: Bool, keyboard: Bool) -> CGSize? {
        guard [authored.width, authored.height, host.width, host.height, web.width, web.height]
            .allSatisfy({ $0.isFinite && $0 > 0 }) else { return nil }
        func matches(_ left: CGSize, _ right: CGSize) -> Bool {
            abs(left.width - right.width) < 1 && abs(left.height - right.height) < 1
        }
        if matches(authored, host) { return host }
        guard coherent, keyboard, matches(authored, web), abs(web.width - host.width) < 1,
              web.height <= host.height else { return nil }
        return host
    }
}

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

    var hasValidGeometry: Bool {
        frame.width > 0 && frame.height > 0 &&
            [frame.minX, frame.minY, frame.width, frame.height, offset, opacity].allSatisfy { $0.isFinite } &&
            (0...1).contains(opacity) && abs(offset) <= frame.width
    }

    func isContained(in bounds: CGRect) -> Bool {
        guard hasValidGeometry, bounds.width > 0, bounds.height > 0,
              [bounds.minX, bounds.minY, bounds.width, bounds.height].allSatisfy({ $0.isFinite }) else { return false }
        // WK's transformed client rect uses Float32 precision: a full-width
        // 390px panel was observed as 390.000030517578px. Permit only two
        // representable steps at this viewport scale, not a CSS-pixel margin.
        let scale = Float(max(1, max(bounds.width, bounds.height)))
        guard scale.isFinite else { return false }
        let roundoff = CGFloat(scale.ulp) * 2
        return bounds.insetBy(dx: -roundoff, dy: -roundoff).contains(frame)
    }
}

struct NativePanelPoseFence {
    private(set) var pose: NativePanelPose?
    private(set) var retiredGeneration = -1

    mutating func apply(_ next: NativePanelPose, privacy: Int) -> Bool {
        guard next.generation > retiredGeneration, next.sequence > 0,
              next.privacyGeneration == privacy,
              next.hasValidGeometry else { return false }
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

private enum NativeRegionRefusal: Int {
    case viewport = 1, revision, geometry, coverage, initialGeometry, poseOrder
    case initialContext
}

/// One WebView, retained native base plane, bounded overlay groups. The outer
/// container routes only explicitly admitted hits; Maps keeps its WK hit path.
final class NativePresentationContainer: UIView, UIGestureRecognizerDelegate {
    static let isolationDidChange = Notification.Name("HushhNativeDrawerIsolationDidChange")
    enum BasePresentation { case underlay, contentBacked, coherentDrawers }
    let webView: WKWebView
    let basePresentation: BasePresentation
    var contentBackedPresentation: Bool { basePresentation != .underlay }
    var legacyRegionPresentation: Bool { basePresentation == .contentBacked }
    var wholeNativeDrawers: Bool { basePresentation == .coherentDrawers }
    private var ownedDrawerIsolation = false
    var interactionIsolated: Bool { overlayIsolated || ownedDrawerIsolation }
    private(set) var isolationGeneration = 0
    let drawerClipping: Bool
    private let baseViewport = UIView()
    // Retain the legacy name for the independently reversible underlay pilot.
    let underlay = UIView()
    private let contentChrome = UIView()
    private var contentPaneFence = NativeContentPaneFence()
    var contentPane: NativeContentPaneIdentity? { contentPaneFence.identity }
    private var groups: [String: UIView] = [:]
    private var fences: [String: NativePanelPoseFence] = [:]
    private var controls: [String: (view: UIView, group: String?, pane: NativeContentPaneIdentity?, admitted: Bool)] = [:]
    private(set) var bottomChromeScrollOffset: CGFloat = 0
    private var bottomNavigationScrollOffset: CGFloat = 0
    var bottomChromePressChanged: ((Bool) -> Void)?
    var workspaceScrollChanged: ((NativeWorkspaceIdentity, CGFloat?, Bool) -> Void)?
    private(set) var workspaceScrollOwner: NativeWorkspaceIdentity?
    func ownWorkspaceScroll(_ identity: NativeWorkspaceIdentity) { workspaceScrollOwner = identity }
    func releaseWorkspaceScroll(_ identity: NativeWorkspaceIdentity) {
        guard workspaceScrollOwner == identity else { return }
        workspaceScrollOwner = nil; workspaceScrollChanged?(identity, nil, false)
    }
    func reportWorkspaceScroll(_ identity: NativeWorkspaceIdentity, y: CGFloat, fromPerson: Bool) {
        guard workspaceScrollOwner == identity, allowsControl("route-workspace") else { return }
        workspaceScrollChanged?(identity, y, fromPerson)
    }
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
    #if DEBUG
    private(set) var lastRegionRefusal = 0
    private(set) var lastRejectedInitialFrame: CGRect?
    var baseEditorFocused: Bool {
        func focused(_ view: UIView) -> Bool {
            if view.accessibilityIdentifier == "native-dock-editor" { return view.isFirstResponder }
            return view.subviews.contains(where: focused)
        }
        return focused(underlay)
    }
    #endif

    private func rejectRegion(_ reason: NativeRegionRefusal) -> Bool {
        #if DEBUG
        lastRegionRefusal = reason.rawValue
        #endif
        return false
    }

    func setRegions(document: String, revision: Int, viewport: CGSize, top: CGFloat, bottom: CGFloat, isolated: Bool, covered: Bool = false, privacyGeneration: Int? = nil, drawer: String? = nil, initialPose: NativePanelPose? = nil) -> Bool {
        // The coherent owner has no React/native pose or clipping path.
        guard !wholeNativeDrawers else { return rejectRegion(.coverage) }
        guard contentBackedPresentation, viewport == bounds.size else { return rejectRegion(.viewport) }
        guard revision >= 0, regionDocument != document || revision > regionRevision else { return rejectRegion(.revision) }
        guard top.isFinite, bottom.isFinite, top >= 0, bottom >= 0,
              top + bottom < viewport.height else { return rejectRegion(.geometry) }
        guard !covered || isolated && privacyGeneration != nil,
              regionDocument != document || regionPrivacyGeneration == nil || privacyGeneration != nil,
              drawer == nil || drawerClipping && covered && ["profile", "history"].contains(drawer!) else { return rejectRegion(.coverage) }
        // Stage both fences before changing the visible plane. Invalid initial
        // geometry must not partially commit coverage or a newer revision.
        var stagedFence: NativePanelPoseFence?
        if let initialPose {
            guard let drawer, let privacyGeneration, covered, isolated, !privacyConcealed,
                  initialPose.document == document,
                  privacyGeneration == HushhSessionPrivacyShield.shared.snapshot().generation else { return rejectRegion(.initialContext) }
            guard initialPose.isContained(in: bounds),
                  abs(initialPose.frame.minY) <= 1, abs(initialPose.frame.maxY - bounds.height) <= 1,
                  initialPose.hasValidGeometry,
                  initialPose.opacity == 0 || initialPose.opacity == 1 else {
                #if DEBUG
                lastRejectedInitialFrame = initialPose.frame
                #endif
                return rejectRegion(.initialGeometry)
            }
            var fence = fences[drawer] ?? NativePanelPoseFence()
            if !fence.apply(initialPose, privacy: privacyGeneration) {
                // An ordinary pose can overtake initial sampling while this
                // newer, compatible region waits in the bridge. Keep its
                // already admitted geometry; never rewind or inherit another
                // drawer owner, generation or privacy state.
                guard coverageRevision == regionRevision,
                      drawerCoverageIsSuperseded(initialPose, group: drawer,
                        privacy: privacyGeneration, revision: regionRevision) else { return rejectRegion(.poseOrder) }
            }
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
        guard contentBackedPresentation, bounds.contains(frame) else { return false }
        // Complete native drawers share this hierarchy; no React pose or
        // reserved-region receipt exists in that mode. Document/privacy and
        // authored-family fences remain in the plugin admission owner.
        if wholeNativeDrawers { return true }
        guard regionDocument == document else { return false }
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
        contentChrome.frame = bounds
        contentChrome.backgroundColor = .clear
        contentChrome.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(contentChrome)
        let press = NativeBottomChromePressObserver { [weak self] held in self?.bottomChromePressChanged?(held) }
        press.cancelsTouchesInView = false
        press.delaysTouchesBegan = false
        press.delaysTouchesEnded = false
        press.delegate = self
        underlay.addGestureRecognizer(press)
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

    func install(_ view: UIView, id: String, group: String?, pane: NativeContentPaneIdentity? = nil) {
        if pane != nil { contentChrome.addSubview(view) }
        else if let group {
            let host = groupHost(group)
            host.addSubview(view)
        } else { underlay.addSubview(view) }
        controls[id] = (view, group, pane, false)
        if Self.bottomChromeIds.contains(id), pane == nil {
            view.transform = CGAffineTransform(translationX: 0, y: bottomScrollOffset(for: id))
        }
    }

    private static let bottomChromeIds: Set<String> = ["bottom-navigation", "agent-dock"]
    /// Both retained native surfaces move in one UIKit transaction. The tab bar
    /// includes UIKit's bottom safe area; the dock must keep that area clear.
    /// Header, WebView, layout reservations and action admission stay in place.
    func setBottomChromeScrollOffset(_ offset: CGFloat, navigationOffset: CGFloat? = nil) {
        let navigation = navigationOffset ?? offset
        guard offset.isFinite, (0...160).contains(offset),
              navigation.isFinite, (0...160).contains(navigation) else { return }
        bottomChromeScrollOffset = offset
        bottomNavigationScrollOffset = navigation
        UIView.performWithoutAnimation {
            for (id, control) in controls where Self.bottomChromeIds.contains(id) && control.pane == nil {
                control.view.transform = CGAffineTransform(translationX: 0, y: bottomScrollOffset(for: id))
            }
        }
    }
    private func bottomScrollOffset(for id: String) -> CGFloat {
        id == "bottom-navigation" ? bottomNavigationScrollOffset : bottomChromeScrollOffset
    }
    func restingBottomChromeFrame(_ id: String) -> CGRect? {
        guard Self.bottomChromeIds.contains(id), let control = controls[id], control.pane == nil else { return nil }
        return control.view.convert(control.view.bounds, to: self).offsetBy(dx: 0, dy: -bottomScrollOffset(for: id))
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard gestureRecognizer is NativeBottomChromePressObserver, let touched = touch.view else { return true }
        return !interactionIsolated && controls.contains { id, control in
            Self.bottomChromeIds.contains(id) && control.admitted &&
                (touched === control.view || touched.isDescendant(of: control.view))
        }
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        gestureRecognizer is NativeBottomChromePressObserver || otherGestureRecognizer is NativeBottomChromePressObserver
    }

    /// A full-height React pane owns WK's whole paint plane, not frame-by-frame
    /// clipping. Base hosts survive behind WK; only its authored header is above.
    func acquireContentPane(_ identity: NativeContentPaneIdentity, viewport: CGSize) -> Bool {
        guard wholeNativeDrawers, viewport == bounds.size, !privacyConcealed,
              identity.privacyGeneration == HushhSessionPrivacyShield.shared.snapshot().generation,
              contentPaneFence.acquire(identity) else { return false }
        underlay.layer.zPosition = -1
        for (id, control) in controls where control.pane != identity { setAdmission(id, admitted: false) }
        return true
    }

    func releaseContentPane(_ identity: NativeContentPaneIdentity) -> Bool {
        guard !controls.values.contains(where: { $0.pane?.sameLifetime(as: identity) == true }), contentPaneFence.release(identity) else { return false }
        underlay.layer.zPosition = contentBackedPresentation ? 0 : -1
        // Fresh feature bindings must re-admit; old covered permissions never return.
        NotificationCenter.default.post(name: Self.isolationDidChange, object: self)
        return true
    }
    func beginContentPaneRetirement(_ identity: NativeContentPaneIdentity) -> Bool {
        guard contentPaneFence.beginRetirement(identity) else { return false }
        for id in Array(controls.keys) { setAdmission(id, admitted: false) }
        return true
    }
    func contentPaneAdmits(_ identity: NativeContentPaneIdentity) -> Bool {
        !contentPaneFence.retiring && contentPane == identity
    }

    func resetContentPane() {
        contentPaneFence = NativeContentPaneFence()
        underlay.layer.zPosition = contentBackedPresentation ? 0 : -1
    }

    func allowsControl(_ id: String) -> Bool {
        guard !privacyConcealed, !ownedDrawerIsolation, !overlayIsolated, let control = controls[id] else { return false }
        if let pane = control.pane {
            return contentPaneAdmits(pane) && pane.privacyGeneration == HushhSessionPrivacyShield.shared.snapshot().generation
        }
        return contentPane == nil
    }

    func setAdmission(_ id: String, admitted: Bool, presentationRegionRevision: Int? = nil, privacyGeneration: Int? = nil) {
        guard var control = controls[id] else { return }
        let currentRegion = acceptsPresentationRevision(presentationRegionRevision, privacyGeneration: privacyGeneration)
        let admitted = admitted && currentRegion && allowsControl(id)
        control.admitted = admitted
        controls[id] = control
        control.view.isUserInteractionEnabled = admitted
        control.view.accessibilityElementsHidden = !admitted
    }

    func remove(_ id: String) { controls.removeValue(forKey: id)?.view.removeFromSuperview() }

    /// Geometry only, from the existing authored installation. A drawer may
    /// align its own Close with its opener without a second CSS inset constant
    /// or per-frame bridge synchronization. This grants no action admission.
    func installedFrame(_ id: String) -> CGRect? {
        guard let control = controls[id], control.view.superview != nil,
              control.view.window != nil else { return nil }
        return control.view.convert(control.view.bounds, to: self)
    }

    #if DEBUG
    enum DiagnosticHit: String { case target, web, drawer, privacy, navigation, other, none }
    struct ControlHitEvidence {
        let admitted: Bool
        let allowed: Bool
        let isolated: Bool
        let pane: Bool
        let hidden: Bool
        let touchBlocked: Bool
        let axHidden: Bool
        let frame: CGRect
        let containerHits: [DiagnosticHit]
        let windowHits: [DiagnosticHit]
    }

    /// Observation, never admission or a dispatched event. Fixed roles replace
    /// arbitrary labels/identifiers; a window interceptor can differ from this
    /// container's own hit even when the authored rectangle is unchanged.
    func controlHitEvidence(_ id: String) -> ControlHitEvidence? {
        guard let control = controls[id], let window = control.view.window,
              !privacyConcealed else { return nil }
        let view = control.view
        let frame = view.convert(view.bounds, to: window)
        guard [frame.minX, frame.minY, frame.width, frame.height].allSatisfy({ $0.isFinite && abs($0) <= 10_000 }),
              frame.width > 0, frame.height > 0 else { return nil }
        var hidden = false, touchBlocked = false, axHidden = false
        var ancestor: UIView? = view
        while let current = ancestor {
            hidden = hidden || current.isHidden || current.alpha <= 0.01
            touchBlocked = touchBlocked || !current.isUserInteractionEnabled
            axHidden = axHidden || current.accessibilityElementsHidden
            ancestor = current.superview
        }
        func role(_ hit: UIView?) -> DiagnosticHit {
            guard let hit else { return .none }
            if hit === view || hit.isDescendant(of: view) { return .target }
            if hit === webView || hit.isDescendant(of: webView) { return .web }
            var current: UIView? = hit
            while let candidate = current {
                switch candidate.accessibilityIdentifier {
                case "session-privacy-shield": return .privacy
                case "native-private-drawer", "native-history-drawer-body", "native-profile-drawer-body", "native-agent-profile-drawer-body": return .drawer
                case "one-native-navigation": return .navigation
                default: current = candidate.superview
                }
            }
            return .other
        }
        let fractions: [CGPoint] = [.init(x: 0.5, y: 0.5), .init(x: 0.25, y: 0.5),
            .init(x: 0.75, y: 0.5), .init(x: 0.5, y: 0.25), .init(x: 0.5, y: 0.75)]
        let points = fractions.map { CGPoint(x: frame.minX + frame.width * $0.x, y: frame.minY + frame.height * $0.y) }
        return ControlHitEvidence(admitted: control.admitted, allowed: allowsControl(id),
            isolated: interactionIsolated, pane: contentPane != nil, hidden: hidden,
            touchBlocked: touchBlocked, axHidden: axHidden, frame: frame,
            containerHits: points.map { role(hitTest(convert($0, from: window), with: nil)) },
            windowHits: points.map { role(window.hitTest($0, with: nil)) })
    }
    #endif

    /// Called synchronously by the complete native drawer owner. Covering a
    /// base surface changes eligibility, never its paint or retained identity.
    func isolateForOwnedDrawer(_ covered: Bool) {
        guard wholeNativeDrawers, ownedDrawerIsolation != covered else { return }
        ownedDrawerIsolation = covered
        isolationGeneration += 1
        webView.isUserInteractionEnabled = !covered
        webView.accessibilityElementsHidden = covered
        underlay.isUserInteractionEnabled = !covered
        underlay.accessibilityElementsHidden = covered
        if covered {
            // Touch/AX exclusion does not resign a retained first responder.
            // Complete IME editing through UIKit before the modal owns input;
            // never let hardware keys continue into the covered composer.
            webView.endEditing(true)
            underlay.endEditing(true)
            for id in Array(controls.keys) { setAdmission(id, admitted: false) }
        }
        NotificationCenter.default.post(name: Self.isolationDidChange, object: self)
        // Uncovering does not restore captured permissions. The current feature
        // bindings must explicitly re-admit their actions after settlement.
    }

    func groupPose(_ id: String) -> NativePanelPose? { fences[id]?.pose }

    /// Mirror the authored drawer's rectangular coverage, not its decisions or
    /// its scrim. A missing/currently unconfirmed pose exposes no base pixels.
    func drawerCoverageIsSuperseded(_ pose: NativePanelPose, group: String, privacy: Int, revision: Int) -> Bool {
        guard drawerClipping, fullWindowCovered, overlayIsolated, !privacyConcealed,
              regionDrawer == group, regionDocument == pose.document,
              regionRevision == revision, regionPrivacyGeneration == privacy,
              let current = fences[group]?.pose,
              current.document == pose.document, current.ownerEpoch == pose.ownerEpoch,
              current.generation == pose.generation, current.privacyGeneration == pose.privacyGeneration,
              pose.privacyGeneration == privacy, pose.sequence > 0, pose.hasValidGeometry,
              pose.opacity == 0 || pose.opacity == 1 else { return false }
        // Atomic admission may overtake a pose already in flight. This is a
        // no-op acknowledgement, never permission to apply its older geometry.
        return pose.sequence <= current.sequence
    }

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
        lastRegionRefusal = 0
        lastRejectedInitialFrame = nil
        #endif
        privacyConcealed = true
        contentChrome.isHidden = true
        reconcileBaseVisibility()
        groups.values.forEach { $0.isHidden = true }
        for id in Array(controls.keys) { setAdmission(id, admitted: false) }
    }

    func revealUnderlay(presentationRegionRevision: Int? = nil, privacyGeneration: Int? = nil) {
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        guard privacy.appIsActive, !privacy.shielded,
              acceptsPresentationRevision(presentationRegionRevision, privacyGeneration: privacyGeneration) else { return }
        privacyConcealed = false
        contentChrome.isHidden = false
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
        for child in subviews.reversed() where child !== webView && child !== underlay && child !== contentChrome && child !== baseViewport && !groups.values.contains(where: { $0 === child }) {
            if let hit = child.hitTest(child.convert(point, from: self), with: event) { return hit }
        }
        // Follow actual UIKit stacking, not dictionary enumeration. The host
        // hit test enforces clipping, ancestor visibility and disabled state.
        let presentationHosts = subviews.map { $0 === baseViewport ? underlay : $0 }
        for host in presentationHosts.reversed() where host === underlay || host === contentChrome || groups.values.contains(where: { $0 === host }) {
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

/// Observes a native press without consuming it or moving its target. The
/// complete touch lifetime quarantines scroll updates, not normal actions.
private final class NativeBottomChromePressObserver: UIGestureRecognizer {
    private let changed: (Bool) -> Void
    private var held = false
    private var touches = Set<UITouch>()
    init(_ changed: @escaping (Bool) -> Void) { self.changed = changed; super.init(target: nil, action: nil) }
    private func hold(_ value: Bool) { if held != value { held = value; changed(value) } }
    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) { self.touches.formUnion(touches); state = .began; hold(true) }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) { state = .changed }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        self.touches.subtract(touches)
        if self.touches.isEmpty { state = .ended; hold(false) }
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        self.touches.subtract(touches)
        if self.touches.isEmpty { state = .cancelled; hold(false) }
    }
    override func reset() { touches.removeAll(); hold(false); super.reset() }
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
