import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: false,
  unregister: vi.fn(),
  deleteNativeToken: vi.fn(),
  getRegistration: vi.fn(),
  register: vi.fn(),
  getSubscription: vi.fn(),
  unsubscribe: vi.fn(),
  registerPush: vi.fn(),
  listeners: new Map<string, (payload: unknown) => Promise<void>>(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.native, getPlatform: () => "ios" },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { unregisterPushToken: mocks.unregister, registerPushToken: mocks.registerPush },
}));
vi.mock("@capacitor-firebase/messaging", () => ({
  FirebaseMessaging: { deleteToken: mocks.deleteNativeToken,
    checkPermissions: vi.fn().mockResolvedValue({ receive: "granted" }),
    getToken: vi.fn().mockResolvedValue({ token: "device-token" }),
    addListener: vi.fn(async (name: string, callback: (payload: unknown) => Promise<void>) => { mocks.listeners.set(name, callback); return { remove: vi.fn() }; }),
  },
}));
vi.mock("@/lib/firebase/config", () => ({
  app: { options: { appId: "test", apiKey: "test", messagingSenderId: "test" } },
}));

import { clearFCMSession, deleteFCMToken, initializeFCM } from "@/lib/notifications/fcm-service";
vi.mock("@/lib/services/auth-service", () => ({ AuthService: { getIdTokenWithRetry: vi.fn().mockResolvedValue("fresh-token") } }));

describe("sign-out push cleanup", () => {
  it("does not delete a newer same-owner registration after a stale response", async () => {
    mocks.native = true;
    let finish!: (response: Response) => void;
    mocks.registerPush.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const stale = initializeFCM("owner", "token");
    await vi.waitFor(() => expect(mocks.registerPush).toHaveBeenCalledTimes(2));
    clearFCMSession();
    await initializeFCM("owner", "token");
    finish(new Response("{}", { status: 200 }));
    await stale;
    expect(mocks.unregister).not.toHaveBeenCalled();
  });

  it("uses fresh owner-bound auth on token refresh and stops refreshing after logout", async () => {
    mocks.native = true;
    const refresh = mocks.listeners.get("tokenReceived")!;
    await refresh({ token: "new-device-token" });
    expect(mocks.registerPush).toHaveBeenLastCalledWith("owner", "new-device-token", "ios", "fresh-token");
    await deleteFCMToken("owner", "token");
    const calls = mocks.registerPush.mock.calls.length;
    await refresh({ token: "signed-out-token" });
    expect(mocks.registerPush).toHaveBeenCalledTimes(calls);
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    clearFCMSession();
    mocks.native = true;
    mocks.registerPush.mockResolvedValue(new Response("{}", { status: 200 }));
    await initializeFCM("owner", "token");
    mocks.native = false;
    mocks.unregister.mockResolvedValue(undefined);
    mocks.deleteNativeToken.mockResolvedValue(undefined);
    mocks.getRegistration.mockResolvedValue(undefined);
    mocks.getSubscription.mockResolvedValue({ unsubscribe: mocks.unsubscribe });
    mocks.unsubscribe.mockResolvedValue(true);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: mocks.getRegistration, register: mocks.register },
    });
  });

  it("clears an existing subscription without registering a worker during logout", async () => {
    mocks.getRegistration.mockResolvedValue({
      pushManager: { getSubscription: mocks.getSubscription },
    });
    await deleteFCMToken("owner", "token");
    expect(mocks.unregister).toHaveBeenCalledOnce();
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it("does not download a worker when this device has no push registration", async () => {
    await deleteFCMToken("owner", "token");
    expect(mocks.getRegistration).toHaveBeenCalledOnce();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it.each([false, true])("clears device push state while the backend stalls (native=%s)", async (native) => {
    mocks.native = native;
    let complete!: () => void;
    mocks.unregister.mockReturnValue(new Promise<void>((resolve) => { complete = resolve; }));
    const controller = new AbortController();
    const cleanup = deleteFCMToken("owner", "token", { signal: controller.signal });
    expect(mocks.unregister).toHaveBeenCalledWith("owner", "token", "ios", controller.signal, "device-token");
    const localOperation = native ? mocks.deleteNativeToken : mocks.getRegistration;
    await vi.waitFor(() => expect(localOperation).toHaveBeenCalledOnce());
    controller.abort();
    complete();
    await cleanup;
    expect(localOperation).toHaveBeenCalledOnce();
  });

  it("does not unsubscribe a later account after a slow subscription lookup", async () => {
    let complete!: (subscription: { unsubscribe: typeof mocks.unsubscribe }) => void;
    mocks.getRegistration.mockResolvedValue({ pushManager: { getSubscription: mocks.getSubscription } });
    mocks.getSubscription.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const controller = new AbortController();
    const cleanup = deleteFCMToken("owner", "token", { signal: controller.signal });
    await vi.waitFor(() => expect(mocks.getSubscription).toHaveBeenCalledOnce());
    controller.abort();
    complete({ unsubscribe: mocks.unsubscribe });
    await cleanup;
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
  });
});
