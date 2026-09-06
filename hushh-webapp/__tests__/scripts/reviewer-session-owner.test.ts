// @vitest-environment node
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewerSessionHarness } from "../../../.codex/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs";

afterEach(() => vi.unstubAllEnvs());
async function harness() {
  vi.stubEnv("REVIEWER_UID", "synthetic-owner");
  vi.stubEnv("REVIEWER_VAULT_PASSPHRASE", "synthetic-passphrase");
  vi.stubEnv("REVIEWER_ALLOW_SHARED_MUTATIONS", "false");
  return createReviewerSessionHarness({ repoRoot: resolve(process.cwd(), ".."), appOrigin: "https://synthetic.example" });
}
function browser(state = "authenticated") {
  const window = { location: { pathname: "/one/setup" }, __HUSHH_NATIVE_TEST__: { bootstrapState: state, bootstrapUserId: "synthetic-owner" } };
  const fill = vi.fn();
  const control = { first() { return this; }, isVisible: async () => false, isEnabled: async () => false, fill, click: vi.fn() };
  const page = Object.assign(new EventEmitter(), {
    addInitScript: vi.fn(async () => undefined), setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    getByRole: () => control, locator: () => control,
    evaluate: async (fn, argument) => runInNewContext(`(${fn.toString()})(argument)`, { window, argument }),
    waitForFunction: async (fn) => { expect(runInNewContext(`(${fn.toString()})()`, { window })).toBe(true); },
    goto: vi.fn(async () => undefined),
  });
  const context = { newPage: async () => page, route: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  return { newContext: async () => context, page, window, fill, context };
}
describe("reviewer session authority", () => {
  it("attaches observation before navigation and never injects a first-run passphrase", async () => {
    const reviewer = await harness();
    const b = browser();
    const observe = vi.fn(() => expect(b.page.goto).not.toHaveBeenCalled());
    await reviewer.openSession(b, "/one/setup", { requireVaultUnlocked: false, onPageCreated: observe });
    expect(observe).toHaveBeenCalledOnce();
    expect(b.page.addInitScript.mock.calls[0][1].vaultPassphrase).toBe("");
    expect(b.fill).not.toHaveBeenCalled();
    await reviewer.assertVaultContinuity(b.page, "synthetic");
    b.window.__HUSHH_NATIVE_TEST__.bootstrapUserId = "foreign-owner";
    await expect(reviewer.assertVaultContinuity(b.page, "synthetic")).rejects.toThrow("expected reviewer session");
  });
  it("rejects terminal authentication errors in first-run mode", async () => {
    const reviewer = await harness();
    const b = browser("auth_error");
    await expect(reviewer.openSession(b, "/one/setup", { requireVaultUnlocked: false })).rejects.toThrow("bootstrap failed");
    expect(b.fill).not.toHaveBeenCalled();
  });
  it("keeps first-run continuity scoped to its page", async () => {
    const reviewer = await harness();
    const first = browser();
    await reviewer.openSession(first, "/one/setup", { requireVaultUnlocked: false });
    const established = browser("vault_unlocked");
    await reviewer.openSession(established, "/one");
    await reviewer.assertVaultContinuity(first.page, "first-run");
    established.window.__HUSHH_NATIVE_TEST__.bootstrapState = "authenticated";
    await expect(reviewer.assertVaultContinuity(established.page, "established")).rejects.toThrow();
  });
});
