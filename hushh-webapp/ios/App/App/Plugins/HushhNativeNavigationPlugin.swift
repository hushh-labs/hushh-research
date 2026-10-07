import Capacitor
import UIKit

/// Presentation metadata only. React retains routing, consent and session authority.
struct HushhNativeNavigationState {
    static let tabs = ["chat", "dashboard", "connect", "feed", "search"]
    private(set) var documentId: String?
    private(set) var revision = -1
    private(set) var visible = false
    private(set) var selected = "chat"
    private(set) var interactionEpoch = -1
    private var retiredDocuments = Set<String>()

    mutating func retireDocument() {
        if let documentId { retiredDocuments.insert(documentId) }
        documentId = nil
        revision = -1
        visible = false
    }

    mutating func apply(document: String, revision: Int, visible: Bool, selected: String, interactionEpoch: Int = 0) -> Bool {
        guard !document.isEmpty, document.count <= 128, !retiredDocuments.contains(document),
              revision >= 0, interactionEpoch >= 0,
              Self.tabs.contains(selected) else { return false }
        if let previous = documentId, previous != document { retireDocument() }
        guard revision > self.revision else { return false }
        documentId = document
        self.revision = revision
        self.visible = visible
        self.selected = selected
        self.interactionEpoch = interactionEpoch
        return true
    }

    func acceptsTap(_ tab: String, appIsActive: Bool, shielded: Bool, keyboardVisible: Bool) -> Bool {
        visible && appIsActive && !shielded && !keyboardVisible && Self.tabs.contains(tab)
    }
}

enum HushhNativeNavigationArtwork {
    static func items(image: (String) -> UIImage? = { UIImage(named: $0) }) -> [UITabBarItem]? {
        let labels = ["Chat", "One", "Connect", "Feed", "Search"]
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

@objc(HushhNativeNavigationPlugin)
final class HushhNativeNavigationPlugin: CAPPlugin, CAPBridgedPlugin, UITabBarDelegate {
    let identifier = "HushhNativeNavigationPlugin"
    let jsName = "HushhNativeNavigation"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "confirmSelection", returnType: CAPPluginReturnPromise),
    ]
    private var state = HushhNativeNavigationState()
    private var tabBar: UITabBar?
    private var observers = [NSObjectProtocol]()
    private var keyboardVisible = false
    private var contentHeight: CGFloat = 0
    private var bottomInset: CGFloat = 0
    private var tapSequence = 0
    private var confirmedSequence = 0
    private var retiredRestartGeneration = -1
    private lazy var navigationItems = HushhNativeNavigationArtwork.items()

    override func load() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let center = NotificationCenter.default
            for name in [UIResponder.keyboardWillShowNotification, UIResponder.keyboardWillHideNotification,
                         UIApplication.willResignActiveNotification, UIApplication.didBecomeActiveNotification,
                         HushhSessionPrivacyShield.presentationDidChange] {
                self.observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                    guard let self else { return }
                    if note.name == UIResponder.keyboardWillShowNotification { self.keyboardVisible = true }
                    if note.name == UIResponder.keyboardWillHideNotification { self.keyboardVisible = false }
                    self.updatePresentation()
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
                call.resolve(["contractVersion": HushhNativeControlAppearance.contractVersion, "supported": self.navigationItems != nil, "contentHeight": self.contentHeight, "bottomInset": self.bottomInset])
            } else {
                call.resolve(["contractVersion": HushhNativeControlAppearance.contractVersion, "supported": false, "contentHeight": 0, "bottomInset": 0])
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
                  let theme = HushhNativeControlAppearance(appearance: call.getString("appearance"),
                    accentHex: call.getString("accentHex"), foregroundHex: call.getString("foregroundHex")) else {
                call.reject("NATIVE_NAVIGATION_INVALID_STATE"); return
            }
            let shield = HushhSessionPrivacyShield.shared
            self.updatePresentation() // Consume pending restart retirement before observing the replacement.
            shield.observeDocument(document)
            guard shield.acceptsDocument(document), self.state.apply(document: document, revision: revision,
                      visible: visible, selected: selected, interactionEpoch: epoch) else {
                call.reject("NATIVE_NAVIGATION_STALE_STATE"); return
            }
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
            call.resolve(["supported": self.tabBar != nil, "contentHeight": self.contentHeight, "bottomInset": self.bottomInset])
        }
    }

    @objc func confirmSelection(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let privacy = HushhSessionPrivacyShield.shared.snapshot()
            let sequence = call.getInt("sequence") ?? -1
            let tab = call.getString("tab") ?? ""
            let valid = call.getString("documentId") == self.state.documentId &&
                call.getInt("interactionEpoch") == self.state.interactionEpoch &&
                call.getInt("privacyGeneration") == privacy.generation &&
                sequence == self.tapSequence && sequence > self.confirmedSequence &&
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
        bar.items = items
        // A shield installed before the bridge call must remain above native controls.
        if let shield = host.subviews.first(where: { $0.accessibilityIdentifier == HushhSessionPrivacyShield.accessibilityIdentifier }) {
            host.insertSubview(bar, belowSubview: shield)
        } else {
            host.addSubview(bar)
        }
        tabBar = bar
    }

    func layoutTabBar() {
        guard let bar = tabBar, let host = bridge?.viewController?.view else { return }
        let inset = host.safeAreaInsets.bottom
        let height = bar.sizeThatFits(CGSize(width: host.bounds.width, height: 0)).height
        // UITabBar's fitting height includes its own safe-area inset once attached.
        let fullHeight = max(height, 49 + inset)
        bar.frame = CGRect(x: 0, y: host.bounds.height - fullHeight, width: host.bounds.width, height: fullHeight)
        let next = fullHeight - inset
        if abs(next - contentHeight) > 0.5 || abs(inset - bottomInset) > 0.5 {
            contentHeight = next
            bottomInset = inset
            notifyListeners("geometryChanged", data: ["contentHeight": contentHeight, "bottomInset": bottomInset])
        }
    }

    private func updatePresentation() {
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        if privacy.shielded && privacy.cause == "restart" && privacy.generation != retiredRestartGeneration {
            state.retireDocument()
            retiredRestartGeneration = privacy.generation
        }
        let show = state.acceptsTap(state.selected, appIsActive: privacy.appIsActive,
                                   shielded: privacy.shielded, keyboardVisible: keyboardVisible)
        tabBar?.isHidden = !show
        tabBar?.isUserInteractionEnabled = show
        tabBar?.accessibilityElementsHidden = !show
        tabBar?.selectedItem = tabBar?.items?.first(where: {
            HushhNativeNavigationState.tabs[$0.tag] == state.selected
        })
    }

    func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
        guard HushhNativeNavigationState.tabs.indices.contains(item.tag) else { return }
        let tab = HushhNativeNavigationState.tabs[item.tag]
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        updatePresentation() // Do not commit a selection before React's existing guard accepts it.
        guard state.acceptsTap(tab, appIsActive: privacy.appIsActive,
                              shielded: privacy.shielded, keyboardVisible: keyboardVisible) else { return }
        tapSequence += 1
        notifyListeners("selectionRequested", data: ["tab": tab, "sequence": tapSequence,
                                                    "interactionEpoch": state.interactionEpoch,
                                                    "privacyGeneration": privacy.generation,
                                                    "documentId": state.documentId ?? ""])
    }
}
