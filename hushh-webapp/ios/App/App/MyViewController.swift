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
            // Disable the native scroll view (mirrors ios.scrollEnabled=false in
            // capacitor.config). Belt-and-suspenders guarantee that iOS never
            // auto-scrolls the WKWebView to reveal a focused input, which would
            // drag the fixed chat overlay under the status bar / keyboard. All
            // app scrolling is done by inner overflow-y containers.
            webView.scrollView.isScrollEnabled = false
            webView.accessibilityIdentifier = "native-webview"
            print("🔧 [MyViewController] WebView bounce + native scroll disabled for stable fixed-overlay layout")

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
        bridge?.registerPluginInstance(HushhLocationPlugin())
        bridge?.registerPluginInstance(HushhContactsPlugin())
        
        print("✅ [MyViewController] All 12 plugins registered successfully:")
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
        print("   - HushhLocation (Foreground Location)")
        print("   - HushhContacts (Contact Matching)")
        
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
            "HushhNotifications",
            "HushhLocation",
            "HushhContacts"
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
                forMainFrameOnly: true
            )
        )
        controller.addUserScript(
            WKUserScript(
                source: NativeUiTestRunnerScript.source,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )

        let statusLabel = NativeTestStatusLabel(
            frame: .zero,
            showOverlay: nativeTestConfig.showStatusOverlay
        )
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
            guard var components = URLComponents(string: "https://native-test.local\(trimmed)") else {
                return trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
            }
            if components.path.count > 1 && components.path.hasSuffix("/") {
                components.path = String(components.path.dropLast())
            }
            return components.path.isEmpty ? "/" : components.path
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
        let nativeUiRunnerPresent = (payload["nativeUiRunnerPresent"] as? Bool ?? false) ? "1" : "0"
        let runUiFlows = (payload["runUiFlows"] as? Bool ?? false) ? "1" : "0"
        let uiFlowsStarted = (payload["uiFlowsStarted"] as? Bool ?? false) ? "1" : "0"
        let uiFlowsFailed = (payload["uiFlowsFailed"] as? Bool ?? false) ? "1" : "0"
        let uiFlowBootstrapActive = (payload["uiFlowBootstrapActive"] as? Bool ?? false) ? "1" : "0"
        let activePersona = (payload["activePersona"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let primaryNavPersona = (payload["primaryNavPersona"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let personaSwitchStatus = (payload["personaSwitchStatus"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let personaSwitchErrorClass = NativeTestArtifactSanitizer.errorClass(payload["personaSwitchError"])
        let portfolioImportStartState = (payload["portfolioImportStartState"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let portfolioImportStartStatus = (payload["portfolioImportStartStatus"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let portfolioImportStartRunPresent = ((payload["portfolioImportStartRunId"] as? String)?.isEmpty == false) ? "1" : "0"
        let portfolioImportStartErrorClass = NativeTestArtifactSanitizer.errorClass(payload["portfolioImportStartError"])
        let portfolioStreamState = (payload["portfolioStreamState"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let portfolioStreamRunPresent = ((payload["portfolioStreamRunId"] as? String)?.isEmpty == false) ? "1" : "0"
        let portfolioStreamEventCount = (payload["portfolioStreamEventCount"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let portfolioStreamLastEvent = (payload["portfolioStreamLastEvent"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let portfolioStreamLastSeq = (payload["portfolioStreamLastSeq"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let portfolioStreamLastErrorClass = NativeTestArtifactSanitizer.errorClass(payload["portfolioStreamLastError"])
        let triggerReviewerLoginPresent = (payload["triggerReviewerLoginPresent"] as? Bool ?? false) ? "1" : "0"
        let triggerVaultUnlockPresent = (payload["triggerVaultUnlockPresent"] as? Bool ?? false) ? "1" : "0"
        let vaultPassphraseConfigured = (payload["vaultPassphraseConfigured"] as? Bool ?? false) ? "1" : "0"
        let expectedUserConfigured = (payload["expectedUserConfigured"] as? Bool ?? false) ? "1" : "0"
        let vaultCryptoStage = (payload["vaultCryptoStage"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let vaultCryptoErrorName = (payload["vaultCryptoErrorName"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let vaultCryptoSubtleAvailable = (payload["vaultCryptoSubtleAvailable"] as? Bool ?? false) ? "1" : "0"
        let vaultCryptoPassphraseMatchesConfig = (payload["vaultCryptoPassphraseMatchesConfig"] as? Bool ?? false) ? "1" : "0"
        let vaultCryptoPassphraseUtf8Length = (payload["vaultCryptoPassphraseUtf8Length"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let vaultCryptoSaltLength = (payload["vaultCryptoSaltLength"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let vaultCryptoIvLength = (payload["vaultCryptoIvLength"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let vaultCryptoCiphertextLength = (payload["vaultCryptoCiphertextLength"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let vaultBridgeParity = NativeTestDiagnostics.vaultBridgeParity()
        let vaultBridgeParityAvailable = vaultBridgeParity == nil ? "0" : "1"
        let vaultBridgeParityAll = vaultBridgeParity?.allFields == true ? "1" : "0"
        let vaultBridgeWrapperCount = vaultBridgeParity?.wrapperCount == true ? "1" : "0"
        let vaultBridgeEncrypted = vaultBridgeParity?.encryptedVaultKey == true ? "1" : "0"
        let vaultBridgeSalt = vaultBridgeParity?.salt == true ? "1" : "0"
        let vaultBridgeIv = vaultBridgeParity?.iv == true ? "1" : "0"
        let domTestEnabled = (payload["domTestEnabled"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let domAutoReviewerLogin = (payload["domAutoReviewerLogin"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let reviewerButtonFound = (payload["reviewerButtonFound"] as? Bool ?? false) ? "1" : "0"
        let bootstrapState = (payload["bootstrapState"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let bootstrapUserMatchesExpected = payload["bootstrapUserMatchesExpected"] as? Bool
        let bootstrapUidOk = bootstrapUserMatchesExpected.map { $0 ? "1" : "0" } ?? ""
        let bootstrapErrorClass = NativeTestArtifactSanitizer.errorClass(payload["bootstrapErrorClass"])
        let jsErrorClass = NativeTestArtifactSanitizer.errorClass(payload["jsErrorClass"])
        let jsRejectionClass = NativeTestArtifactSanitizer.errorClass(payload["jsRejectionClass"])
        let longWait = (payload["longImportWait"] as? Bool ?? false) ? "1" : "0"
        let visible404 = payload["visible404"] as? Bool ?? false
        let uiFlowsComplete = (payload["uiFlowsComplete"] as? Bool ?? false) ? "1" : "0"
        let uiFlowsOk = (payload["uiFlowsOk"] as? Bool ?? false) ? "1" : "0"
        let uiFlowCurrent = (payload["uiFlowCurrent"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let uiFlowStepIndex = (payload["uiFlowStepIndex"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let uiFlowStepType = (payload["uiFlowStepType"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let uiFlowLayout = safeNativeTestLayoutToken(payload["uiFlowLayout"])
        let uiFlowErrorClass = NativeTestArtifactSanitizer.errorClass(payload["uiFlowErrorClass"])
        let routeReady = expectedRoute.isEmpty ? true : normalizeRoute(route) == normalizeRoute(expectedRoute)
        let documentReady = readyState == "interactive" || readyState == "complete"
        let markerFound = payload["markerFound"] as? Bool ?? false
        let ready = routeReady && documentReady && markerFound

        let safeRoute = normalizeRoute(route)
        let status = "route=\(safeRoute);ready=\(ready ? "1" : "0");marker=\(marker);auth=\(authState);data=\(dataState);doc=\(readyState);found=\(markerFound ? "1" : "0");routeok=\(routeReady ? "1" : "0");test=\(testEnabled);auto=\(autoReviewerLogin);bridge=\(bridgeBeaconPresent);uirunner=\(nativeUiRunnerPresent);runui=\(runUiFlows);uistarted=\(uiFlowsStarted);uifailed=\(uiFlowsFailed);uiboot=\(uiFlowBootstrapActive);persona=\(activePersona);primary_persona=\(primaryNavPersona);persona_switch=\(personaSwitchStatus);persona_error_class=\(personaSwitchErrorClass);portfolio_start_state=\(portfolioImportStartState);portfolio_start_status=\(portfolioImportStartStatus);portfolio_start_run_present=\(portfolioImportStartRunPresent);portfolio_start_error_class=\(portfolioImportStartErrorClass);portfolio_stream_state=\(portfolioStreamState);portfolio_stream_run_present=\(portfolioStreamRunPresent);portfolio_events=\(portfolioStreamEventCount);portfolio_last_event=\(portfolioStreamLastEvent);portfolio_last_seq=\(portfolioStreamLastSeq);portfolio_stream_error_class=\(portfolioStreamLastErrorClass);trigger=\(triggerReviewerLoginPresent);vault_trigger=\(triggerVaultUnlockPresent);vaultcfg=\(vaultPassphraseConfigured);uidcfg=\(expectedUserConfigured);vault_crypto_stage=\(vaultCryptoStage);vault_crypto_error_class=\(NativeTestArtifactSanitizer.errorClass(vaultCryptoErrorName));vault_crypto_subtle=\(vaultCryptoSubtleAvailable);vault_crypto_passphrase_match=\(vaultCryptoPassphraseMatchesConfig);vault_crypto_passphrase_bytes=\(vaultCryptoPassphraseUtf8Length);vault_crypto_salt_bytes=\(vaultCryptoSaltLength);vault_crypto_iv_bytes=\(vaultCryptoIvLength);vault_crypto_ciphertext_bytes=\(vaultCryptoCiphertextLength);vault_struct_available=\(vaultBridgeParityAvailable);vault_struct=\(vaultBridgeParityAll);vault_struct_wrappers=\(vaultBridgeWrapperCount);vault_struct_encrypted=\(vaultBridgeEncrypted);vault_struct_salt=\(vaultBridgeSalt);vault_struct_iv=\(vaultBridgeIv);domtest=\(domTestEnabled);domauto=\(domAutoReviewerLogin);reviewer=\(reviewerButtonFound);bootstrap=\(bootstrapState);bootstrap_uid_ok=\(bootstrapUidOk);bootstrap_error_class=\(bootstrapErrorClass);jserr_class=\(jsErrorClass);jsrej_class=\(jsRejectionClass);long_wait=\(longWait);visible404=\(visible404 ? "1" : "0");ui_complete=\(uiFlowsComplete);ui_ok=\(uiFlowsOk);ui_flow=\(uiFlowCurrent);ui_step=\(uiFlowStepIndex);ui_step_type=\(uiFlowStepType);ui_layout=\(uiFlowLayout);ui_error_class=\(uiFlowErrorClass);error_class=\(NativeTestArtifactSanitizer.errorClass(errorCode))"
        nativeTestStatusLabel?.update(status: status)
        NativeTestStatusStore.write(status)
    }

    private func safeNativeTestLayoutToken(_ raw: Any?) -> String {
        let value = String(describing: raw ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.range(of: #"^[A-Za-z0-9_-]{1,120}$"#, options: .regularExpression) != nil else {
            return ""
        }
        return value
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

        if let uiFlowReport = payload["uiFlowReport"] {
            let sanitizedReport = NativeTestArtifactSanitizer.sanitizeReport(uiFlowReport)
            if let data = try? JSONSerialization.data(withJSONObject: sanitizedReport, options: [.prettyPrinted]),
               let json = String(data: data, encoding: .utf8) {
                NativeTestStatusStore.writeUiReport(json)
            }
        }

        updateNativeTestStatus(from: payload)
    }
}
