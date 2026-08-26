import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  getToken: vi.fn(),
  addListener: vi.fn(),
  registerPushToken: vi.fn(),
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
  },
}));

import { initializeFCM } from "@/lib/notifications/fcm-service";

describe("native FCM permission ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.addListener.mockResolvedValue({ remove: vi.fn() });
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
});
