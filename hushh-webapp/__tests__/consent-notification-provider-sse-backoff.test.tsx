import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    navigation: { pathname: "/one/setup", search: "" },
    apiFetchStream: vi.fn(),
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
    apiFetchStream: mocks.apiFetchStream,
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

import { ConsentNotificationProvider } from "@/components/consent/notification-provider";

/**
 * The request storm this file exists for.
 *
 * Consent SSE is deliberately switched off in production: the backend answers
 * 410 with CONSENT_SSE_DISABLED and tells the client to use FCM instead. The
 * client discarded the status, treated a settled configuration as a transient
 * blip, and reconnected on a fixed 3-second timer with no cap. Every retry cost
 * two Cloud Run invocations, one logged backend error and one failed
 * api_request_completed metric -- per open tab, forever. The founder's console
 * showed the error count climbing from 79 to 157 while he sat on one screen.
 */

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

function streamResponse(status: number, body: string) {
  return {
    ok: false,
    status,
    body: null,
    text: vi.fn().mockResolvedValue(body),
  };
}

describe("consent SSE stops retrying a permanent refusal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.auth.user = mocks.user;
    mocks.platform = { value: "web", native: false };
    mocks.navigation = { pathname: "/one/setup", search: "" };
    mocks.getState.mockResolvedValue(EMPTY_LOCATION_STATE);
    mocks.getVaultOwnerToken?.mockReturnValue?.("vault-owner-token");
    // Web with notifications never granted -- the default state for a signed-in
    // browser user, and the one that puts the SSE fallback in the path.
    mocks.initializeFCM.mockResolvedValue({ status: "push_not_requested" });
    mocks.prepareFCMListeners.mockResolvedValue(undefined);
    mocks.getPendingConsents?.mockResolvedValue?.({
      ok: true,
      json: vi.fn().mockResolvedValue({ pending: [] }),
    });
  });

  it("gives up after one 410 instead of reconnecting forever", async () => {
    mocks.apiFetchStream.mockResolvedValue(
      streamResponse(
        410,
        JSON.stringify({
          detail: {
            error_code: "CONSENT_SSE_DISABLED",
            message: "Consent SSE is disabled. Use FCM notifications.",
          },
        }),
      ),
    );

    render(
      <ConsentNotificationProvider>
        <div>Setup</div>
      </ConsentNotificationProvider>,
    );

    // Let the first attempt run.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(1);

    // Past the old fixed 3s reconnect and every backoff step after it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(1);
  });

  it("still retries a status that can genuinely recover, then stops", async () => {
    // 503 is transient. The fix must not turn every failure into a give-up --
    // but it must not retry forever either.
    mocks.apiFetchStream.mockResolvedValue(
      streamResponse(503, "service unavailable"),
    );

    render(
      <ConsentNotificationProvider>
        <div>Setup</div>
      </ConsentNotificationProvider>,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });

    // 3s, 6s, 12s, 24s, 48s -> six attempts in total, then silence.
    expect(mocks.apiFetchStream).toHaveBeenCalledTimes(6);
  });
});
