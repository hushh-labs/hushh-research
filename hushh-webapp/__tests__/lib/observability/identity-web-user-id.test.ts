import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression cover for the web GA4 User-ID binding.
 *
 * `applyWebUserId` previously issued a second `gtag('config', id, { user_id })`
 * after the stream was already initialised. That does not attach `user_id` to
 * subsequent hits and it fails silently, so the function reported success and
 * the id was memoised as applied. The result was 67 completed web sign-ins in
 * a month with zero `user_id` reaching GA4, while iOS -- which binds through
 * Firebase Analytics rather than gtag -- worked.
 *
 * These tests assert the command actually issued, because the observable
 * symptom of the bug was that everything else looked correct.
 */

const setUserIdMock = vi.fn();

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));

vi.mock("@capacitor-firebase/analytics", () => ({
  FirebaseAnalytics: { setUserId: setUserIdMock },
}));

vi.mock("@/lib/observability/env", () => ({
  resolveAnalyticsMeasurementId: () => "G-TESTID0001",
}));

async function loadIdentity() {
  vi.resetModules();
  return import("@/lib/observability/identity");
}

describe("web GA4 User-ID binding", () => {
  let gtag: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    gtag = vi.fn();
    vi.stubGlobal("window", { gtag } as unknown as Window & typeof globalThis);
    setUserIdMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("binds the identity with set(), not a second config()", async () => {
    const { setObservabilityUserId } = await loadIdentity();
    await setObservabilityUserId("firebase-uid-1");

    expect(gtag).toHaveBeenCalledTimes(1);
    const [command, params] = gtag.mock.calls[0];
    expect(command).toBe("set");
    expect(params).toMatchObject({ user_id: expect.any(String) });

    // The regression itself: a second config() is silently ignored by gtag
    // once the stream is initialised, so it must never be the mechanism here.
    expect(gtag).not.toHaveBeenCalledWith("config", expect.anything(), expect.anything());
  });

  it("sends a digest, never the raw Firebase UID", async () => {
    const { setObservabilityUserId } = await loadIdentity();
    await setObservabilityUserId("firebase-uid-1");

    const [, params] = gtag.mock.calls[0];
    expect(params.user_id).not.toBe("firebase-uid-1");
    expect(params.user_id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("clears the identity with an explicit null on sign-out", async () => {
    const { setObservabilityUserId } = await loadIdentity();
    await setObservabilityUserId(null);

    const [command, params] = gtag.mock.calls[0];
    expect(command).toBe("set");
    // Explicitly null, not undefined: gtag drops undefined fields, which would
    // leave the previous account's id bound to the next person's events.
    expect(params).toHaveProperty("user_id", null);
  });

  it("does not report success when gtag is unavailable, so the caller retries", async () => {
    vi.stubGlobal("window", {} as unknown as Window & typeof globalThis);
    const { setObservabilityUserId } = await loadIdentity();

    await setObservabilityUserId("firebase-uid-1");
    // Nothing was applied, so nothing may be memoised: a later call once gtag
    // exists has to be able to bind.
    vi.stubGlobal("window", { gtag } as unknown as Window & typeof globalThis);
    await setObservabilityUserId("firebase-uid-1");

    expect(gtag).toHaveBeenCalledTimes(1);
    expect(gtag.mock.calls[0][0]).toBe("set");
  });
});
