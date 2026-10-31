import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deletePushToken: vi.fn(),
  unregisterPushToken: vi.fn(),
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  getToken: vi.fn(),
  addListener: vi.fn(),
  registerPushToken: vi.fn(),
  getNotificationSettings: vi.fn(),
  requestAlarm: vi.fn(),
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

vi.mock("@/lib/capacitor", () => ({ HushhNotifications: { deletePushToken: mocks.deletePushToken, getNotificationSettings: mocks.getNotificationSettings, requestEmergencySmsAlarmPermission: mocks.requestAlarm } }));
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
    mocks.getNotificationSettings.mockResolvedValue({ alertsEnabled: true, soundsEnabled: true, emergencySoundEnabled: true });
    mocks.requestAlarm.mockResolvedValue({ supported: true, authorized: true });
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
    expect(mocks.requestAlarm).not.toHaveBeenCalled();
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it("requests authorization and registers only after an explicit action", async () => {
    await expect(
      initializeFCM("user-1", "id-token", { requestPermission: true }),
    ).resolves.toEqual({ status: "push_active" });

    expect(mocks.requestPermissions).toHaveBeenCalledOnce();
    expect(mocks.requestAlarm).toHaveBeenCalledOnce();
    expect(mocks.getToken).toHaveBeenCalledOnce();
    expect(mocks.registerPushToken).toHaveBeenCalledWith(
      "user-1",
      "test-token",
      "ios",
      "id-token",
      expect.any(Function),
    );
  });
  it("retains generic registration but reports unavailable native chat custody for retry", async () => {
    mocks.checkPermissions.mockResolvedValue({ receive: "granted" });
    mocks.registerPushToken.mockResolvedValueOnce({
      ok: true,
      clone: () => ({ json: async () => ({ registered: true, chatReady: false }) }),
    });
    await expect(initializeFCM("user-1", "id-token")).resolves.toEqual({ status: "push_failed", detail: "native_chat_key_unavailable" });
    expect(mocks.registerPushToken).toHaveBeenCalledOnce();
    expect(mocks.requestPermissions).not.toHaveBeenCalled();
  });
  it.each([
    [{ chatAlertsEnabled: false, chatSoundsEnabled: true }, "native_chat_alerts_disabled"],
    [{ chatAlertsEnabled: true, chatSoundsEnabled: false }, "native_chat_sound_disabled"],
  ])("checks chat channel readiness independently of activity alerts: %s", async (chatSettings, detail) => {
    mocks.checkPermissions.mockResolvedValue({ receive: "granted" });
    mocks.getNotificationSettings.mockResolvedValue({ alertsEnabled: true, soundsEnabled: true, emergencySoundEnabled: true, ...chatSettings });
    await expect(initializeFCM("user-1", "id-token")).resolves.toEqual({ status: "push_active", detail });
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
  it("reports quiet OS sound settings without discarding the valid registration", async () => {
    mocks.checkPermissions.mockResolvedValue({ receive: "granted" });
    mocks.getNotificationSettings.mockResolvedValue({ alertsEnabled: true, soundsEnabled: false, emergencySoundEnabled: false });
    await expect(initializeFCM("user-1", "id-token")).resolves.toEqual({ status: "push_active", detail: "native_sound_disabled" });
    expect(mocks.registerPushToken).toHaveBeenCalledOnce();
    expect(mocks.requestPermissions).not.toHaveBeenCalled();
  });
  it("refreshes a native token through its authenticated session when web auth differs", async () => {
    mocks.checkPermissions.mockResolvedValue({ receive: "granted" });
    const getIdToken = vi.fn().mockResolvedValue("fresh-native-proof");
    await initializeFCM("user-1", "id-token", { getIdToken });
    mocks.currentUser.uid = "unrelated-web-session";
    await mocks.listeners.get("tokenReceived")!({ token: "rotated-token" });
    expect(getIdToken).toHaveBeenCalledOnce();
    expect(mocks.registerPushToken).toHaveBeenLastCalledWith("user-1", "test-token", "ios", "fresh-native-proof", expect.any(Function));
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

  it("does not register the previous owner when its delayed native identity proof resolves", async () => {
    mocks.checkPermissions.mockResolvedValue({ receive: "granted" });
    let resolveProof!: (proof: string) => void;
    const getIdToken = vi.fn(() => new Promise<string>((resolve) => { resolveProof = resolve; }));
    await initializeFCM("old-account", "old-proof", { getIdToken });
    const refresh = mocks.listeners.get("tokenReceived")!({ token: "rotated-token" });
    await vi.waitFor(() => expect(getIdToken).toHaveBeenCalledOnce());
    await initializeFCM("new-account", "new-proof");
    mocks.registerPushToken.mockClear();
    resolveProof("stale-owner-proof");
    await refresh;
    expect(mocks.registerPushToken).not.toHaveBeenCalled();
  });

});
