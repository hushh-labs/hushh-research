// @vitest-environment node
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { auditFirstRun, isFirstRunState, trackApiConcurrency } from "../../scripts/testing/first-run-reachability.mjs";
const origin = "https://synthetic.example";
const fresh = { userId: "synthetic-owner", hasVault: false, vaultStatus: "placeholder", setupCompleted: false, setupCapabilityIds: [], oneRuntimeSetupChoice: null };
function fixture(state = fresh) {
  const page = Object.assign(new EventEmitter(), {
    request: { post: vi.fn(async () => ({ status: () => 200, json: async () => state, dispose: vi.fn() })) },
    waitForFunction: vi.fn(async () => undefined),
    locator: vi.fn(() => ({ waitFor: vi.fn(async () => undefined), click: vi.fn(async () => undefined) })),
  });
  const guard = { assertNoBlockedMutation: vi.fn() };
  const context = { close: vi.fn(async () => undefined) };
  const browser = { close: vi.fn(async () => undefined) };
  const reviewer = {
    reviewerUid: fresh.userId,
    assertVaultContinuity: vi.fn(async () => undefined),
    openSession: vi.fn(async (_browser, redirect, options) => {
      expect(redirect).toBe("/one/setup");
      expect(options.requireVaultUnlocked).toBe(false);
      options.onPageCreated(page);
      return { page, context, readOnlyGuard: guard, capture: {
        firebaseBearer: () => "synthetic-in-memory-token", assertNoCriticalApiFailures: vi.fn(),
      } };
    }),
  };
  return { page, context, browser, reviewer, guard };
}
describe("first-run evidence boundaries", () => {
  it.each([
    { userId: "foreign" }, { hasVault: true }, { vaultStatus: "active" },
    { setupCompleted: true }, { setupCompleted: null }, { setupCapabilityIds: ["cloud"] },
    { setupCapabilityIds: ["connections"] }, { oneRuntimeSetupChoice: "managed" },
  ])("rejects established, ambiguous or foreign state %j", (change) => {
    expect(isFirstRunState({ ...fresh, ...change }, fresh.userId)).toBe(false);
  });
  it("counts duplicate requests until bodies finish without retaining URLs", () => {
    const page = new EventEmitter();
    const read = trackApiConcurrency(page, origin, () => "authentication");
    const request = () => ({ url: () => `${origin}/api/private/owner-secret?token=secret` });
    const a = request(), b = request();
    page.emit("request", a); page.emit("request", b);
    page.emit("response", { request: () => a });
    expect(read().outstandingRequests).toBe(2);
    page.emit("requestfinished", a); page.emit("requestfailed", b);
    expect(read()).toEqual({ peakInflight: 2, peakStage: "authentication", failedRequests: 1, outstandingRequests: 0 });
    expect(JSON.stringify(read())).not.toContain("secret");
  });
  it("clicks the actual tile and limits its claim to first-run state", async () => {
    const f = fixture();
    const report = await auditFirstRun({ ...f, origin, budgetMs: 1000 });
    expect(report).toMatchObject({ passed: true, actual_tile_click: true, reached: true, first_run_state: true, account_creation_proven: false, database_pool_measured: false });
    expect(f.page.locator.mock.results[0].value.click).toHaveBeenCalledOnce();
    expect(f.context.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(report)).not.toContain("synthetic-owner");
    expect(JSON.stringify(report)).not.toContain("synthetic-in-memory-token");
  });
  it("does not click for an established owner", async () => {
    const f = fixture({ ...fresh, hasVault: true });
    const report = await auditFirstRun({ ...f, origin, budgetMs: 1000 });
    expect(report).toMatchObject({ passed: false, failureStage: "owner_state" });
    expect(f.page.locator).not.toHaveBeenCalled();
  });
  it("fails a blocked mutation without printing private errors", async () => {
    const f = fixture();
    f.guard.assertNoBlockedMutation.mockImplementation(() => { throw new Error("private-payload"); });
    const report = await auditFirstRun({ ...f, origin, budgetMs: 1000 });
    expect(report.passed).toBe(false);
    expect(JSON.stringify(report)).not.toContain("private-payload");
  });
  it("a hung authentication cannot reset the total deadline", async () => {
    const f = fixture();
    f.reviewer.openSession.mockImplementation(() => new Promise(() => undefined));
    const report = await auditFirstRun({ ...f, origin, budgetMs: 15 });
    expect(report).toMatchObject({ passed: false, failureStage: "authentication" });
    expect(f.browser.close).toHaveBeenCalled();
  });
});


it("closes a late session without requests or changes to the returned failure", async () => {
  const f = fixture();
  let resolveSession;
  f.reviewer.openSession.mockImplementation(() => new Promise((resolve) => { resolveSession = resolve; }));
  const report = await auditFirstRun({ ...f, origin, budgetMs: 10 });
  const before = JSON.stringify(report);
  resolveSession({ page: f.page, context: f.context });
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.page.request.post).not.toHaveBeenCalled();
  expect(f.page.locator).not.toHaveBeenCalled();
  expect(f.context.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(report)).toBe(before);
});

it("does not credit a chooser left mounted after session loss", async () => {
  const f = fixture();
  f.reviewer.assertVaultContinuity.mockRejectedValue(new Error("private owner state"));
  const report = await auditFirstRun({ ...f, origin, budgetMs: 1000 });
  expect(report.passed).toBe(false);
  expect(JSON.stringify(report)).not.toContain("private owner state");
});


it("accepts an explicit incomplete journey while the legacy completion field is unset", () => {
  expect(isFirstRunState({ ...fresh, setupCompleted: null, onboardingJourneyVersion: 1, onboardingPhase: "setup_hub" }, fresh.userId)).toBe(true);
  expect(isFirstRunState({ ...fresh, onboardingJourneyVersion: 1, onboardingPhase: "root_completion" }, fresh.userId)).toBe(false);
});
