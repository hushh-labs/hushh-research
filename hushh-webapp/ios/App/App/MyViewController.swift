import UIKit
import Capacitor
import WebKit

/**
 * MyViewController - Custom Capacitor Bridge View Controller
 * 
 * This is the iOS equivalent of Android's MainActivity.kt
 * Registers native Hushh plugins with the Capacitor bridge.
 *
 * Following Capacitor 8 documentation:
 * https://capacitorjs.com/docs/ios/custom-code#register-the-plugin
 */
class MyViewController: CAPBridgeViewController, WKScriptMessageHandler {
    private let nativeTestConfig = NativeTestConfiguration()
    private var nativeTestStatusLabel: NativeTestStatusLabel?
    private var nativeTestPollTimer: Timer?
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        // Disable bounce effect for stable scrolling (fixes iOS layout bounce)
        if let webView = self.webView {
            webView.scrollView.bounces = false
            webView.scrollView.alwaysBounceVertical = false
            webView.scrollView.alwaysBounceHorizontal = false
            // Keep iOS inset ownership aligned with Capacitor config:
            // ios.contentInset = "never" + app-level safe-area CSS contract.
            webView.scrollView.contentInsetAdjustmentBehavior = .never
            webView.accessibilityIdentifier = "native-webview"
            print("🔧 [MyViewController] WebView bounce disabled for stable scrolling")

            if nativeTestConfig.enabled {
                installNativeTestBridge(on: webView)
                startNativeTestPolling(on: webView)
            }
        }
    }
    
    override open func capacitorDidLoad() {
        super.capacitorDidLoad()
        
        print("🔌 [MyViewController] Registering all native plugins...")
        print("🔌 [MyViewController] Bridge available: \(bridge != nil)")
        
        // Register all Hushh native plugins
        // These must match the jsName in each plugin's CAPBridgedPlugin protocol
        bridge?.registerPluginInstance(HushhAuthPlugin())
        bridge?.registerPluginInstance(HushhVaultPlugin())
        bridge?.registerPluginInstance(HushhConsentPlugin())
        bridge?.registerPluginInstance(KaiPlugin())
        bridge?.registerPluginInstance(HushhSyncPlugin())
        bridge?.registerPluginInstance(HushhSettingsPlugin())
        bridge?.registerPluginInstance(HushhKeystorePlugin())
        bridge?.registerPluginInstance(PersonalKnowledgeModelPlugin())
        bridge?.registerPluginInstance(HushhAccountPlugin())
        bridge?.registerPluginInstance(HushhNotificationsPlugin())
        
        print("✅ [MyViewController] All 10 plugins registered successfully:")
        print("   - HushhAuth (Google Sign-In)")
        print("   - HushhVault (Encryption + Cloud DB)")
        print("   - HushhConsent (Token Management)")
        print("   - Kai (Agent Kai)")
        print("   - HushhSync (Cloud Sync)")
        print("   - HushhSettings (App Settings)")
        print("   - HushhKeystore (Secure Storage)")
        print("   - PersonalKnowledgeModel (PKM / Domain Data)")
        print("   - HushhAccount (Account Management)")
        print("   - HushhNotifications (Push Token Registration)")
        
        // Verify plugins are actually accessible by the bridge
        verifyPluginRegistration()
    }
    
    /// Debug helper to verify plugins are properly registered and accessible
    private func verifyPluginRegistration() {
        print("🔍 [MyViewController] Verifying plugin registration...")
        
        let pluginNames = [
            "HushhAuth",
            "HushhVault", 
            "HushhConsent",
            "Kai",
            "HushhSync",
            "HushhSettings",
            "HushhKeychain",  // Note: jsName is HushhKeychain (not HushhKeystore)
            "PersonalKnowledgeModel",
            "HushhAccount",
            "HushhNotifications"
        ]
        
        for name in pluginNames {
            if let plugin = bridge?.plugin(withName: name) {
                print("   ✅ \(name) found: \(type(of: plugin))")
            } else {
                print("   ❌ \(name) NOT FOUND!")
            }
        }
    }

    private func installNativeTestBridge(on webView: WKWebView) {
        let controller = webView.configuration.userContentController
        controller.removeScriptMessageHandler(forName: "hushhNativeTest")
        controller.add(self, name: "hushhNativeTest")
        controller.addUserScript(
            WKUserScript(
                source: nativeTestConfig.injectedScript,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false
            )
        )

        let statusLabel = NativeTestStatusLabel(frame: .zero)
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(statusLabel)
        NSLayoutConstraint.activate([
            statusLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            statusLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            statusLabel.widthAnchor.constraint(equalToConstant: 360),
            statusLabel.heightAnchor.constraint(equalToConstant: 22),
        ])
        view.bringSubviewToFront(statusLabel)
        nativeTestStatusLabel = statusLabel
        NativeTestStatusStore.reset()
        let initialStatus = "route=booting;ready=0;marker=\(nativeTestConfig.expectedMarker ?? "");auth=pending;data=booting;error="
        nativeTestStatusLabel?.update(status: initialStatus)
        NativeTestStatusStore.write(initialStatus)
    }

    private func startNativeTestPolling(on webView: WKWebView) {
        nativeTestPollTimer?.invalidate()

        let refresh: () -> Void = { [weak self, weak webView] in
            guard let self = self, let webView = webView else { return }
            webView.evaluateJavaScript(self.nativeTestConfig.statusJavaScript) { result, _ in
                guard
                    let raw = result as? String,
                    let data = raw.data(using: .utf8),
                    let json = try? JSONSerialization.jsonObject(with: data, options: []) as? [String: Any]
                else {
                    self.nativeTestStatusLabel?.update(
                        status: "route=unknown;ready=0;marker=\(self.nativeTestConfig.expectedMarker ?? "");auth=pending;data=booting;error=status_parse"
                    )
                    return
                }

                self.updateNativeTestStatus(from: json)
            }
        }

        refresh()
        nativeTestPollTimer = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: true) { _ in
            refresh()
        }
    }

    private func updateNativeTestStatus(from payload: [String: Any]) {
        func normalizeRoute(_ value: String) -> String {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty, trimmed != "/" else { return trimmed.isEmpty ? "/" : trimmed }
            return trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        }

        let route = (payload["route"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let marker = (payload["expectedMarker"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let expectedRoute = (payload["expectedRoute"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let readyState = (payload["readyState"] as? String)?.lowercased() ?? ""
        let authState = (payload["authState"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "pending"
        let dataState = (payload["dataState"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "booting"
        let errorCode = (payload["errorCode"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let testEnabled = (payload["testEnabled"] as? Bool ?? false) ? "1" : "0"
        let autoReviewerLogin = (payload["autoReviewerLogin"] as? Bool ?? false) ? "1" : "0"
        let bridgeBeaconPresent = (payload["bridgeBeaconPresent"] as? Bool ?? false) ? "1" : "0"
        let triggerReviewerLoginPresent = (payload["triggerReviewerLoginPresent"] as? Bool ?? false) ? "1" : "0"
        let domTestEnabled = (payload["domTestEnabled"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let domAutoReviewerLogin = (payload["domAutoReviewerLogin"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let reviewerButtonFound = (payload["reviewerButtonFound"] as? Bool ?? false) ? "1" : "0"
        let bootstrapState = (payload["bootstrapState"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let bootstrapUserId = (payload["bootstrapUserId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let bootstrapError = (payload["bootstrapError"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let jsError = (payload["jsError"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let jsRejection = (payload["jsRejection"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let bodySnippet = (payload["bodySnippet"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let routeReady = expectedRoute.isEmpty ? true : normalizeRoute(route) == normalizeRoute(expectedRoute)
        let documentReady = readyState == "interactive" || readyState == "complete"
        let markerFound = payload["markerFound"] as? Bool ?? false
        let ready = routeReady && documentReady && markerFound

        let status = "route=\(route);ready=\(ready ? "1" : "0");marker=\(marker);auth=\(authState);data=\(dataState);doc=\(readyState);found=\(markerFound ? "1" : "0");routeok=\(routeReady ? "1" : "0");test=\(testEnabled);auto=\(autoReviewerLogin);bridge=\(bridgeBeaconPresent);trigger=\(triggerReviewerLoginPresent);domtest=\(domTestEnabled);domauto=\(domAutoReviewerLogin);reviewer=\(reviewerButtonFound);bootstrap=\(bootstrapState);bootstrap_uid=\(bootstrapUserId);bootstrap_error=\(bootstrapError);jserr=\(jsError);jsrej=\(jsRejection);body=\(bodySnippet);error=\(errorCode)"
        nativeTestStatusLabel?.update(status: status)
        NativeTestStatusStore.write(status)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "hushhNativeTest" else {
            return
        }

        guard let payload = message.body as? [String: Any] else {
            nativeTestStatusLabel?.update(
                status: "route=invalid;ready=0;marker=;auth=pending;data=error;error=invalid_payload"
            )
            NativeTestStatusStore.write("route=invalid;ready=0;marker=;auth=pending;data=error;error=invalid_payload")
            return
        }

        updateNativeTestStatus(from: payload)
    }
}
