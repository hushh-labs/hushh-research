import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  native: false,
  deliveryMode: "inbox_only",
  retry: vi.fn(),
  openSettings: vi.fn(),
  returned: null as (() => void) | null,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => state.native },
}));

vi.mock("@/components/consent/notification-provider", () => ({
  useConsentNotificationState: () => ({
    deliveryMode: state.deliveryMode,
    retryPushRegistration: state.retry,
    isRetryingPushRegistration: false,
  }),
}));

vi.mock("@/lib/morphy-ux/button", () => ({
  Button: ({ children, ...props }: Record<string, unknown>) => (
    <button {...(props as object)}>{children as never}</button>
  ),
}));
vi.mock("@/lib/services/notification-settings-service", () => ({
  NotificationSettingsService: {
    open: state.openSettings,
    onReturn: (callback: () => void) => { state.returned = callback; return () => { state.returned = null; }; },
  },
}));

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
    state.retry.mockReset();
    state.openSettings.mockReset().mockResolvedValue(true);
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

  it("stays out of the way once push works and enables native only on a tap", () => {
    setPermission("default");
    state.deliveryMode = "push_active";
    const { container, rerender } = render(<FeedPushPrompt />);
    expect(container.innerHTML).toBe("");

    state.deliveryMode = "inbox_only";
    state.native = true;
    rerender(<FeedPushPrompt />);
    expect(state.retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(state.retry).toHaveBeenCalledOnce();
  });

  it("opens denied native settings explicitly and rechecks only after returning", async () => {
    state.native = true;
    state.deliveryMode = "push_blocked";
    const request = setPermission("default");
    render(<FeedPushPrompt />);
    expect(state.openSettings).not.toHaveBeenCalled();
    state.returned?.();
    expect(state.retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
    await waitFor(() => expect(state.openSettings).toHaveBeenCalledOnce());
    state.returned?.();
    state.returned?.();
    expect(state.retry).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
  });
});
