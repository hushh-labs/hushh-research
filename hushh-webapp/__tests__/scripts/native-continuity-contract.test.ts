import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  isCompleteNativeRouteAuditStatus,
  isSettledNativeRouteAuditSurface,
  nativeRouteAuditProgressKey,
  parseNativeRouteAuditStatus,
} from "../../scripts/native/native-route-status.mjs";

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

describe("native cold-audit and continuity contract", () => {
  const destructiveAudits = [
    "scripts/native/ios-route-audit.mjs",
    "scripts/native/ios-ui-interaction-audit.mjs",
    "scripts/native/android-route-audit.mjs",
    "scripts/native/android-ui-interaction-audit.mjs",
  ];

  it.each(destructiveAudits)("requires explicit cold-audit authority before loading reviewer state: %s", (path) => {
    const script = source(path);
    const guardIndex = script.indexOf("assertDestructiveNativeAuditAllowed();");
    const reviewerIndex = script.indexOf("resolveReviewerTestIdentity(");

    expect(guardIndex).toBeGreaterThan(-1);
    expect(reviewerIndex).toBeGreaterThan(guardIndex);
    expect(script).toContain("HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT");
    expect(script).toContain("cannot prove vault or route continuity");
  });

  it("keeps local continuity runners free of reset, install, and credential bootstrap commands", () => {
    for (const path of [
      "scripts/native/ios-continuity-local.mjs",
      "scripts/native/android-continuity-local.mjs",
    ]) {
      const script = source(path);
      expect(script).not.toContain('"uninstall"');
      expect(script).not.toContain('"install"');
      expect(script).not.toContain('"clear"');
      expect(script).not.toContain('"force-stop"');
      expect(script).not.toContain("RESET_APP_STATE");
      expect(script).not.toContain("VaultPassphrase");
    }
  });

  it("uses the app shell as the one native lifecycle collector and resumes browser visibility", () => {
    const runtime = source("components/app-ui/interaction-runtime.tsx");
    const vault = source("lib/vault/vault-context.tsx");
    const auth = source("lib/firebase/auth-context.tsx");
    const notification = source("components/consent/notification-provider.tsx");

    expect(runtime).toContain('App.addListener("appStateChange"');
    expect(runtime).toContain('document.visibilityState === "hidden" ? "background" : "active"');
    expect(vault).toContain("appInteractionCoordinator.subscribeLifecycle");
    expect(auth).toContain("appInteractionCoordinator.subscribeLifecycle");
    expect(notification).toContain("appInteractionCoordinator.subscribeLifecycle");
    expect(vault).not.toContain('App.addListener("appStateChange"');
    expect(auth).not.toContain('App.addListener("appStateChange"');
    expect(notification).not.toContain('App.addListener("appStateChange"');
  });

  it("exposes explicit cold-audit scripts rather than silently resetting a normal continuity run", () => {
    const packageJson = JSON.parse(source("package.json")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["ios:cold:audit"]).toContain(
      "HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT=true",
    );
    expect(packageJson.scripts["android:cold:audit"]).toContain(
      "HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT=true",
    );
    expect(packageJson.scripts["ios:device:ui:test"]).toContain(
      "assert-destructive-native-audit.mjs",
    );
    expect(packageJson.scripts["ios:continuity:local"]).not.toContain(
      "HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT",
    );
    expect(packageJson.scripts["android:continuity:local"]).not.toContain(
      "HUSHH_ALLOW_DESTRUCTIVE_NATIVE_AUDIT",
    );
  });

  it("always terminates an iOS cold-audit app after success, failure, or interruption", () => {
    const routeAudit = source("scripts/native/ios-route-audit.mjs");
    const shellAudit = source("scripts/native/ios-test.sh");
    const script = source("scripts/native/ios-ui-interaction-audit.mjs");
    const uiTests = source("ios/App/AppUITests/AppUITests.swift");

    expect(script).toContain("process.once(signal");
    expect(script).toContain("finally {");
    expect(script).toContain("terminateAuditApp();");
    expect(script).not.toContain("IOS_UI_INTERACTION_KEEP_APP");
    expect(uiTests).toContain("defer { app.terminate() }");
    expect(routeAudit).toContain("function terminateAuditApp()");
    expect(routeAudit).toContain("finally {");
    expect(shellAudit).toContain("trap cleanup_native_test_app EXIT");
    expect(shellAudit).toContain("-only-testing:AppTests test");
    expect(shellAudit).not.toMatch(
      /xcodebuild[^\n]*test-without-building/,
    );
  });

  it("resets the anonymous root before route auditing so preserved Firebase credentials cannot redirect it", () => {
    const routeAudit = source("scripts/native/ios-route-audit.mjs");

    expect(routeAudit).toContain('"/,/logout,/login"');
    expect(routeAudit).toContain("Simulator uninstall does not clear Firebase");
    expect(routeAudit).toContain(
      '"-UITestResetAppState", resetStateRoutes.has(route.route) ? "true" : "false"',
    );
  });

  it("makes route-audit interruption and repeated failures explicit instead of reusing stale completion evidence", () => {
    const iosRouteAudit = source("scripts/native/ios-route-audit.mjs");
    const androidRouteAudit = source("scripts/native/android-route-audit.mjs");

    for (const [routeAudit, prefix] of [
      [iosRouteAudit, "IOS"],
      [androidRouteAudit, "ANDROID"],
    ]) {
      expect(routeAudit).toContain("fs.rmSync(reportPath, { force: true })");
      expect(routeAudit).toContain(`${prefix}_ROUTE_AUDIT_MAX_CONSECUTIVE_FAILURES`);
      expect(routeAudit).toContain(`${prefix}_ROUTE_AUDIT_NO_PROGRESS_TIMEOUT_MS`);
      expect(routeAudit).toContain('errorClass: "stalled"');
      expect(routeAudit).toContain("consecutiveFailures >= maxConsecutiveFailures");
      expect(routeAudit).toContain("audit_complete");
      expect(routeAudit).toContain("completed_routes");
    }
  });

  it("ignores partial native status writes so they cannot keep a route watchdog alive", () => {
    const complete = parseNativeRouteAuditStatus(
      "route=/one/kyc;ready=0;marker=native-route-one-kyc;auth=authenticated;data=loaded;doc=complete;found=1;routeok=0;bootstrap=vault_unlocked",
    );
    const partialAuthenticated = parseNativeRouteAuditStatus(
      "route=/one/kyc;ready=0;marker=native-route-one-kyc",
    );
    const completeAnonymous = parseNativeRouteAuditStatus(
      "route=/;ready=1;marker=native-route-home;auth=anonymous;data=loaded;doc=complete;found=1;routeok=1",
    );
    const advanced = { ...complete, routeok: "1" };

    expect(
      isCompleteNativeRouteAuditStatus(complete, { requiresVaultBootstrap: true }),
    ).toBe(true);
    expect(
      isCompleteNativeRouteAuditStatus(partialAuthenticated, {
        requiresVaultBootstrap: true,
      }),
    ).toBe(false);
    expect(
      isCompleteNativeRouteAuditStatus(completeAnonymous, {
        requiresVaultBootstrap: false,
      }),
    ).toBe(true);
    expect(
      isSettledNativeRouteAuditSurface(complete, {
        expectedAuth: "authenticated",
        allowedDataStates: ["loaded"],
      }),
    ).toBe(true);
    expect(nativeRouteAuditProgressKey(complete)).not.toBe(
      nativeRouteAuditProgressKey(advanced),
    );
  });

  it("fails a stable wrong native route as a route mismatch instead of consuming the full timeout", () => {
    for (const path of [
      "scripts/native/ios-route-audit.mjs",
      "scripts/native/android-route-audit.mjs",
    ]) {
      const routeAudit = source(path);
      expect(routeAudit).toContain("isSettledNativeRouteAuditSurface");
      expect(routeAudit).toContain('errorClass: "route_mismatch"');
      expect(routeAudit).toContain("Date.now() - settledMismatchAt >= 1_000");
    }
  });

  it("terminalizes a stalled native UI bootstrap and keeps the generated iOS runner in sync", () => {
    const runnerSource = source("scripts/native/native-ui-test-runner-source.js");
    const generatedIosRunner = source("ios/App/App/NativeUiTestRunnerScript.swift");

    expect(runnerSource).toContain("UI_FLOW_BOOTSTRAP_TIMEOUT_MS = 45000");
    expect(runnerSource).toContain("completeUiFlowBootstrapTimeout");
    expect(runnerSource).toContain("stopUiFlowAutomation");
    expect(runnerSource).toContain('errorClass: "timeout"');
    expect(generatedIosRunner).toContain(runnerSource);
  });

  it("never auto-dismisses product Continue or Skip actions", () => {
    const runnerSource = source("scripts/native/native-ui-test-runner-source.js");
    const dismissStart = runnerSource.indexOf("function dismissBlockingScreens()");
    const dismissEnd = runnerSource.indexOf(
      "function personaMismatchPromptVisible()",
      dismissStart,
    );
    const dismissSource = runnerSource.slice(dismissStart, dismissEnd);

    expect(dismissSource).not.toContain('"continue"');
    expect(dismissSource).not.toContain('"skip"');
    expect(dismissSource).toContain('"not now"');
    expect(dismissSource).toContain('"skip tour"');
  });

  it("keeps UI-flow routing ownership across a WebView document reload", () => {
    const nativeSupport = source("ios/App/App/NativeTestSupport.swift");

    expect(nativeSupport).toContain("function hasIncompleteUiFlowSession(runId)");
    expect(nativeSupport).toContain("__hushh_native_ui_flow_state_v1");
    expect(nativeSupport).toContain("bridge._uiFlowsRoutingOwned = uiFlowsOwnRouting");
    expect(nativeSupport).toContain("bridge._uiFlowsRoutingOwned === true");
  });

  it("drives Profile through the canonical signed-in route", () => {
    const runner = source("scripts/native/native-ui-test-runner-source.js");
    const flows = source("scripts/testing/signed-in-ui-flows.mjs");

    expect(runner).toContain("clickShellAction");
    expect(runner).not.toContain("NAV_ROUTE_BY_PERSONA_AND_LABEL");
    expect(flows).toContain('route: "/one/profile"');
    expect(flows).toContain('routeIds: ["/one/profile"]');
  });

  it("binds each cold UI report to the exact generated manifest and real controls", () => {
    const iosAudit = source("scripts/native/ios-ui-interaction-audit.mjs");
    const androidAudit = source("scripts/native/android-ui-interaction-audit.mjs");
    const runner = source("scripts/native/native-ui-test-runner-source.js");
    const artifacts = source("scripts/native/prepare-native-test-artifacts.mjs");
    const flows = source("scripts/testing/signed-in-ui-flows.mjs");

    for (const audit of [iosAudit, androidAudit]) {
      expect(audit).toContain("validateNativeUiAuditCompletion");
      expect(audit).toContain("nativeUiFlowStepTimeoutMs");
      expect(audit).not.toContain('console.log("==> skipping rebuild');
    }
    expect(androidAudit).toContain(
      "must build and sync the exact requested flow manifest",
    );
    expect(iosAudit).toContain(
      "prebuilt iOS app flow manifest does not match the requested audit plan",
    );
    expect(artifacts).toContain("createNativeUiAuditManifest");
    expect(runner).toContain("auditPlanDigest");
    expect(runner).toContain("inFlightFlowId");
    expect(runner).toContain("bottom navigation is not visible");
    expect(runner).not.toContain("NAV_ROUTE_BY_PERSONA_AND_LABEL");
    expect(runner).not.toContain("clickContextualTab");
    expect(runner).not.toContain("verifyRiaPicksAdmission");
    expect(runner).toContain('await clickTopTab("Clients")');
    expect(flows).toContain('type: "click_top_tab", label: "Portfolio"');
    expect(flows).toContain('type: "click_top_tab", label: "Clients"');
    expect(flows).toContain("requiresRiaWorkspace: true");
    expect(flows).toContain('type: "ensure_ria_workspace"');
    expect(flows).toContain('type: "assert_ria_workspace_admission"');
    expect(flows).toContain('type: "click_shell_action", ariaLabel: "Open Profile"');
  });

  it("keeps canonical Profile inventory redirects and XCTest fixtures off deleted routes", () => {
    const inventory = JSON.parse(source("native-route-inventory.json")) as {
      routes: Array<{ route: string; initialRoute?: string }>;
    };
    const uiTests = source("ios/App/AppUITests/AppUITests.swift");

    for (const route of inventory.routes.filter((entry) =>
      entry.route.startsWith("/one/profile"),
    )) {
      if (!route.initialRoute?.startsWith("/login?")) continue;
      const redirect = new URL(route.initialRoute, "https://native-test.local").searchParams.get("redirect");
      expect(redirect).toMatch(/^\/one\/profile/);
    }
    expect(uiTests).not.toContain('redirect: "/profile');
    expect(uiTests).not.toContain('redirect=%2Fprofile');
  });

  it("gives Finance import setup its own native route marker instead of borrowing the Kai setup marker", () => {
    const inventory = JSON.parse(source("native-route-inventory.json")) as {
      routes: Array<{ route: string; expectedMarker?: string }>;
    };
    const setupImport = source(
      "app/one/setup/finance/import/finance-import-onboarding-setup-client.tsx",
    );
    const route = inventory.routes.find(
      (entry) => entry.route === "/one/setup/finance/import",
    );

    expect(route?.expectedMarker).toBe("native-route-one-setup-finance-import");
    expect(setupImport).toContain("<NativeTestBeacon");
    expect(setupImport).toContain('marker="native-route-one-setup-finance-import"');
  });

  it("audits disabled Gmail setup through its intentional setup-hub redirect", () => {
    const inventory = JSON.parse(source("native-route-inventory.json")) as {
      routes: Array<{
        route: string;
        expectedMarker?: string;
        expectedRoute?: string;
      }>;
    };
    const gmailSetup = source(
      "app/one/setup/gmail/gmail-onboarding-setup-client.tsx",
    );
    const route = inventory.routes.find(
      (entry) => entry.route === "/one/setup/gmail",
    );

    expect(gmailSetup).toContain("!isOneCapabilityEnabled(\"gmail\")");
    expect(gmailSetup).toContain("router.replace(ROUTES.ONE_SETUP)");
    expect(route).toMatchObject({
      expectedMarker: "native-route-one-setup",
      expectedRoute: "/one/setup",
    });
  });

  it("audits Location setup through the canonical Location surface that owns its active route", () => {
    const inventory = JSON.parse(source("native-route-inventory.json")) as {
      routes: Array<{ route: string; expectedMarker?: string; expectedRoute?: string }>;
    };
    const locationSetup = source(
      "app/one/setup/location/location-onboarding-setup-client.tsx",
    );
    const route = inventory.routes.find(
      (entry) => entry.route === "/one/setup/location",
    );

    expect(locationSetup).toContain("<OneLocationAgentPage");
    expect(route).toMatchObject({
      expectedMarker: "native-route-one-location",
      expectedRoute: "/one/location",
    });
  });

  it("audits resolved KYC setup through its canonical KYC handoff", () => {
    const inventory = JSON.parse(source("native-route-inventory.json")) as {
      routes: Array<{ route: string; expectedMarker?: string; expectedRoute?: string }>;
    };
    const coordinator = source(
      "components/onboarding/setup/setup-capability-coordinator.tsx",
    );
    const routes = source("lib/navigation/routes.ts");
    const route = inventory.routes.find(
      (entry) => entry.route === "/one/setup/email",
    );

    expect(coordinator).toContain("resolveCapabilityHandoffTarget(capabilityId)");
    expect(routes).toContain("email: ROUTES.ONE_KYC");
    expect(route).toMatchObject({
      expectedMarker: "native-route-one-kyc",
      expectedRoute: "/one/kyc",
    });
  });

  it("audits resolved RIA setup through the canonical RIA onboarding handoff", () => {
    const inventory = JSON.parse(source("native-route-inventory.json")) as {
      routes: Array<{ route: string; expectedMarker?: string; expectedRoute?: string }>;
    };
    const routes = source("lib/navigation/routes.ts");
    const route = inventory.routes.find(
      (entry) => entry.route === "/one/setup/ria",
    );

    expect(routes).toContain("ria: ROUTES.RIA_ONBOARDING");
    expect(route).toMatchObject({
      expectedMarker: "native-route-ria-onboarding",
      expectedRoute: "/ria/onboarding",
    });
  });

  it("audits resolved Connected Systems setup through the canonical workspace handoff", () => {
    const inventory = JSON.parse(source("native-route-inventory.json")) as {
      routes: Array<{ route: string; expectedMarker?: string; expectedRoute?: string }>;
    };
    const routes = source("lib/navigation/routes.ts");
    const route = inventory.routes.find(
      (entry) => entry.route === "/one/setup/connected-systems",
    );

    expect(routes).toContain('"connected-systems": ROUTES.CONNECTED_SYSTEMS');
    expect(route).toMatchObject({
      expectedMarker: "native-route-connected-systems",
      expectedRoute: "/one/connected-systems",
    });
  });

  it("keeps Android cold audits debug-only, isolated, and terminally cleaned up", () => {
    const activity = source("android/app/src/main/java/com/hushh/app/MainActivity.kt");
    const uiAudit = source("scripts/native/android-ui-interaction-audit.mjs");
    const routeAudit = source("scripts/native/android-route-audit.mjs");

    expect(activity).toContain("NativeTestModePolicy.isEnabled(");
    expect(activity).toContain("ApplicationInfo.FLAG_DEBUGGABLE");
    expect(activity).toContain('"HUSHH_NATIVE_TEST_UI_FLOW_RUN_ID"');
    expect(activity).toContain(
      '"skipClass", "reasonClass", "errorClass", "checkpoint"',
    );
    expect(activity).not.toContain("resetAppState");
    expect(uiAudit).toContain("const uiFlowRunId = `android-");
    expect(uiAudit).toContain('"HUSHH_NATIVE_TEST_UI_FLOW_RUN_ID"');
    expect(uiAudit).toContain("Android cold audit could not clear");
    expect(uiAudit).toContain("cleanupAuditProcess");
    expect(routeAudit).toContain("cleanupAuditProcess");
    expect(routeAudit).not.toContain("HUSHH_NATIVE_TEST_RESET_APP_STATE");
  });
});
