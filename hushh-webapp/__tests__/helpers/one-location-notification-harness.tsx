import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const toast = Object.assign(vi.fn(), { dismiss: vi.fn() });
  const user = {
    uid: "recipient-user",
    getIdToken: vi.fn().mockResolvedValue("firebase-token"),
  };
  return {
    toast,
    user,
    auth: {
      user: user as typeof user | null,
    },
    platform: {
      native: false,
      value: "web",
    },
    routerPush: vi.fn(),
    pathname: "/one/location",
    initializeFCM: vi.fn(),
    prepareFCMListeners: vi.fn(),
    playEmergencySmsCue: vi.fn().mockResolvedValue({ played: true }),
    stopEmergencySmsCue: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn(),
    startTask: vi.fn(),
    completeTask: vi.fn(),
    dispatchConsentStateChanged: vi.fn(),
    dispatchFeedStateChanged: vi.fn(),
    onOneLocationStateMutated: vi.fn(),
    onPkmDomainStored: vi.fn(),
    onPkmDomainCleared: vi.fn(),
    onRemotePkmDomainChanged: vi.fn(),
    onRemoteOneLocationStateChanged: vi.fn(),
    remotePkmListener: null as
      | ((detail: {
          userId: string;
          domain: string;
          dataVersion: number | null;
          updatedAt: string | null;
          operation: "stored" | "cleared" | "restored";
        }) => void)
      | null,
    remoteLocationStateListener: null as
      | ((detail: {
          userId: string;
          domains: Array<
            "workspace" | "circles" | "sms_roster" | "map_preferences"
          >;
          changedAt: number;
          eventId?: string;
        }) => void)
      | null,
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ push: mocks.routerPush, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

vi.mock("@capacitor/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@capacitor/core")>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => mocks.platform.native,
      getPlatform: () => mocks.platform.value,
    },
  };
});

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: mocks.auth.user, userId: mocks.auth.user?.uid ?? null }),
}));

vi.mock("@/lib/capacitor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/capacitor")>();
  return {
    ...actual,
    HushhNotifications: {
      ...actual.HushhNotifications,
      playEmergencySmsCue: mocks.playEmergencySmsCue,
      stopEmergencySmsCue: mocks.stopEmergencySmsCue,
    },
  };
});

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: true,
    getVaultOwnerToken: () => "vault-owner-token",
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
    markPendingConsentOpened: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/services/app-background-task-service", () => ({
  AppBackgroundTaskService: {
    startTask: mocks.startTask,
    completeTask: mocks.completeTask,
    dismissTask: vi.fn(),
  },
}));

vi.mock("@/lib/feed/feed-events", () => ({
  dispatchFeedStateChanged: mocks.dispatchFeedStateChanged,
}));

vi.mock("@/lib/cache/cache-sync-service", () => ({
  CacheSyncService: {
    onOneLocationStateMutated: mocks.onOneLocationStateMutated,
    onPkmDomainStored: mocks.onPkmDomainStored,
    onPkmDomainCleared: mocks.onPkmDomainCleared,
    onRemotePkmDomainChanged: mocks.onRemotePkmDomainChanged,
    onRemoteOneLocationStateChanged: mocks.onRemoteOneLocationStateChanged,
  },
}));

vi.mock("@/lib/pkm/pkm-domain-change-events", () => ({
  subscribeToRemotePkmDomainChanges: vi.fn((listener) => {
    mocks.remotePkmListener = listener;
    return () => {
      mocks.remotePkmListener = null;
    };
  }),
}));

vi.mock("@/lib/one-location/one-location-state-events", () => ({
  subscribeToRemoteOneLocationStateChanges: vi.fn((listener) => {
    mocks.remoteLocationStateListener = listener;
    return () => {
      mocks.remoteLocationStateListener = null;
    };
  }),
}));

vi.mock("@/lib/consent/consent-events", () => ({
  CONSENT_STATE_CHANGED_EVENT: "consent-state-changed",
  dispatchConsentStateChanged: mocks.dispatchConsentStateChanged,
}));

import {
  ConsentNotificationProvider,
} from "@/components/consent/notification-provider";
import { CacheService } from "@/lib/services/cache-service";

export const EMPTY_LOCATION_STATE = {
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

export function renderProvider(children: ReactNode = <div>Settings page</div>) {
  return render(
    <ConsentNotificationProvider>{children}</ConsentNotificationProvider>,
  );
}

export async function renderReady(children?: ReactNode) {
  renderProvider(children);
  await waitFor(() => expect(mocks.initializeFCM).toHaveBeenCalled());
  await waitFor(() => expect(mocks.getState).toHaveBeenCalled());
  mocks.toast.mockClear();
  mocks.startTask.mockClear();
  mocks.completeTask.mockClear();
  mocks.dispatchConsentStateChanged.mockClear();
  mocks.dispatchFeedStateChanged.mockClear();
  mocks.onOneLocationStateMutated.mockClear();
  mocks.onPkmDomainStored.mockClear();
  mocks.onPkmDomainCleared.mockClear();
  mocks.onRemotePkmDomainChanged.mockClear();
  mocks.onRemoteOneLocationStateChanged.mockClear();
}

export function dispatchLocation(
  data: Record<string, string>,
  options: { source?: "service_worker" } = {},
) {
  const detail: {
    notification: { title: string | undefined; body: string | undefined };
    data: Record<string, string>;
    source?: "service_worker";
    accepted?: boolean;
  } = {
    notification: {
      title: data.notification_title,
      body: data.notification_body,
    },
    data,
    ...options,
  };
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
  CacheService.getInstance().clear();
  vi.clearAllMocks();
  mocks.auth.user = mocks.user;
  mocks.pathname = "/one/location";
  mocks.platform.native = false;
  mocks.platform.value = "web";
  mocks.prepareFCMListeners.mockResolvedValue(undefined);
  mocks.initializeFCM.mockResolvedValue({ status: "push_active" });
  mocks.getState.mockResolvedValue(EMPTY_LOCATION_STATE);
  mocks.remotePkmListener = null;
});

export const notificationMocks = mocks;
