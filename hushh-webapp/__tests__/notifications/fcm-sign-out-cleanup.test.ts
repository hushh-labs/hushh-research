import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  native: false,
  unregister: vi.fn(),
  deleteNativeToken: vi.fn(),
  getRegistration: vi.fn(),
  register: vi.fn(),
  getSubscription: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => mocks.native },
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { unregisterPushToken: mocks.unregister },
}));
vi.mock("@capacitor-firebase/messaging", () => ({
  FirebaseMessaging: { deleteToken: mocks.deleteNativeToken },
}));
vi.mock("@/lib/firebase/config", () => ({
  app: { options: { appId: "test", apiKey: "test", messagingSenderId: "test" } },
}));

import { deleteFCMToken } from "@/lib/notifications/fcm-service";

describe("sign-out push cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(mocks.unregister).toHaveBeenCalledWith("owner", "token", undefined, controller.signal);
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
