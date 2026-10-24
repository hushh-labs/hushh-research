import Capacitor
import UIKit

/// Presentation metadata only. React retains routing, consent and session authority.
struct HushhNativeNavigationState {
    static let contractVersion = 3
    static let tabs = ["chat", "dashboard", "connect", "feed"]
    private(set) var documentId: String?
    private(set) var revision = -1
    private(set) var visible = false
    private(set) var interactionEnabled = false
    private(set) var selected = "chat"
    private(set) var interactionEpoch = -1
    private var retiredDocuments = Set<String>()

    mutating func retireDocument() {
        if let documentId { retiredDocuments.insert(documentId) }
        documentId = nil
        revision = -1
        visible = false
        interactionEnabled = false
    }

    mutating func apply(document: String, revision: Int, visible: Bool, selected: String, interactionEpoch: Int = 0, interactionEnabled: Bool = true) -> Bool {
        guard !document.isEmpty, document.count <= 128, !retiredDocuments.contains(document),
              revision >= 0, interactionEpoch >= 0,
              Self.tabs.contains(selected) else { return false }
        if let previous = documentId, previous != document { retireDocument() }
        guard revision > self.revision else { return false }
        documentId = document
        self.revision = revision
        self.visible = visible
        self.interactionEnabled = interactionEnabled
        self.selected = selected
        self.interactionEpoch = interactionEpoch
        return true
    }

    func isPresented(appIsActive: Bool, shielded: Bool, keyboardVisible: Bool) -> Bool {
        visible && appIsActive && !shielded && !keyboardVisible
    }

    func acceptsTap(_ tab: String, appIsActive: Bool, shielded: Bool, keyboardVisible: Bool) -> Bool {
        isPresented(appIsActive: appIsActive, shielded: shielded, keyboardVisible: keyboardVisible) &&
            interactionEnabled && Self.tabs.contains(tab)
    }
}

/// A separate presentation fence: motion never changes routing or tap authority.
struct HushhNativeNavigationScrollState {
    private(set) var generation = 0
    private(set) var sequence = 0
    mutating func invalidate() { generation += 1; sequence = 0 }
    mutating func apply(generation: Int, sequence: Int, progress: Double, travel: Double) -> CGFloat? {
        guard generation == self.generation, sequence > self.sequence,
              sequence <= HushhSessionPrivacyState.maximumJavaScriptSafeGeneration,
              progress.isFinite, (0...1).contains(progress), travel.isFinite, (0...160).contains(travel) else { return nil }
        self.sequence = sequence
        return CGFloat(progress * travel)
    }
}

/// Native-scroller counterpart of kai-bottom-chrome-visibility's authored
/// displacement policy. Only the active renderer supplies scroll samples.
struct HushhNativeContentScrollState {
    private var lastY: CGFloat?
    private var direction: CGFloat = 0
    private var distance: CGFloat = 0
    private(set) var progress: CGFloat = 0
    mutating func reset(progress: CGFloat = 0) { lastY = nil; direction = 0; distance = 0; self.progress = min(1, max(0, progress)) }
    mutating func apply(y: CGFloat, fromPerson: Bool) -> CGFloat? {
        guard y.isFinite else { return nil }
        let next = max(0, y)
        guard let previous = lastY else { lastY = next; return progress }
        lastY = next
        if !fromPerson && next > 10 { return nil }
        let delta = next - previous
        if next <= 10 { direction = -1; distance = 0; progress = 0; return 0 }
        guard abs(delta) >= 1.5 else { return nil }
        let nextDirection: CGFloat = delta > 0 ? 1 : -1
        if nextDirection != direction { direction = nextDirection; distance = 0 }
        distance += abs(delta)
        guard distance >= 15 else { return nil }
        progress = min(1, max(0, progress + delta / 84)); return progress
    }
}

enum HushhNativeNavigationArtwork {
    static func items(image: (String) -> UIImage? = { UIImage(named: $0) }) -> [UITabBarItem]? {
        let labels = ["Chat", "One", "Connect", "Feed"]
        var items = [UITabBarItem]()
        for (index, tab) in HushhNativeNavigationState.tabs.enumerated() {
            // Assets are generated from the shared Phosphor registry descriptor.
            // A partial catalog must keep the DOM fallback, not show blank tabs.
            guard let normal = image("HushhNav-\(tab)-default"),
                  let selected = image("HushhNav-\(tab)-selected") else { return nil }
            let item = UITabBarItem(title: labels[index],
                image: normal.withRenderingMode(.alwaysTemplate),
                selectedImage: selected.withRenderingMode(.alwaysTemplate))
            item.tag = index
            item.accessibilityIdentifier = "one-native-tab-\(tab)"
            items.append(item)
        }
        return items
    }
}

/// The DOM shell owns painted width and content padding. UIKit owns its safe area.
struct HushhNativeNavigationColumn {
    // iOS 26's standard floating capsule paints 22pt inside UITabBar's bounds.
    // Synthetic native captures at 320–760pt qualify this optical allowance.
    static let glassHorizontalInset: CGFloat = 22
    let x: CGFloat
    let width: CGFloat
    let contentHeight: CGFloat
    let viewportWidth: CGFloat

    init?(projection: JSObject?) {
        guard let projection, let x = projection["x"] as? Double,
              let width = projection["width"] as? Double, let height = projection["contentHeight"] as? Double,
              let viewport = projection["viewportWidth"] as? Double,
              [x, width, height, viewport].allSatisfy({ $0.isFinite }),
              x >= 0, width >= 220, (49...120).contains(height), viewport > 0,
              x + width <= viewport + 0.5 else { return nil }
        self.x = x; self.width = width; contentHeight = height; viewportWidth = viewport
    }

    func frame(in host: UIView, webView: UIView, bottomInset: CGFloat) -> CGRect? {
        let scale = webView.bounds.width / viewportWidth
        let origin = webView.convert(CGPoint(x: x * scale, y: 0), to: host).x
        let projectedWidth = width * scale
        guard scale.isFinite, scale > 0, origin >= 0,
              origin + projectedWidth <= host.bounds.width + 0.5 else { return nil }
        let fullHeight = contentHeight + bottomInset
        return CGRect(x: origin - Self.glassHorizontalInset, y: host.bounds.height - fullHeight,
            width: projectedWidth + 2 * Self.glassHorizontalInset, height: fullHeight)
    }
}

@objc(HushhNativeNavigationPlugin)
final class HushhNativeNavigationPlugin: CAPPlugin, CAPBridgedPlugin, UITabBarDelegate {
    let identifier = "HushhNativeNavigationPlugin"
    let jsName = "HushhNativeNavigation"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setScroll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmSelection", returnType: CAPPluginReturnPromise),
    ]
    private var state = HushhNativeNavigationState()
    private var scrollState = HushhNativeNavigationScrollState()
    private var contentScrollState = HushhNativeContentScrollState()
    private var scrollFollowing = false
    private var scrollPressHeld = false
    private var pendingScrollSnap = false
    private var admissionRegionRevision: Int?
    private var admissionPrivacyGeneration: Int?
    private var tabBar: UITabBar?
    private var observers = [NSObjectProtocol]()
    private(set) var keyboardVisible = false
    private var keyboardHidePending = false
    private var contentHeight: CGFloat = 0
    private var bottomInset: CGFloat = 0
    private var column: HushhNativeNavigationColumn?
    private var tapSequence = 0
    private var confirmedSequence = 0
    private var retiredRestartGeneration = -1
    private lazy var navigationItems = HushhNativeNavigationArtwork.items()
    private var compositor: NativePresentationContainer? { bridge?.viewController?.view as? NativePresentationContainer }
    #if DEBUG
    private var presentationProbe: NativeTestStatusLabel?
    #endif

    override func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let center = NotificationCenter.default
            for name in [UIResponder.keyboardWillShowNotification, UIResponder.keyboardWillHideNotification,
                         UIResponder.keyboardDidHideNotification,
                         UIApplication.willResignActiveNotification, UIApplication.didBecomeActiveNotification,
                         HushhSessionPrivacyShield.presentationDidChange, NativePresentationContainer.isolationDidChange] {
                self.observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                    guard let self else { return }
                    if note.name == NativePresentationContainer.isolationDidChange {
                        guard note.object as? NativePresentationContainer === self.compositor else { return }
                        self.confirmedSequence = self.tapSequence
                    }
                    if note.name == UIResponder.keyboardWillShowNotification {
                        self.keyboardVisible = true; self.keyboardHidePending = false
                    }
                    if note.name == UIResponder.keyboardWillHideNotification {
                        self.keyboardVisible = true; self.keyboardHidePending = true
                    }
                    if note.name == UIResponder.keyboardDidHideNotification {
                        guard self.keyboardHidePending else { return }
                        self.keyboardVisible = false; self.keyboardHidePending = false
                    }
                    self.updatePresentation()
                    self.invalidateScroll(snap: note.name == UIResponder.keyboardWillShowNotification)
                })
            }
        }
    }

    deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    @objc func getCapabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if #available(iOS 26.0, *) {
                call.resolve(["contractVersion": HushhNativeNavigationState.contractVersion, "columnLayout": true, "interactionIsolation": true,
                              "underlayPresentation": self.compositor != nil && self.compositor?.contentBackedPresentation != true,
                              "contentBackedPresentation": self.compositor?.legacyRegionPresentation == true,
                              "reservedPresentationRegions": self.compositor?.legacyRegionPresentation == true,
                              "fullWindowOverlays": self.compositor?.legacyRegionPresentation == true,
                              "wholeNativeDrawers": self.compositor?.wholeNativeDrawers == true,
                              "synchronizedBottomScroll": self.compositor?.wholeNativeDrawers == true && UIDevice.current.userInterfaceIdiom == .phone,
                              "supported": self.navigationItems != nil,
                              "contentHeight": self.contentHeight, "bottomInset": self.bottomInset])
            } else {
                call.resolve(["contractVersion": HushhNativeNavigationState.contractVersion, "supported": false, "contentHeight": 0, "bottomInset": 0])
            }
        }
    }

    @objc func setState(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            guard #available(iOS 26.0, *) else {
                call.resolve(["supported": false, "contentHeight": 0, "bottomInset": 0]); return
            }
            guard let document = call.getString("documentId"), let revision = call.getInt("revision"),
                  let visible = call.getBool("visible"), let selected = call.getString("selected"),
                  let epoch = call.getInt("interactionEpoch"),
                  let column = HushhNativeNavigationColumn(projection: call.getObject("column")),
                  let theme = HushhNativeControlAppearance(appearance: call.getString("appearance"),
                    accentHex: call.getString("accentHex"), foregroundHex: call.getString("foregroundHex")) else {
                call.reject("NATIVE_NAVIGATION_INVALID_STATE"); return
            }
            let shield = HushhSessionPrivacyShield.shared
            self.updatePresentation() // Consume pending restart retirement before observing the replacement.
            shield.observeDocument(document)
            guard shield.acceptsDocument(document) else {
                call.reject("NATIVE_NAVIGATION_STALE_STATE"); return
            }
            guard self.compositor?.acceptsPresentationRevision(call.getInt("presentationRegionRevision"),
                privacyGeneration: call.getInt("privacyGeneration")) != false else {
                call.resolve(["supported": true, "contentHeight": self.contentHeight,
                    "bottomInset": self.bottomInset, "presentationApplied": false]); return
            }
            guard self.state.apply(document: document, revision: revision,
                      visible: visible, selected: selected, interactionEpoch: epoch,
                      interactionEnabled: call.getBool("interactionEnabled") ?? visible) else {
                call.reject("NATIVE_NAVIGATION_STALE_STATE"); return
            }
            self.admissionRegionRevision = call.getInt("presentationRegionRevision")
            self.admissionPrivacyGeneration = call.getInt("privacyGeneration")
            self.column = column
            self.scrollState.invalidate()
            self.scrollFollowing = call.getBool("scrollFollowing") == true && self.compositor?.wholeNativeDrawers == true &&
                UIDevice.current.userInterfaceIdiom == .phone
            if !self.scrollFollowing { self.reconcileScrollSnap(requested: true) }
            self.installIfNeeded()
            if let feed = self.tabBar?.items?.first(where: { $0.tag == 3 }) {
                feed.badgeValue = call.getBool("feedAttention") == true ? " " : nil
                // A 4pt badge font shrinks UIKit's pill to a small round attention dot.
                let dot: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 4)]
                feed.setBadgeTextAttributes(dot, for: .normal)
                feed.setBadgeTextAttributes(dot, for: .selected)
            }
            self.tabBar?.overrideUserInterfaceStyle = theme.style
            self.tabBar?.tintColor = theme.accent
            self.updatePresentation()
            self.layoutTabBar()
            call.resolve(self.geometryReceipt())
        }
    }

    @objc func setScroll(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { call.resolve(["applied": false]); return }
            let privacy = HushhSessionPrivacyShield.shared.snapshot()
            guard Set(call.options.keys).isSubset(of: ["documentId", "revision", "interactionEpoch", "privacyGeneration", "scrollGeneration", "sequence", "progress", "travel"]),
                  self.scrollActive, let container = self.compositor, container.workspaceScrollOwner == nil,
                  call.getString("documentId") == self.state.documentId,
                  call.getInt("revision") == self.state.revision,
                  call.getInt("interactionEpoch") == self.state.interactionEpoch,
                  call.getInt("privacyGeneration") == privacy.generation,
                  let generation = call.getInt("scrollGeneration"), let sequence = call.getInt("sequence"),
                  let progress = call.getDouble("progress"), let travel = call.getDouble("travel"),
                  let offset = self.scrollState.apply(generation: generation, sequence: sequence, progress: progress, travel: travel) else {
                call.resolve(["applied": false]); return
            }
            self.applyScroll(offset: offset, progress: CGFloat(progress), in: container)
            self.publishPresentationProbe()
            call.resolve(["applied": true])
        }
    }

    private var scrollActive: Bool {
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        return compositor?.wholeNativeDrawers == true && compositor?.interactionIsolated == false && compositor?.contentPane == nil &&
            scrollFollowing && !scrollPressHeld && state.visible && state.interactionEnabled && privacy.appIsActive && !privacy.shielded && !keyboardVisible
    }
    private func applyScroll(offset: CGFloat, progress: CGFloat, in container: NativePresentationContainer) {
        let reduced = UIAccessibility.isReduceMotionEnabled
        container.setBottomChromeScrollOffset(reduced ? 0 : offset,
            navigationOffset: reduced ? 0 : min(160, offset + bottomInset * progress))
    }
    @discardableResult private func reconcileScrollSnap(requested: Bool) -> Bool {
        pendingScrollSnap = pendingScrollSnap || requested
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        guard pendingScrollSnap, !scrollPressHeld, compositor?.interactionIsolated == false,
              compositor?.contentPane == nil, privacy.appIsActive, !privacy.shielded else { return false }
        pendingScrollSnap = false
        compositor?.setBottomChromeScrollOffset(0)
        return true
    }
    private func invalidateScroll(snap: Bool) {
        scrollState.invalidate()
        let snapped = reconcileScrollSnap(requested: snap)
        let travel = ceil(contentHeight) + 6
        contentScrollState.reset(progress: snap || snapped ? 0 : (compositor?.bottomChromeScrollOffset ?? 0) / max(1, travel))
        guard let document = state.documentId else { return }
        notifyListeners("scrollResetRequested", data: ["documentId": document, "revision": state.revision,
            "interactionEpoch": state.interactionEpoch, "privacyGeneration": HushhSessionPrivacyShield.shared.snapshot().generation,
            "scrollGeneration": scrollState.generation, "active": scrollActive, "snap": snapped])
    }

    @objc func confirmSelection(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let privacy = HushhSessionPrivacyShield.shared.snapshot()
            let sequence = call.getInt("sequence") ?? -1
            let tab = call.getString("tab") ?? ""
            let valid = self.compositor?.interactionIsolated != true && call.getString("documentId") == self.state.documentId &&
                call.getInt("interactionEpoch") == self.state.interactionEpoch &&
                call.getInt("privacyGeneration") == privacy.generation &&
                sequence == self.tapSequence && sequence > self.confirmedSequence &&
                self.currentColumnFrame != nil &&
                self.state.acceptsTap(tab, appIsActive: privacy.appIsActive,
                                      shielded: privacy.shielded, keyboardVisible: self.keyboardVisible)
            if valid { self.confirmedSequence = sequence }
            call.resolve(["valid": valid])
        }
    }

    @available(iOS 26.0, *)
    private func installIfNeeded() {
        guard tabBar == nil, let host = bridge?.viewController?.view, let items = navigationItems else { return }
        let bar = UITabBar()
        bar.accessibilityIdentifier = "one-native-navigation"
        bar.isHidden = true
        bar.delegate = self
        // Keep Apple's standard appearance: no custom blur, material or background image.
        bar.unselectedItemTintColor = .label
        bar.itemPositioning = .fill
        bar.items = items
        // A shield installed before the bridge call must remain above native controls.
        if let compositor {
            compositor.install(bar, id: "bottom-navigation", group: nil)
            compositor.bottomChromePressChanged = { [weak self] held in
                guard let self else { return }
                self.scrollPressHeld = held
                // Hold the current visual position through release. Snapping
                // on touch-down would move touch-up-inside away from the finger.
                self.invalidateScroll(snap: false)
            }
            compositor.workspaceScrollChanged = { [weak self, weak compositor] identity, y, fromPerson in
                guard let self, let compositor else { return }
                guard let y else { self.contentScrollState.reset(); self.invalidateScroll(snap: true); return }
                guard compositor.workspaceScrollOwner == identity, self.state.documentId == identity.documentId, self.scrollActive,
                      let progress = self.contentScrollState.apply(y: y, fromPerson: fromPerson) else { return }
                let travel = ceil(self.contentHeight) + 6
                self.applyScroll(offset: min(160, progress * travel), progress: progress, in: compositor)
                self.publishPresentationProbe()
            }
        } else if let shield = host.subviews.first(where: { $0.accessibilityIdentifier == HushhSessionPrivacyShield.accessibilityIdentifier }) {
            host.insertSubview(bar, belowSubview: shield)
        } else {
            host.addSubview(bar)
        }
        tabBar = bar
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--hushh-native-chrome-diagnostics") {
            let probe = NativeTestStatusLabel(frame: CGRect(x: 0, y: host.safeAreaInsets.top, width: 1, height: 1), showOverlay: false)
            probe.accessibilityIdentifier = "native-navigation-presentation"
            host.addSubview(probe)
            presentationProbe = probe
        }
        #endif
    }

    private var currentColumnFrame: CGRect? {
        guard let host = bridge?.viewController?.view, let webView = bridge?.webView, let column else { return nil }
        return column.frame(in: host, webView: webView, bottomInset: host.safeAreaInsets.bottom)
    }

    func layoutTabBar() {
        guard let bar = tabBar, let column, let restingFrame = currentColumnFrame else {
            tabBar?.isHidden = true; tabBar?.isUserInteractionEnabled = false; return
        }
        let previousFrame = CGRect(origin: CGPoint(x: bar.center.x - bar.bounds.width / 2, y: bar.center.y - bar.bounds.height / 2), size: bar.bounds.size)
        // UIView.frame is undefined under a nonidentity transform. Layout owns
        // the authored column's resting bounds/center; scroll owns translation.
        bar.bounds = CGRect(origin: .zero, size: restingFrame.size)
        bar.center = CGPoint(x: restingFrame.midX, y: restingFrame.midY)
        let next = column.contentHeight
        let inset = restingFrame.height - next
        if abs(next - contentHeight) > 0.5 || abs(inset - bottomInset) > 0.5 || previousFrame != restingFrame {
            contentHeight = next
            bottomInset = inset
            notifyListeners("geometryChanged", data: geometryReceipt())
        }
        publishPresentationProbe()
    }

    private func updatePresentation() {
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        if privacy.shielded && privacy.cause == "restart" && privacy.generation != retiredRestartGeneration {
            state.retireDocument()
            retiredRestartGeneration = privacy.generation
        }
        let show = currentColumnFrame != nil && state.isPresented(appIsActive: privacy.appIsActive,
                                     shielded: privacy.shielded, keyboardVisible: keyboardVisible && compositor?.wholeNativeDrawers != true)
        let interactive = currentColumnFrame != nil && compositor?.interactionIsolated != true && state.acceptsTap(state.selected, appIsActive: privacy.appIsActive,
                                          shielded: privacy.shielded, keyboardVisible: keyboardVisible && compositor?.wholeNativeDrawers != true)
        tabBar?.isHidden = !show
        tabBar?.isUserInteractionEnabled = interactive
        tabBar?.accessibilityElementsHidden = !interactive
        if show { compositor?.revealUnderlay(presentationRegionRevision: admissionRegionRevision, privacyGeneration: admissionPrivacyGeneration) }
        compositor?.setAdmission("bottom-navigation", admitted: interactive,
            presentationRegionRevision: admissionRegionRevision, privacyGeneration: admissionPrivacyGeneration)
        tabBar?.selectedItem = tabBar?.items?.first(where: {
            HushhNativeNavigationState.tabs[$0.tag] == state.selected
        })
        publishPresentationProbe()
    }

    private func geometryReceipt() -> [String: Any] {
        var receipt: [String: Any] = ["supported": tabBar != nil, "contentHeight": contentHeight, "bottomInset": bottomInset,
                                      "documentId": state.documentId ?? "", "revision": state.revision,
                                      "scrollGeneration": scrollState.generation,
                                      "scrollFollowing": scrollFollowing,
                                      "privacyGeneration": HushhSessionPrivacyShield.shared.snapshot().generation]
        if let bar = tabBar, compositor != nil {
            let resting = (compositor?.restingBottomChromeFrame("bottom-navigation") ?? bar.frame)
                .intersection(compositor?.bounds ?? bar.superview?.bounds ?? bar.frame)
            receipt["frame"] = ["x": resting.minX, "y": resting.minY, "width": resting.width, "height": resting.height]
        }
        return receipt
    }

    private func publishPresentationProbe() {
        #if DEBUG
        guard let bar = tabBar, let probe = presentationProbe else { return }
        // Public presentation only; never routes, owners, drafts or credentials.
        var fields: [String: Any] = ["visible": !bar.isHidden, "interactive": bar.isUserInteractionEnabled,
                                    "scrollFollowing": scrollFollowing, "scrollActive": scrollActive,
                                    "scrollPressHeld": scrollPressHeld, "keyboardVisible": keyboardVisible,
                                    "scrollOffset": compositor?.bottomChromeScrollOffset ?? 0,
                                    "scrollSequence": scrollState.sequence,
                                    "accessibilityHidden": bar.accessibilityElementsHidden,
                                    "underlay": compositor.map { bar.superview === $0.underlay && $0.underlay.layer.zPosition < $0.webView.layer.zPosition } ?? false,
                                    "x": bar.frame.minX, "y": bar.frame.minY,
                                    "width": bar.frame.width, "height": bar.frame.height]
        if let compositor, compositor.contentBackedPresentation {
            fields["contentBacked"] = true
            fields["covered"] = compositor.fullWindowCovered
            fields["planeVisible"] = !compositor.underlay.isHidden && compositor.baseVisibleFrame.width > 0
            fields["retained"] = bar.superview === compositor.underlay
        }
        if let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]),
           let status = String(data: data, encoding: .utf8) { probe.update(status: status) }
        #endif
    }

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        guard HushhNativeNavigationState.tabs.indices.contains(item.tag) else { return }
        let tab = HushhNativeNavigationState.tabs[item.tag]
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        updatePresentation() // Do not commit a selection before React's existing guard accepts it.
        guard currentColumnFrame != nil, compositor?.interactionIsolated != true, state.acceptsTap(tab, appIsActive: privacy.appIsActive,
                              shielded: privacy.shielded, keyboardVisible: keyboardVisible && compositor?.wholeNativeDrawers != true) else { return }
        // Tracking has completed. Reveal for this deliberate tab intent only
        // now, never by moving its target during touch-up-inside tracking.
        invalidateScroll(snap: true)
        tapSequence += 1
        notifyListeners("selectionRequested", data: ["tab": tab, "sequence": tapSequence,
                                                    "interactionEpoch": state.interactionEpoch,
                                                    "privacyGeneration": privacy.generation,
                                                    "documentId": state.documentId ?? ""])
    }
}
