import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  native: false,
  deliveryMode: "inbox_only",
  deliveryDetail: null as string | null,
  retry: vi.fn(),
  openSettings: vi.fn(),
  requestAlarm: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => state.native },
}));

vi.mock("@/components/consent/notification-provider", () => ({
  useConsentNotificationState: () => ({
    deliveryMode: state.deliveryMode,
    deliveryDetail: state.deliveryDetail,
    retryPushRegistration: state.retry,
    isRetryingPushRegistration: false,
  }),
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children, ...props }: Record<string, unknown>) => (
    <button {...(props as object)}>{children as never}</button>
  ),
}));

vi.mock("@/lib/services/notification-settings-service", () => ({ NotificationSettingsService: { open: state.openSettings } }));
vi.mock("@/lib/capacitor", () => ({ HushhNotifications: { requestEmergencySmsAlarmPermission: state.requestAlarm } }));

import { FeedPushPrompt } from "@/components/feed/feed-push-prompt";

function setPermission(permission: NotificationPermission) {
  const requestPermission = vi.fn(async () => "granted" as const);
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: { permission, requestPermission },
  });
  return requestPermission;
}

describe("FeedPushPrompt", () => {
  beforeEach(() => {
    state.native = false;
    state.deliveryMode = "inbox_only";
    state.deliveryDetail = null;
    state.retry.mockReset();
    state.openSettings.mockReset();
    state.requestAlarm.mockReset().mockResolvedValue({ supported: true, authorized: true });
  });
  afterEach(() => {
    Reflect.deleteProperty(window, "Notification");
  });

  it("asks the browser inside the tap, then registers this device", async () => {
    const requestPermission = setPermission("default");
    render(<FeedPushPrompt />);

    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));

    await waitFor(() => expect(state.retry).toHaveBeenCalledTimes(1));
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("explains a blocked browser instead of offering a dead button", async () => {
    setPermission("denied");
    render(<FeedPushPrompt />);
    expect(await screen.findByText(/blocked for One/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("stays out of the way once push works", () => {
    setPermission("default");
    state.deliveryMode = "push_active";
    const { container, rerender } = render(<FeedPushPrompt />);
    expect(container.innerHTML).toBe("");

    rerender(<FeedPushPrompt />);
    expect(container.innerHTML).toBe("");
  });
  it("offers registration retry after permission is granted but delivery failed", async () => {
    const requestPermission = setPermission("granted");
    render(<FeedPushPrompt context="chat" />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(state.retry).toHaveBeenCalledOnce();
    expect(requestPermission).not.toHaveBeenCalled();
  });
  it("provides native authorization and settings recovery", async () => {
    state.native = true;
    const { rerender } = render(<FeedPushPrompt />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(state.retry).toHaveBeenCalledOnce();
    state.deliveryMode = "push_blocked";
    rerender(<FeedPushPrompt />);
    fireEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    await waitFor(() => expect(state.openSettings).toHaveBeenCalledOnce());
  });
  it("does not hide quiet OS settings behind a successfully registered token", async () => {
    state.native = true;
    state.deliveryMode = "push_active";
    state.deliveryDetail = "native_sound_disabled";
    render(<FeedPushPrompt context="location" />);
    expect(await screen.findByText(/Device alerts or sounds are off/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Open settings" }));
    await waitFor(() => expect(state.openSettings).toHaveBeenCalled());
    expect(state.retry).not.toHaveBeenCalled();
  });

  it("offers SMS alarm permission separately when ordinary push already works", async () => {
    state.native = true;
    state.deliveryMode = "push_active";
    state.deliveryDetail = "native_emergency_alarm_not_authorized";
    render(<FeedPushPrompt context="location" />);
    expect(state.requestAlarm).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Allow alarms" }));
    await waitFor(() => expect(state.requestAlarm).toHaveBeenCalledOnce());
    expect(state.retry).toHaveBeenCalledOnce();
  });

  it.each(["native_chat_alerts_disabled", "native_chat_sound_disabled"])(
    "scopes %s recovery to chat while other channels remain enabled",
    async (detail) => {
      state.native = true;
      state.deliveryMode = "push_active";
      state.deliveryDetail = detail;
      const { rerender } = render(<FeedPushPrompt />);
      expect(screen.queryByRole("status")).toBeNull();
      rerender(<FeedPushPrompt context="location" />);
      expect(screen.queryByRole("status")).toBeNull();

      rerender(<FeedPushPrompt context="chat" />);
      fireEvent.click(await screen.findByRole("button", { name: "Open settings" }));
      await waitFor(() => expect(state.openSettings).toHaveBeenCalledOnce());
      expect(state.retry).not.toHaveBeenCalled();
    },
  );
});
