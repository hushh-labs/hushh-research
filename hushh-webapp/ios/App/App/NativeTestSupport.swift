import Foundation
import UIKit
import WebKit
import FirebaseAuth

struct NativeTestConfiguration {
    let enabled: Bool
    let initialRoute: String?
    let expectedMarker: String?
    let expectedRoute: String?
    let autoReviewerLogin: Bool
    let vaultPassphrase: String?
    let expectedUserId: String?
    let resetAppState: Bool
    let runUiFlows: Bool

    init(arguments: [String] = ProcessInfo.processInfo.arguments) {
        enabled = arguments.contains("-UITestMode")
        initialRoute = NativeTestConfiguration.value(for: "-UITestInitialRoute", in: arguments)
        expectedMarker = NativeTestConfiguration.value(for: "-UITestExpectedMarker", in: arguments)
        expectedRoute =
            NativeTestConfiguration.value(for: "-UITestExpectedRoute", in: arguments)
            ?? NativeTestConfiguration.deriveExpectedRoute(from: initialRoute)
        autoReviewerLogin = NativeTestConfiguration.boolValue(for: "-UITestAutoReviewerLogin", in: arguments)
        vaultPassphrase = NativeTestConfiguration.value(for: "-UITestVaultPassphrase", in: arguments)
        expectedUserId = NativeTestConfiguration.value(for: "-UITestExpectedUserId", in: arguments)
        resetAppState = NativeTestConfiguration.boolValue(
            for: "-UITestResetAppState",
            in: arguments,
            defaultValue: true
        )
        runUiFlows = NativeTestConfiguration.boolValue(for: "-UITestRunUiFlows", in: arguments)
    }

    var injectedScript: String {
        let payload: [String: Any] = [
            "enabled": enabled,
            "initialRoute": initialRoute ?? "",
            "expectedMarker": expectedMarker ?? "",
            "expectedRoute": expectedRoute ?? "",
            "autoReviewerLogin": autoReviewerLogin,
            "vaultPassphrase": vaultPassphrase ?? "",
            "expectedUserId": expectedUserId ?? "",
            "runUiFlows": runUiFlows,
        ]

        guard
            let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
            let json = String(data: data, encoding: .utf8)
        else {
            return ""
        }

        return """
        (function() {
          if (window.top !== window) return;
          var config = \(json);
          var bridge = window.__HUSHH_NATIVE_TEST__ || {};
          var initialRouteKey = "__hushh_native_test_initial_route_applied__";
          bridge.enabled = config.enabled === true;
          bridge.initialRoute = config.initialRoute || null;
          bridge.expectedMarker = config.expectedMarker || null;
          bridge.expectedRoute = config.expectedRoute || null;
          bridge.autoReviewerLogin = config.autoReviewerLogin === true;
          bridge.vaultPassphrase = config.vaultPassphrase || "";
          bridge.expectedUserId = config.expectedUserId || "";
          bridge.runUiFlows = config.runUiFlows === true;
          bridge.lastJsError = "";
          bridge.lastUnhandledRejection = "";
          try {
            var root = document.documentElement;
            if (root) {
              root.setAttribute("data-hushh-native-test-enabled", bridge.enabled ? "true" : "false");
              root.setAttribute("data-hushh-native-test-auto-reviewer-login", bridge.autoReviewerLogin ? "true" : "false");
              root.setAttribute("data-hushh-native-test-expected-marker", bridge.expectedMarker || "");
              root.setAttribute("data-hushh-native-test-initial-route", bridge.initialRoute || "");
              root.setAttribute("data-hushh-native-test-expected-route", bridge.expectedRoute || "");
            }
          } catch (_) {}
          try {
            window.addEventListener("error", function(event) {
              try {
                bridge.lastJsError = String(event && (event.message || event.error || "unknown_js_error"));
              } catch (_) {}
            });
            window.addEventListener("unhandledrejection", function(event) {
              try {
                var reason = event && event.reason ? event.reason : "unknown_unhandled_rejection";
                bridge.lastUnhandledRejection = typeof reason === "string" ? reason : JSON.stringify(reason);
              } catch (_) {
                bridge.lastUnhandledRejection = "unserializable_unhandled_rejection";
              }
            });
          } catch (_) {}
          bridge.readStatus = function() {
            var beacon = bridge.beacon || null;
            if (!beacon) {
              try {
                var element = bridge.expectedMarker
                  ? document.querySelector('[data-testid="' + bridge.expectedMarker + '"]')
                  : null;
                if (!element) {
                  element =
                    document.querySelector('[data-native-test-beacon="true"]') ||
                    document.querySelector('[data-native-route-marker="true"]');
                }
                if (element) {
                  beacon = {
                    routeId: element.getAttribute("data-native-route-id") || "",
                    marker: element.getAttribute("data-testid") || "",
                    authState: element.getAttribute("data-native-auth-state") || element.getAttribute("data-native-auth-default") || "",
                    dataState: element.getAttribute("data-native-data-state") || element.getAttribute("data-native-data-default") || "",
                    errorCode: element.getAttribute("data-native-error-code") || "",
                    errorMessage: element.getAttribute("data-native-error-message") || ""
                  };
                }
              } catch (_) {}
            }
            var markerFound = !!(beacon && (!bridge.expectedMarker || beacon.marker === bridge.expectedMarker));
            var reviewerButtonFound = false;
            try {
              var buttons = Array.prototype.slice.call(document.querySelectorAll("button"));
              reviewerButtonFound = buttons.some(function(button) {
                var text = (button.textContent || "").trim().toLowerCase();
                return text === "continue as reviewer";
              });
            } catch (_) {}
            var bodySnippet = "";
            var visible404 = false;
            try {
              bodySnippet = ((document.body && document.body.innerText) || "").trim().slice(0, 160);
              visible404 =
                bodySnippet.indexOf("404") >= 0 ||
                bodySnippet.toLowerCase().indexOf("not found") >= 0;
            } catch (_) {}
            if (!markerFound && bridge.expectedMarker) {
              try {
                var html = document.documentElement ? document.documentElement.outerHTML : "";
                markerFound = html.indexOf('data-testid="' + bridge.expectedMarker + '"') !== -1;
              } catch (_) {}
            }
            return {
              route: window.location.pathname + window.location.search,
              readyState: document.readyState,
              expectedMarker: bridge.expectedMarker || "",
              expectedRoute: bridge.expectedRoute || "",
              testEnabled: bridge.enabled === true,
              autoReviewerLogin: bridge.autoReviewerLogin === true,
              bridgeBeaconPresent: !!bridge.beacon,
              nativeUiRunnerPresent: !!window.__HUSHH_NATIVE_UI_TEST__,
              runUiFlows: bridge.runUiFlows === true,
              uiFlowsStarted: bridge._uiFlowsStarted === true,
              uiFlowsFailed: bridge.uiFlowsFailed === true,
              uiFlowsOk: bridge.uiFlowsOk === true,
              uiFlowBootstrapActive: !!bridge._uiFlowBootstrapTimer,
              activePersona: bridge.activePersona || "",
              primaryNavPersona: bridge.primaryNavPersona || "",
              personaSwitchStatus: bridge.personaSwitchStatus || "",
              personaSwitchError: bridge.personaSwitchError || "",
              portfolioImportStartState: bridge.portfolioImportStartState || "",
              portfolioImportStartStatus: bridge.portfolioImportStartStatus || "",
              portfolioImportStartRunId: bridge.portfolioImportStartRunId || "",
              portfolioImportStartError: bridge.portfolioImportStartError || "",
              portfolioStreamState: bridge.portfolioStreamState || "",
              portfolioStreamRunId: bridge.portfolioStreamRunId || "",
              portfolioStreamEventCount: String(bridge.portfolioStreamEventCount || 0),
              portfolioStreamLastEvent: bridge.portfolioStreamLastEvent || "",
              portfolioStreamLastSeq: bridge.portfolioStreamLastSeq || "",
              portfolioStreamLastError: bridge.portfolioStreamLastError || "",
              triggerReviewerLoginPresent: typeof bridge.triggerReviewerLogin === "function",
              domTestEnabled: "",
              domAutoReviewerLogin: "",
              reviewerButtonFound: reviewerButtonFound,
              jsError: bridge.lastJsError || "",
              jsRejection: bridge.lastUnhandledRejection || "",
              bodySnippet: bodySnippet,
              visible404: visible404,
              markerFound: markerFound,
              bootstrapState: bridge.bootstrapState || "",
              bootstrapUserId: bridge.bootstrapUserId || "",
              bootstrapError: bridge.bootstrapError || "",
              title: document.title || "",
              routeId: beacon ? (beacon.routeId || "") : "",
              authState: beacon ? (beacon.authState || "") : "",
              dataState: beacon ? (beacon.dataState || "") : "",
              errorCode: beacon ? (beacon.errorCode || "") : "",
              errorMessage: beacon ? (beacon.errorMessage || "") : "",
              uiFlowCurrent: bridge.uiFlowCurrent || "",
              uiFlowStepIndex: String(bridge.uiFlowStepIndex ?? ""),
              uiFlowStepType: bridge.uiFlowStepType || "",
              uiFlowStepStartedAt: bridge.uiFlowStepStartedAt || "",
              uiFlowError: bridge.uiFlowError || "",
              uiFlowsComplete: bridge.uiFlowsComplete === true,
              uiFlowsOk: bridge.uiFlowsOk === true
            };
          };
          bridge.start = function() {
            if (!bridge.enabled) return;

            if (bridge.autoReviewerLogin && !bridge.expectedUserId && !bridge._reviewerTimer) {
              bridge._reviewerTimer = window.setInterval(function() {
                try {
                  if (!window.location.pathname || window.location.pathname !== "/login") {
                    return;
                  }
                  if (typeof bridge.triggerReviewerLogin === "function") {
                    bridge.triggerReviewerLogin();
                    window.clearInterval(bridge._reviewerTimer);
                    bridge._reviewerTimer = null;
                    return;
                  }
                  var buttons = Array.prototype.slice.call(document.querySelectorAll("button"));
                  var reviewerButton = buttons.find(function(button) {
                    var text = (button.textContent || "").trim().toLowerCase();
                    return text === "continue as reviewer";
                  });
                  if (reviewerButton && !reviewerButton.disabled) {
                    reviewerButton.click();
                    window.clearInterval(bridge._reviewerTimer);
                    bridge._reviewerTimer = null;
                  }
                } catch (_) {}
              }, 400);
            }

            if (bridge.vaultPassphrase && !bridge._vaultTimer) {
              bridge._vaultTimer = window.setInterval(function() {
                try {
                  if (typeof bridge.triggerVaultUnlock === "function") {
                    bridge.triggerVaultUnlock();
                    return;
                  }
                  var buttons = Array.prototype.slice.call(document.querySelectorAll("button"));
                  var passphraseInput = document.querySelector('#unlock-passphrase');
                  if (!passphraseInput) {
                    var fallbackButton = document.querySelector('[data-testid="vault-use-passphrase-instead"]');
                    if (!fallbackButton) {
                      fallbackButton = buttons.find(function(button) {
                        var text = (button.textContent || "").trim().toLowerCase();
                        return text === "use passphrase instead";
                      });
                    }
                    if (fallbackButton && !fallbackButton.disabled) {
                      fallbackButton.click();
                    }
                    return;
                  }
                  var prototype = window.HTMLInputElement && window.HTMLInputElement.prototype;
                  var descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : null;
                  if (descriptor && typeof descriptor.set === "function") {
                    descriptor.set.call(passphraseInput, bridge.vaultPassphrase);
                  } else {
                    passphraseInput.value = bridge.vaultPassphrase;
                  }
                  passphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
                  passphraseInput.dispatchEvent(new Event("change", { bubbles: true }));
                  var unlockButton = buttons.find(function(button) {
                    var text = (button.textContent || "").trim().toLowerCase();
                    return text === "unlock with passphrase";
                  });
                  if (unlockButton && !unlockButton.disabled) {
                    unlockButton.click();
                  }
                } catch (_) {}
              }, 500);
            }

            if (bridge._timer) return;
            var send = function() {
              try {
                window.webkit.messageHandlers.hushhNativeTest.postMessage(bridge.readStatus());
              } catch (error) {
                window.webkit.messageHandlers.hushhNativeTest.postMessage({
                  route: window.location.pathname + window.location.search,
                  readyState: "error",
                  expectedMarker: bridge.expectedMarker || "",
                  expectedRoute: bridge.expectedRoute || "",
                  markerFound: false,
                  title: String(error),
                  routeId: "",
                  authState: "",
                  dataState: "error",
                  errorCode: "bridge_error",
                  errorMessage: String(error)
                });
              }
            };

            bridge._timer = window.setInterval(send, 300);
            window.addEventListener("load", send);
            document.addEventListener("readystatechange", send);
            send();
          };

          window.__HUSHH_NATIVE_TEST__ = bridge;
          try {
            if (window.__HUSHH_NATIVE_UI_TEST__ && typeof window.__HUSHH_NATIVE_UI_TEST__.startUiFlowBootstrap === "function") {
              window.__HUSHH_NATIVE_UI_TEST__.startUiFlowBootstrap();
            }
          } catch (_) {}
          setTimeout(function() { bridge.start(); }, 0);
        })();
        """
    }

    var statusJavaScript: String {
        let marker = (expectedMarker ?? "")
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let expectedRoute = (self.expectedRoute ?? "")
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let initialRoute = (self.initialRoute ?? "")
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let autoReviewerLogin = self.autoReviewerLogin ? "true" : "false"

        return """
        (function() {
          var marker = "\(marker)";
          var expectedRoute = "\(expectedRoute)";
          var initialRoute = "\(initialRoute)";
          var autoReviewerLogin = \(autoReviewerLogin);
          var bridge = window.__HUSHH_NATIVE_TEST__ || {};
          var previousInitialRoute = bridge.initialRoute || "";
          var uiFlowsOwnRouting = bridge.runUiFlows === true && bridge._uiFlowsStarted === true;
          if (!uiFlowsOwnRouting) {
            bridge.expectedMarker = marker;
            bridge.expectedRoute = expectedRoute;
            bridge.initialRoute = initialRoute || null;
            bridge.autoReviewerLogin = autoReviewerLogin === true;
          } else {
            marker = bridge.expectedMarker || "";
            expectedRoute = bridge.expectedRoute || "";
            initialRoute = bridge.initialRoute || "";
          }
          try {
            var root = document.documentElement;
            if (root) {
              if (!uiFlowsOwnRouting) {
                root.setAttribute("data-hushh-native-test-auto-reviewer-login", bridge.autoReviewerLogin ? "true" : "false");
                root.setAttribute("data-hushh-native-test-initial-route", bridge.initialRoute || "");
                root.setAttribute("data-hushh-native-test-expected-marker", bridge.expectedMarker || "");
                root.setAttribute("data-hushh-native-test-expected-route", bridge.expectedRoute || "");
              } else {
                root.setAttribute("data-hushh-native-test-initial-route", "");
                root.setAttribute("data-hushh-native-test-expected-marker", "");
                root.setAttribute("data-hushh-native-test-expected-route", "");
              }
            }
            if (previousInitialRoute !== (bridge.initialRoute || "")) {
              window.dispatchEvent(new CustomEvent("hushh:native-test-config-updated"));
            }
          } catch (_) {}
          if (bridge.readStatus) {
            return JSON.stringify(bridge.readStatus());
          }
          return JSON.stringify({
            route: window.location.pathname + window.location.search,
            readyState: document.readyState,
            expectedMarker: marker,
            expectedRoute: expectedRoute,
            testEnabled: bridge.enabled === true,
            autoReviewerLogin: bridge.autoReviewerLogin === true,
              bridgeBeaconPresent: !!bridge.beacon,
              nativeUiRunnerPresent: !!window.__HUSHH_NATIVE_UI_TEST__,
              runUiFlows: bridge.runUiFlows === true,
              uiFlowsStarted: bridge._uiFlowsStarted === true,
              uiFlowsFailed: bridge.uiFlowsFailed === true,
              uiFlowsOk: bridge.uiFlowsOk === true,
              uiFlowBootstrapActive: !!bridge._uiFlowBootstrapTimer,
              activePersona: bridge.activePersona || "",
              primaryNavPersona: bridge.primaryNavPersona || "",
              personaSwitchStatus: bridge.personaSwitchStatus || "",
              personaSwitchError: bridge.personaSwitchError || "",
              portfolioStreamEventCount: String(bridge.portfolioStreamEventCount || 0),
              portfolioStreamLastEvent: bridge.portfolioStreamLastEvent || "",
              portfolioStreamLastSeq: bridge.portfolioStreamLastSeq || "",
              portfolioStreamLastError: bridge.portfolioStreamLastError || "",
              triggerReviewerLoginPresent: typeof bridge.triggerReviewerLogin === "function",
              domTestEnabled: "",
            domAutoReviewerLogin: "",
            reviewerButtonFound: false,
            bootstrapState: bridge.bootstrapState || "",
            bootstrapUserId: bridge.bootstrapUserId || "",
            bootstrapError: bridge.bootstrapError || "",
            jsError: bridge.lastJsError || "",
            jsRejection: bridge.lastUnhandledRejection || "",
            bodySnippet: "",
            markerFound: false,
            title: document.title || "",
            routeId: "",
            authState: "",
            dataState: "",
            errorCode: "",
            errorMessage: "",
            uiFlowCurrent: bridge.uiFlowCurrent || "",
            uiFlowStepIndex: String(bridge.uiFlowStepIndex ?? ""),
            uiFlowStepType: bridge.uiFlowStepType || "",
            uiFlowStepStartedAt: bridge.uiFlowStepStartedAt || "",
            uiFlowError: bridge.uiFlowError || "",
            uiFlowsComplete: bridge.uiFlowsComplete === true,
            uiFlowsOk: bridge.uiFlowsOk === true
          });
        })();
        """
    }

    private static func value(for key: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: key), index + 1 < arguments.count else {
            return nil
        }
        let value = arguments[index + 1].trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private static func boolValue(
        for key: String,
        in arguments: [String],
        defaultValue: Bool = false
    ) -> Bool {
        guard let value = value(for: key, in: arguments)?.lowercased() else {
            return defaultValue
        }
        return value == "1" || value == "true" || value == "yes"
    }

    private static func deriveExpectedRoute(from initialRoute: String?) -> String? {
        guard let initialRoute, !initialRoute.isEmpty else { return nil }
        if initialRoute.hasPrefix("/login"), let redirect = redirectTarget(from: initialRoute) {
            return redirect
        }
        return initialRoute
    }

    private static func redirectTarget(from route: String) -> String? {
        guard let components = URLComponents(string: "https://hushh.app\(route)") else {
            return nil
        }
        guard let redirect = components.queryItems?.first(where: { $0.name == "redirect" })?.value else {
            return nil
        }
        return redirect.isEmpty ? nil : redirect
    }
}

enum NativeTestResetter {
    static func resetAppStateIfNeeded(configuration: NativeTestConfiguration) {
        guard configuration.enabled, configuration.resetAppState else { return }

        clearFirebaseAuth()
        clearUserDefaults()
        clearCookies()
        clearWebsiteData()
    }

    private static func clearFirebaseAuth() {
        do {
            try Auth.auth().signOut()
        } catch {
            print("⚠️ [NativeTestResetter] Failed to sign out Firebase auth: \(error)")
        }
    }

    private static func clearUserDefaults() {
        guard let bundleId = Bundle.main.bundleIdentifier else { return }
        UserDefaults.standard.removePersistentDomain(forName: bundleId)
        UserDefaults.standard.synchronize()
    }

    private static func clearCookies() {
        let semaphore = DispatchSemaphore(value: 0)
        HTTPCookieStorage.shared.removeCookies(since: .distantPast)
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { cookies in
            cookies.forEach { WKWebsiteDataStore.default().httpCookieStore.delete($0) }
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 5)
    }

    private static func clearWebsiteData() {
        let semaphore = DispatchSemaphore(value: 0)
        let allTypes = WKWebsiteDataStore.allWebsiteDataTypes()
        WKWebsiteDataStore.default().fetchDataRecords(ofTypes: allTypes) { records in
            WKWebsiteDataStore.default().removeData(ofTypes: allTypes, for: records) {
                semaphore.signal()
            }
        }
        _ = semaphore.wait(timeout: .now() + 10)
    }
}

final class NativeTestStatusLabel: UIButton {
    override init(frame: CGRect) {
        super.init(frame: frame)
        isAccessibilityElement = true
        accessibilityIdentifier = "native-test-status"
        let initialStatus = "route=booting;ready=0;marker=;auth=pending;data=booting;error="
        accessibilityLabel = initialStatus
        accessibilityValue = initialStatus
        setTitle(initialStatus, for: .normal)
        setTitleColor(.systemGreen, for: .normal)
        backgroundColor = UIColor.black.withAlphaComponent(0.72)
        alpha = 0.95
        titleLabel?.font = UIFont.monospacedSystemFont(ofSize: 10, weight: .regular)
        titleLabel?.numberOfLines = 1
        isUserInteractionEnabled = false
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func update(status: String) {
        setTitle(status, for: .normal)
        accessibilityLabel = status
        accessibilityValue = status
    }
}

enum NativeTestStatusStore {
    private static let fileName = "native-test-status.txt"
    private static let uiReportFileName = "native-ui-interaction-report.json"

    static func write(_ status: String) {
        guard let url = statusFileURL() else { return }
        try? status.write(to: url, atomically: true, encoding: .utf8)
        UIPasteboard.general.string = status
    }

    static func writeUiReport(_ report: String) {
        guard let url = uiReportFileURL() else { return }
        try? report.write(to: url, atomically: true, encoding: .utf8)
    }

    static func reset() {
        guard let url = statusFileURL() else { return }
        try? FileManager.default.removeItem(at: url)
        if let uiReportUrl = uiReportFileURL() {
            try? FileManager.default.removeItem(at: uiReportUrl)
        }
        UIPasteboard.general.string = nil
    }

    private static func statusFileURL() -> URL? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent(fileName)
    }

    private static func uiReportFileURL() -> URL? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent(uiReportFileName)
    }
}
