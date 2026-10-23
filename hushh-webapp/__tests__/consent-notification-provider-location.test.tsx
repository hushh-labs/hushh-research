import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
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
  useAuth: () => ({ user: mocks.auth.user }),
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
  useConsentNotificationState,
} from "@/components/consent/notification-provider";
import { markOneLocationGrantUnwatched } from "@/lib/one-location/notifications";
import * as locationNotifications from "@/lib/one-location/notifications";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import type { OneLocationState } from "@/lib/one-location/types";
import { CacheService } from "@/lib/services/cache-service";

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

function renderProvider(children: ReactNode = <div>Settings page</div>) {
  return render(
    <ConsentNotificationProvider>{children}</ConsentNotificationProvider>,
  );
}

async function renderReady(children?: ReactNode) {
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

function dispatchLocation(
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

describe("global One Location Feed-first notification policy", () => {
  it("repairs a transient startup registration failure without prompting again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mocks.initializeFCM.mockResolvedValueOnce({ status: "push_failed", detail: "temporary_network_error" });
    const view = renderProvider();
    try {
      await act(async () => { await Promise.resolve(); });
      expect(mocks.initializeFCM).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(mocks.initializeFCM).toHaveBeenCalledTimes(2);
      expect(mocks.initializeFCM).toHaveBeenLastCalledWith("recipient-user", "firebase-token", { requestPermission: false });
    } finally { view.unmount(); vi.useRealTimers(); }
  });

  it("cancels a pending registration retry when the account signs out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    mocks.initializeFCM.mockResolvedValue({ status: "push_failed" });
    const view = renderProvider();
    try {
      await act(async () => { await Promise.resolve(); });
      mocks.auth.user = null;
      view.rerender(<ConsentNotificationProvider><div /></ConsentNotificationProvider>);
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      expect(mocks.initializeFCM).toHaveBeenCalledTimes(1);
    } finally { view.unmount(); vi.useRealTimers(); }
  });
  function PermissionRequestButton() {
    const notificationState = useConsentNotificationState();
    return (
      <button type="button" onClick={notificationState.retryPushRegistration}>
        Enable notifications
      </button>
    );
  }

  it("requests notification authorization only after an explicit user action", async () => {
    mocks.initializeFCM.mockResolvedValue({
      status: "push_not_requested",
      detail: "permission_default",
    });
    renderProvider(<PermissionRequestButton />);

    await waitFor(() => expect(mocks.initializeFCM).toHaveBeenCalledTimes(1));
    expect(mocks.initializeFCM).toHaveBeenLastCalledWith(
      "recipient-user",
      "firebase-token",
      { requestPermission: false },
    );

    act(() => {
      screen.getByRole("button", { name: "Enable notifications" }).click();
    });

    await waitFor(() => expect(mocks.initializeFCM).toHaveBeenCalledTimes(2));
    expect(mocks.initializeFCM).toHaveBeenLastCalledWith(
      "recipient-user",
      "firebase-token",
      { requestPermission: true },
    );
  });

  it("defers full Location reconciliation until the Location workspace opens", async () => {
    mocks.pathname = "/one/pkm";
    renderProvider();

    await waitFor(() => expect(mocks.initializeFCM).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(mocks.getState).not.toHaveBeenCalled();
  });

  it("records one Feed item without popup UI for duplicate routine pushes", async () => {
    await renderReady();
    const data = {
      type: "location_share_created",
      message_id: "message-live-1",
      grant_id: "grant-live-1",
      owner_display_label: "Alex",
      share_kind: "check_in",
      share_message: "Reached safely",
    };

    dispatchLocation(data);
    dispatchLocation(data);

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.startTask).toHaveBeenCalledTimes(1);
    expect(mocks.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "one_location_share:grant-live-1",
        routeHref: expect.stringContaining("section=shared"),
      }),
    );
    expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledOnce();
  });

  it("treats settings and saved-location pushes as silent sync doorbells", async () => {
    await renderReady();

    dispatchLocation({
      type: "location_settings_changed",
      setting: "map_preferences",
      message_id: "location_settings_changed:event-1",
    });
    dispatchLocation({
      type: "location_pkm_changed",
      domain: "location",
      data_version: "8",
      updated_at: "2026-09-20T00:00:00Z",
      message_id: "location_pkm_changed:event-2",
    });

    expect(mocks.onOneLocationStateMutated).toHaveBeenCalledWith(
      "recipient-user",
      ["map_preferences"],
      {
        notificationType: "location_settings_changed",
        eventId: "location_settings_changed:event-1",
      },
    );
    expect(mocks.onPkmDomainStored).toHaveBeenCalledWith(
      "recipient-user",
      "location",
      {
        eventDataVersion: 8,
        metadataTimestamp: "2026-09-20T00:00:00Z",
        writeThroughMetadata: false,
        eventId: "location_pkm_changed:event-2",
      },
    );
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.startTask).not.toHaveBeenCalled();
    expect(mocks.dispatchFeedStateChanged).not.toHaveBeenCalled();
  });

  it("clears saved-location caches for deletion doorbells", async () => {
    await renderReady();

    dispatchLocation({
      type: "location_pkm_changed",
      domain: "location",
      operation: "cleared",
      data_version: "12",
      message_id: "location_pkm_changed:delete-1",
    });

    expect(mocks.onPkmDomainCleared).toHaveBeenCalledWith(
      "recipient-user",
      "location",
      { eventId: "location_pkm_changed:delete-1" },
    );
    expect(mocks.onPkmDomainStored).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.dispatchFeedStateChanged).not.toHaveBeenCalled();
  });

  it("globally invalidates PKM state when a peer tab broadcasts a change", async () => {
    await renderReady();
    const detail = {
      userId: "recipient-user",
      domain: "location",
      dataVersion: 13,
      updatedAt: "2026-09-20T12:30:00Z",
      operation: "cleared" as const,
    };

    act(() => mocks.remotePkmListener?.(detail));

    expect(mocks.onRemotePkmDomainChanged).toHaveBeenCalledWith(detail);
  });

  it("globally invalidates map preferences when a peer tab broadcasts a change", async () => {
    await renderReady();
    const detail = {
      userId: "recipient-user",
      domains: ["map_preferences" as const],
      changedAt: 123,
      eventId: "map-preferences:remote-1",
    };

    act(() => mocks.remoteLocationStateListener?.(detail));

    expect(mocks.onRemoteOneLocationStateChanged).toHaveBeenCalledWith(detail);
  });

  it("records repeated duration changes for the same grant without a replay identity", async () => {
    await renderReady();
    const data = {
      type: "location_share_duration_changed",
      grant_id: "grant-duration-repeat-1",
      owner_display_label: "Alex",
      notification_title: "Location activity",
      notification_body: "Location sharing duration changed.",
    };

    dispatchLocation(data);
    dispatchLocation(data);

    expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledTimes(2);
  });

  it("publishes ordinary live Location metadata to the shared workspace channel", async () => {
    await renderReady();

    dispatchLocation({
      type: "location_access_request_withdrawn",
      message_id: "request-withdrawn:event-1",
      request_id: "request-withdrawn-1",
      owner_display_label: "Alex",
    });

    expect(mocks.onOneLocationStateMutated).toHaveBeenCalledOnce();
    expect(mocks.onOneLocationStateMutated).toHaveBeenCalledWith(
      "recipient-user",
      ["workspace"],
      {
        notificationType: "location_access_request_withdrawn",
        circleId: undefined,
        eventId: "request-withdrawn:event-1",
      },
    );
  });

  it("queues native location delivery during auth hydration and drains it for the addressed account", async () => {
    mocks.auth.user = null;
    mocks.platform.native = true;
    mocks.platform.value = "ios";
    const view = renderProvider();
    const detail = dispatchLocation({
      type: "location_share_created",
      grant_id: "grant-auth-hydration-1",
      user_id: "recipient-user",
      owner_display_label: "Alex",
    });

    expect(detail.accepted).not.toBe(true);
    expect(mocks.startTask).not.toHaveBeenCalled();

    mocks.auth.user = mocks.user;
    view.rerender(
      <ConsentNotificationProvider>
        <div>Settings page</div>
      </ConsentNotificationProvider>,
    );

    await waitFor(() =>
      expect(mocks.startTask).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "one_location_share:grant-auth-hydration-1",
        }),
      ),
    );
  });

  it("leaves a service-worker location push unaccepted while auth is unavailable", () => {
    mocks.auth.user = null;
    renderProvider();

    const detail = dispatchLocation(
      {
        type: "location_share_created",
        grant_id: "grant-worker-auth-loading-1",
        user_id: "recipient-user",
      },
      { source: "service_worker" },
    );

    expect(detail.accepted).not.toBe(true);
    expect(mocks.startTask).not.toHaveBeenCalled();
    expect(mocks.dispatchFeedStateChanged).not.toHaveBeenCalled();
  });

  it("sanitizes legacy phone suffixes in the Feed record", async () => {
    await renderReady();
    dispatchLocation({
      type: "location_share_created",
      grant_id: "grant-legacy-phone-1",
      owner_display_label: "Hussh Social - ********8014",
      notification_body:
        "Hussh Social - ********8014 shared location access with you.",
    });

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.not.stringContaining("8014"),
      }),
    );
  });

  it("keeps the system fallback retryable when browser audio is blocked, until the grant ends", async () => {
    await renderReady();
    const data = { type: "location_share_created", grant_id: "sms-no-audio", message_id: "sms-no-audio:event", share_kind: "sos" };
    expect(dispatchLocation(data, { source: "service_worker" }).accepted).toBe(false);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(dispatchLocation(data, { source: "service_worker" }).accepted).toBe(false);
    dispatchLocation({ type: "location_share_revoked", grant_id: data.grant_id });
    expect(dispatchLocation(data, { source: "service_worker" }).accepted).toBe(true);
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.playEmergencySmsCue).not.toHaveBeenCalled();
  });

  it.each(["ios", "android"])("uses a single native foreground cue on %s when Web Audio is unavailable, and stops it on revoke/sign-out", async (platform) => {
    mocks.platform.native = true;
    mocks.platform.value = platform;
    const view = renderProvider();
    await waitFor(() => expect(mocks.initializeFCM).toHaveBeenCalled());
    const now = Date.now();
    const data = { type: "location_share_created", grant_id: "native-sms", share_kind: "sos" };
    dispatchLocation(data);
    dispatchLocation(data);
    expect(mocks.playEmergencySmsCue).toHaveBeenCalledTimes(1);
    const options = mocks.playEmergencySmsCue.mock.calls[0][0];
    expect(options).toMatchObject({ userId: "recipient-user", grantId: "native-sms" });
    expect(options.expiresAt).toBeGreaterThan(now);
    expect(options.expiresAt).toBeLessThanOrEqual(Date.now() + 2000);
    dispatchLocation({ type: "location_share_revoked", grant_id: data.grant_id });
    expect(mocks.stopEmergencySmsCue).toHaveBeenCalledWith({ grantId: data.grant_id });
    dispatchLocation(data);
    dispatchLocation({ ...data, grant_id: "expired-native", expires_at: "2000-01-01T00:00:00Z" });
    expect(mocks.playEmergencySmsCue).toHaveBeenCalledTimes(1);
    mocks.auth.user = null;
    view.rerender(<ConsentNotificationProvider><div>Signed out</div></ConsentNotificationProvider>);
    expect(mocks.stopEmergencySmsCue).toHaveBeenCalledWith({});
  });

  it("uses native sound and vibration together without also starting Web Audio", async () => {
    mocks.platform.native = true;
    mocks.platform.value = "ios";
    const sound = vi.spyOn(locationNotifications, "playOneLocationNotificationSound").mockReturnValue(true);
    try {
      await renderReady();
      dispatchLocation({ type: "location_share_created", grant_id: "audible-native", share_kind: "sos" });
      expect(sound).not.toHaveBeenCalled();
      expect(mocks.playEmergencySmsCue).toHaveBeenCalledWith(expect.objectContaining({ grantId: "audible-native" }));
    } finally {
      sound.mockRestore();
    }
  });

  it.each(["2000-01-01T00:00:00Z", "invalid"])("acknowledges stale SMS silently without requesting an OS alarm: %s", async (expires_at) => {
    await renderReady();
    expect(dispatchLocation({ type: "location_share_created", grant_id: "stale-sms", share_kind: "sos", expires_at }, { source: "service_worker" }).accepted).toBe(true);
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.startTask).not.toHaveBeenCalled();
  });

  it("deduplicates and retains terminal precedence when browser storage is unavailable", async () => {
    await renderReady();
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("unavailable"); });
    try {
      const data = { type: "location_share_created", grant_id: "storage-blocked", message_id: "storage-blocked:event", share_kind: "sos" };
      expect(dispatchLocation(data, { source: "service_worker" }).accepted).toBe(false);
      expect(dispatchLocation(data, { source: "service_worker" }).accepted).toBe(false);
      dispatchLocation({ type: "location_share_revoked", grant_id: data.grant_id });
      expect(dispatchLocation(data, { source: "service_worker" }).accepted).toBe(true);
      const delayed = { ...data, grant_id: "ended-before-create", message_id: "ended-before-create:event" };
      dispatchLocation({ type: "location_share_expired", grant_id: delayed.grant_id });
      expect(dispatchLocation(delayed, { source: "service_worker" }).accepted).toBe(true);
      expect(mocks.toast).toHaveBeenCalledTimes(1);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it("retains the emergency SMS foreground alarm as the safety exception", async () => {
    await renderReady();
    dispatchLocation({
      type: "location_share_created",
      grant_id: "grant-sms-emergency-1",
      owner_display_label: "Alex",
      share_kind: "sos",
      share_message: "Come get me",
      notification_profile: "one_location_sms_emergency",
      notification_category: "ONE_LOCATION_SMS_EMERGENCY",
      notification_title: "SMS · Save my soul",
      notification_body: "Alex: Come get me",
    });

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        duration: Infinity,
        className: expect.stringMatching(
          /one-location-emergency-toast.*!bg-red-600.*!text-white/,
        ),
      }),
    );
    const popup = mocks.toast.mock.calls[0]?.[0] as ReactNode;
    render(<>{popup}</>);
    expect(screen.getByRole("alert")).toHaveAttribute(
      "data-one-location-emergency-sms-alert",
    );
    expect(screen.getByText("Emergency SMS")).toBeInTheDocument();
    expect(mocks.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "one_location_share:grant-sms-emergency-1",
        metadata: expect.objectContaining({ shareKind: "sos" }),
      }),
    );
  });

  it.each(["button", "swipe", "open", "unwatch"])("stops the recipient alarm on %s without allowing a replay", async (dismissal) => {
    mocks.platform.native = true;
    mocks.platform.value = "ios";
    await renderReady();
    const data = { type: "location_share_created", grant_id: `dismiss-${dismissal}`, share_kind: "sos" };
    dispatchLocation(data);
    const [popup, options] = mocks.toast.mock.calls[0];
    if (dismissal === "button") {
      render(<>{popup}</>);
      fireEvent.click(screen.getByRole("button", { name: "Dismiss alarm" }));
      expect(mocks.routerPush).not.toHaveBeenCalled();
    } else if (dismissal === "swipe") {
      options.onDismiss();
    } else if (dismissal === "open") {
      locationNotifications.markOneLocationGrantOpened("recipient-user", data.grant_id);
    } else {
      locationNotifications.markOneLocationGrantUnwatched("recipient-user", data.grant_id);
    }
    expect(mocks.stopEmergencySmsCue).toHaveBeenCalledWith({ grantId: data.grant_id });
    if (dismissal === "swipe") {
      // Sonner already owns removal; requesting dismiss again re-enters its callback.
      expect(mocks.toast.dismiss).not.toHaveBeenCalled();
    } else {
      expect(mocks.toast.dismiss).toHaveBeenCalledWith(`one-location-share:${data.grant_id}`);
    }
    dispatchLocation(data);
    expect(mocks.playEmergencySmsCue).toHaveBeenCalledTimes(1);
  });

  it("stops an alarm when another window acknowledges the same recipient's grant", async () => {
    mocks.platform.native = true;
    mocks.platform.value = "ios";
    await renderReady();
    dispatchLocation({ type: "location_share_created", grant_id: "other-window", share_kind: "sos" });
    window.localStorage.setItem("one_location_opened_grants_v1:someone-else", JSON.stringify(["other-window"]));
    window.dispatchEvent(new StorageEvent("storage"));
    expect(mocks.toast.dismiss).not.toHaveBeenCalled();
    window.localStorage.setItem("one_location_opened_grants_v1:recipient-user", JSON.stringify(["other-window"]));
    window.dispatchEvent(new StorageEvent("storage"));
    expect(mocks.stopEmergencySmsCue).toHaveBeenCalledWith({ grantId: "other-window" });
    expect(mocks.toast.dismiss).toHaveBeenCalledWith("one-location-share:other-window");
  });

  it("removes the persistent private alarm popup on sign-out", async () => {
    const view = renderProvider();
    await waitFor(() => expect(mocks.initializeFCM).toHaveBeenCalled());
    dispatchLocation({ type: "location_share_created", grant_id: "private-popup", share_kind: "sos" });
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    mocks.auth.user = null;
    view.rerender(<ConsentNotificationProvider><div>Signed out</div></ConsentNotificationProvider>);
    expect(mocks.toast.dismiss).toHaveBeenCalledWith("one-location-share:private-popup");
  });

  it("does not sound a sender-side SOS echo", async () => {
    mocks.platform.native = true;
    mocks.platform.value = "ios";
    await renderReady();
    dispatchLocation({ type: "location_share_created", grant_id: "sender-echo", share_kind: "sos", owner_user_id: "recipient-user" });
    expect(mocks.playEmergencySmsCue).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("never presents historical reconciliation as a popup", async () => {
    mocks.getState.mockResolvedValue({
      ...EMPTY_LOCATION_STATE,
      receivedGrants: [
        {
          id: "grant-historical-1",
          ownerUserId: "owner-user",
          recipientUserId: "recipient-user",
          ownerDisplayName: "Jordan",
          recipientKeyId: "key-1",
          status: "expired",
          consentScope: "one.location",
          capabilityScopes: [],
          durationHours: 2,
          shareKind: "share",
        },
      ],
    });

    renderProvider();
    await waitFor(() => expect(mocks.getState).toHaveBeenCalled());
    await waitFor(() => expect(mocks.startTask).toHaveBeenCalledTimes(1));

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId:
          "one_location_workflow:location_share_expired:grant-historical-1",
      }),
    );
  });

  it.each(["active", "revoked", "expired"])("reconciles Feed before a live SMS push without reviving a %s share", async (status) => {
    mocks.getState.mockResolvedValue({ ...EMPTY_LOCATION_STATE, receivedGrants: [{
      id: "sms-race", ownerUserId: "owner-user", recipientUserId: "recipient-user",
      ownerDisplayName: "Alex", recipientKeyId: "key-1", status: "active",
      consentScope: "cap.location.live.view", capabilityScopes: [], durationHours: 8,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(), shareKind: "sos",
      latestEnvelopeId: "envelope-sms-race",
    }] });
    renderProvider();
    await waitFor(() => expect(mocks.startTask).toHaveBeenCalledTimes(1));
    expect(mocks.toast).not.toHaveBeenCalled();
    const push = { type: "location_share_created", grant_id: "sms-race",
      owner_display_label: "Alex", share_kind: "sos",
      notification_profile: "one_location_sms_emergency" };
    if (status !== "active") {
      dispatchLocation({ ...push, type: `location_share_${status}`, message_id: `terminal-${status}-event` });
    }
    dispatchLocation(push);
    dispatchLocation(push);
    expect(mocks.toast).toHaveBeenCalledTimes(status === "active" ? 1 : 0);
    expect(mocks.startTask).toHaveBeenCalledTimes(status === "active" ? 1 : 2);
  });

  it.each(["revoked", "expired"])("silences a reconciled %s SMS even while its owner has another active share", async (status) => {
    const grant = {
      ownerUserId: "owner-user", recipientUserId: "recipient-user",
      ownerDisplayName: "Alex", recipientKeyId: "key-1",
      consentScope: "cap.location.live.view", capabilityScopes: [], durationHours: 8,
      expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    };
    mocks.getState.mockResolvedValue({ ...EMPTY_LOCATION_STATE, receivedGrants: [
      { ...grant, id: "ended-sms", status, shareKind: "sos" },
      { ...grant, id: "ordinary-share", status: "active", shareKind: "share", latestEnvelopeId: "ordinary-envelope" },
    ] });
    renderProvider();
    await waitFor(() => expect(mocks.startTask).toHaveBeenCalledTimes(1));
    dispatchLocation({ type: "location_share_created", grant_id: "ended-sms",
      owner_display_label: "Alex", share_kind: "sos",
      notification_profile: "one_location_sms_emergency" });
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.startTask).toHaveBeenCalledTimes(1);
  });

  it("keeps a visibility-race reconciliation silent after refocus", async () => {
    const locationState = {
      ...EMPTY_LOCATION_STATE,
      requests: [
        {
          id: "request-visibility-race-1",
          ownerUserId: "recipient-user",
          requesterUserId: "requester-user",
          requesterDisplayName: "Alex",
          status: "pending",
        },
      ],
    };
    let resolveFirstState!: (state: typeof locationState) => void;
    mocks.getState
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstState = resolve;
          }),
      )
      .mockResolvedValue(locationState);
    const visibilityState = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");

    renderProvider();
    await waitFor(() => expect(mocks.getState).toHaveBeenCalledTimes(1));
    visibilityState.mockReturnValue("hidden");
    await act(async () => resolveFirstState(locationState));
    await waitFor(() => expect(mocks.startTask).toHaveBeenCalledTimes(1));

    visibilityState.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => expect(mocks.getState).toHaveBeenCalledTimes(2));

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.startTask).toHaveBeenCalledTimes(1);
    visibilityState.mockRestore();
  });

  it.each([
    {
      type: "location_access_approved",
      idKey: "grant_id",
      id: "grant-approved-1",
    },
    {
      type: "location_share_shortened",
      idKey: "grant_id",
      id: "grant-shortened-1",
    },
    {
      type: "location_share_duration_changed",
      idKey: "grant_id",
      id: "grant-duration-changed-1",
    },
    {
      type: "location_access_request_withdrawn",
      idKey: "request_id",
      id: "request-withdrawn-1",
    },
    {
      type: "location_circle_member_invite",
      idKey: "invite_id",
      id: "circle-invite-1",
    },
  ])("records $type in Feed without a toast", async ({ type, idKey, id }) => {
    await renderReady();
    dispatchLocation({
      type,
      [idKey]: id,
      ...(type === "location_access_approved"
        ? { request_id: "request-1" }
        : {}),
      owner_display_label: "Alex",
      inviter_display_label: "Alex",
      request_url: `/one/location?event=${id}`,
      notification_title: "Location activity",
      notification_body: "Location activity changed.",
    });

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.startTask).toHaveBeenCalledTimes(1);
    expect(mocks.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: expect.stringContaining(id),
        routeHref: `/one/location?event=${id}`,
      }),
    );
    expect(mocks.dispatchFeedStateChanged).toHaveBeenCalledOnce();
    expect(mocks.dispatchConsentStateChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "one_location_notification",
        notificationType: type,
      }),
    );
  });

  it("does not record a terminal event for an explicitly unwatched grant", async () => {
    markOneLocationGrantUnwatched("recipient-user", "grant-unwatched-1");
    await renderReady();
    dispatchLocation({
      type: "location_share_expired",
      grant_id: "grant-unwatched-1",
      owner_display_label: "Alex",
    });

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.startTask).not.toHaveBeenCalled();
  });

  it.each([
    "location_circle_member_invite",
    "location_circle_member_invite_accepted",
    "location_circle_member_invite_declined",
    "location_circle_member_invite_cancelled",
    "location_circle_code_joined",
    "location_circle_member_added",
    "location_circle_member_removed",
    "location_circle_member_left",
    "location_circle_renamed",
    "location_circle_deleted",
  ])(
    "publishes one authoritative Circle reconciliation for %s",
    async (type) => {
      await renderReady();

      dispatchLocation({
        type,
        message_id: `${type}:event-1`,
        circle_id: "circle-1",
        circle_name: "Family",
        ...(type === "location_circle_member_removed"
          ? { member_user_id: "recipient-user" }
          : null),
        notification_title: "Circle changed",
        notification_body: "Circle state changed.",
      });

      expect(mocks.onOneLocationStateMutated).toHaveBeenCalledTimes(1);
      expect(mocks.onOneLocationStateMutated).toHaveBeenCalledWith(
        "recipient-user",
        ["workspace", "circles", "sms_roster"],
        {
          notificationType: type,
          circleId: "circle-1",
          ...(type === "location_circle_member_removed"
            ? { memberUserId: "recipient-user" }
            : null),
          eventId: `${type}:event-1`,
        },
      );
    },
  );

  it("uses an owner event for sync without showing or recording a self-notification", async () => {
    await renderReady();

    dispatchLocation({
      type: "location_circle_renamed",
      message_id: "location_circle_renamed:event-owner",
      circle_id: "circle-1",
      circle_name: "Family trip",
      sync_only: "true",
      notification_title: "Circle renamed",
      notification_body: "This Circle is now called Family trip.",
    });

    expect(mocks.onOneLocationStateMutated).toHaveBeenCalledTimes(1);
    expect(mocks.dispatchFeedStateChanged).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.startTask).not.toHaveBeenCalled();
  });

  // Without this patch, the counterpart's device only learns of a decline,
  // withdrawal, or approval once the next full `list_state` reload lands
  // (~10s+ on UAT) -- see mergeRequestStatus in one-location-state-resource.ts.
  it.each([
    { type: "location_access_denied", status: "denied" },
    { type: "location_access_request_withdrawn", status: "cancelled" },
    { type: "location_access_approved", status: "approved" },
  ])(
    "patches the cached request's status to $status on $type",
    async ({ type, status }) => {
      await renderReady();
      // Seeded after mount: the provider's own reconcile-on-mount load
      // (mocks.getState) already wrote EMPTY_LOCATION_STATE, so seeding
      // earlier would be overwritten before the push under test fires.
      OneLocationStateResource.write("recipient-user", {
        ...EMPTY_LOCATION_STATE,
        requests: [
          {
            id: "request-outcome-1",
            ownerUserId: "owner-user",
            requesterUserId: "recipient-user",
            status: "pending",
          },
        ],
      } as unknown as OneLocationState);

      dispatchLocation({
        type,
        request_id: "request-outcome-1",
        ...(type === "location_access_approved"
          ? { grant_id: "grant-outcome-1" }
          : {}),
        owner_display_label: "Alex",
        notification_title: "Location activity",
        notification_body: "Location activity changed.",
      });

      expect(
        OneLocationStateResource.peek("recipient-user")?.data.requests[0],
      ).toMatchObject({ id: "request-outcome-1", status });
    },
  );

  it("patches an approval before broadcasting its authoritative refresh", async () => {
    await renderReady();
    OneLocationStateResource.write("recipient-user", {
      ...EMPTY_LOCATION_STATE,
      requests: [
        {
          id: "request-approval-order-1",
          ownerUserId: "owner-user",
          requesterUserId: "recipient-user",
          status: "pending",
        },
      ],
    } as unknown as OneLocationState);
    mocks.onOneLocationStateMutated.mockImplementationOnce(() => {
      expect(
        OneLocationStateResource.peek("recipient-user")?.data.requests[0],
      ).toMatchObject({
        id: "request-approval-order-1",
        status: "approved",
        approvedGrantId: "grant-approval-order-1",
      });
    });

    dispatchLocation({
      type: "location_access_approved",
      request_id: "request-approval-order-1",
      grant_id: "grant-approval-order-1",
      owner_display_label: "Alex",
      notification_title: "Location approved",
      notification_body: "Alex approved your request.",
    });

    expect(mocks.onOneLocationStateMutated).toHaveBeenCalledOnce();
  });

  it("leaves cached state untouched when it has no row for the pushed request", async () => {
    await renderReady();
    OneLocationStateResource.write(
      "recipient-user",
      EMPTY_LOCATION_STATE as OneLocationState,
    );

    dispatchLocation({
      type: "location_access_denied",
      request_id: "request-unknown-1",
      owner_display_label: "Alex",
      notification_title: "Location activity",
      notification_body: "Location activity changed.",
    });

    expect(
      OneLocationStateResource.peek("recipient-user")?.data.requests,
    ).toEqual([]);
  });
});
