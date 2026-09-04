import Foundation
import UIKit
import WebKit
import FirebaseAuth

enum NativeTestDiagnostics {
    struct VaultBridgeParity {
        let wrapperCount: Bool
        let encryptedVaultKey: Bool
        let salt: Bool
        let iv: Bool

        var allFields: Bool {
            wrapperCount && encryptedVaultKey && salt && iv
        }
    }

    private static let lock = NSLock()
    private static var storedVaultBridgeParity: VaultBridgeParity?

    static func recordVaultBridgeParity(_ parity: VaultBridgeParity) {
        lock.lock()
        storedVaultBridgeParity = parity
        lock.unlock()
    }

    static func vaultBridgeParity() -> VaultBridgeParity? {
        lock.lock()
        defer { lock.unlock() }
        return storedVaultBridgeParity
    }
}

enum NativeTestArtifactSanitizer {
    private static let sensitiveKeyFragments = [
        "body", "email", "error", "message", "passphrase", "payload", "reason",
        "response", "secret", "token", "uid", "userid", "requestid",
    ]
    private static let allowedErrorClasses: Set<String> = [
        "authentication", "identity", "network", "not_found", "other",
            "permission", "rate_limit", "reference_error", "syntax_error",
            "stalled", "timeout", "type_error", "vault",
    ]

    static func errorClass(_ rawValue: Any?) -> String {
        let value = String(describing: rawValue ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !value.isEmpty else { return "" }
        if allowedErrorClasses.contains(value) { return value }
        if value.contains("uid") || value.contains("identity") { return "identity" }
        if value.contains("401") || value.contains("403") || value.contains("auth") || value.contains("sign in") {
            return "authentication"
        }
        if value.contains("404") || value.contains("not found") { return "not_found" }
        if value.contains("timeout") || value.contains("timed out") { return "timeout" }
        if value.contains("stalled") || value.contains("no progress") { return "stalled" }
        if value.contains("network") || value.contains("connection") || value.contains("fetch") {
            return "network"
        }
        if value.contains("vault") || value.contains("decrypt") || value.contains("crypto") {
            return "vault"
        }
        if value.contains("permission") || value.contains("denied") { return "permission" }
        if value.contains("typeerror") { return "type_error" }
        if value.contains("referenceerror") { return "reference_error" }
        if value.contains("syntaxerror") { return "syntax_error" }
        return "other"
    }

    static func userMatchStatus(userId: String, expectedUserId: String) -> String {
        guard !userId.isEmpty, !expectedUserId.isEmpty else { return "" }
        return userId == expectedUserId ? "1" : "0"
    }

    static func routePath(_ rawValue: String) -> String {
        guard let components = URLComponents(string: "https://native-test.local\(rawValue)") else {
            return "/"
        }
        return components.path.isEmpty ? "/" : components.path
    }

    static func sanitizeReport(_ value: Any, key: String = "") -> Any {
        let normalizedKey = key.replacingOccurrences(of: "_", with: "").lowercased()
        let sensitiveKey = sensitiveKeyFragments.contains { normalizedKey.contains($0) }
        if sensitiveKey && !normalizedKey.hasSuffix("class") {
            return "<redacted>"
        }
        if normalizedKey == "route" || normalizedKey.hasSuffix("route") {
            return routePath(String(describing: value))
        }
        if let dictionary = value as? [String: Any] {
            return dictionary.reduce(into: [String: Any]()) { result, entry in
                result[entry.key] = sanitizeReport(entry.value, key: entry.key)
            }
        }
        if let array = value as? [Any] {
            return array.map { sanitizeReport($0, key: key) }
        }
        if let string = value as? String,
           string.range(of: #"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return "<redacted>"
        }
        return value
    }
}

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
    let uiFlowRunId: String?
    let showStatusOverlay: Bool

    init(arguments: [String] = ProcessInfo.processInfo.arguments) {
        #if DEBUG
        let testModeEnabled = arguments.contains("-UITestMode")
        #else
        let testModeEnabled = false
        #endif
        enabled = testModeEnabled
        initialRoute = testModeEnabled ? NativeTestConfiguration.value(for: "-UITestInitialRoute", in: arguments) : nil
        expectedMarker = NativeTestConfiguration.value(for: "-UITestExpectedMarker", in: arguments)
        expectedRoute =
            NativeTestConfiguration.value(for: "-UITestExpectedRoute", in: arguments)
            ?? NativeTestConfiguration.deriveExpectedRoute(from: initialRoute)
        autoReviewerLogin = testModeEnabled && NativeTestConfiguration.boolValue(for: "-UITestAutoReviewerLogin", in: arguments)
        vaultPassphrase = testModeEnabled ? NativeTestConfiguration.value(for: "-UITestVaultPassphrase", in: arguments) : nil
        expectedUserId = testModeEnabled ? NativeTestConfiguration.value(for: "-UITestExpectedUserId", in: arguments) : nil
        resetAppState = NativeTestConfiguration.boolValue(
            for: "-UITestResetAppState",
            in: arguments,
            defaultValue: true
        )
        runUiFlows = testModeEnabled && NativeTestConfiguration.boolValue(for: "-UITestRunUiFlows", in: arguments)
        uiFlowRunId = testModeEnabled ? NativeTestConfiguration.value(for: "-UITestUiFlowRunId", in: arguments) : nil
        showStatusOverlay = testModeEnabled && NativeTestConfiguration.boolValue(for: "-UITestShowStatusOverlay", in: arguments)
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
            "uiFlowRunId": uiFlowRunId ?? "",
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
          function hasIncompleteUiFlowSession(runId) {
            try {
              var normalizedRunId = String(runId || "").replace(/[^a-zA-Z0-9_-]/g, "");
              var storageKey = "__hushh_native_ui_flow_state_v1" +
                (normalizedRunId ? ":" + normalizedRunId : "");
              var raw = window.sessionStorage.getItem(storageKey);
              if (!raw) return false;
              var state = JSON.parse(raw);
              return state && state.started === true && state.complete !== true;
            } catch (_) {
              return false;
            }
          }
          var uiFlowsOwnRouting =
            (bridge.runUiFlows === true || config.runUiFlows === true) &&
            (bridge._uiFlowsStarted === true ||
              bridge._uiFlowsRoutingOwned === true ||
              hasIncompleteUiFlowSession(config.uiFlowRunId));
          bridge.enabled = config.enabled === true;
          bridge.autoReviewerLogin = config.autoReviewerLogin === true;
          bridge.vaultPassphrase = config.vaultPassphrase || "";
          bridge.expectedUserId = config.expectedUserId || "";
          bridge.runUiFlows = bridge.runUiFlows === true || config.runUiFlows === true;
          bridge.uiFlowRunId = config.uiFlowRunId || "";
          bridge._uiFlowsRoutingOwned = uiFlowsOwnRouting;
          if (!uiFlowsOwnRouting) {
            bridge.initialRoute = config.initialRoute || null;
            bridge.expectedMarker = config.expectedMarker || null;
            bridge.expectedRoute = config.expectedRoute || null;
          }
          bridge.bootstrapState = bridge.bootstrapState || "";
          bridge.bootstrapUserId = bridge.bootstrapUserId || "";
          bridge.bootstrapErrorClass = bridge.bootstrapErrorClass || "";
          bridge.lastJsErrorClass = "";
          bridge.lastUnhandledRejectionClass = "";
          function classifyError(value) {
            var text = "";
            try {
              text = String(value && (value.name || value.message || value) || "").toLowerCase();
            } catch (_) {}
            if (!text) return "";
            if (text.indexOf("401") >= 0 || text.indexOf("403") >= 0 || text.indexOf("auth") >= 0) return "authentication";
            if (text.indexOf("404") >= 0 || text.indexOf("not found") >= 0) return "not_found";
            if (text.indexOf("timeout") >= 0 || text.indexOf("timed out") >= 0) return "timeout";
            if (text.indexOf("network") >= 0 || text.indexOf("connection") >= 0 || text.indexOf("fetch") >= 0) return "network";
            if (text.indexOf("vault") >= 0 || text.indexOf("decrypt") >= 0 || text.indexOf("crypto") >= 0) return "vault";
            if (text.indexOf("permission") >= 0 || text.indexOf("denied") >= 0) return "permission";
            if (text.indexOf("typeerror") >= 0) return "type_error";
            if (text.indexOf("referenceerror") >= 0) return "reference_error";
            if (text.indexOf("syntaxerror") >= 0) return "syntax_error";
            return "other";
          }
          try {
            var root = document.documentElement;
            if (root) {
              root.setAttribute("data-hushh-native-test-enabled", bridge.enabled ? "true" : "false");
              root.setAttribute("data-hushh-native-test-auto-reviewer-login", bridge.autoReviewerLogin ? "true" : "false");
              root.setAttribute("data-hushh-native-test-expected-marker", uiFlowsOwnRouting ? "" : (bridge.expectedMarker || ""));
              root.setAttribute("data-hushh-native-test-initial-route", uiFlowsOwnRouting ? "" : (bridge.initialRoute || ""));
              root.setAttribute("data-hushh-native-test-expected-route", uiFlowsOwnRouting ? "" : (bridge.expectedRoute || ""));
            }
          } catch (_) {}
          try {
            window.addEventListener("error", function(event) {
              try {
                bridge.lastJsErrorClass = classifyError(event && (event.error || event.message));
              } catch (_) {}
            });
            window.addEventListener("unhandledrejection", function(event) {
              try {
                bridge.lastUnhandledRejectionClass = classifyError(event && event.reason);
              } catch (_) {
                bridge.lastUnhandledRejectionClass = "other";
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
            var visible404 = false;
            try {
              var bodyText = ((document.body && document.body.innerText) || "").trim().slice(0, 400);
              visible404 =
                bodyText.indexOf("404") >= 0 ||
                bodyText.toLowerCase().indexOf("not found") >= 0;
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
              triggerVaultUnlockPresent: typeof bridge.triggerVaultUnlock === "function",
              vaultPassphraseConfigured: typeof bridge.vaultPassphrase === "string" && bridge.vaultPassphrase.length > 0,
              expectedUserConfigured: typeof bridge.expectedUserId === "string" && bridge.expectedUserId.length > 0,
              vaultCryptoStage: bridge.vaultCryptoStage || "",
              vaultCryptoErrorName: bridge.vaultCryptoErrorName || "",
              vaultCryptoSubtleAvailable: bridge.vaultCryptoSubtleAvailable === true,
              vaultCryptoPassphraseMatchesConfig: bridge.vaultCryptoPassphraseMatchesConfig === true,
              vaultCryptoPassphraseUtf8Length: String(bridge.vaultCryptoPassphraseUtf8Length || 0),
              vaultCryptoSaltLength: String(bridge.vaultCryptoSaltLength || 0),
              vaultCryptoIvLength: String(bridge.vaultCryptoIvLength || 0),
              vaultCryptoCiphertextLength: String(bridge.vaultCryptoCiphertextLength || 0),
              domTestEnabled: "",
              domAutoReviewerLogin: "",
              reviewerButtonFound: reviewerButtonFound,
              jsErrorClass: bridge.lastJsErrorClass || "",
              jsRejectionClass: bridge.lastUnhandledRejectionClass || "",
              longImportWait: bridge.uiFlowLongWait === true,
              visible404: visible404,
              markerFound: markerFound,
              bootstrapState: bridge.bootstrapState || "",
              bootstrapUserMatchesExpected: !!bridge.bootstrapUserId && !!bridge.expectedUserId
                ? bridge.bootstrapUserId === bridge.expectedUserId
                : null,
              bootstrapErrorClass: bridge.bootstrapErrorClass || "",
              title: document.title || "",
              routeId: beacon ? (beacon.routeId || "") : "",
              authState: beacon ? (beacon.authState || "") : "",
              dataState: beacon ? (beacon.dataState || "") : "",
              errorCode: beacon ? (beacon.errorCode || "") : "",
              errorMessage: beacon ? (beacon.errorMessage || "") : "",
              uiFlowCurrent: bridge.uiFlowCurrent || "",
              uiFlowStepIndex: String(bridge.uiFlowStepIndex ?? ""),
              uiFlowStepType: bridge.uiFlowStepType || "",
              uiFlowCheckpoint: bridge.uiFlowCheckpoint || "",
              uiFlowStepStartedAt: bridge.uiFlowStepStartedAt || "",
              uiFlowAuditRunId: bridge.uiFlowAuditRunId || bridge.uiFlowRunId || "",
              uiFlowAuditPlanDigest: bridge.uiFlowAuditPlanDigest || "",
              uiFlowLayout: bridge.uiFlowLayout || "",
              uiFlowErrorClass: classifyError(bridge.uiFlowErrorClass || bridge.uiFlowError || ""),
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
                    if (bridge._vaultUnlockSubmitted === true) {
                      return;
                    }
                    bridge._vaultUnlockSubmitted = true;
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
                  if (unlockButton && !unlockButton.disabled && bridge._vaultUnlockSubmitted !== true) {
                    bridge._vaultUnlockSubmitted = true;
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
          function hasIncompleteUiFlowSession(runId) {
            try {
              var normalizedRunId = String(runId || "").replace(/[^a-zA-Z0-9_-]/g, "");
              var storageKey = "__hushh_native_ui_flow_state_v1" +
                (normalizedRunId ? ":" + normalizedRunId : "");
              var raw = window.sessionStorage.getItem(storageKey);
              if (!raw) return false;
              var state = JSON.parse(raw);
              return state && state.started === true && state.complete !== true;
            } catch (_) {
              return false;
            }
          }
          var uiFlowsOwnRouting =
            bridge.runUiFlows === true &&
            (bridge._uiFlowsStarted === true ||
              bridge._uiFlowsRoutingOwned === true ||
              hasIncompleteUiFlowSession(bridge.uiFlowRunId));
          bridge._uiFlowsRoutingOwned = uiFlowsOwnRouting;
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
            bootstrapUserMatchesExpected: !!bridge.bootstrapUserId && !!bridge.expectedUserId
              ? bridge.bootstrapUserId === bridge.expectedUserId
              : null,
            bootstrapErrorClass: bridge.bootstrapErrorClass || "",
            jsErrorClass: bridge.lastJsErrorClass || "",
            jsRejectionClass: bridge.lastUnhandledRejectionClass || "",
            longImportWait: bridge.uiFlowLongWait === true,
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
            uiFlowCheckpoint: bridge.uiFlowCheckpoint || "",
            uiFlowStepStartedAt: bridge.uiFlowStepStartedAt || "",
            uiFlowAuditRunId: bridge.uiFlowAuditRunId || bridge.uiFlowRunId || "",
            uiFlowAuditPlanDigest: bridge.uiFlowAuditPlanDigest || "",
            uiFlowLayout: bridge.uiFlowLayout || "",
            uiFlowErrorClass: bridge.uiFlowErrorClass || "",
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
        // Firebase owns its Keychain record; HushhAuth owns a second cached
        // identity/token service. Both must be cleared or a destructive cold
        // audit can silently restore the previous user after reinstall.
        HushhAuthPlugin.clearPersistedSessionForNativeReset()
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
    init(frame: CGRect, showOverlay: Bool) {
        super.init(frame: frame)
        isAccessibilityElement = true
        accessibilityIdentifier = "native-test-status"
        let initialStatus = "route=booting;ready=0;marker=;auth=pending;data=booting;error="
        accessibilityLabel = initialStatus
        accessibilityValue = initialStatus
        setTitle(initialStatus, for: .normal)
        setTitleColor(showOverlay ? .systemGreen : .clear, for: .normal)
        backgroundColor = showOverlay ? UIColor.black.withAlphaComponent(0.72) : .clear
        alpha = showOverlay ? 0.95 : 0.01
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
    }

    private static func statusFileURL() -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent(fileName)
    }

    private static func uiReportFileURL() -> URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent(uiReportFileName)
    }
}
