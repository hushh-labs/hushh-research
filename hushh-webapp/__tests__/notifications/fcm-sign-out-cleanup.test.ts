import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: false,
  unregister: vi.fn(),
  registerToken: vi.fn(),
  deleteNativeToken: vi.fn(),
  getNativeToken: vi.fn(),
  freshIdToken: vi.fn(),
  getRegistration: vi.fn(),
  register: vi.fn(),
  getSubscription: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.native, getPlatform: () => "ios" },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { unregisterPushToken: mocks.unregister, registerPushToken: mocks.registerToken },
}));
vi.mock("@capacitor-firebase/messaging", () => ({
  FirebaseMessaging: {
    deleteToken: mocks.deleteNativeToken,
    checkPermissions: vi.fn(async () => ({ receive: "granted" })),
    getToken: mocks.getNativeToken,
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
  },
}));
vi.mock("@/lib/services/auth-service", () => ({
  AuthService: { getIdTokenWithRetry: mocks.freshIdToken },
}));
vi.mock("@/lib/firebase/config", () => ({
  app: { options: { appId: "test", apiKey: "test", messagingSenderId: "test" } },
}));

import { deleteFCMToken, initializeFCM } from "@/lib/notifications/fcm-service";
import { getFCMSessionEpoch, lastKnownSession } from "@/lib/notifications/fcm-session";

describe("sign-out push cleanup", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.native = false;
    mocks.unregister.mockResolvedValue(undefined);
    mocks.deleteNativeToken.mockResolvedValue(undefined);
    mocks.getNativeToken.mockResolvedValue({ token: "this-device-token" });
    mocks.freshIdToken.mockResolvedValue("fresh-new-id-token");
    mocks.getRegistration.mockResolvedValue(undefined);
    mocks.getSubscription.mockResolvedValue({ unsubscribe: mocks.unsubscribe });
    mocks.unsubscribe.mockResolvedValue(true);
    mocks.registerToken.mockResolvedValue(new Response(JSON.stringify({ registered: true })));
    mocks.native = true;
    await initializeFCM("owner", "token");
    mocks.native = false;
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
    expect(mocks.unregister).toHaveBeenCalledWith("owner", "token", "ios", controller.signal, "this-device-token");
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

  it("never unregisters every device when the local registration is unknown", async () => {
    await deleteFCMToken("other-owner", "other-token");
    expect(mocks.unregister).not.toHaveBeenCalled();
  });

  it("preserves a newer account when old cleanup resumes after credential lookup", async () => {
    const sessionEpoch = getFCMSessionEpoch();
    mocks.native = true;
    await initializeFCM("new-owner", "new-token");
    await deleteFCMToken("owner", "token", { sessionEpoch });
    expect(lastKnownSession?.userId).toBe("new-owner");
    expect(mocks.deleteNativeToken).not.toHaveBeenCalled();
    expect(mocks.unregister).not.toHaveBeenCalled();
  });

  it("fences slow subscription cleanup when a new account takes ownership without an abort", async () => {
    let complete!: (subscription: { unsubscribe: typeof mocks.unsubscribe }) => void;
    mocks.getRegistration.mockResolvedValue({ pushManager: { getSubscription: mocks.getSubscription } });
    mocks.getSubscription.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    const cleanup = deleteFCMToken("owner", "token");
    await vi.waitFor(() => expect(mocks.getSubscription).toHaveBeenCalledOnce());
    mocks.native = true;
    await initializeFCM("new-owner", "new-token");
    complete({ unsubscribe: mocks.unsubscribe });
    await cleanup;
    expect(lastKnownSession?.userId).toBe("new-owner");
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
  });

  it("renews the current native device after an old logout deletes its token, even before an older registration settles", async () => {
    mocks.native = true;
    let finishDeletion!: () => void;
    let finishOlderRegistration!: (response: Response) => void;
    mocks.deleteNativeToken.mockReturnValueOnce(new Promise<void>(resolve => { finishDeletion = resolve; }));
    const cleanup = deleteFCMToken("owner", "token");
    await vi.waitFor(() => expect(mocks.deleteNativeToken).toHaveBeenCalledOnce());
    mocks.registerToken.mockReturnValueOnce(new Promise<Response>(resolve => { finishOlderRegistration = resolve; }));
    const nextInitialization = initializeFCM("new-owner", "new-token");
    await vi.waitFor(() => expect(mocks.registerToken).toHaveBeenLastCalledWith("new-owner", "this-device-token", "ios", "new-token"));
    mocks.getNativeToken.mockResolvedValue({ token: "replacement-device-token" });
    finishDeletion();
    await cleanup;
    expect(mocks.freshIdToken).toHaveBeenCalledWith({ expectedUserId: "new-owner" });
    expect(mocks.registerToken).toHaveBeenLastCalledWith("new-owner", "replacement-device-token", "ios", "fresh-new-id-token");
    finishOlderRegistration(new Response(JSON.stringify({ registered: true })));
    await nextInitialization;
    await deleteFCMToken("new-owner", "new-token");
    expect(mocks.unregister).toHaveBeenLastCalledWith("new-owner", "new-token", "ios", undefined, "replacement-device-token");
  });
});
