package com.hussh.app

import android.net.Uri
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import com.getcapacitor.BridgeActivity
import com.getcapacitor.WebViewListener
import com.hussh.app.plugins.HushhAuth.HushhAuthPlugin
import com.hussh.app.plugins.HushhConsent.HushhConsentPlugin
import com.hussh.app.plugins.HushhVault.HushhVaultPlugin
import com.hussh.app.plugins.HushhKeystore.HushhKeystorePlugin
import com.hussh.app.plugins.HushhSettings.HushhSettingsPlugin
import com.hussh.app.plugins.HushhSync.HushhSyncPlugin
import com.hussh.app.plugins.HushhAccount.HushhAccountPlugin
import com.hussh.app.plugins.HushhLocation.HushhLocationPlugin
import com.hussh.app.plugins.HushhContacts.HushhContactsPlugin
import com.hussh.app.plugins.HushhNotifications.HushhNotificationsPlugin
import com.hussh.app.plugins.HushhSessionPrivacy.HushhSessionPrivacyPlugin
import com.hussh.app.plugins.Kai.KaiPlugin
import com.hussh.app.plugins.PersonalKnowledgeModel.PersonalKnowledgeModelPlugin
import org.json.JSONObject
import org.json.JSONTokener
import org.json.JSONArray
import java.io.File

object NativeTestModePolicy {
    @JvmStatic
    fun isEnabled(isDebugBuild: Boolean, requested: Boolean): Boolean =
        isDebugBuild && requested

    @JvmStatic
    fun uiFlowRunId(value: String?): String =
        value.orEmpty().filter { it.isLetterOrDigit() || it == '_' || it == '-' }.take(64)
}

class MainActivity : BridgeActivity() {
    private val nativeTestHandler = Handler(Looper.getMainLooper())
    private var nativeTestPollRunnable: Runnable? = null
    private var nativeAuditCredentialReceiver: NativeAuditCredentialReceiver? = null
    private var nativeAuditGeneration = 0
    private var sessionPrivacyOverlay: FrameLayout? = null
    private var sessionPrivacyShielded = false
    private var sessionPrivacyGeneration = 0
    private var sessionPrivacyActivityResumed = false
    private var sessionPrivacyOwnsSecureFlag = false
    private var sessionPrivacyAccessibilityWebView: WebView? = null
    private var sessionPrivacyPreviousWebViewAccessibility: Int? = null

    data class SessionPrivacyState(
        val shielded: Boolean,
        val generation: Int
    )

    data class SessionPrivacyCompletion(
        val released: Boolean,
        val shielded: Boolean,
        val generation: Int
    )

    override fun onCreate(savedInstanceState: Bundle?) {
        sessionPrivacyShielded =
            savedInstanceState?.getBoolean(SESSION_PRIVACY_SHIELDED_KEY, false) == true
        sessionPrivacyGeneration =
            savedInstanceState?.getInt(SESSION_PRIVACY_GENERATION_KEY, 0)?.coerceAtLeast(0) ?: 0
        if (sessionPrivacyShielded && sessionPrivacyGeneration == 0) {
            sessionPrivacyGeneration = 1
        }

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
        registerPlugin(HushhContactsPlugin::class.java) // Contact matching
        registerPlugin(HushhSessionPrivacyPlugin::class.java) // Resume-time session privacy shield
        
        Log.d("MainActivity", "All 13 plugins registered successfully")
        
        super.onCreate(savedInstanceState)

        installSessionPrivacyOverlay()
        if (sessionPrivacyShielded) {
            showSessionPrivacyOverlay()
        }

        val isDebuggableBuild =
            (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        val config = NativeTestConfiguration.from(intent.extras, isDebuggableBuild)
        if (config.enabled) {
            if (intent.hasExtra("HUSHH_NATIVE_TEST_VAULT_PASSPHRASE") ||
                intent.hasExtra("HUSHH_NATIVE_TEST_EXPECTED_USER_ID")) {
                writeNativeTestStatus("ready=0;error=audit_credentials_unavailable")
                return
            }
            val runId = intent.getStringExtra("HUSHH_NATIVE_TEST_CREDENTIAL_RUN_ID").orEmpty()
            if (runId.isNotEmpty()) {
                val generation = ++nativeAuditGeneration
                try {
                    nativeAuditCredentialReceiver = NativeAuditCredentialReceiver(
                        this, config.enabled, runId,
                        received = { credentials ->
                            nativeTestHandler.post {
                                if (!isDestroyed && nativeAuditGeneration == generation) {
                                    installNativeTestBridge(config.copy(
                                        vaultPassphrase = credentials.passphrase,
                                        expectedUserId = credentials.userId,
                                    ))
                                }
                            }
                        },
                        refused = {
                            nativeTestHandler.post {
                                if (!isDestroyed && nativeAuditGeneration == generation) {
                                    writeNativeTestStatus("ready=0;error=audit_credentials_unavailable")
                                }
                            }
                        },
                    )
                } catch (_: Exception) {
                    writeNativeTestStatus("ready=0;error=audit_credentials_unavailable")
                }
            } else if (config.autoReviewerLogin) {
                writeNativeTestStatus("ready=0;error=audit_credentials_unavailable")
            } else {
                installNativeTestBridge(config)
            }
        }
    }

    /**
     * Mark the Activity resumed before BridgeActivity emits Capacitor's active
     * event. JS can then query HushhSessionPrivacy and safely acknowledge the
     * exact generation it just validated.
     */
    override fun onResume() {
        sessionPrivacyActivityResumed = true
        if (sessionPrivacyShielded) {
            showSessionPrivacyOverlay()
        }
        super.onResume()
    }

    /**
     * Cover the WebView before BridgeActivity/Capacitor observes the pause so
     * Android never snapshots or reveals stale vault content while inactive.
     */
    override fun onPause() {
        val wasResumed = sessionPrivacyActivityResumed
        sessionPrivacyActivityResumed = false
        if (wasResumed) {
            activateSessionPrivacyShield()
        } else if (sessionPrivacyShielded) {
            showSessionPrivacyOverlay()
        }
        super.onPause()
    }

    override fun onStop() {
        sessionPrivacyActivityResumed = false
        if (sessionPrivacyShielded) {
            showSessionPrivacyOverlay()
        }
        super.onStop()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean(SESSION_PRIVACY_SHIELDED_KEY, sessionPrivacyShielded)
        outState.putInt(SESSION_PRIVACY_GENERATION_KEY, sessionPrivacyGeneration)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        nativeAuditGeneration += 1
        nativeAuditCredentialReceiver?.close()
        nativeAuditCredentialReceiver = null
        sessionPrivacyActivityResumed = false
        restoreSessionContentAccessibility()
        nativeTestPollRunnable?.let { nativeTestHandler.removeCallbacks(it) }
        nativeTestPollRunnable = null
        super.onDestroy()
    }

    internal fun readSessionPrivacyState(): SessionPrivacyState =
        SessionPrivacyState(
            shielded = sessionPrivacyShielded,
            generation = sessionPrivacyGeneration
        )

    /**
     * Release is deliberately fail-closed: an acknowledgement is accepted
     * only for the currently resumed Activity and its current pause generation.
     */
    internal fun completeSessionValidation(generation: Int): SessionPrivacyCompletion {
        val released =
            sessionPrivacyShielded &&
                sessionPrivacyActivityResumed &&
                generation == sessionPrivacyGeneration

        if (released) {
            sessionPrivacyShielded = false
            hideSessionPrivacyOverlay()
        }

        return SessionPrivacyCompletion(
            released = released,
            shielded = sessionPrivacyShielded,
            generation = sessionPrivacyGeneration
        )
    }

    private fun activateSessionPrivacyShield() {
        sessionPrivacyGeneration =
            if (sessionPrivacyGeneration == Int.MAX_VALUE) 1 else sessionPrivacyGeneration + 1
        sessionPrivacyShielded = true
        showSessionPrivacyOverlay()
    }

    private fun installSessionPrivacyOverlay() {
        if (sessionPrivacyOverlay != null || isFinishing || isDestroyed) {
            return
        }

        val density = resources.displayMetrics.density
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES

            addView(
                ProgressBar(context),
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            )

            addView(
                TextView(context).apply {
                    text = "Checking your session\u2026"
                    setTextColor(Color.rgb(56, 53, 64))
                    textSize = 17f
                    gravity = Gravity.CENTER
                    setPadding(0, (20 * density).toInt(), 0, 0)
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            )

            addView(
                TextView(context).apply {
                    text = "Your private information stays hidden while we verify access."
                    setTextColor(Color.rgb(105, 101, 113))
                    textSize = 14f
                    gravity = Gravity.CENTER
                    setPadding(
                        (32 * density).toInt(),
                        (10 * density).toInt(),
                        (32 * density).toInt(),
                        0
                    )
                },
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT
                )
            )
        }

        val overlay = FrameLayout(this).apply {
            setBackgroundColor(Color.rgb(248, 247, 252))
            isClickable = true
            isFocusable = true
            contentDescription =
                "Checking your session. Your private information stays hidden while we verify access."
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            visibility = View.GONE
            elevation = 10_000f * density
            addView(
                content,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
        }
        sessionPrivacyOverlay = overlay

        addContentView(
            overlay,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )
    }

    private fun showSessionPrivacyOverlay() {
        installSessionPrivacyOverlay()
        hideSessionContentFromAccessibility()

        if ((window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE) == 0) {
            window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            sessionPrivacyOwnsSecureFlag = true
        }

        sessionPrivacyOverlay?.apply {
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
            visibility = View.VISIBLE
            bringToFront()
        }
    }

    private fun hideSessionPrivacyOverlay() {
        sessionPrivacyOverlay?.apply {
            visibility = View.GONE
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        }
        restoreSessionContentAccessibility()

        if (sessionPrivacyOwnsSecureFlag) {
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            sessionPrivacyOwnsSecureFlag = false
        }
    }

    /**
     * A visual cover is not enough for TalkBack: accessibility traversal can
     * otherwise reach sibling WebView nodes behind an opaque overlay. Preserve
     * the host's exact prior mode and hide all WebView descendants for as long
     * as the native shield owns this lifecycle generation.
     */
    private fun hideSessionContentFromAccessibility() {
        val webView = bridge?.webView ?: return
        if (sessionPrivacyAccessibilityWebView !== webView) {
            restoreSessionContentAccessibility()
            sessionPrivacyAccessibilityWebView = webView
            sessionPrivacyPreviousWebViewAccessibility =
                webView.importantForAccessibility
        } else if (sessionPrivacyPreviousWebViewAccessibility == null) {
            sessionPrivacyPreviousWebViewAccessibility =
                webView.importantForAccessibility
        }
        webView.importantForAccessibility =
            View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
    }

    private fun restoreSessionContentAccessibility() {
        val webView = sessionPrivacyAccessibilityWebView
        val previousMode = sessionPrivacyPreviousWebViewAccessibility
        sessionPrivacyAccessibilityWebView = null
        sessionPrivacyPreviousWebViewAccessibility = null
        if (webView != null && previousMode != null) {
            webView.importantForAccessibility = previousMode
        }
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

        webView.addJavascriptInterface(
            NativeTestJavaScriptBridge(filesDir, config),
            "HushhNativeTest"
        )
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
        val runUiFlows: Boolean,
        val uiFlowRunId: String
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
                    put("runUiFlows", runUiFlows)
                    put("uiFlowRunId", uiFlowRunId)
                }.toString()

                return """
                (function() {
                  if (window.top !== window) return;
                  var config = $payload;
                  var bridge = window.__HUSHH_NATIVE_TEST__ || {};
                  var configuredUiFlowRunId = String(config.uiFlowRunId || "").replace(/[^a-zA-Z0-9_-]/g, "");
                  var uiFlowStorageKey = "__hushh_native_ui_flow_state_v1" +
                    (configuredUiFlowRunId ? ":" + configuredUiFlowRunId : "");
                  var persistedUiFlowsOwnRouting = false;
                  try {
                    var persistedUiFlowState = JSON.parse(
                      window.sessionStorage.getItem(uiFlowStorageKey) || "null"
                    );
                    persistedUiFlowsOwnRouting = !!(
                      persistedUiFlowState &&
                      persistedUiFlowState.started === true &&
                      persistedUiFlowState.complete !== true
                    );
                  } catch (_) {}
                  var uiFlowsOwnRouting =
                    (bridge.runUiFlows === true || config.runUiFlows === true) &&
                    (bridge._uiFlowsStarted === true || persistedUiFlowsOwnRouting);
                  bridge.enabled = config.enabled === true;
                  bridge.autoReviewerLogin = config.autoReviewerLogin === true;
                  bridge.vaultPassphrase = config.vaultPassphrase || "";
                  bridge.expectedUserId = config.expectedUserId || "";
                  bridge.runUiFlows = bridge.runUiFlows === true || config.runUiFlows === true;
                  bridge.uiFlowRunId = configuredUiFlowRunId;
                  if (!uiFlowsOwnRouting) {
                    bridge.initialRoute = config.initialRoute || null;
                    bridge.expectedMarker = config.expectedMarker || null;
                    bridge.expectedRoute = config.expectedRoute || null;
                  }
                  bridge.lastJsError = bridge.lastJsError || "";
                  bridge.lastUnhandledRejection = bridge.lastUnhandledRejection || "";
                  try {
                    if (!window.webkit) window.webkit = {};
                    if (!window.webkit.messageHandlers) window.webkit.messageHandlers = {};
                    window.webkit.messageHandlers.hushhNativeTest = {
                      postMessage: function(payload) {
                        try {
                          if (window.HushhNativeTest && typeof window.HushhNativeTest.postMessage === "function") {
                            window.HushhNativeTest.postMessage(JSON.stringify(payload || {}));
                          }
                        } catch (_) {}
                      }
                    };
                  } catch (_) {}
                  try {
                    var root = document.documentElement;
                    if (root) {
                      root.setAttribute("data-hushh-native-test-enabled", bridge.enabled ? "true" : "false");
                      root.setAttribute("data-hushh-native-test-auto-reviewer-login", bridge.autoReviewerLogin ? "true" : "false");
                      root.setAttribute("data-hushh-native-test-expected-marker", uiFlowsOwnRouting ? "" : (bridge.expectedMarker || ""));
                      root.setAttribute("data-hushh-native-test-initial-route", uiFlowsOwnRouting ? "" : (bridge.initialRoute || ""));
                      root.setAttribute("data-hushh-native-test-expected-route", uiFlowsOwnRouting ? "" : (bridge.expectedRoute || ""));
                      root.setAttribute("data-hushh-native-test-run-ui-flows", bridge.runUiFlows ? "true" : "false");
                    }
                    window.dispatchEvent(new CustomEvent("hushh:native-test-config-updated"));
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
                    try {
                      var buttons = Array.prototype.slice.call(document.querySelectorAll("button"));
                      reviewerButtonFound = buttons.some(function(button) {
                        var text = (button.textContent || "").trim().toLowerCase();
                        return text === "continue as reviewer";
                      });
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
                      domTestEnabled: (document.documentElement && document.documentElement.getAttribute("data-hushh-native-test-enabled")) || "",
                      domAutoReviewerLogin: (document.documentElement && document.documentElement.getAttribute("data-hushh-native-test-auto-reviewer-login")) || "",
                      reviewerButtonFound: reviewerButtonFound,
                      jsError: bridge.lastJsError || "",
                      jsRejection: bridge.lastUnhandledRejection || "",
                      bodySnippet: "",
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
                      uiFlowCheckpoint: bridge.uiFlowCheckpoint || "",
                      uiFlowStepStartedAt: bridge.uiFlowStepStartedAt || "",
                      uiFlowAuditRunId: bridge.uiFlowAuditRunId || bridge.uiFlowRunId || "",
                      uiFlowAuditPlanDigest: bridge.uiFlowAuditPlanDigest || "",
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
                            if (!bridge._vaultUnlockTriggerSubmitted) {
                              bridge._vaultUnlockTriggerSubmitted = true;
                              bridge.triggerVaultUnlock();
                            }
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
                          if (bridge._vaultUnlockValueSet) {
                            return;
                          }
                          var prototype = window.HTMLInputElement && window.HTMLInputElement.prototype;
                          var descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, "value") : null;
                          var setInputValue = function(value) {
                            if (descriptor && typeof descriptor.set === "function") {
                              descriptor.set.call(passphraseInput, value);
                            } else {
                              passphraseInput.value = value;
                            }
                            passphraseInput.dispatchEvent(new Event("input", { bubbles: true }));
                            passphraseInput.dispatchEvent(new Event("change", { bubbles: true }));
                          };
                          setInputValue("");
                          setInputValue(bridge.vaultPassphrase);
                          bridge._vaultUnlockValueSet = true;
                          var submitDeadline = Date.now() + 3000;
                          var submitWhenReady = function() {
                            if (bridge._vaultUnlockButtonClicked) {
                              return;
                            }
                            var currentButtons = Array.prototype.slice.call(document.querySelectorAll("button"));
                            var unlockButton = currentButtons.find(function(button) {
                              var text = (button.textContent || "").trim().toLowerCase();
                              return text === "unlock with passphrase";
                            });
                            if (unlockButton && !unlockButton.disabled) {
                              bridge._vaultUnlockButtonClicked = true;
                              unlockButton.click();
                              return;
                            }
                            if (Date.now() < submitDeadline) {
                              window.setTimeout(submitWhenReady, 100);
                            }
                          };
                          submitWhenReady();
                        } catch (_) {}
                      }, 500);
                    }
                  };
                  window.__HUSHH_NATIVE_TEST__ = bridge;
                  try {
                    if (bridge.runUiFlows === true && !window.__HUSHH_NATIVE_UI_TEST__ && !bridge._androidUiRunnerLoading) {
                      bridge._androidUiRunnerLoading = true;
                      fetch("/native-ui-test-runner.js", { cache: "no-store" })
                        .then(function(response) {
                          if (!response.ok) {
                            throw new Error("failed to load native-ui-test-runner.js: " + response.status);
                          }
                          return response.text();
                        })
                        .then(function(source) {
                          (0, eval)(source);
                          bridge._androidUiRunnerLoaded = true;
                          if (window.__HUSHH_NATIVE_UI_TEST__ && typeof window.__HUSHH_NATIVE_UI_TEST__.startUiFlowBootstrap === "function") {
                            window.__HUSHH_NATIVE_UI_TEST__.startUiFlowBootstrap();
                          }
                        })
                        .catch(function(error) {
                          bridge.uiFlowError = error instanceof Error ? error.message : String(error);
                          bridge.uiFlowReport = { ok: false, error: bridge.uiFlowError, flows: [] };
                          bridge.uiFlowsComplete = true;
                          bridge.uiFlowsOk = false;
                          bridge.uiFlowsFailed = true;
                          try {
                            window.webkit.messageHandlers.hushhNativeTest.postMessage({
                              uiFlowReport: bridge.uiFlowReport,
                              uiFlowError: bridge.uiFlowError,
                              uiFlowsComplete: true,
                              uiFlowsOk: false
                            });
                          } catch (_) {}
                        });
                    }
                    if (window.__HUSHH_NATIVE_UI_TEST__ && typeof window.__HUSHH_NATIVE_UI_TEST__.startUiFlowBootstrap === "function") {
                      window.__HUSHH_NATIVE_UI_TEST__.startUiFlowBootstrap();
                    }
                  } catch (_) {}
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
                val runFlows = if (runUiFlows) "true" else "false"
                return """
                (function() {
                  var marker = $marker;
                  var expectedRoute = $route;
                  var initialRoute = $initial;
                  var autoReviewerLogin = $autoLogin;
                  var runUiFlows = $runFlows;
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
                  var uiFlowsOwnRouting = bridge.runUiFlows === true && bridge._uiFlowsStarted === true;
                  uiFlowsOwnRouting = uiFlowsOwnRouting || (
                    bridge.runUiFlows === true &&
                    (bridge._uiFlowsRoutingOwned === true || hasIncompleteUiFlowSession(bridge.uiFlowRunId))
                  );
                  bridge._uiFlowsRoutingOwned = uiFlowsOwnRouting;
                  if (!uiFlowsOwnRouting) {
                    bridge.expectedMarker = marker;
                    bridge.expectedRoute = expectedRoute;
                    bridge.initialRoute = initialRoute || null;
                    bridge.autoReviewerLogin = autoReviewerLogin === true;
                    bridge.runUiFlows = runUiFlows === true;
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
                      root.setAttribute("data-hushh-native-test-run-ui-flows", bridge.runUiFlows ? "true" : "false");
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
                    errorMessage: "",
                    uiFlowCurrent: bridge.uiFlowCurrent || "",
                    uiFlowStepIndex: String(bridge.uiFlowStepIndex ?? ""),
                    uiFlowStepType: bridge.uiFlowStepType || "",
                    uiFlowCheckpoint: bridge.uiFlowCheckpoint || "",
                    uiFlowStepStartedAt: bridge.uiFlowStepStartedAt || "",
                    uiFlowAuditRunId: bridge.uiFlowAuditRunId || bridge.uiFlowRunId || "",
                    uiFlowAuditPlanDigest: bridge.uiFlowAuditPlanDigest || "",
                    uiFlowError: bridge.uiFlowError || "",
                    uiFlowsComplete: bridge.uiFlowsComplete === true,
                    uiFlowsOk: bridge.uiFlowsOk === true
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
            val nativeUiRunnerPresent = payload.optBoolean("nativeUiRunnerPresent", false)
            val runUiFlows = payload.optBoolean("runUiFlows", false)
            val uiFlowsStarted = payload.optBoolean("uiFlowsStarted", false)
            val uiFlowsFailed = payload.optBoolean("uiFlowsFailed", false)
            val uiFlowBootstrapActive = payload.optBoolean("uiFlowBootstrapActive", false)
            val visible404 = payload.optBoolean("visible404", false)
            val uiFlowsComplete = payload.optBoolean("uiFlowsComplete", false)
            val uiFlowsOk = payload.optBoolean("uiFlowsOk", false)
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
                "uirunner=${if (nativeUiRunnerPresent) "1" else "0"}",
                "runui=${if (runUiFlows) "1" else "0"}",
                "uistarted=${if (uiFlowsStarted) "1" else "0"}",
                "uifailed=${if (uiFlowsFailed) "1" else "0"}",
                "uiboot=${if (uiFlowBootstrapActive) "1" else "0"}",
                "persona=${sanitizeStatusValue(payload.optString("activePersona", ""))}",
                "primary_persona=${sanitizeStatusValue(payload.optString("primaryNavPersona", ""))}",
                "persona_switch=${sanitizeStatusValue(payload.optString("personaSwitchStatus", ""))}",
                "persona_error=${sanitizeStatusValue(payload.optString("personaSwitchError", ""))}",
                "portfolio_start_state=${sanitizeStatusValue(payload.optString("portfolioImportStartState", ""))}",
                "portfolio_start_status=${sanitizeStatusValue(payload.optString("portfolioImportStartStatus", ""))}",
                "portfolio_start_run=${sanitizeStatusValue(payload.optString("portfolioImportStartRunId", ""))}",
                "portfolio_start_error=${sanitizeStatusValue(payload.optString("portfolioImportStartError", ""))}",
                "portfolio_stream_state=${sanitizeStatusValue(payload.optString("portfolioStreamState", ""))}",
                "portfolio_stream_run=${sanitizeStatusValue(payload.optString("portfolioStreamRunId", ""))}",
                "portfolio_events=${sanitizeStatusValue(payload.optString("portfolioStreamEventCount", ""))}",
                "portfolio_last_event=${sanitizeStatusValue(payload.optString("portfolioStreamLastEvent", ""))}",
                "portfolio_last_seq=${sanitizeStatusValue(payload.optString("portfolioStreamLastSeq", ""))}",
                "portfolio_stream_error=${sanitizeStatusValue(payload.optString("portfolioStreamLastError", ""))}",
                "trigger=${if (payload.optBoolean("triggerReviewerLoginPresent", false)) "1" else "0"}",
                "domtest=${sanitizeStatusValue(payload.optString("domTestEnabled", ""))}",
                "domauto=${sanitizeStatusValue(payload.optString("domAutoReviewerLogin", ""))}",
                "reviewer=${if (payload.optBoolean("reviewerButtonFound", false)) "1" else "0"}",
                "bootstrap=${sanitizeStatusValue(payload.optString("bootstrapState", ""))}",
                "bootstrap_uid_ok=${if (expectedUserId.isNotBlank() && payload.optString("bootstrapUserId", "") == expectedUserId) "1" else "0"}",
                "bootstrap_error=${sanitizeStatusValue(payload.optString("bootstrapError", ""))}",
                "jserr=${sanitizeStatusValue(payload.optString("jsError", ""))}",
                "jsrej=${sanitizeStatusValue(payload.optString("jsRejection", ""))}",
                "visible404=${if (visible404) "1" else "0"}",
                "ui_complete=${if (uiFlowsComplete) "1" else "0"}",
                "ui_ok=${if (uiFlowsOk) "1" else "0"}",
                "ui_run=${sanitizeStatusValue(payload.optString("uiFlowAuditRunId", ""))}",
                "ui_plan=${sanitizeStatusValue(payload.optString("uiFlowAuditPlanDigest", ""))}",
                "ui_flow=${sanitizeStatusValue(payload.optString("uiFlowCurrent", ""))}",
                "ui_step=${sanitizeStatusValue(payload.optString("uiFlowStepIndex", ""))}",
                "ui_step_type=${sanitizeStatusValue(payload.optString("uiFlowStepType", ""))}",
                "ui_checkpoint=${sanitizeStatusValue(payload.optString("uiFlowCheckpoint", ""))}",
                "ui_error=${sanitizeStatusValue(payload.optString("uiFlowError", ""))}",
                "error=${sanitizeStatusValue(errorCode)}"
            ).joinToString(";")
        }

        companion object {
            fun from(
                bundle: Bundle?,
                isDebugBuild: Boolean
            ): NativeTestConfiguration {
                val initialRoute = bundle?.getString("HUSHH_NATIVE_TEST_INITIAL_ROUTE").orEmpty()
                val expectedRoute = bundle?.getString("HUSHH_NATIVE_TEST_EXPECTED_ROUTE")
                    ?: deriveExpectedRoute(initialRoute)
                return NativeTestConfiguration(
                    enabled = NativeTestModePolicy.isEnabled(
                        isDebugBuild,
                        bundle?.getBoolean("HUSHH_NATIVE_TEST_MODE", false) ?: false
                    ),
                    initialRoute = initialRoute,
                    expectedMarker = bundle?.getString("HUSHH_NATIVE_TEST_EXPECTED_MARKER").orEmpty(),
                    expectedRoute = expectedRoute,
                    autoReviewerLogin = bundle?.getBoolean("HUSHH_NATIVE_TEST_AUTO_REVIEWER_LOGIN", false) ?: false,
                    vaultPassphrase = "",
                    expectedUserId = "",
                    runUiFlows = bundle?.getBoolean("HUSHH_NATIVE_TEST_RUN_UI_FLOWS", false) ?: false,
                    uiFlowRunId = NativeTestModePolicy.uiFlowRunId(
                        bundle?.getString("HUSHH_NATIVE_TEST_UI_FLOW_RUN_ID")
                    )
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

    private class NativeTestJavaScriptBridge(
        private val filesDir: File,
        private val config: NativeTestConfiguration
    ) {
        @JavascriptInterface
        fun postMessage(rawPayload: String?) {
            if (rawPayload.isNullOrBlank()) {
                return
            }

            val payload = try {
                val decoded = JSONTokener(rawPayload).nextValue()
                decoded as? JSONObject ?: JSONObject(rawPayload)
            } catch (_: Exception) {
                return
            }

            try {
                val report = payload.opt("uiFlowReport")
                if (report != null && report != JSONObject.NULL) {
                    File(filesDir, "native-ui-interaction-report.json").writeText(
                        sanitizeUiFlowReport(report).toString(2)
                    )
                }
            } catch (error: Exception) {
                Log.w("MainActivity", "Failed to write native UI report: ${error.message}")
            }

            try {
                File(filesDir, "native-test-status.txt").writeText(config.statusFromPayload(payload))
            } catch (error: Exception) {
                Log.w("MainActivity", "Failed to write native test bridge status: ${error.message}")
            }
        }

        private fun sanitizeUiFlowReport(rawReport: Any): JSONObject {
            val report = rawReport as? JSONObject ?: return JSONObject()
            val safe = JSONObject()
            for (key in listOf("ok", "auditRunId", "auditPlanVersion", "auditPlanDigest", "startedAt", "completedAt", "errorClass")) {
                if (report.has(key)) {
                    safe.put(key, report.opt(key))
                }
            }

            val safeFlows = JSONArray()
            val flows = report.optJSONArray("flows") ?: JSONArray()
            for (index in 0 until flows.length()) {
                val flow = flows.optJSONObject(index) ?: continue
                val safeFlow = JSONObject()
                for (key in listOf("id", "ok", "optional", "skipped")) {
                    if (flow.has(key)) {
                        safeFlow.put(key, flow.opt(key))
                    }
                }
                val failedStep = flow.optJSONObject("failedStep")
                if (failedStep?.has("type") == true) {
                    safeFlow.put("failedStep", JSONObject().put("type", failedStep.optString("type")))
                }
                val safeResults = JSONArray()
                val results = flow.optJSONArray("results") ?: JSONArray()
                for (resultIndex in 0 until results.length()) {
                    val result = results.optJSONObject(resultIndex) ?: continue
                    val safeResult = JSONObject()
                    for (key in listOf("step", "type", "ok", "skipped", "skipClass", "reasonClass", "errorClass", "checkpoint")) {
                        if (result.has(key)) {
                            safeResult.put(key, result.opt(key))
                        }
                    }
                    safeResults.put(safeResult)
                }
                safeFlow.put("results", safeResults)
                safeFlows.put(safeFlow)
            }
            safe.put("flows", safeFlows)
            return safe
        }
    }

    companion object {
        private const val SESSION_PRIVACY_SHIELDED_KEY =
            "com.hussh.app.session_privacy.shielded"
        private const val SESSION_PRIVACY_GENERATION_KEY =
            "com.hussh.app.session_privacy.generation"

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
