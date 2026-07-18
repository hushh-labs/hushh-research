import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ConsentNotificationProvider,
  useConsentNotificationState,
} from "@/components/consent/notification-provider";
import { FCM_MESSAGE_EVENT, initializeFCM } from "@/lib/notifications";
import { ApiService } from "@/lib/services/api-service";

const {
  apiFetchStreamMock,
  clearDeliveredConsentNotificationsMock,
  getIdTokenMock,
  getVaultOwnerTokenMock,
  handleDenyMock,
  initializeFCMMock,
  pushMock,
  replaceMock,
  toastDismissMock,
  toastMock,
} = vi.hoisted(() => ({
  apiFetchStreamMock: vi.fn(),
  clearDeliveredConsentNotificationsMock: vi.fn(),
  getIdTokenMock: vi.fn(),
  getVaultOwnerTokenMock: vi.fn(),
  handleDenyMock: vi.fn(),
  initializeFCMMock: vi.fn(),
  pushMock: vi.fn(),
  replaceMock: vi.fn(),
  toastDismissMock: vi.fn(),
  toastMock: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => false,
  },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/consents",
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
  }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(toastMock, {
    dismiss: toastDismissMock,
  }),
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: {
      uid: "user_private_123",
      getIdToken: getIdTokenMock,
    },
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: true,
    getVaultOwnerToken: getVaultOwnerTokenMock,
  }),
}));

vi.mock("@/lib/consent", () => ({
  useConsentActions: () => ({
    handleDeny: handleDenyMock,
  }),
}));

vi.mock("@/lib/notifications", () => ({
  initializeFCM: initializeFCMMock,
  clearDeliveredConsentNotifications: clearDeliveredConsentNotificationsMock,
  FCM_MESSAGE_EVENT: "fcm-message",
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    apiFetchStream: apiFetchStreamMock,
    getPendingConsents: vi.fn(),
    markPendingConsentOpened: vi.fn(),
  },
}));

function ConsentStateProbe() {
  const state = useConsentNotificationState();

  return (
    <output data-testid="consent-notification-state">
      {JSON.stringify({
        deliveryMode: state.deliveryMode,
        deliveryDetail: state.deliveryDetail,
        pendingCount: state.pendingCount,
      })}
    </output>
  );
}

function currentConsentState() {
  return JSON.parse(
    screen.getByTestId("consent-notification-state").textContent || "{}",
  ) as {
    deliveryMode?: string;
    deliveryDetail?: string | null;
    pendingCount?: number;
  };
}

describe("ConsentNotificationProvider network fail-safe behavior", () => {
  const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  beforeEach(() => {
    vi.clearAllMocks();
    getIdTokenMock.mockResolvedValue("private_id_token_123");
    getVaultOwnerTokenMock.mockReturnValue("private_vault_owner_token_123");
    initializeFCMMock.mockResolvedValue({
      status: "push_failed",
      detail: "network_timeout",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("defaults to zero pending tracking when consent delivery falls back after a dropped stream", async () => {
    apiFetchStreamMock.mockRejectedValue(new Error("consent_sse_failed"));

    render(
      <ConsentNotificationProvider>
        <ConsentStateProbe />
      </ConsentNotificationProvider>,
    );

    await waitFor(() => {
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "[NotificationProvider] Consent SSE fallback failed:",
        expect.any(Error),
      );
    });

    expect(currentConsentState()).toMatchObject({
      deliveryMode: "inbox_only",
      deliveryDetail: "consent_sse_failed",
      pendingCount: 0,
    });
    expect(toastMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("logs consent fallback network errors without exposing raw user parameters", async () => {
    apiFetchStreamMock.mockRejectedValue(new Error("timeout"));

    render(
      <ConsentNotificationProvider>
        <ConsentStateProbe />
      </ConsentNotificationProvider>,
    );

    await waitFor(() => {
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        "[NotificationProvider] Consent SSE fallback failed:",
        expect.any(Error),
      );
    });

    const loggedText = [
      ...consoleWarnSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
      ...consoleInfoSpy.mock.calls,
    ]
      .flat()
      .map((value) => (value instanceof Error ? value.message : String(value)))
      .join(" ");

    expect(loggedText).toContain("Consent SSE fallback failed");
    expect(loggedText).not.toContain("user_private_123");
    expect(loggedText).not.toContain("private_id_token_123");
    expect(loggedText).not.toContain("private_vault_owner_token_123");
    expect(ApiService.apiFetchStream).toHaveBeenCalledWith(
      "/api/consent/events/user_private_123",
      expect.objectContaining({
        cache: "no-store",
        method: "GET",
      }),
    );
    expect(FCM_MESSAGE_EVENT).toBe("fcm-message");
    expect(initializeFCM).toHaveBeenCalledWith(
      "user_private_123",
      "private_id_token_123",
    );
  });
});
