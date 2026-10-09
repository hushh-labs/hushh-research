import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  getToken: vi.fn(),
  addListener: vi.fn(),
  registerPushToken: vi.fn(),
  unregisterPushToken: vi.fn(),
  freshIdToken: vi.fn(),
  tokenReceived: null as ((event: { token: string }) => Promise<void>) | null,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
  },
}));

vi.mock("@capacitor-firebase/messaging", () => ({
  FirebaseMessaging: {
    checkPermissions: mocks.checkPermissions,
    requestPermissions: mocks.requestPermissions,
    getToken: mocks.getToken,
    addListener: mocks.addListener,
  },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    registerPushToken: mocks.registerPushToken,
    unregisterPushToken: mocks.unregisterPushToken,
  },
}));
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getIdTokenWithRetry: mocks.freshIdToken } }));

import { clearFCMSession, initializeFCM } from "@/lib/notifications/fcm-service";
import { getFCMSessionEpoch } from "@/lib/notifications/fcm-session";

describe("native FCM permission ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearFCMSession();
    mocks.addListener.mockImplementation(async (type, callback) => {
      if (type === "tokenReceived") mocks.tokenReceived = callback;
      return { remove: vi.fn() };
    });
    mocks.freshIdToken.mockResolvedValue("fresh-token");
    mocks.unregisterPushToken.mockResolvedValue(new Response(null));
    mocks.checkPermissions.mockResolvedValue({ receive: "prompt" });
    mocks.requestPermissions.mockResolvedValue({ receive: "granted" });
    mocks.getToken.mockResolvedValue({ token: "test-token" });
    mocks.registerPushToken.mockResolvedValue({
      ok: true,
      clone: () => ({ json: vi.fn().mockResolvedValue({ registered: true }) }),
    });
  });

  it("does not request notification authorization during normal startup", async () => {
    await expect(initializeFCM("user-1", "id-token")).resolves.toEqual({
      status: "push_not_requested",
      detail: "native_permission_prompt",
    });

    expect(mocks.checkPermissions).toHaveBeenCalledOnce();
    expect(mocks.requestPermissions).not.toHaveBeenCalled();
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it("requests authorization and registers only after an explicit action", async () => {
    await expect(
      initializeFCM("user-1", "id-token", { requestPermission: true }),
    ).resolves.toEqual({ status: "push_active" });

    expect(mocks.requestPermissions).toHaveBeenCalledOnce();
    expect(mocks.getToken).toHaveBeenCalledOnce();
    expect(mocks.registerPushToken).toHaveBeenCalledWith(
      "user-1",
      "test-token",
      "ios",
      "id-token",
    );
  });

  it("refreshes credentials for the current owner and withdraws authority immediately on logout", async () => {
    mocks.checkPermissions.mockResolvedValue({ receive: "granted" });
    await initializeFCM("user-1", "expired-id-token");
    await mocks.tokenReceived?.({ token: "refreshed-device" });
    expect(mocks.freshIdToken).toHaveBeenCalledWith({ expectedUserId: "user-1" });
    expect(mocks.registerPushToken).toHaveBeenLastCalledWith("user-1", "refreshed-device", "ios", "fresh-token");
    clearFCMSession();
    mocks.registerPushToken.mockClear();
    await mocks.tokenReceived?.({ token: "after-logout" });
    expect(mocks.registerPushToken).not.toHaveBeenCalled();
  });

  it("fences an in-flight registration after account switching with exact old-owner cleanup", async () => {
    mocks.checkPermissions.mockResolvedValue({ receive: "granted" });
    let complete!: (response: Response) => void;
    mocks.registerPushToken.mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }));
    const old = initializeFCM("owner-a", "id-a");
    await vi.waitFor(() => expect(mocks.registerPushToken).toHaveBeenCalledOnce());
    await initializeFCM("owner-b", "id-b");
    complete(new Response(JSON.stringify({ registered: true })));
    expect((await old).status).toBe("push_failed");
    expect(mocks.unregisterPushToken).toHaveBeenCalledWith("owner-a", "id-a", "ios", undefined, "test-token");
  });

  it("repairs the current owner while its registration response is still pending", async () => {
    mocks.checkPermissions.mockResolvedValue({ receive: "granted" });
    let finishA!: (response: Response) => void;
    let finishB!: (response: Response) => void;
    mocks.registerPushToken
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishA = resolve; }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finishB = resolve; }));
    const old = initializeFCM("owner-a", "id-a");
    await vi.waitFor(() => expect(mocks.registerPushToken).toHaveBeenCalledTimes(1));
    const current = initializeFCM("owner-b", "id-b");
    await vi.waitFor(() => expect(mocks.registerPushToken).toHaveBeenCalledTimes(2));
    finishA(new Response(JSON.stringify({ registered: true })));
    await old;
    expect(mocks.registerPushToken).toHaveBeenLastCalledWith("owner-b", "test-token", "ios", "fresh-token");
    finishB(new Response(JSON.stringify({ registered: true })));
    expect((await current).status).toBe("push_active");
  });

  it("refuses a delayed provider initialization from before logout", async () => {
    const sessionEpoch = getFCMSessionEpoch();
    clearFCMSession();
    expect((await initializeFCM("owner-a", "id-a", { sessionEpoch })).status).toBe("push_failed");
    expect(mocks.checkPermissions).not.toHaveBeenCalled();
    expect(mocks.registerPushToken).not.toHaveBeenCalled();
  });
});
