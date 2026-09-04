import { act, render, screen, waitFor } from "@testing-library/react";
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
    initializeFCM: vi.fn(),
    prepareFCMListeners: vi.fn(),
    getState: vi.fn(),
    startTask: vi.fn(),
    completeTask: vi.fn(),
    dispatchConsentStateChanged: vi.fn(),
    dispatchFeedStateChanged: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings",
  useRouter: () => ({ push: mocks.routerPush, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
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

vi.mock("@/lib/consent/consent-events", () => ({
  CONSENT_STATE_CHANGED_EVENT: "consent-state-changed",
  dispatchConsentStateChanged: mocks.dispatchConsentStateChanged,
}));

import {
  ConsentNotificationProvider,
  useConsentNotificationState,
} from "@/components/consent/notification-provider";
import { markOneLocationGrantUnwatched } from "@/lib/one-location/notifications";
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
  mocks.platform.native = false;
  mocks.platform.value = "web";
  mocks.prepareFCMListeners.mockResolvedValue(undefined);
  mocks.initializeFCM.mockResolvedValue({ status: "push_active" });
  mocks.getState.mockResolvedValue(EMPTY_LOCATION_STATE);
});

describe("global One Location Feed-first notification policy", () => {
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
        duration: 30000,
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
