import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  notificationMocks as mocks, EMPTY_LOCATION_STATE, renderProvider, renderReady, dispatchLocation,
} from "./helpers/one-location-notification-harness";
import { ConsentNotificationProvider, useConsentNotificationState } from "@/components/consent/notification-provider";
import { markOneLocationGrantUnwatched } from "@/lib/one-location/notifications";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import type { OneLocationState } from "@/lib/one-location/types";

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
