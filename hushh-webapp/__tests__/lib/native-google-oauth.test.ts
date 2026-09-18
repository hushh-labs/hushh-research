import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";

const mocks = vi.hoisted(() => ({
  appListener: vi.fn(), browserListener: vi.fn(), launch: vi.fn(), open: vi.fn(), close: vi.fn(),
  complete: vi.fn(), byoc: vi.fn(), remove: vi.fn(), navigate: vi.fn(),
}));
vi.mock("@capacitor/app", () => ({ App: { addListener: mocks.appListener, getLaunchUrl: mocks.launch } }));
vi.mock("@capacitor/browser", () => ({ Browser: { addListener: mocks.browserListener, open: mocks.open, close: mocks.close } }));
vi.mock("@/lib/services/google-calendar-service", () => ({ GoogleCalendarService: { completeConnect: mocks.complete } }));
vi.mock("@/lib/services/api-service", () => ({ ApiService: { completeByocAuthorize: mocks.byoc } }));

const callback = "https://dev.one.hushh.ai/one/profile/google/oauth/return";
const user = (uid = "owner") => ({ uid, getIdToken: vi.fn().mockResolvedValue("synthetic-id-token") }) as unknown as User;
let flow: typeof import("@/lib/google/native-google-oauth");
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function start(state = "synthetic-state", ownerUid = "owner") {
  return flow.connectNativeGoogleCalendar({ ownerUid,
    authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}&redirect_uri=${encodeURIComponent(callback)}`,
    redirectUri: callback, expiresAt: new Date(Date.now() + 600000).toISOString(),
  });
}
function returned(state = "synthetic-state") { return `${callback}?state=${state}&code=synthetic-code`; }

beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks(); vi.useFakeTimers();
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://dev.one.hushh.ai");
  mocks.appListener.mockResolvedValue({ remove: mocks.remove });
  mocks.browserListener.mockResolvedValue({ remove: mocks.remove });
  mocks.open.mockResolvedValue(undefined); mocks.close.mockResolvedValue(undefined);
  mocks.complete.mockResolvedValue({ connected: true }); mocks.byoc.mockResolvedValue({});
  flow = await import("@/lib/google/native-google-oauth");
  await flow.installNativeGoogleOAuthReturn(mocks.navigate);
  flow.updateNativeGoogleOAuthAuth(user(), false);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("native Calendar OAuth authority and continuity", () => {
  it("completes once for launch/event duplicates without putting codes in navigation", async () => {
    const result = start(); await flush();
    flow.receiveNativeGoogleOAuthReturn(returned());
    flow.receiveNativeGoogleOAuthReturn(returned());
    await result;
    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", code: "synthetic-code" }));
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("rejects foreign origin, legacy path and wrong state before exchange", async () => {
    const result = start(); const rejected = expect(result).rejects.toThrow("session changed"); await flush();
    for (const url of [returned().replace("dev.one.hushh.ai", "attacker.invalid"), returned().replace("/one/profile", "/profile"), returned("foreign")]) {
      flow.receiveNativeGoogleOAuthReturn(url);
    }
    expect(mocks.complete).not.toHaveBeenCalled();
    flow.updateNativeGoogleOAuthAuth(user("other-owner"), false);
    await rejected;
  });
  it("waits for native authentication to settle before exchanging", async () => {
    const owner = user(); flow.updateNativeGoogleOAuthAuth(owner, false);
    const result = start(); await flush();
    flow.updateNativeGoogleOAuthAuth(owner, true);
    flow.receiveNativeGoogleOAuthReturn(returned()); await flush();
    expect(mocks.complete).not.toHaveBeenCalled();
    flow.updateNativeGoogleOAuthAuth(owner, false);
    await result;
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  it("prevents exchange if account changes during token retrieval", async () => {
    let token!: (value: string) => void;
    const owner = user(); vi.mocked(owner.getIdToken).mockReturnValue(new Promise((resolve) => { token = resolve; }));
    flow.updateNativeGoogleOAuthAuth(owner, false);
    const result = start(); const rejected = expect(result).rejects.toThrow("session changed"); await flush();
    flow.receiveNativeGoogleOAuthReturn(returned()); await flush();
    flow.updateNativeGoogleOAuthAuth(user("other"), false);
    token("old-owner-token"); await rejected; await flush();
    expect(mocks.complete).not.toHaveBeenCalled();
  });
  it("lets a valid return win the browser-dismiss race", async () => {
    const result = start(); await flush();
    mocks.browserListener.mock.calls[0][1]();
    flow.receiveNativeGoogleOAuthReturn(returned());
    await vi.advanceTimersByTimeAsync(500); await result;
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  it("ignores a previous browser-open failure after a new attempt starts", async () => {
    let rejectOld!: (error: Error) => void;
    mocks.open.mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }));
    const first = start("first"); const rejected = expect(first).rejects.toThrow("session changed"); await flush();
    flow.updateNativeGoogleOAuthAuth(null, false); await rejected;
    flow.updateNativeGoogleOAuthAuth(user(), false);
    const second = start("second"); await flush();
    rejectOld(new Error("old native callback")); await flush();
    flow.receiveNativeGoogleOAuthReturn(returned("second")); await second;
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  it("gives explicit cold-restart recovery without exchanging an unknown Calendar attempt", async () => {
    flow.receiveNativeGoogleOAuthReturn(returned()); await flush();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.navigate).toHaveBeenCalledWith("/one/calendar?calendar=restart");
  });
  it("preserves BYOC completion and deduplicates reordered returns", async () => {
    flow.receiveNativeGoogleOAuthReturn(returned("byoc.first")); await flush();
    flow.receiveNativeGoogleOAuthReturn(returned("byoc.second")); await flush();
    flow.receiveNativeGoogleOAuthReturn(returned("byoc.first")); await flush();
    expect(mocks.byoc).toHaveBeenCalledTimes(2);
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
  it("does not navigate from a BYOC error after an account switch", async () => {
    let reject!: (error: Error) => void;
    mocks.byoc.mockImplementation(() => new Promise((_, no) => { reject = no; }));
    flow.receiveNativeGoogleOAuthReturn(returned("byoc.first")); await flush();
    flow.updateNativeGoogleOAuthAuth(user("other"), false);
    reject(new Error("synthetic refusal")); await flush();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it("cleans partial installation and permits retry", async () => {
    vi.resetModules(); flow = await import("@/lib/google/native-google-oauth");
    mocks.browserListener.mockRejectedValueOnce(new Error("native unavailable"));
    await expect(flow.installNativeGoogleOAuthReturn(mocks.navigate)).rejects.toThrow("native unavailable");
    expect(mocks.remove).toHaveBeenCalled();
    await expect(flow.installNativeGoogleOAuthReturn(mocks.navigate)).resolves.toBeUndefined();
  });
});
