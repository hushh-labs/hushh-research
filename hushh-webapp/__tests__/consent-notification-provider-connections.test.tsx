import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { dismiss: vi.fn() });
  const user = {
    uid: "recipient-user",
    getIdToken: vi.fn().mockResolvedValue("firebase-token"),
  };
  return {
    toast,
    user,
    auth: { user: user as typeof user | null },
    platform: { value: "web", native: false },
    initializeFCM: vi.fn(),
    prepareFCMListeners: vi.fn(),
    getState: vi.fn(),
    getVaultOwnerToken: vi.fn(),
    onConsentMutated: vi.fn(),
    dispatchConsentStateChanged: vi.fn(),
    dispatchFeedStateChanged: vi.fn(),
    markPendingConsentOpened: vi.fn(),
    navigation: { pathname: "/settings", search: "" },
    vault: { unlocked: true, token: "vault-owner-token" },
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.navigation.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.navigation.search),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => mocks.platform.native,
    getPlatform: () => mocks.platform.value,
  },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.auth.user }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: mocks.vault.unlocked,
    getVaultOwnerToken: mocks.getVaultOwnerToken,
  }),
}));

vi.mock("@/lib/notifications", () => ({
  initializeFCM: mocks.initializeFCM,
  prepareFCMListeners: mocks.prepareFCMListeners,
  clearDeliveredConsentNotifications: vi.fn(),
  FCM_MESSAGE_EVENT: "fcm-message",
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: { getState: mocks.getState },
}));

vi.mock("@/lib/services/api-service", () => ({
  ApiService: {
    getPendingConsents: vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ pending: [] }),
    }),
    markPendingConsentOpened: mocks.markPendingConsentOpened,
  },
}));

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    startTask: vi.fn(),
    completeTask: vi.fn(),
    dismissTask: vi.fn(),
  },
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onConsentMutated: mocks.onConsentMutated,
    onConsentReviewed: vi.fn(),
  },
}));

vi.mock("@/lib/consent/consent-events", () => ({
  CONSENT_STATE_CHANGED_EVENT: "consent-state-changed",
  dispatchConsentStateChanged: mocks.dispatchConsentStateChanged,
}));

vi.mock("@/lib/feed/feed-events", () => ({
  dispatchFeedStateChanged: mocks.dispatchFeedStateChanged,
}));

import {
  ConsentNotificationProvider,
  usePendingConsentCount,
} from "@/components/consent/notification-provider";

const EMPTY_LOCATION_STATE = {
  recipients: [],
  ownerGrants: [],
  receivedGrants: [],
  requests: [],
  referrals: [],
  publicInvites: [],
  networkConnections: [],
  publicInviteSubmissions: [],
  capabilityScopes: [],
};

async function renderProvider() {
  render(
    <ConsentNotificationProvider>
      <div>Settings page</div>
      <PendingCount />
    </ConsentNotificationProvider>,
  );
  await waitFor(() => expect(mocks.initializeFCM).toHaveBeenCalledOnce());
  await waitFor(() => expect(mocks.getState).toHaveBeenCalled());
  mocks.toast.mockClear();
  mocks.onConsentMutated.mockClear();
  mocks.dispatchConsentStateChanged.mockClear();
  mocks.dispatchFeedStateChanged.mockClear();
}

function PendingCount() {
  return <div data-testid="pending-count">{usePendingConsentCount()}</div>;
}

function dispatchConnectionRequest(data: Record<string, string>) {
  const detail: {
    data: Record<string, string>;
    accepted?: boolean;
  } = { data: { type: "connection_request", ...data } };
  act(() => {
    window.dispatchEvent(
      new CustomEvent("fcm-message", {
        detail,
      }),
    );
  });
  return detail;
}

function dispatchConnectionRequestResolved(data: Record<string, string>) {
  const detail: {
    data: Record<string, string>;
    accepted?: boolean;
  } = { data: { type: "connection_request_resolved", ...data } };
  act(() => {
    window.dispatchEvent(
      new CustomEvent("fcm-message", {
        detail,
      }),
    );
  });
  return detail;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.clearAllMocks();
  mocks.auth.user = mocks.user;
  mocks.platform.native = false;
  mocks.platform.value = "web";
  mocks.navigation.pathname = "/settings";
  mocks.navigation.search = "";
  mocks.vault.unlocked = true;
  mocks.vault.token = "vault-owner-token";
  mocks.getVaultOwnerToken.mockImplementation(() => mocks.vault.token);
  mocks.prepareFCMListeners.mockResolvedValue(undefined);
  mocks.initializeFCM.mockResolvedValue({ status: "push_active" });
  mocks.getState.mockResolvedValue(EMPTY_LOCATION_STATE);
  mocks.markPendingConsentOpened.mockResolvedValue(undefined);
});

describe("connection-request Feed-first foreground policy", () => {
  it.each([
    { platform: "web", native: false },
    { platform: "ios", native: true },
    { platform: "android", native: true },
  ])(
    "refreshes Feed without a $platform popup",
    async ({ platform, native }) => {
      mocks.platform.value = platform;
      mocks.platform.native = native;
      await renderProvider();

      const detail = dispatchConnectionRequest({
        user_id: "recipient-user",
        requester_user_id: "requester-user",
        requester_label: "Rohan",
        request_id: "conn-req-1",
      });

      expect(mocks.toast).not.toHaveBeenCalled();
      expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledOnce();
      expect(mocks.onConsentMutated).toHaveBeenCalledWith("recipient-user");
      expect(mocks.dispatchConsentStateChanged).toHaveBeenCalledWith({
        source: "fcm_connection_request",
        reconcile: true,
      });
      expect(detail.accepted).toBe(true);
    },
  );

  it("drops a payload addressed to a different signed-in user", async () => {
    await renderProvider();
    const detail = dispatchConnectionRequest({
      user_id: "someone-else",
      request_id: "conn-req-1",
    });

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.dispatchFeedStateChanged).not.toHaveBeenCalled();
    expect(mocks.onConsentMutated).not.toHaveBeenCalled();
    expect(detail.accepted).not.toBe(true);
  });

  it("does not accept a foreground push while signed out", () => {
    mocks.auth.user = null;
    render(
      <ConsentNotificationProvider>
        <div>Signed out</div>
      </ConsentNotificationProvider>,
    );

    const detail = dispatchConnectionRequest({
      user_id: "recipient-user",
      request_id: "conn-req-signed-out",
    });

    expect(detail.accepted).not.toBe(true);
    expect(mocks.dispatchFeedStateChanged).not.toHaveBeenCalled();
    expect(mocks.onConsentMutated).not.toHaveBeenCalled();
  });

  it("deduplicates an exact retry but accepts a new notification sequence", async () => {
    await renderProvider();
    const initial = {
      request_id: "conn-req-1",
      notification_sequence: "1",
    };

    dispatchConnectionRequest(initial);
    dispatchConnectionRequest(initial);
    dispatchConnectionRequest({
      ...initial,
      notification_sequence: "2",
    });

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledTimes(2);
    expect(mocks.onConsentMutated).toHaveBeenCalledTimes(2);
  });

  it("keeps a consent request in Feed and the Consent Center without a popup", async () => {
    await renderProvider();
    act(() => {
      window.dispatchEvent(
        new CustomEvent("fcm-message", {
          detail: {
            data: {
              type: "consent_request",
              user_id: "recipient-user",
              request_id: "consent-1",
              requester_label: "Example developer",
              scope: "attr.financial.*",
            },
          },
        }),
      );
    });

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledOnce();
    expect(mocks.onConsentMutated).toHaveBeenCalledWith("recipient-user");
    expect(mocks.dispatchConsentStateChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "fcm_live",
        requestId: "consent-1",
        reconcile: true,
      }),
    );
  });

  it("leaves a malformed consent payload unacknowledged for system fallback", async () => {
    await renderProvider();
    const detail: {
      source: "service_worker";
      data: Record<string, string>;
      accepted?: boolean;
    } = {
      source: "service_worker",
      data: {
        type: "consent_request",
        user_id: "recipient-user",
        requester_label: "Example developer",
        // request_id is mandatory for an actionable consent.
      },
    };

    act(() => {
      window.dispatchEvent(new CustomEvent("fcm-message", { detail }));
    });

    expect(detail.accepted).not.toBe(true);
    expect(mocks.dispatchFeedStateChanged).not.toHaveBeenCalled();
    expect(mocks.onConsentMutated).not.toHaveBeenCalled();
    expect(mocks.dispatchConsentStateChanged).not.toHaveBeenCalled();
  });

  it("re-ingests a final reminder without double-counting one pending request", async () => {
    await renderProvider();
    const dispatchConsent = (sequence: string) => {
      act(() => {
        window.dispatchEvent(
          new CustomEvent("fcm-message", {
            detail: {
              data: {
                type: "consent_request",
                user_id: "recipient-user",
                request_id: "consent-1",
                notification_sequence: sequence,
                requester_label: "Example developer",
                scope: "attr.financial.*",
              },
            },
          }),
        );
      });
    };

    dispatchConsent("1");
    dispatchConsent("2");

    expect(screen.getByTestId("pending-count")).toHaveTextContent("1");
    expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledTimes(2);
  });

  it("acknowledges a consent notification body tap from Feed", async () => {
    mocks.navigation.pathname = "/one/feed";
    mocks.navigation.search =
      "notificationRequestId=consent-1&notificationBundleId=bundle-1";

    render(
      <ConsentNotificationProvider>
        <div>Feed page</div>
      </ConsentNotificationProvider>,
    );

    await waitFor(() =>
      expect(mocks.markPendingConsentOpened).toHaveBeenCalledWith({
        userId: "recipient-user",
        vaultOwnerToken: "vault-owner-token",
        requestId: "consent-1",
        bundleId: "bundle-1",
        openedVia: "deep_link",
      }),
    );
  });

  it("retries a transient consent notification acknowledgement failure", async () => {
    mocks.navigation.pathname = "/one/feed";
    mocks.navigation.search = "notificationRequestId=consent-retry";
    mocks.markPendingConsentOpened
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    render(
      <ConsentNotificationProvider>
        <div>Feed page</div>
      </ConsentNotificationProvider>,
    );

    await waitFor(
      () => expect(mocks.markPendingConsentOpened).toHaveBeenCalledTimes(2),
      { timeout: 2_500 },
    );
    expect(mocks.markPendingConsentOpened).toHaveBeenLastCalledWith({
      userId: "recipient-user",
      vaultOwnerToken: "vault-owner-token",
      requestId: "consent-retry",
      bundleId: undefined,
      openedVia: "deep_link",
    });
  });

  it("refreshes Feed for an unrecognized future notification family", async () => {
    await renderProvider();
    act(() => {
      window.dispatchEvent(
        new CustomEvent("fcm-message", {
          detail: {
            data: {
              type: "future_notification_type",
              user_id: "recipient-user",
              message_id: "future-1",
            },
          },
        }),
      );
    });

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledOnce();
    expect(mocks.onConsentMutated).not.toHaveBeenCalled();
  });

  describe("connection-request-resolved (#6507)", () => {
    // The requester learning their OWN request was accepted/declined --
    // previously not pushed at all, so this branch did not exist. Same
    // Feed-first shape as the sibling connection_request tests above.
    it.each([
      { accepted: "true", label: "accepted" },
      { accepted: "false", label: "declined" },
    ])(
      "refreshes Feed and invalidates consent cache when $label",
      async ({ accepted }) => {
        await renderProvider();

        const detail = dispatchConnectionRequestResolved({
          user_id: "recipient-user",
          resolver_user_id: "resolver-user",
          resolver_label: "Rohan",
          request_id: "conn-req-1",
          accepted,
        });

        expect(mocks.toast).not.toHaveBeenCalled();
        expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledOnce();
        expect(mocks.onConsentMutated).toHaveBeenCalledWith("recipient-user");
        expect(mocks.dispatchConsentStateChanged).toHaveBeenCalledWith({
          source: "fcm_connection_request_resolved",
          reconcile: true,
        });
        expect(detail.accepted).toBe(true);
      },
    );

    it("drops a payload addressed to a different signed-in user", async () => {
      await renderProvider();
      const detail = dispatchConnectionRequestResolved({
        user_id: "someone-else",
        request_id: "conn-req-1",
        accepted: "true",
      });

      expect(mocks.toast).not.toHaveBeenCalled();
      expect(mocks.dispatchFeedStateChanged).not.toHaveBeenCalled();
      expect(mocks.onConsentMutated).not.toHaveBeenCalled();
      expect(detail.accepted).not.toBe(true);
    });
  });
});
