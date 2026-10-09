// @vitest-environment node
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareReviewerRehearsal } from "../../../.codex/skills/reviewer-app-testing/scripts/reviewer-rehearsal-preflight.mjs";
import { createReviewerBootstrap } from "../../../.codex/skills/reviewer-app-testing/scripts/reviewer-session-bootstrap.mjs";
import { createReviewerSessionHarness } from "../../../.codex/skills/reviewer-app-testing/scripts/reviewer-session-harness.mjs";
import { installOperatorReviewerTokenBinding } from "../../../.codex/skills/reviewer-app-testing/scripts/reviewer-operator-token-binding.mjs";

afterEach(() => vi.unstubAllEnvs());
async function harness(authMode = "custom_token") {
  vi.stubEnv("REVIEWER_AUTH_MODE", authMode);
  vi.stubEnv("REVIEWER_UID", "synthetic-owner");
  vi.stubEnv("REVIEWER_VAULT_PASSPHRASE", "synthetic-passphrase");
  vi.stubEnv("REVIEWER_ALLOW_SHARED_MUTATIONS", "false");
  return createReviewerSessionHarness({ repoRoot: resolve(process.cwd(), ".."), appOrigin: "https://synthetic.example",
    reviewerTokenProvider: authMode === "operator_issued_token" ? vi.fn(async () => "synthetic-proof") : null });
}
function browser(state = "authenticated") {
  const window = { location: { pathname: "/one/setup", search: "" }, __HUSHH_NATIVE_TEST__: { bootstrapState: state, bootstrapUserId: "synthetic-owner" } };
  const fill = vi.fn();
  const control = { first() { return this; }, isVisible: async () => false, isEnabled: async () => false, fill, click: vi.fn() };
  const page = Object.assign(new EventEmitter(), {
    addInitScript: vi.fn(async () => undefined), setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    getByRole: () => control, locator: () => control,
    evaluate: async (fn, argument) => runInNewContext(`(${fn.toString()})(argument)`, { window, argument }),
    waitForFunction: async (fn, argument) => {
      expect(runInNewContext(`(${fn.toString()})(argument)`, { window, argument })).toBe(true);
    },
    goto: vi.fn(async (url: string) => {
      window.location.pathname = new URL(url).searchParams.get("redirect") || "/";
    }), waitForTimeout: vi.fn(async () => undefined),
  });
  const context = { newPage: async () => page, route: vi.fn(async () => undefined), close: vi.fn(async () => undefined) };
  return { newContext: async () => context, page, window, fill, context };
}
describe("reviewer session authority", () => {
  it.each([
    "/api/one/personal-agent/endpoint",
    "/api/one/personal-agent/status",
    "/api/account/trusted-devices",
  ])("observes Files/Hosting identity without confusing an owner capability: %s", async (path) => {
    const reviewer = await harness();
    const b = browser();
    const session = await reviewer.openSession(b, "/one/setup", { requireVaultUnlocked: false });
    const request = (pathname, token) => b.page.emit("request", {
      url: () => `https://synthetic.example${pathname}`,
      // Playwright's abbreviated headers can omit security headers.
      headers: () => ({}),
      allHeaders: async () => ({ authorization: `Bearer ${token}` }),
    });
    request("/api/one/models/preference", "baseline-identity");
    request(path, "pod-identity");
    request("/api/account/trusted-devices/synthetic/puppy-access", "owner-capability");
    expect(await session.capture.identityToken()).toBe("pod-identity");
  });
  it("uses the automation bridge rather than a legal-agreement sign-in click", async () => {
    const reviewer = await harness();
    const b = browser("pending");
    const trigger = vi.fn(() => {
      b.window.__HUSHH_NATIVE_TEST__.bootstrapState = "authenticated";
    });
    Object.assign(b.window.__HUSHH_NATIVE_TEST__, { triggerReviewerLogin: trigger });
    const getByRole = b.page.getByRole;
    const click = vi.fn();
    b.page.getByRole = (...[role]: unknown[]) => role === "button" ? {
      ...getByRole(), isVisible: async () => true, click,
    } : getByRole();
    await reviewer.openSession(b, "/one/setup", { requireVaultUnlocked: false });
    expect(trigger).toHaveBeenCalledOnce();
    expect(click).not.toHaveBeenCalled();
  });
  it("defers a legal prompt without accepting an agreement", async () => {
    const reviewer = await harness();
    const b = browser();
    const getByRole = b.page.getByRole;
    const defer = vi.fn();
    b.page.getByRole = (...[role]: unknown[]) => role === "dialog" ? {
      ...getByRole(),
      isVisible: async () => true,
      getByRole: (controlRole: string, controlOptions: { name: string; exact: boolean }) => {
        expect(controlRole).toBe("button");
        expect(controlOptions).toEqual({ name: "Not now", exact: true });
        return { click: defer };
      },
    } : getByRole();
    await reviewer.openSession(b, "/one/setup", { requireVaultUnlocked: false });
    expect(defer).toHaveBeenCalledOnce();
  });
  it.each([false, true])("only tolerates a lost legal prompt when it disappears (remaining=%s)", async (remainsVisible) => {
    const reviewer = await harness();
    const b = browser();
    const getByRole = b.page.getByRole;
    let attempted = false;
    const failure = new Error("synthetic legal control detached");
    b.page.getByRole = (...[role]: unknown[]) => role === "dialog" ? {
      isVisible: async () => !attempted || remainsVisible,
      getByRole: () => ({ click: async (options) => {
        expect(options).toEqual({ timeout: 2_000 });
        attempted = true;
        throw failure;
      } }),
    } : getByRole();
    const session = reviewer.openSession(b, "/one/setup", { requireVaultUnlocked: false });
    if (remainsVisible) await expect(session).rejects.toMatchObject({ cause: failure });
    else await expect(session).resolves.toBeDefined();
    expect(attempted).toBe(true);
  });
  it("attaches observation before navigation and never injects a first-run passphrase", async () => {
    const reviewer = await harness();
    const b = browser();
    const observe = vi.fn(() => expect(b.page.goto).not.toHaveBeenCalled());
    await reviewer.openSession(b, "/one/setup", { requireVaultUnlocked: false, onPageCreated: observe });
    expect(observe).toHaveBeenCalledOnce();
    expect(b.page.addInitScript.mock.calls[0][1].vaultPassphrase).toBe("");
    expect(b.fill).not.toHaveBeenCalled();
    await reviewer.assertAuthenticatedContinuity(b.page, "synthetic");
    b.window.__HUSHH_NATIVE_TEST__.bootstrapUserId = "foreign-owner";
    await expect(reviewer.assertAuthenticatedContinuity(b.page, "synthetic")).rejects.toThrow("expected reviewer session");
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
    await reviewer.assertAuthenticatedContinuity(first.page, "first-run");
    established.window.__HUSHH_NATIVE_TEST__.bootstrapState = "authenticated";
    await expect(reviewer.assertVaultContinuity(established.page, "established")).rejects.toThrow();
  });
});


describe("read-only request admission", () => {
  it("installs interception before first navigation", async () => {
    const reviewer = await harness();
    const b = browser();
    let release;
    b.context.route.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const opened = reviewer.openSession(b, "/one/setup", { requireVaultUnlocked: false });
    for (let attempt = 0; attempt < 10 && !b.context.route.mock.calls.length; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(b.context.route).toHaveBeenCalledOnce();
    expect(b.page.goto).not.toHaveBeenCalled();
    release();
    await opened;
    expect(b.page.goto).toHaveBeenCalledOnce();
  });
  it.each([
    ["https://www.google-analytics.com/g/collect", true],
    ["https://region1.google-analytics.com/g/collect", true],
    ["https://analytics.google.com/g/collect", true],
    ["https://www.google-analytics.com.evil.invalid/g/collect", false],
    ["https://synthetic.example/g/collect", false],
    ["https://www.google-analytics.com/account/delete", false],
    ["https://synthetic.example/api/account/delete", false],
  ])("suppresses only known telemetry locally: %s", async (url, suppressed) => {
    const reviewer = await harness();
    const b = browser();
    const session = await reviewer.openSession(b, "/one/setup", { requireVaultUnlocked: false });
    const intercept = b.context.route.mock.calls[0][1];
    const route = { request: () => ({ method: () => "POST", url: () => url }), fulfill: vi.fn(), continue: vi.fn() };
    await intercept(route);
    expect(route.continue).not.toHaveBeenCalled();
    expect(route.fulfill).toHaveBeenCalledWith(expect.objectContaining({ status: suppressed ? 204 : 409 }));
    expect(session.readOnlyGuard.suppressedAnalyticsRequests()).toBe(suppressed ? 1 : 0);
    if (suppressed) expect(() => session.readOnlyGuard.assertNoBlockedMutation()).not.toThrow();
    else expect(() => session.readOnlyGuard.assertNoBlockedMutation()).toThrow("blocked state-changing");
  });
});


it.each([
  ["custom_token", 3],
  ["human_authenticated", 1],
  ["operator_issued_token", 1],
])("closes failed contexts without replaying one-shot reviewer admission (%s)", async (mode, expectedAttempts) => {
  const reviewer = await harness(mode);
  const b = browser();
  b.context.route.mockRejectedValue(new Error("synthetic interception failure"));
  await expect(reviewer.openSession(b, "/one/setup", { requireVaultUnlocked: false })).rejects.toThrow("bootstrap failed");
  expect(b.context.close).toHaveBeenCalledTimes(expectedAttempts);
  expect(b.page.goto).not.toHaveBeenCalled();
});

it("requires an owner-bound visible human unlock without injecting or submitting credentials", async () => {
    const b = browser();
    const click = vi.fn(), fill = vi.fn(), trigger = vi.fn();
    Object.assign(b.window.__HUSHH_NATIVE_TEST__, { triggerReviewerLogin: trigger });
    b.page.locator = () => ({ ...b.page.getByRole(), isVisible: async () => true, fill, click });
    b.page.waitForTimeout = vi.fn(async () => { b.window.__HUSHH_NATIVE_TEST__.bootstrapState = "vault_unlocked"; });
    const bootstrap = createReviewerBootstrap({ reviewerUid: "synthetic-owner", reviewerPassphrase: "",
      reviewerAuthMode: "human_authenticated", deferLegalAcceptance: async () => {}, timeoutMs: 1000 });
    await bootstrap.installBridge(b.page);
    const payload = b.page.addInitScript.mock.calls[0][1];
    const isolatedWindow = {};
    runInNewContext(`(${b.page.addInitScript.mock.calls[0][0].toString()})(argument)`, { window: isolatedWindow, argument: payload });
    expect(isolatedWindow.__HUSHH_NATIVE_TEST__).not.toHaveProperty("vaultPassphrase");
    expect(isolatedWindow.__HUSHH_NATIVE_TEST__).not.toHaveProperty("reviewerSessionPassphrase");
    await bootstrap.waitForUnlock(b.page, { assertNoBlockedMutation() {} });
    expect(fill).not.toHaveBeenCalled(); expect(click).not.toHaveBeenCalled(); expect(trigger).not.toHaveBeenCalled();
    await expect(bootstrap.waitForUnlock(b.page, { assertNoBlockedMutation() {} })).rejects.toThrow("visible vault challenge");
    b.window.__HUSHH_NATIVE_TEST__.bootstrapState = "uid_mismatch";
    await expect(bootstrap.waitForUnlock(b.page, { assertNoBlockedMutation() {} })).rejects.toThrow("bootstrap failed");
  });



it("human preflight requires explicit identity and HTTPS without a credential or backend mint read", async () => {
  vi.stubEnv("REVIEWER_AUTH_MODE", "human_authenticated");
  vi.stubEnv("REVIEWER_UID", "synthetic-owner");
  vi.stubEnv("REVIEWER_VAULT_PASSPHRASE", "");
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    const options = { repoRoot: resolve(process.cwd(), ".."), appOrigin: "https://synthetic.example", secretProject: "must-not-read-secrets" };
    expect(await prepareReviewerRehearsal(options)).toMatchObject({ authMode: "human_authenticated", identitySource: "configured_uid_human_authentication" });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expect(prepareReviewerRehearsal({ ...options, appOrigin: "http://synthetic.example" })).rejects.toThrow("explicit canonical UID and exact HTTPS");
    vi.stubEnv("REVIEWER_UID", "");
    await expect(prepareReviewerRehearsal(options)).rejects.toThrow("explicit canonical UID");
    vi.stubEnv("REVIEWER_AUTH_MODE", "unrecognized");
    await expect(prepareReviewerRehearsal(options)).rejects.toThrow("Unsupported reviewer authentication mode");
  } finally { fetchSpy.mockRestore(); }
});


it("issues one operator token only to the exact owner and HTTPS main frame", async () => {
  const issueToken = vi.fn(async () => "synthetic-proof");
  const makePage = () => {
    const frame = { url: () => "https://synthetic.example/login" };
    let callback;
    const page = { mainFrame: () => frame, exposeBinding: vi.fn(async (_name, fn) => { callback = fn; }) };
    return { page, frame, call: (source, uid) => callback(source, uid) };
  };
  for (const cold of [false, true]) {
    const b = makePage();
    await installOperatorReviewerTokenBinding(b.page, { appOrigin: "https://synthetic.example", reviewerUid: "synthetic-owner", issueToken });
    const before = issueToken.mock.calls.length;
    await expect(b.call({ page: {}, frame: b.frame }, "synthetic-owner")).rejects.toThrow("authority refused");
    await expect(b.call({ page: b.page, frame: { url: b.frame.url } }, "synthetic-owner")).rejects.toThrow("authority refused");
    const ownUrl = b.frame.url; b.frame.url = () => "https://foreign.example/login";
    await expect(b.call({ page: b.page, frame: b.frame }, "synthetic-owner")).rejects.toThrow("authority refused");
    b.frame.url = ownUrl;
    await expect(b.call({ page: b.page, frame: b.frame }, "foreign-owner")).rejects.toThrow("authority refused");
    expect(issueToken).toHaveBeenCalledTimes(before);
    await expect(b.call({ page: b.page, frame: b.frame }, "synthetic-owner")).resolves.toBe("synthetic-proof");
    await expect(b.call({ page: b.page, frame: b.frame }, "synthetic-owner")).rejects.toThrow("authority refused");
    expect(issueToken).toHaveBeenCalledTimes(cold ? 2 : 1);
  }
});

it("withholds operator phrases until owner-bound challenge and refuses challenge-free unlock", async () => {
  const b = browser();
  const frame = { url: () => "https://synthetic.example/login" };
  Object.assign(b.page, { mainFrame: () => frame, exposeBinding: vi.fn() });
  const fill = vi.fn(), click = vi.fn();
  b.page.locator = () => ({ ...b.page.getByRole(), isVisible: async () => true, fill });
  b.page.getByRole = () => ({ first() { return this; }, isVisible: async () => false, isEnabled: async () => true, click });
  b.page.waitForTimeout = vi.fn(async () => { b.window.__HUSHH_NATIVE_TEST__.bootstrapState = "vault_unlocked"; });
  const bootstrap = createReviewerBootstrap({ reviewerUid: "synthetic-owner", reviewerPassphrase: "synthetic-phrase",
    reviewerAuthMode: "operator_issued_token", appOrigin: "https://synthetic.example", reviewerTokenProvider: vi.fn(),
    deferLegalAcceptance: async () => {}, timeoutMs: 1000 });
  await bootstrap.installBridge(b.page);
  const [script, payload] = b.page.addInitScript.mock.calls[0];
  expect(JSON.stringify(payload)).not.toContain("synthetic-phrase");
  const isolatedWindow = {};
  runInNewContext(`(${script.toString()})(argument)`, { window: isolatedWindow, argument: payload });
  expect(isolatedWindow.__HUSHH_NATIVE_TEST__).not.toHaveProperty("vaultPassphrase");
  expect(isolatedWindow.__HUSHH_NATIVE_TEST__).not.toHaveProperty("reviewerSessionPassphrase");
  await bootstrap.waitForUnlock(b.page, { assertNoBlockedMutation() {} });
  expect(fill).toHaveBeenCalledWith("synthetic-phrase"); expect(click).toHaveBeenCalledOnce();
  await expect(bootstrap.waitForUnlock(b.page, { assertNoBlockedMutation() {} })).rejects.toThrow("visible vault challenge");
});
