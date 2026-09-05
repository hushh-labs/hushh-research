import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function between(value: string, start: string, end: string): string {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return value.slice(startIndex, endIndex);
}

describe("native resumed-session privacy shield contract", () => {
  it("exposes a web-safe, generation-scoped Capacitor acknowledgement API", () => {
    const bridge = source("lib/capacitor/session-privacy.ts");

    expect(bridge).toContain('"HushhSessionPrivacy"');
    expect(bridge).toContain("getNativeSessionPrivacyState");
    expect(bridge).toContain("completeNativeSessionPrivacyValidation");
    expect(bridge).toContain("completeSessionValidation({ generation })");
    expect(bridge).toContain("Number.isSafeInteger(generation)");
    expect(bridge).toContain("if (!Capacitor.isNativePlatform())");
  });

  it("keeps the cover until the shared auth owner settles the same generation", () => {
    const authContext = source("lib/firebase/auth-context.tsx");

    expect(authContext).toContain("getNativeSessionPrivacyState()");
    expect(authContext).toContain(
      "validateActiveSession({ force: privacyState.shielded })",
    );
    expect(authContext).toContain("completeNativeSessionPrivacyValidation(");
    expect(authContext).toContain("privacyState.generation");
    expect(authContext).toContain("!terminalInvalidationLatchRef.current");
    expect(authContext).toContain("!signOutPromiseRef.current");
  });

  it("covers iOS before inactivity and releases only an active matching generation", () => {
    const delegate = source("ios/App/App/AppDelegate.swift");
    const controller = source(
      "ios/App/App/Plugins/HushhSessionPrivacyPlugin.swift",
    );
    const bridgeController = source("ios/App/App/MyViewController.swift");
    const project = source("ios/App/App.xcodeproj/project.pbxproj");

    const resignActive = between(
      delegate,
      "func applicationWillResignActive",
      "func applicationDidEnterBackground",
    );
    const becameActive = between(
      delegate,
      "func applicationDidBecomeActive",
      "func applicationWillTerminate",
    );

    expect(resignActive).toContain(
      "HushhSessionPrivacyShield.shared.protectForAppInactive()",
    );
    expect(becameActive).toContain(
      "HushhSessionPrivacyShield.shared.markAppActive()",
    );
    expect(becameActive).not.toContain("completeSessionValidation");
    expect(becameActive).not.toContain("removeFromSuperview");

    expect(controller).toContain("struct HushhSessionPrivacyState");
    expect(controller).toContain("private(set) var shielded = false");
    expect(controller).toContain("private(set) var generation = 0");
    expect(controller).toContain("private var state = HushhSessionPrivacyState()");
    expect(controller).toContain("requestedGeneration == generation");
    expect(controller).toContain("requestedGeneration > 0");
    expect(controller).toContain("appIsActive");
    expect(controller).toContain("overlay.isOpaque = true");
    expect(controller).toContain(
      'accessibilityIdentifier = "session-privacy-shield"',
    );
    expect(controller).toContain("overlay.isUserInteractionEnabled = true");
    expect(controller).toContain(
      "UIApplication.shared.applicationState == .active",
    );
    expect(bridgeController).toContain(
      "HushhSessionPrivacyShield.shared.attach(to: view)",
    );
    expect(bridgeController).toContain(
      "registerPluginInstance(HushhSessionPrivacyPlugin())",
    );
    expect(project).toContain("HushhSessionPrivacyPlugin.swift in Sources");
  });

  it("covers Android before Capacitor pause and never auto-releases on resume", () => {
    const activity = source(
      "android/app/src/main/java/com/hussh/app/MainActivity.kt",
    );
    const plugin = source(
      "android/app/src/main/java/com/hussh/app/plugins/HushhSessionPrivacy/HushhSessionPrivacyPlugin.kt",
    );

    const onCreate = between(
      activity,
      "override fun onCreate",
      "override fun onResume",
    );
    const onResume = between(
      activity,
      "override fun onResume",
      "override fun onPause",
    );
    const onPause = between(
      activity,
      "override fun onPause",
      "override fun onStop",
    );
    const onDestroy = between(
      activity,
      "override fun onDestroy",
      "internal fun readSessionPrivacyState",
    );
    const showOverlay = between(
      activity,
      "private fun showSessionPrivacyOverlay",
      "private fun hideSessionPrivacyOverlay",
    );
    const hideOverlay = between(
      activity,
      "private fun hideSessionPrivacyOverlay",
      "private fun hideSessionContentFromAccessibility",
    );

    expect(onCreate).not.toContain("activateSessionPrivacyShield()");
    expect(onCreate).toContain("if (sessionPrivacyShielded)");
    expect(onResume).toContain("sessionPrivacyActivityResumed = true");
    expect(onResume).not.toContain("completeSessionValidation");
    expect(onResume).not.toContain("hideSessionPrivacyOverlay");
    expect(onPause.indexOf("activateSessionPrivacyShield()")).toBeLessThan(
      onPause.indexOf("super.onPause()"),
    );

    expect(activity).toContain("generation == sessionPrivacyGeneration");
    expect(activity).toContain("sessionPrivacyActivityResumed");
    expect(activity).toContain("WindowManager.LayoutParams.FLAG_SECURE");
    expect(activity).toContain("isClickable = true");
    expect(activity).toContain("View.IMPORTANT_FOR_ACCESSIBILITY_YES");
    expect(activity).toContain(
      "View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS",
    );
    expect(activity).toContain("sessionPrivacyPreviousWebViewAccessibility");
    expect(activity).toContain("webView.importantForAccessibility");
    expect(activity).toContain(
      "webView.importantForAccessibility = previousMode",
    );
    expect(showOverlay).toContain("hideSessionContentFromAccessibility()");
    expect(hideOverlay).toContain("restoreSessionContentAccessibility()");
    expect(onDestroy).toContain("restoreSessionContentAccessibility()");
    expect(activity).toContain(
      "registerPlugin(HushhSessionPrivacyPlugin::class.java)",
    );
    expect(plugin).toContain('@CapacitorPlugin(name = "HushhSessionPrivacy")');
    expect(plugin).toContain("fun getState(call: PluginCall)");
    expect(plugin).toContain("fun completeSessionValidation(call: PluginCall)");
    expect(plugin).toContain("generation <= 0");
  });
});
