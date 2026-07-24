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
    auth: { user: user as typeof user | null },
    routerPush: vi.fn(),
    initializeFCM: vi.fn(),
    prepareFCMListeners: vi.fn(),
    getState: vi.fn(),
    startTask: vi.fn(),
    completeTask: vi.fn(),
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
    isNativePlatform: () => false,
    getPlatform: () => "web",
  },
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({
    user: mocks.auth.user,
  }),
}));

vi.mock("@/lib/vault/vault-context", () => ({
  useVault: () => ({
    isVaultUnlocked: true,
    getVaultOwnerToken: () => "vault-owner-token",
  }),
}));

vi.mock("@/lib/consent", () => ({
  useConsentActions: () => ({ handleDeny: vi.fn() }),
}));

vi.mock("@/lib/notifications", () => ({
  initializeFCM: mocks.initializeFCM,
  prepareFCMListeners: mocks.prepareFCMListeners,
  clearDeliveredConsentNotifications: vi.fn(),
  FCM_MESSAGE_EVENT: "fcm-message",
}));

vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: {
    getState: mocks.getState,
  },
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

vi.mock("@/lib/morphy-ux/ui", () => ({
  Icon: () => null,
}));

import {
  ConsentNotificationProvider,
  useConsentNotificationState,
} from "@/components/consent/notification-provider";
import { markOneLocationGrantUnwatched } from "@/lib/one-location/notifications";

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

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.clearAllMocks();
  mocks.auth.user = mocks.user;
  mocks.prepareFCMListeners.mockResolvedValue(undefined);
  mocks.initializeFCM.mockResolvedValue({ status: "push_active" });
  mocks.getState.mockResolvedValue(EMPTY_LOCATION_STATE);
});

describe("global One Location notification provider", () => {
  function PermissionRequestButton() {
    const notificationState = useConsentNotificationState();
    return (
      <button type="button" onClick={notificationState.retryPushRegistration}>
        Enable notifications
      </button>
    );
  }

  it("removes a legacy masked phone suffix from the rendered popup", async () => {
    renderProvider();
    await waitFor(() => expect(mocks.initializeFCM).toHaveBeenCalledOnce());
    expect(mocks.initializeFCM).toHaveBeenCalledWith(
      "recipient-user",
      "firebase-token",
      { requestPermission: false },
    );

    act(() => {
      window.dispatchEvent(
        new CustomEvent("fcm-message", {
          detail: {
            data: {
              type: "location_share_created",
              grant_id: "grant-legacy-phone-1",
              owner_display_label: "hushh Social - ********8014",
              notification_body:
                "hushh Social - ********8014 shared location access with you.",
            },
          },
        }),
      );
    });

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    const popup = mocks.toast.mock.calls[0]?.[0] as ReactNode;
    render(<>{popup}</>);
    expect(
      screen.getByText("hushh Social shared location access with you."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/8014/)).not.toBeInTheDocument();
  });

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

  it("shows one popup and records one bell item for duplicate live pushes on a non-Location route", async () => {
    renderProvider();
    await waitFor(() => expect(mocks.initializeFCM).toHaveBeenCalledOnce());

    const detail = {
      data: {
        type: "location_share_created",
        grant_id: "grant-live-1",
        owner_display_label: "Alex",
        share_kind: "check_in",
        share_message: "Reached safely",
      },
    };

    act(() => {
      window.dispatchEvent(new CustomEvent("fcm-message", { detail }));
      window.dispatchEvent(new CustomEvent("fcm-message", { detail }));
    });

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        duration: 10000,
        className: undefined,
      }),
    );
    const popup = mocks.toast.mock.calls[0]?.[0] as ReactNode;
    render(<>{popup}</>);
    expect(screen.getByRole("button", { name: "Open" })).toBeInTheDocument();
    expect(screen.queryByText("Emergency SMS")).not.toBeInTheDocument();
    expect(mocks.startTask).toHaveBeenCalledTimes(1);
    expect(mocks.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "one_location_share:grant-live-1",
        routeHref: expect.stringContaining("section=shared"),
      }),
    );
  });

  it("renders emergency SMS as a persistent alarm popup and keeps its alert metadata", async () => {
    renderProvider();
    await waitFor(() => expect(mocks.initializeFCM).toHaveBeenCalledOnce());

    act(() => {
      window.dispatchEvent(
        new CustomEvent("fcm-message", {
          detail: {
            notification: {
              title: "SMS · Save my soul",
              body: "Alex: Come get me",
            },
            data: {
              type: "location_share_created",
              grant_id: "grant-sms-emergency-1",
              owner_display_label: "Alex",
              share_kind: "sos",
              share_message: "Come get me",
              notification_profile: "one_location_sms_emergency",
              notification_category: "ONE_LOCATION_SMS_EMERGENCY",
            },
          },
        }),
      );
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
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-one-location-emergency-sms-alert");
    expect(alert).toHaveClass("text-white");
    expect(screen.getByText("Emergency SMS")).toBeInTheDocument();
    const viewLocationButton = screen.getByRole("button", {
      name: /view live location/i,
    });
    expect(viewLocationButton).toHaveClass("bg-white", "text-red-700");
    expect(mocks.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "one_location_share:grant-sms-emergency-1",
        metadata: expect.objectContaining({ shareKind: "sos" }),
      }),
    );
  });

  it("queues a foreground push received during auth hydration and drains it once for the matching user", async () => {
    mocks.auth.user = null;
    const view = renderProvider();

    act(() => {
      window.dispatchEvent(
        new CustomEvent("fcm-message", {
          detail: {
            data: {
              type: "location_share_created",
              user_id: "recipient-user",
              grant_id: "grant-auth-race-1",
              owner_display_label: "Alex",
            },
          },
        }),
      );
    });
    expect(mocks.toast).not.toHaveBeenCalled();

    mocks.auth.user = mocks.user;
    view.rerender(
      <ConsentNotificationProvider>
        <div>Settings page</div>
      </ConsentNotificationProvider>,
    );

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    expect(mocks.startTask).toHaveBeenCalledTimes(1);
  });

  it("recovers globally and still presents only once when push registration is blocked", async () => {
    mocks.initializeFCM.mockResolvedValue({
      status: "push_blocked",
      detail: "permission_denied",
    });
    mocks.getState.mockResolvedValue({
      ...EMPTY_LOCATION_STATE,
      receivedGrants: [
        {
          id: "grant-catch-up-1",
          ownerUserId: "owner-user",
          recipientUserId: "recipient-user",
          ownerDisplayName: "Jordan",
          recipientKeyId: "key-1",
          status: "active",
          consentScope: "one.location",
          capabilityScopes: [],
          durationHours: 2,
          shareKind: "share",
        },
      ],
    });

    renderProvider();

    await waitFor(() => expect(mocks.getState).toHaveBeenCalled());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    expect(mocks.startTask).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(
        new CustomEvent("fcm-message", {
          detail: {
            data: {
              type: "location_share_created",
              grant_id: "grant-catch-up-1",
              owner_display_label: "Jordan",
            },
          },
        }),
      );
    });

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.startTask).toHaveBeenCalledTimes(1);
  });

  it("presents a push-active reconciliation once and deduplicates a later live push", async () => {
    mocks.getState.mockResolvedValue({
      ...EMPTY_LOCATION_STATE,
      requests: [
        {
          id: "request-race-1",
          ownerUserId: "recipient-user",
          requesterUserId: "requester-user",
          requesterDisplayName: "Alex",
          status: "pending",
        },
      ],
    });

    renderProvider();
    await waitFor(() => expect(mocks.getState).toHaveBeenCalled());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.startTask).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(
        new CustomEvent("fcm-message", {
          detail: {
            data: {
              type: "location_access_request",
              request_id: "request-race-1",
              requester_display_label: "Alex",
            },
          },
        }),
      );
    });

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.startTask).toHaveBeenCalledTimes(1);
  });

  it("presents a reconciliation once after a fetch finishes while the page is hidden", async () => {
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
    await act(async () => {
      resolveFirstState(locationState);
    });
    await waitFor(() => expect(mocks.startTask).toHaveBeenCalledTimes(1));
    expect(mocks.toast).not.toHaveBeenCalled();

    visibilityState.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(mocks.getState).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledTimes(1));
    expect(mocks.startTask).toHaveBeenCalledTimes(1);

    visibilityState.mockRestore();
  });

  it("keeps approval copy and the backend deep link without creating a second share entry", async () => {
    renderProvider();
    await waitFor(() => expect(mocks.initializeFCM).toHaveBeenCalledOnce());

    const detail = {
      notification: {
        title: "Location request approved",
        body: "Alex approved your location request.",
      },
      data: {
        type: "location_access_approved",
        request_id: "request-approved-1",
        grant_id: "grant-approved-1",
        owner_display_label: "Alex",
        request_url:
          "/one/location?requestId=request-approved-1&grantId=grant-approved-1&locationNotification=opened&section=shared",
      },
    };

    act(() => {
      window.dispatchEvent(new CustomEvent("fcm-message", { detail }));
      window.dispatchEvent(new CustomEvent("fcm-message", { detail }));
    });

    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.startTask).toHaveBeenCalledTimes(1);
    expect(mocks.startTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId:
          "one_location_workflow:location_access_approved:grant-approved-1",
        title: "Location request approved",
        description: "Alex approved your location request.",
        routeHref: detail.data.request_url,
      }),
    );
  });

  it("does not surface live terminal notifications for an explicitly unwatched grant", async () => {
    markOneLocationGrantUnwatched("recipient-user", "grant-unwatched-1");
    renderProvider();
    await waitFor(() => expect(mocks.initializeFCM).toHaveBeenCalledOnce());

    act(() => {
      window.dispatchEvent(
        new CustomEvent("fcm-message", {
          detail: {
            data: {
              type: "location_share_expired",
              grant_id: "grant-unwatched-1",
              owner_display_label: "Alex",
            },
          },
        }),
      );
    });

    expect(mocks.toast).not.toHaveBeenCalled();
    expect(mocks.startTask).not.toHaveBeenCalled();
  });
});
