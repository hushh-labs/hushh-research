import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  notificationMocks as mocks, EMPTY_LOCATION_STATE, renderProvider, renderReady, dispatchLocation,
} from "./helpers/one-location-notification-harness";
import { ConsentNotificationProvider } from "@/components/consent/notification-provider";
import * as locationNotifications from "@/lib/one-location/notifications";
import { acknowledgeSmsAlarm, forgetSmsAlarms, isSmsAlarmAcknowledged, pendingSmsAlarms, rememberSmsAlarm } from "@/lib/one-location/sms-alarm-state";

describe("foreground SMS alarm presentation and cancellation", () => {
  it("never overwrites an acknowledgement arriving from another tab during alarm admission", () => {
    const set = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (key, value) {
      if (value === "pending") acknowledgeSmsAlarm("race-owner", "race-grant");
      set.call(this, key, value);
    });
    try {
      rememberSmsAlarm("race-owner", "race-grant");
      expect(isSmsAlarmAcknowledged("race-owner", "race-grant")).toBe(true);
      expect(pendingSmsAlarms("race-owner")).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it("retains pending and acknowledged state when storage reads work but writes hit quota", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota", "QuotaExceededError"); });
    try {
      rememberSmsAlarm("quota-owner", "quota-grant");
      expect(pendingSmsAlarms("quota-owner")).toEqual(["quota-grant"]);
      acknowledgeSmsAlarm("quota-owner", "quota-grant");
      expect(isSmsAlarmAcknowledged("quota-owner", "quota-grant")).toBe(true);
      expect(pendingSmsAlarms("quota-owner")).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it("erases only the deleted account's pending and acknowledgement receipts", () => {
    rememberSmsAlarm("deleted-owner", "pending");
    acknowledgeSmsAlarm("deleted-owner", "dismissed");
    rememberSmsAlarm("retained-owner", "pending");
    forgetSmsAlarms("deleted-owner");
    expect(pendingSmsAlarms("deleted-owner")).toEqual([]);
    expect(isSmsAlarmAcknowledged("deleted-owner", "dismissed")).toBe(false);
    expect(pendingSmsAlarms("retained-owner")).toEqual(["pending"]);
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

  it.each(["ios", "android"])("keeps an admitted %s alarm through revoke/expiry and disposes it on sign-out", async (platform) => {
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
    dispatchLocation({ type: "location_share_expired", grant_id: data.grant_id });
    expect(mocks.stopEmergencySmsCue).not.toHaveBeenCalled();
    expect(mocks.toast.dismiss).not.toHaveBeenCalledWith(`one-location-share:${data.grant_id}`);
    expect(isSmsAlarmAcknowledged("recipient-user", data.grant_id)).toBe(false);
    dispatchLocation(data);
    dispatchLocation({ ...data, grant_id: "expired-native", expires_at: "2000-01-01T00:00:00Z" });
    expect(mocks.playEmergencySmsCue).toHaveBeenCalledTimes(1);
    mocks.auth.user = null;
    view.rerender(<ConsentNotificationProvider><div>Signed out</div></ConsentNotificationProvider>);
    expect(mocks.stopEmergencySmsCue).toHaveBeenCalledWith({ userId: "recipient-user" });
    expect(pendingSmsAlarms("recipient-user")).toContain(data.grant_id);
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

  it.each(["button", "open", "unwatch"])("stops the recipient alarm on %s without allowing a replay", async (dismissal) => {
    mocks.platform.native = true;
    mocks.platform.value = "ios";
    await renderReady();
    const data = { type: "location_share_created", grant_id: `dismiss-${dismissal}`, share_kind: "sos" };
    dispatchLocation(data);
    const [popup, options] = mocks.toast.mock.calls[0];
    expect(options.dismissible).toBe(false);
    if (dismissal === "button") {
      render(<>{popup}</>);
      fireEvent.click(screen.getByRole("button", { name: "Dismiss alarm" }));
      expect(mocks.routerPush).not.toHaveBeenCalled();
    } else if (dismissal === "open") {
      locationNotifications.markOneLocationGrantOpened("recipient-user", data.grant_id);
    } else {
      locationNotifications.markOneLocationGrantUnwatched("recipient-user", data.grant_id);
    }
    expect(mocks.stopEmergencySmsCue).toHaveBeenCalledExactlyOnceWith({ userId: "recipient-user", grantId: data.grant_id });
    expect(mocks.toast.dismiss).toHaveBeenCalledWith(`one-location-share:${data.grant_id}`);
    expect(isSmsAlarmAcknowledged("recipient-user", data.grant_id)).toBe(true);
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
    expect(mocks.stopEmergencySmsCue).toHaveBeenCalledWith({ userId: "recipient-user", grantId: "other-window" });
    expect(mocks.toast.dismiss).toHaveBeenCalledWith("one-location-share:other-window");
  });

  it("restores an unacknowledged alarm after provider reload, including after the share ended", async () => {
    mocks.platform.native = true;
    mocks.platform.value = "android";
    const first = renderProvider();
    await waitFor(() => expect(mocks.initializeFCM).toHaveBeenCalled());
    dispatchLocation({ type: "location_share_created", grant_id: "reload-alarm", share_kind: "sos" });
    dispatchLocation({ type: "location_share_revoked", grant_id: "reload-alarm" });
    first.unmount();
    expect(isSmsAlarmAcknowledged("recipient-user", "reload-alarm")).toBe(false);
    mocks.toast.mockClear();
    const second = renderProvider();
    await waitFor(() => expect(mocks.playEmergencySmsCue).toHaveBeenCalledTimes(2));
    expect(mocks.toast).toHaveBeenCalledWith("Unacknowledged SMS alert", expect.objectContaining({ duration: Infinity }));
    const options = mocks.toast.mock.calls[0][1];
    options.action.onClick();
    expect(pendingSmsAlarms("recipient-user")).not.toContain("reload-alarm");
    second.unmount();
    renderProvider();
    expect(mocks.playEmergencySmsCue).toHaveBeenCalledTimes(2);
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

  it("restores native receipts offline and reconciles system acknowledgement without a replay", async () => {
    mocks.platform.native = true;
    mocks.platform.value = "ios";
    mocks.initializeFCM.mockResolvedValue({ status: "push_failed", detail: "offline" });
    rememberSmsAlarm("recipient-user", "system-dismissed");
    mocks.getPendingEmergencySmsAlarms.mockResolvedValue({
      grantIds: ["offline-alarm"], acknowledgedGrantIds: ["system-dismissed"],
    });
    renderProvider();
    await waitFor(() => expect(mocks.playEmergencySmsCue).toHaveBeenCalledWith(expect.objectContaining({ grantId: "offline-alarm" })));
    expect(mocks.playEmergencySmsCue).not.toHaveBeenCalledWith(expect.objectContaining({ grantId: "system-dismissed" }));
    expect(isSmsAlarmAcknowledged("recipient-user", "system-dismissed")).toBe(true);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("Unacknowledged SMS alert", expect.objectContaining({ id: "one-location-share:offline-alarm" })));
    expect(mocks.toast.mock.calls.filter(([, options]) => options.id === "one-location-share:offline-alarm")).toHaveLength(1);
    const callback = mocks.addNotificationListener.mock.calls[0][1];
    callback({ userId: "someone-else", grantId: "offline-alarm" });
    expect(isSmsAlarmAcknowledged("recipient-user", "offline-alarm")).toBe(false);
    callback({ userId: "recipient-user", grantId: "offline-alarm" });
    expect(isSmsAlarmAcknowledged("recipient-user", "offline-alarm")).toBe(true);
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

});
