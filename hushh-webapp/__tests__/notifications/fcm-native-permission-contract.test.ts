import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deletePushToken: vi.fn(),
  unregisterPushToken: vi.fn(),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  getToken: vi.fn(),
  addListener: vi.fn(),
  registerPushToken: vi.fn(),
  listeners: new Map<string, (event: { token: string }) => Promise<void>>(),
  currentUser: { uid: "user-1", getIdToken: vi.fn() },
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

vi.mock("@/lib/capacitor", () => ({ HushhNotifications: { deletePushToken: mocks.deletePushToken } }));
vi.mock("@/lib/firebase/config", () => ({ auth: { get currentUser() { return mocks.currentUser; } } }));

import { initializeFCM, deleteFCMToken } from "@/lib/notifications/fcm-service";

describe("native FCM permission ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.unregisterPushToken.mockResolvedValue(undefined);
    mocks.deletePushToken.mockResolvedValue(undefined);
    mocks.addListener.mockImplementation(async (name, listener) => { mocks.listeners.set(name, listener); return { remove: vi.fn() }; });
    mocks.currentUser.uid = "user-1";
    mocks.currentUser.getIdToken.mockResolvedValue("fresh-id-token");
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
      expect.any(Function),
    );
  });
  it("does not register a previous account after a delayed native token lookup", async () => {
    let complete!: (value: { token: string }) => void;
    mocks.checkPermissions.mockResolvedValue({ receive: "granted" });
    mocks.getToken.mockReturnValueOnce(new Promise((resolve) => { complete = resolve; }));
    const previous = initializeFCM("old-account", "old-id-token");
    await vi.waitFor(() => expect(mocks.getToken).toHaveBeenCalledOnce());
    await initializeFCM("new-account", "new-id-token");
    complete({ token: "obsolete-token" });
    await previous;
    expect(mocks.registerPushToken).toHaveBeenCalledOnce();
    expect(mocks.registerPushToken.mock.calls[0][0]).toBe("new-account");
  });

  it("waits for native token deletion before a new account obtains and registers a token", async () => {
    mocks.currentUser.uid = "old-account";
    mocks.checkPermissions.mockResolvedValue({ receive: "granted" });
    await initializeFCM("old-account", "old-id-token");
    let complete!: () => void;
    mocks.deletePushToken.mockReturnValueOnce(new Promise<void>((resolve) => { complete = resolve; }));
    const cleanup = deleteFCMToken("old-account", "old-id-token");
    await vi.waitFor(() => expect(mocks.deletePushToken).toHaveBeenCalledOnce());
    mocks.currentUser.uid = "new-account";
    mocks.getToken.mockResolvedValue({ token: "new-provider-token" });
    const next = initializeFCM("new-account", "new-id-token");
    const refresh = mocks.listeners.get("tokenReceived")!({ token: "obsolete-refresh-token" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.getToken).toHaveBeenCalledOnce();
    expect(mocks.registerPushToken).toHaveBeenCalledOnce();
    complete(); await cleanup; await next; await refresh;
    expect(mocks.getToken).toHaveBeenCalledTimes(3);
    expect(mocks.registerPushToken.mock.calls.at(-1)?.[0]).toBe("new-account");
    expect(mocks.registerPushToken.mock.calls.slice(1).every((call) => call[1] === "new-provider-token")).toBe(true);
  });

});
