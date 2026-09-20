import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The harness owns this policy; no browser, account, or secrets are needed here.
// @ts-expect-error The canonical Node rehearsal script has no TS declaration.
import { installReadOnlyMutationGuard, waitForReviewerVaultAdmission } from "../../../.codex/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs";
import { shouldSkipReviewerBackgroundWritesForAutomation } from "@/lib/testing/native-test";

describe("reviewer preparation-only authority", () => {
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
