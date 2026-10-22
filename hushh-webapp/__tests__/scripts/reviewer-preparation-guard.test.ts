import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The harness owns this policy; no browser, account, or secrets are needed here.
// @ts-expect-error The canonical Node rehearsal script has no TS declaration.
import { installReadOnlyMutationGuard, waitForReviewerVaultAdmission } from "../../../.agents/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs";
import { shouldSkipReviewerBackgroundWritesForAutomation } from "@/lib/testing/native-test";

describe("reviewer preparation-only authority", () => {
  it("rejects a connector-only port before it can advertise broader mutation authority", async () => {
    vi.stubEnv("REVIEWER_ALLOW_SHARED_MUTATIONS", "true");
    const context = { route: vi.fn() };
    await expect(installReadOnlyMutationGuard(context, {
      appOrigin: "https://dev.one.hussh.ai", admitOwnerPodConnectorOperation: () => true,
    })).rejects.toThrow("requires bounded mutation admission");
    expect(context.route).not.toHaveBeenCalled();
  });
  it.each([
    ["catalog", true, true, false, "POST", "", true],
    ["verify", true, true, false, "POST", "", true],
    ["oauth/begin", true, true, false, "POST", "", true],
    ["oauth/complete", true, true, false, "POST", "", true],
    ["oauth/cancel", true, true, false, "POST", "", true],
    ["tools/call", true, true, false, "POST", "", false],
    ["verify", false, true, false, "POST", "", false],
    ["verify", true, false, false, "POST", "", false],
    ["verify", true, true, true, "POST", "", false],
    ["verify", true, true, false, "DELETE", "", false],
    ["verify", true, true, false, "POST", "?account=other", false],
    ["verify", true, true, false, "POST", "#other", false],
  ])("bounds private connector %s to explicit current-owner admission", async (operation, authorized, current, navigation, method, suffix, allowed) => {
    vi.stubEnv("REVIEWER_ALLOW_SHARED_MUTATIONS", String(authorized));
    let handler!: (route: unknown) => Promise<void>;
    const admission = vi.fn(() => current);
    const guard = await installReadOnlyMutationGuard({ route: vi.fn(async (_glob, callback) => { handler = callback; }) }, {
      appOrigin: "https://dev.one.hussh.ai", admitMutation: () => false,
      admitOwnerPodConnectorOperation: admission,
    });
    const path = "/api/one/pod/agent-chat/connectors/custom_" + "a".repeat(32) + "/mcp/";
    const route = { request: () => ({ url: () => "https://owner-pod.example" + path + operation + suffix,
      method: () => method, isNavigationRequest: () => navigation }), continue: vi.fn(), fulfill: vi.fn() };
    await handler(route);
    expect(route.continue).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) expect(() => guard.assertNoBlockedMutation()).not.toThrow();
    else expect(() => guard.assertNoBlockedMutation()).toThrow("blocked");
    if (!authorized || navigation || method !== "POST" || suffix || operation === "tools/call")
      expect(admission).not.toHaveBeenCalled();
  });
  it.each(["truthy", "throw"])("rejects unverifiable private preparation admission (%s)", async failure => {
    let handler!: (route: unknown) => Promise<void>;
    const guard = await installReadOnlyMutationGuard({ route: vi.fn(async (_glob, callback) => { handler = callback; }) }, {
      appOrigin: "https://dev.one.hussh.ai", allowMemoryPreparation: true,
      admitOwnerPodMemoryPreparation: () => {
        if (failure === "throw") throw new Error("private-sentinel");
        return "approved";
      },
    });
    const route = { request: () => ({ url: () => "https://owner-pod.example/api/one/pod/memory/proposals",
      method: () => "POST", isNavigationRequest: () => false }), continue: vi.fn(), fulfill: vi.fn() };
    await handler(route);
    expect(route.continue).not.toHaveBeenCalled();
    expect(() => guard.assertNoBlockedMutation()).toThrow("blocked");
    expect(JSON.stringify(route.fulfill.mock.calls)).not.toContain("private-sentinel");
  });
  it("retains private preparation admission under shared-mutation authorization", async () => {
    vi.stubEnv("REVIEWER_ALLOW_SHARED_MUTATIONS", "true");
    let handler!: (route: unknown) => Promise<void>;
    const admission = vi.fn(() => false);
    const guard = await installReadOnlyMutationGuard({ route: vi.fn(async (_glob, callback) => { handler = callback; }) }, {
      appOrigin: "https://dev.one.hussh.ai", allowMemoryPreparation: true,
      admitOwnerPodMemoryPreparation: admission,
    });
    const route = { request: () => ({ url: () => "https://owner-pod.example/api/one/pod/memory/proposals",
      method: () => "POST", isNavigationRequest: () => false }), continue: vi.fn(), fulfill: vi.fn() };
    await handler(route);
    expect(admission).toHaveBeenCalledOnce();
    expect(route.continue).not.toHaveBeenCalled();
    expect(() => guard.assertNoBlockedMutation()).toThrow("blocked");
  });
  it.each([
    ["https://owner-pod.example/api/one/pod/memory/proposals", "POST", true, false, true, true],
    ["https://other-pod.example/api/one/pod/memory/proposals", "POST", true, false, false, false],
    ["https://owner-pod.example/api/one/pod/memory/proposals", "POST", false, false, true, false],
    ["https://owner-pod.example/api/one/pod/memory/proposals", "POST", true, true, true, false],
    ["https://owner-pod.example/api/one/pod/memory/proposals?account=other", "POST", true, false, true, false],
    ["https://owner-pod.example/api/one/pod/memory/proposals", "DELETE", true, false, true, false],
    ["https://owner-pod.example/api/one/pod/memory/revoke", "POST", true, false, true, false],
    ["https://owner-pod.example/api/scope-commerce/purchases", "POST", true, false, true, false],
  ])("keeps private preparation behind endpoint and owner admission (%s %s)", async (url, method, enabled, navigation, ownerCurrent, allowed) => {
    let handler!: (route: unknown) => Promise<void>;
    const admission = vi.fn((request: { url: () => string }) =>
      ownerCurrent && new URL(request.url()).origin === "https://owner-pod.example");
    const guard = await installReadOnlyMutationGuard({ route: vi.fn(async (_glob, callback) => { handler = callback; }) }, {
      appOrigin: "https://dev.one.hussh.ai", allowMemoryPreparation: enabled,
      admitOwnerPodMemoryPreparation: admission,
    });
    const route = { request: () => ({ url: () => url, method: () => method, isNavigationRequest: () => navigation }),
      continue: vi.fn(), fulfill: vi.fn() };
    await handler(route);
    expect(route.continue).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) expect(() => guard.assertNoBlockedMutation()).not.toThrow();
    else expect(() => guard.assertNoBlockedMutation()).toThrow("blocked");
    if (!enabled || navigation || method !== "POST" || new URL(url).search || !url.endsWith("/memory/proposals"))
      expect(admission).not.toHaveBeenCalled();
  });
  it.each([
    [true, "https://access.stripe.com/mcp/oauth2/authorize?state=synthetic", true, true, true],
    [true, "https://access.stripe.com/mcp/oauth2/authorize", true, true, false, false],
    [true, "https://access.stripe.com/mcp/oauth2/token", true, true, false],
    [true, "https://access.stripe.com/v1/payouts", true, true, false],
    [true, "https://api.stripe.com/mcp/oauth2/authorize", true, true, false],
    [true, "https://access.stripe.com/mcp/oauth2/authorize#other", true, true, false],

    [true, "https://login.microsoftonline.com/common/Consent/Set", true, true, true],
    [true, "https://login.microsoftonline.com/common/Consent/Set", false, true, false],
    [true, "https://login.microsoftonline.com/common/Consent/Set", true, false, false],
    [true, "https://evil.invalid/common/Consent/Set", true, true, false],
    [false, "https://login.microsoftonline.com/common/Consent/Set", true, true, false],
  ])("admits only explicit owner OAuth document navigation (%s %s %s %s)", async (authorized, url, navigation, topFrame, allowed, current = true) => {
    vi.stubEnv("REVIEWER_ALLOW_SHARED_MUTATIONS", String(authorized));
    let handler!: (route: unknown) => Promise<void>;
    const guard = await installReadOnlyMutationGuard({ route: vi.fn(async (_glob, callback) => { handler = callback; }) }, {
      appOrigin: "https://dev.one.hussh.ai", admitMutation: () => false,
      admitProviderOAuth: (request: { url: () => string }) => current &&
        ["/common/Consent/Set", "/mcp/oauth2/authorize"].includes(new URL(request.url()).pathname),
    });
    const route = { request: () => ({ url: () => url, method: () => "POST", isNavigationRequest: () => navigation,
      resourceType: () => navigation ? "document" : "fetch", frame: () => ({ parentFrame: () => topFrame ? null : {} }) }),
      continue: vi.fn(), fulfill: vi.fn() };
    await handler(route);
    expect(route.continue).toHaveBeenCalledTimes(allowed ? 1 : 0);
    if (allowed) expect(() => guard.assertNoBlockedMutation()).not.toThrow();
    else expect(() => guard.assertNoBlockedMutation()).toThrow("blocked");
  });
  it.each([
    ["https://browser.events.data.microsoft.com/OneCollector/1.0/", true],
    ["https://browser.events.data.microsoft.com/other", false],
    ["https://browser.events.data.microsoft.com.evil.invalid/OneCollector/1.0/", false],
  ])("suppresses only the exact provider telemetry endpoint %s", async (url, suppressed) => {
    let handler!: (route: unknown) => Promise<void>;
    const guard = await installReadOnlyMutationGuard({ route: vi.fn(async (_glob, callback) => { handler = callback; }) }, {
      appOrigin: "https://dev.one.hussh.ai",
    });
    const route = { request: () => ({ url: () => url, method: () => "POST" }), continue: vi.fn(), fulfill: vi.fn() };
    await handler(route);
    expect(route.continue).not.toHaveBeenCalled();
    expect(guard.suppressedAnalyticsRequests()).toBe(suppressed ? 1 : 0);
    if (suppressed) expect(route.fulfill).toHaveBeenCalledWith({ status: 204, body: "" });
    else expect(() => guard.assertNoBlockedMutation()).toThrow("blocked");
  });
  it("requires the expected unlocked owner, not an anonymous route beacon", async () => {
    let predicate!: (expected: string) => boolean;
    const page = { waitForFunction: vi.fn(async (check, expected, options) => {
      predicate = check;
      expect(expected).toBe("synthetic-owner");
      expect(options.timeout).toBe(100);
    }) };
    await waitForReviewerVaultAdmission(page, "synthetic-owner", 100);
    const target = window as unknown as { __HUSHH_NATIVE_TEST__: { bootstrapState: string; bootstrapUserId: string } };
    try {
      delete (target as Partial<typeof target>).__HUSHH_NATIVE_TEST__;
      expect(predicate("synthetic-owner")).toBe(false);
      target.__HUSHH_NATIVE_TEST__ = { bootstrapState: "authenticated", bootstrapUserId: "synthetic-owner" };
      expect(predicate("synthetic-owner")).toBe(false);
      target.__HUSHH_NATIVE_TEST__ = { bootstrapState: "vault_unlocked", bootstrapUserId: "other-owner" };
      expect(predicate("synthetic-owner")).toBe(false);
      target.__HUSHH_NATIVE_TEST__.bootstrapUserId = "synthetic-owner";
      expect(predicate("synthetic-owner")).toBe(true);
    } finally {
      delete (target as Partial<typeof target>).__HUSHH_NATIVE_TEST__;
    }
  });
  it("awaits admission and propagates failure without consulting a route beacon", async () => {
    let finish!: () => void;
    const page = { waitForFunction: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })) };
    let completed = false;
    const admission = waitForReviewerVaultAdmission(page, "synthetic-owner").then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    finish();
    await admission;
    expect(completed).toBe(true);
    const timeout = new Error("Synthetic admission timeout");
    await expect(waitForReviewerVaultAdmission({ waitForFunction: vi.fn().mockRejectedValue(timeout) }, "synthetic-owner")).rejects.toBe(timeout);
  });
  it("rejects absent reviewer configuration before accessing the page", async () => {
    const page = { waitForFunction: vi.fn() };
    await expect(waitForReviewerVaultAdmission(page, "")).rejects.toThrow("configured identity");
    expect(page.waitForFunction).not.toHaveBeenCalled();
  });
  beforeEach(() => vi.stubEnv("REVIEWER_ALLOW_SHARED_MUTATIONS", "false"));
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ["http://localhost:3001/api/one/information-requests", true, true],
    ["http://localhost:3001/api/pkm/store-domain", false, false],
    ["https://elsewhere.example/api/one/information-requests", true, false],
  ])("keeps an explicit mutation run bounded before navigation (%s)", async (url, admitted, allowed) => {
    vi.stubEnv("REVIEWER_ALLOW_SHARED_MUTATIONS", "true");
    let handler!: (route: unknown) => Promise<void>;
    const admitMutation = vi.fn(() => admitted);
    const guard = await installReadOnlyMutationGuard({ route: vi.fn(async (_glob, callback) => { handler = callback; }) }, {
      appOrigin: "http://localhost:3001", admitMutation,
    });
    const route = { request: () => ({ url: () => url, method: () => "POST" }), continue: vi.fn(), fulfill: vi.fn() };
    await handler(route);
    expect(guard.policy).toBe("bounded_mutation");
    expect(route.continue).toHaveBeenCalledTimes(allowed ? 1 : 0);
    expect(route.fulfill).toHaveBeenCalledTimes(allowed ? 0 : 1);
    if (allowed) expect(() => guard.assertNoBlockedMutation()).not.toThrow();
    else expect(() => guard.assertNoBlockedMutation()).toThrow("blocked");
    if (url.startsWith("https://elsewhere")) expect(admitMutation).not.toHaveBeenCalled();
  });
  it("does not let a callback authorize writes in a read-only run", async () => {
    let handler!: (route: unknown) => Promise<void>;
    const admitMutation = vi.fn(() => true);
    const guard = await installReadOnlyMutationGuard({ route: vi.fn(async (_glob, callback) => { handler = callback; }) }, {
      appOrigin: "http://localhost:3001", admitMutation,
    });
    const route = { request: () => ({ url: () => "http://localhost:3001/api/pkm/store-domain", method: () => "POST" }), continue: vi.fn(), fulfill: vi.fn() };
    await handler(route);
    expect(admitMutation).not.toHaveBeenCalled();
    expect(() => guard.assertNoBlockedMutation()).toThrow("blocked");
  });
  it("retains a failed admission without leaking its body or private error", async () => {
    vi.stubEnv("REVIEWER_ALLOW_SHARED_MUTATIONS", "true");
    let handler!: (route: unknown) => Promise<void>;
    const guard = await installReadOnlyMutationGuard({ route: vi.fn(async (_glob, callback) => { handler = callback; }) }, {
      appOrigin: "http://localhost:3001", admitMutation: () => { throw new Error("private-sentinel"); },
    });
    const route = { request: () => ({ url: () => "http://localhost:3001/api/consent/pending/approve", method: () => "POST" }), continue: vi.fn(), fulfill: vi.fn() };
    await handler(route);
    expect(route.continue).not.toHaveBeenCalled();
    expect(JSON.stringify(route.fulfill.mock.calls)).not.toContain("private-sentinel");
    expect(() => guard.assertNoBlockedMutation()).toThrow("blocked");
    try { guard.assertNoBlockedMutation(); } catch (error) { expect(String(error)).not.toContain("private-sentinel"); }
  });
  it("awaits guard installation before returning", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ready = false;
    const install = installReadOnlyMutationGuard(
      { route: () => pending },
      {
        appOrigin: "http://localhost:3001",
        allowMemoryPreparation: true,
      },
    ).then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    release();
    await install;
    expect(ready).toBe(true);
  });

  it.each([
    ["http://localhost:3001/api/pkm/memory/proposals", "POST", true, true],
    ["http://localhost:3001/api/vault/bootstrap-state", "DELETE", false, false],
    ["http://localhost:3001/api/pkm/memory/proposals", "POST", false, false],
    ["http://localhost:3001/api/pkm/memory/proposals", "DELETE", true, false],
    ["https://elsewhere.example/api/pkm/memory/proposals", "POST", true, false],
    ["http://localhost:3001/api/pkm/store-domain", "POST", true, false],
    ["http://localhost:3001/api/consent/pending/approve", "POST", true, false],
    ["http://localhost:3001/api/one/agent-chat", "POST", true, false],
    ["http://localhost:3001/api/one/location/recipient-keys", "POST", true, true],
    ["http://localhost:3001/api/one/location/recipient-keys", "POST", false, false],
    ["http://localhost:3001/api/one/marketplace/recipient-keys", "POST", true, true],
    ["http://localhost:3001/api/one/marketplace/recipient-keys", "POST", false, false],
  ])(
    "bounds the opt-in to exact preparation authority (%s %s)",
    async (url, method, enabled, allowed) => {
      let handler!: (route: unknown) => Promise<void>;
      const context = {
        route: vi.fn(async (_glob: string, callback: typeof handler) => {
          handler = callback;
        }),
      };
      const guard = await installReadOnlyMutationGuard(context, {
        appOrigin: "http://localhost:3001",
        allowMemoryPreparation: enabled,
      });
      const route = {
        request: () => ({ url: () => url, method: () => method }),
        continue: vi.fn(),
        fulfill: vi.fn(),
      };
      await handler(route);
      expect(route.continue).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(route.fulfill).toHaveBeenCalledTimes(allowed ? 0 : 1);
      if (allowed) expect(() => guard.assertNoBlockedMutation()).not.toThrow();
      else expect(() => guard.assertNoBlockedMutation()).toThrow("blocked");
    },
  );

  it.each([
    ["preparation_only", true],
    ["read_only", true],
    ["bounded_mutation", true],
    ["mutation_authorized", false],
  ])("skips background writes only for the non-mutating bridge policy (%s)", (policy, expected) => {
    const target = window as unknown as {
      __HUSHH_NATIVE_TEST__?: {
        enabled?: boolean;
        autoReviewerLogin?: boolean;
        reviewerMutationPolicy?: string;
      };
    };
    const original = target.__HUSHH_NATIVE_TEST__;
    try {
      target.__HUSHH_NATIVE_TEST__ = {
        enabled: true,
        autoReviewerLogin: true,
        reviewerMutationPolicy: policy,
      };
      expect(shouldSkipReviewerBackgroundWritesForAutomation()).toBe(expected);
      target.__HUSHH_NATIVE_TEST__.autoReviewerLogin = false;
      target.__HUSHH_NATIVE_TEST__.reviewerMutationPolicy = "preparation_only";
      expect(shouldSkipReviewerBackgroundWritesForAutomation()).toBe(false);
    } finally {
      target.__HUSHH_NATIVE_TEST__ = original;
    }
  });
});
