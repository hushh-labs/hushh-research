package com.hushh.app

import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import com.getcapacitor.BridgeActivity
import com.getcapacitor.WebViewListener
import com.hushh.app.plugins.HushhAuth.HushhAuthPlugin
import com.hushh.app.plugins.HushhConsent.HushhConsentPlugin
import com.hushh.app.plugins.HushhVault.HushhVaultPlugin
import com.hushh.app.plugins.HushhKeystore.HushhKeystorePlugin
import com.hushh.app.plugins.HushhSettings.HushhSettingsPlugin
import com.hushh.app.plugins.HushhSync.HushhSyncPlugin
import com.hushh.app.plugins.HushhAccount.HushhAccountPlugin
import com.hushh.app.plugins.HushhLocation.HushhLocationPlugin
import com.hushh.app.plugins.HushhNotifications.HushhNotificationsPlugin
import com.hushh.app.plugins.Kai.KaiPlugin
import com.hushh.app.plugins.PersonalKnowledgeModel.PersonalKnowledgeModelPlugin
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File

class MainActivity : BridgeActivity() {
    private val nativeTestHandler = Handler(Looper.getMainLooper())
    private var nativeTestPollRunnable: Runnable? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        Log.d("MainActivity", "Registering all native plugins...")
        
        // Register all Hushh native plugins
        registerPlugin(HushhAuthPlugin::class.java)
        registerPlugin(HushhVaultPlugin::class.java)
        registerPlugin(HushhConsentPlugin::class.java)
        registerPlugin(HushhSyncPlugin::class.java)
        registerPlugin(HushhSettingsPlugin::class.java)
        registerPlugin(HushhKeystorePlugin::class.java)
        registerPlugin(HushhNotificationsPlugin::class.java)
        registerPlugin(KaiPlugin::class.java) // Agent Kai plugin
        registerPlugin(PersonalKnowledgeModelPlugin::class.java) // PKM plugin
        registerPlugin(HushhAccountPlugin::class.java) // Account management (deletion)
        registerPlugin(HushhLocationPlugin::class.java) // Foreground location capture
        
        Log.d("MainActivity", "All 11 plugins registered successfully")
        
        super.onCreate(savedInstanceState)

        val config = NativeTestConfiguration.from(intent.extras)
        if (config.enabled) {
            installNativeTestBridge(config)
        }
    }

    override fun onDestroy() {
        nativeTestPollRunnable?.let { nativeTestHandler.removeCallbacks(it) }
        nativeTestPollRunnable = null
        super.onDestroy()
    }

    private fun installNativeTestBridge(config: NativeTestConfiguration) {
        val activeBridge = bridge ?: run {
            writeNativeTestStatus(config.initialStatus)
            return
        }
        val webView = activeBridge.webView ?: run {
            writeNativeTestStatus(config.initialStatus)
            return
        }

        writeNativeTestStatus(config.initialStatus)
        activeBridge.addWebViewListener(object : WebViewListener() {
            override fun onPageCommitVisible(view: WebView, url: String) {
                injectNativeTestBridge(view, config)
            }

            override fun onPageLoaded(webView: WebView) {
                injectNativeTestBridge(webView, config)
            }
        })

        injectNativeTestBridge(webView, config)
        startNativeTestPolling(webView, config)
    }

    private fun injectNativeTestBridge(webView: WebView, config: NativeTestConfiguration) {
        webView.post {
            webView.evaluateJavascript(config.injectedScript, null)
        }
    }

    private fun startNativeTestPolling(webView: WebView, config: NativeTestConfiguration) {
        nativeTestPollRunnable?.let { nativeTestHandler.removeCallbacks(it) }

        val runnable = object : Runnable {
            override fun run() {
                webView.evaluateJavascript(config.statusJavaScript) { result ->
                    val payload = parseJavaScriptStatus(result)
                    if (payload == null) {
                        writeNativeTestStatus(
                            "route=unknown;ready=0;marker=${sanitizeStatusValue(config.expectedMarker)};auth=pending;data=booting;error=status_parse"
                        )
                    } else {
                        writeNativeTestStatus(config.statusFromPayload(payload))
                    }
                }
                nativeTestHandler.postDelayed(this, 350)
            }
        }

        nativeTestPollRunnable = runnable
        nativeTestHandler.post(runnable)
    }

    private fun parseJavaScriptStatus(raw: String?): JSONObject? {
        if (raw.isNullOrBlank() || raw == "null") {
            return null
        }

        return try {
            val decoded = JSONTokener(raw).nextValue()
            when (decoded) {
                is String -> JSONObject(decoded)
                is JSONObject -> decoded
                else -> null
            }
        } catch (_: Exception) {
            try {
                JSONObject(raw)
            } catch (_: Exception) {
                null
            }
        }
    }

    private fun writeNativeTestStatus(status: String) {
        try {
            File(filesDir, "native-test-status.txt").writeText(status)
        } catch (error: Exception) {
            Log.w("MainActivity", "Failed to write native test status: ${error.message}")
        }
    }

    private data class NativeTestConfiguration(
        val enabled: Boolean,
        val initialRoute: String,
        val expectedMarker: String,
        val expectedRoute: String,
        val autoReviewerLogin: Boolean,
        val vaultPassphrase: String,
        val expectedUserId: String,
        val resetAppState: Boolean
    ) {
        val initialStatus: String
            get() = "route=booting;ready=0;marker=${sanitizeStatusValue(expectedMarker)};auth=pending;data=booting;error="

        val injectedScript: String
            get() {
                val payload = JSONObject().apply {
                    put("enabled", enabled)
                    put("initialRoute", initialRoute)
                    put("expectedMarker", expectedMarker)
                    put("expectedRoute", expectedRoute)
                    put("autoReviewerLogin", autoReviewerLogin)
                    put("vaultPassphrase", vaultPassphrase)
                    put("expectedUserId", expectedUserId)
                }.toString()

                return """
                (function() {
                  if (window.top !== window) return;
                  var config = $payload;
                  var bridge = window.__HUSHH_NATIVE_TEST__ || {};
                  bridge.enabled = config.enabled === true;
                  bridge.initialRoute = config.initialRoute || null;
                  bridge.expectedMarker = config.expectedMarker || null;
                  bridge.expectedRoute = config.expectedRoute || null;
                  bridge.autoReviewerLogin = config.autoReviewerLogin === true;
                  bridge.vaultPassphrase = config.vaultPassphrase || "";
                  bridge.expectedUserId = config.expectedUserId || "";
                  bridge.lastJsError = bridge.lastJsError || "";
                  bridge.lastUnhandledRejection = bridge.lastUnhandledRejection || "";
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
                    if (!bridge._androidErrorListenersInstalled) {
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
                      bridge._androidErrorListenersInstalled = true;
                    }
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
                    var bodySnippet = "";
                    try {
                      var buttons = Array.prototype.slice.call(document.querySelectorAll("button"));
                      reviewerButtonFound = buttons.some(function(button) {
                        var text = (button.textContent || "").trim().toLowerCase();
                        return text === "continue as reviewer";
                      });
                    } catch (_) {}
                    try {
                      bodySnippet = ((document.body && document.body.innerText) || "").trim().slice(0, 160);
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
                      triggerReviewerLoginPresent: typeof bridge.triggerReviewerLogin === "function",
                      domTestEnabled: (document.documentElement && document.documentElement.getAttribute("data-hushh-native-test-enabled")) || "",
                      domAutoReviewerLogin: (document.documentElement && document.documentElement.getAttribute("data-hushh-native-test-auto-reviewer-login")) || "",
                      reviewerButtonFound: reviewerButtonFound,
                      jsError: bridge.lastJsError || "",
                      jsRejection: bridge.lastUnhandledRejection || "",
                      bodySnippet: bodySnippet,
                      markerFound: markerFound,
                      bootstrapState: bridge.bootstrapState || "",
                      bootstrapUserId: bridge.bootstrapUserId || "",
                      bootstrapError: bridge.bootstrapError || "",
                      title: document.title || "",
                      routeId: beacon ? (beacon.routeId || "") : "",
                      authState: beacon ? (beacon.authState || "") : "",
                      dataState: beacon ? (beacon.dataState || "") : "",
                      errorCode: beacon ? (beacon.errorCode || "") : "",
                      errorMessage: beacon ? (beacon.errorMessage || "") : ""
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
                          var passphraseInput = document.querySelector("#unlock-passphrase");
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
                  };
                  window.__HUSHH_NATIVE_TEST__ = bridge;
                  setTimeout(function() { bridge.start(); }, 0);
                })();
                """.trimIndent()
            }

        val statusJavaScript: String
            get() {
                val marker = JSONObject.quote(expectedMarker)
                val route = JSONObject.quote(expectedRoute)
                val initial = JSONObject.quote(initialRoute)
                val autoLogin = if (autoReviewerLogin) "true" else "false"
                return """
                (function() {
                  var marker = $marker;
                  var expectedRoute = $route;
                  var initialRoute = $initial;
                  var autoReviewerLogin = $autoLogin;
                  var bridge = window.__HUSHH_NATIVE_TEST__ || {};
                  var previousInitialRoute = bridge.initialRoute || "";
                  bridge.expectedMarker = marker;
                  bridge.expectedRoute = expectedRoute;
                  bridge.initialRoute = initialRoute || null;
                  bridge.autoReviewerLogin = autoReviewerLogin === true;
                  try {
                    var root = document.documentElement;
                    if (root) {
                      root.setAttribute("data-hushh-native-test-auto-reviewer-login", bridge.autoReviewerLogin ? "true" : "false");
                      root.setAttribute("data-hushh-native-test-initial-route", bridge.initialRoute || "");
                      root.setAttribute("data-hushh-native-test-expected-marker", bridge.expectedMarker || "");
                      root.setAttribute("data-hushh-native-test-expected-route", bridge.expectedRoute || "");
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
                    triggerReviewerLoginPresent: typeof bridge.triggerReviewerLogin === "function",
                    domTestEnabled: (document.documentElement && document.documentElement.getAttribute("data-hushh-native-test-enabled")) || "",
                    domAutoReviewerLogin: (document.documentElement && document.documentElement.getAttribute("data-hushh-native-test-auto-reviewer-login")) || "",
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
                    errorMessage: ""
                  });
                })();
                """.trimIndent()
            }

        fun statusFromPayload(payload: JSONObject): String {
            val route = payload.optString("route", "").trim()
            val marker = payload.optString("expectedMarker", "").trim()
            val expected = payload.optString("expectedRoute", "").trim()
            val readyState = payload.optString("readyState", "").lowercase()
            val authState = payload.optString("authState", "pending").trim()
            val dataState = payload.optString("dataState", "booting").trim()
            val errorCode = payload.optString("errorCode", "").trim()
            val routeReady = expected.isBlank() || normalizeRoute(route) == normalizeRoute(expected)
            val documentReady = readyState == "interactive" || readyState == "complete"
            val markerFound = payload.optBoolean("markerFound", false)
            val ready = routeReady && documentReady && markerFound

            return listOf(
                "route=${sanitizeStatusValue(route)}",
                "ready=${if (ready) "1" else "0"}",
                "marker=${sanitizeStatusValue(marker)}",
                "auth=${sanitizeStatusValue(authState)}",
                "data=${sanitizeStatusValue(dataState)}",
                "doc=${sanitizeStatusValue(readyState)}",
                "found=${if (markerFound) "1" else "0"}",
                "routeok=${if (routeReady) "1" else "0"}",
                "test=${if (payload.optBoolean("testEnabled", false)) "1" else "0"}",
                "auto=${if (payload.optBoolean("autoReviewerLogin", false)) "1" else "0"}",
                "bridge=${if (payload.optBoolean("bridgeBeaconPresent", false)) "1" else "0"}",
                "trigger=${if (payload.optBoolean("triggerReviewerLoginPresent", false)) "1" else "0"}",
                "domtest=${sanitizeStatusValue(payload.optString("domTestEnabled", ""))}",
                "domauto=${sanitizeStatusValue(payload.optString("domAutoReviewerLogin", ""))}",
                "reviewer=${if (payload.optBoolean("reviewerButtonFound", false)) "1" else "0"}",
                "bootstrap=${sanitizeStatusValue(payload.optString("bootstrapState", ""))}",
                "bootstrap_uid=${sanitizeStatusValue(payload.optString("bootstrapUserId", ""))}",
                "bootstrap_error=${sanitizeStatusValue(payload.optString("bootstrapError", ""))}",
                "jserr=${sanitizeStatusValue(payload.optString("jsError", ""))}",
                "jsrej=${sanitizeStatusValue(payload.optString("jsRejection", ""))}",
                "body=${sanitizeStatusValue(payload.optString("bodySnippet", ""))}",
                "error=${sanitizeStatusValue(errorCode)}"
            ).joinToString(";")
        }

        companion object {
            fun from(bundle: Bundle?): NativeTestConfiguration {
                val initialRoute = bundle?.getString("HUSHH_NATIVE_TEST_INITIAL_ROUTE").orEmpty()
                val expectedRoute = bundle?.getString("HUSHH_NATIVE_TEST_EXPECTED_ROUTE")
                    ?: deriveExpectedRoute(initialRoute)
                return NativeTestConfiguration(
                    enabled = bundle?.getBoolean("HUSHH_NATIVE_TEST_MODE", false) ?: false,
                    initialRoute = initialRoute,
                    expectedMarker = bundle?.getString("HUSHH_NATIVE_TEST_EXPECTED_MARKER").orEmpty(),
                    expectedRoute = expectedRoute,
                    autoReviewerLogin = bundle?.getBoolean("HUSHH_NATIVE_TEST_AUTO_REVIEWER_LOGIN", false) ?: false,
                    vaultPassphrase = bundle?.getString("HUSHH_NATIVE_TEST_VAULT_PASSPHRASE").orEmpty(),
                    expectedUserId = bundle?.getString("HUSHH_NATIVE_TEST_EXPECTED_USER_ID").orEmpty(),
                    resetAppState = bundle?.getBoolean("HUSHH_NATIVE_TEST_RESET_APP_STATE", true) ?: true
                )
            }

            private fun deriveExpectedRoute(initialRoute: String): String {
                if (initialRoute.startsWith("/login")) {
                    val redirect = Uri.parse("https://hushh.app$initialRoute").getQueryParameter("redirect")
                    if (!redirect.isNullOrBlank()) {
                        return redirect
                    }
                }
                return initialRoute
            }
        }
    }

    companion object {
        private fun normalizeRoute(value: String): String {
            val trimmed = value.trim()
            if (trimmed.isBlank() || trimmed == "/") {
                return if (trimmed.isBlank()) "/" else trimmed
            }

            return try {
                val uri = Uri.parse("https://native-test.local$trimmed")
                val path = uri.path?.let {
                    if (it.length > 1 && it.endsWith("/")) it.dropLast(1) else it
                } ?: "/"
                val query = uri.encodedQuery?.let { "?$it" } ?: ""
                "$path$query"
            } catch (_: Exception) {
                if (trimmed.endsWith("/")) trimmed.dropLast(1) else trimmed
            }
        }

        private fun sanitizeStatusValue(value: String?): String {
            return value.orEmpty()
                .replace(";", ",")
                .replace("\n", " ")
                .replace("\r", " ")
                .trim()
        }
    }
}
