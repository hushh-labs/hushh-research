import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MouseEvent, ReactNode } from "react";
import { expect, test, vi } from "vitest";
import { executeMainLocationPlan, expandMainLocationTarget, prepareMainLocationPlan, resolveMainLocationChoices, restoreMainLocationPlans } from "@/lib/agent/main-chat-location";
import { getLocationAccountSettings, updateLocationAccountSettings } from "@/lib/location/account-settings";
import { parseMainLocationProposal } from "@/lib/agent/main-chat-location-contract";
import { directLocationShareTerms, locationPlanGroups, locationPlanSentence, locationReviewText, typedLocationEnableAuthority, type LocationConversationReply } from "@/lib/agent/main-chat-location-conversation";
import { loadChatSosReview, sendChatSos } from "@/lib/one-location/chat-sos";
import { OneLocationService } from "@/lib/one-location/service";
import { forgetOneLocationControlPreference, readOneLocationControlState, updateOneLocationControlState } from "@/lib/one-location/location-control-state";
import { ApiError, apiJson } from "@/lib/services/api-client";
import { settleMainLocationBatch } from "@/lib/agent/main-chat-location-batch";
import type { OneLocationGrant } from "@/lib/one-location/types";
import { LocationChatActionPanel } from "../location-chat-action-panel";

const location = vi.hoisted(() => ({
  expiry: "2090-01-01T11:00:00.000Z",
  change: null as null | ((detail: { userId: string }) => void),
  stateLoads: 0,
  receivedGrants: [] as OneLocationGrant[],
}));

vi.mock("@/lib/services/api-client", async (original) => ({
  ...await original<typeof import("@/lib/services/api-client")>(), apiJson: vi.fn(),
}));

vi.mock("@/lib/agent/main-chat-location", () => ({
  restoreMainLocationPlans: vi.fn(async () => [{
    planId: "plan-1", action: "share_live", status: "executed", personDisplayLabel: "Priya",
    receipt: { grantId: "grant-1" }, nextExpiresAt: "2090-01-01T11:00:00.000Z",
  }]),
  resolveMainLocationChoices: vi.fn(),
  prepareMainLocationPlan: vi.fn(),
  executeMainLocationPlan: vi.fn(),
  expandMainLocationTarget: vi.fn(async (_token, _owner, target) => [target]),
}));
vi.mock("@/lib/location/account-settings", () => ({
  getLocationAccountSettings: vi.fn(), updateLocationAccountSettings: vi.fn(), LocationAccountSettingsResource: { write: vi.fn() },
}));
vi.mock("@/lib/one-location/service", () => ({
  OneLocationService: { viewEnvelope: vi.fn(async () => ({})), getPermissionState: vi.fn(async () => ({ state: "granted" })),
    requestLocationPermission: vi.fn(),
    listRecipients: vi.fn(async () => []), removeSmsContact: vi.fn(), addSmsContact: vi.fn(),
    listCircles: vi.fn(async () => [{ id: "family", name: "Family" }]),
    listRecipientsPage: vi.fn(async () => ({ items: [], page: 1, hasMore: false })),
    captureCurrentPosition: vi.fn(async () => ({ latitude: 1, longitude: 1, capturedAt: new Date().toISOString(), sourcePlatform: "web" })) },
}));
vi.mock("@/lib/one-location/chat-sos", () => ({
  loadChatSosReview: vi.fn(), sendChatSos: vi.fn(), stopChatSos: vi.fn(), loadChatSosActiveReview: vi.fn(),
}));
vi.mock("@/components/one-location/redesign/sos-panel", () => ({
  SosPanel: ({ onTrigger, sendBlocked, active }: { onTrigger: () => void; sendBlocked: boolean; active: boolean }) => active
    ? <p>Active alert controls</p> : <button disabled={sendBlocked} onClick={onTrigger}>Send reviewed SOS</button>,
}));
vi.mock("@/components/one-location/redesign/sms-contacts-flow", () => ({ SmsContactsFlow: () => null }));
vi.mock("@/components/agent/location-chat-action/location-chat-workspace", () => ({
  LocationChatWorkspace: ({ mode }: { mode: string }) => <p>Inline workspace {mode}</p>,
}));
vi.mock("@/components/location/setup/location-setup-flow", () => ({
  LocationSetupFlow: ({ onSetupSkip }: { onSetupSkip: () => void }) => <section aria-label="Inline Location setup">
    <button onClick={onSetupSkip}>Cancel setup</button>
  </section>,
}));
vi.mock("@/lib/one-location/one-location-state-resource", () => ({
  OneLocationStateResource: { invalidate: vi.fn(), load: vi.fn(async () => {
    location.stateLoads += 1;
    return { ownerGrants: [{ id: "grant-1", ownerUserId: "owner", recipientUserId: "priya", status: "active", expiresAt: location.expiry }], receivedGrants: location.receivedGrants, requests: [] };
  }) },
}));
vi.mock("@/lib/one-location/one-location-state-events", () => ({
  dispatchOneLocationStateChanged: vi.fn(),
  subscribeToOneLocationStateChanges: vi.fn((callback) => { location.change = callback; return () => { location.change = null; }; }),
}));
vi.mock("@/components/one-location/live-map", () => ({ LiveMap: () => null }));
vi.mock("@/components/agent/location-chat-action/location-chat-action-card", () => ({
  LocationChatActionCard: ({ model, onRecover, onConfirm, map }: { model: { title: string; endAt?: string; status?: string; confirmLabel?: string; description?: string; facts?: { label: string; value: string }[]; actions?: { id: string; label: string }[] };
    onConfirm?: (input: object, event: MouseEvent<HTMLButtonElement>) => void;
    onRecover?: (action: string, event: MouseEvent<HTMLButtonElement>) => void; map?: ReactNode }) =>
    <div data-testid="location-card">
      <span>{model.title}</span>{model.status}<time dateTime={model.endAt}>{model.endAt}</time>{map}
      {model.description && <p>{model.description}</p>}
      {model.confirmLabel && <button onClick={() => onConfirm?.({}, { nativeEvent: { isTrusted: true } } as MouseEvent<HTMLButtonElement>)}>{model.confirmLabel}</button>}
      {model.facts?.map((item) => <p key={item.label}>{item.label} {item.value}</p>)}
      {model.actions?.map((action) => <button key={action.id} onClick={() => onRecover?.(action.id, {
        nativeEvent: { isTrusted: true },
      } as MouseEvent<HTMLButtonElement>)}>{action.label}</button>)}
    </div>,
}));

test("a restored chat card follows the workspace’s new expiry for the same grant", async () => {
  render(<LocationChatActionPanel proposal={{ id: "proposal-1", action: "share_live" }} ownerId="owner" token="owner-token" allowReview onUnlock={() => {}} />);
  await screen.findByText("2090-01-01T11:00:00.000Z");
  await waitFor(() => expect(location.change).toBeTypeOf("function"));

  location.expiry = "2090-01-01T11:30:00.000Z";
  act(() => location.change?.({ userId: "another-owner" }));
  expect(location.stateLoads).toBe(1);
  act(() => location.change?.({ userId: "owner" }));
  expect(location.stateLoads).toBe(2);
  await screen.findByText("2090-01-01T11:30:00.000Z");
  expect(screen.queryByText("2090-01-01T11:00:00.000Z")).not.toBeInTheDocument();
});

test("asking a person whose location is already available opens the exact grant without creating a request", async () => {
  const grant = { id: "incoming-grant", ownerUserId: "priya", recipientUserId: "owner", status: "active", expiresAt: "2090-01-01T12:00:00Z" } as OneLocationGrant;
  location.receivedGrants = [grant];
  vi.mocked(restoreMainLocationPlans).mockResolvedValueOnce([]);
  vi.mocked(resolveMainLocationChoices).mockResolvedValueOnce([{ label: "Priya", targets: [{ label: "Priya", personUserId: "priya" }] }]);
  vi.mocked(prepareMainLocationPlan).mockResolvedValueOnce({ planId: "view-plan", action: "view", grantId: grant.id, status: "pending" });
  vi.mocked(executeMainLocationPlan).mockResolvedValueOnce({ planId: "view-plan", action: "view", status: "executed", receipt: { grantId: grant.id } });

  render(<LocationChatActionPanel proposal={{ id: "ask-proposal", action: "ask", people: ["Priya"] }} ownerId="owner" token="owner-token" allowReview onUnlock={() => {}} />);
  await screen.findByRole("button", { name: "View location" });
  expect(prepareMainLocationPlan).toHaveBeenCalledTimes(1);
  expect(prepareMainLocationPlan).toHaveBeenCalledWith("owner-token", expect.objectContaining({ action: "view" }), expect.objectContaining({ grantId: grant.id }));
  expect(executeMainLocationPlan).toHaveBeenCalledWith("owner-token", "view-plan");
});

test("a first-time live share offers the existing consent and device setup inside Chat", async () => {
  vi.clearAllMocks();
  vi.mocked(restoreMainLocationPlans).mockResolvedValueOnce([]);
  vi.mocked(resolveMainLocationChoices).mockResolvedValueOnce([{ label: "Priya", targets: [{ label: "Priya", personUserId: "priya" }] }]);
  vi.mocked(getLocationAccountSettings).mockResolvedValueOnce({ sharing_state: "unset" } as Awaited<ReturnType<typeof getLocationAccountSettings>>);

  render(<LocationChatActionPanel proposal={{ id: "live-proposal", action: "share_live", people: ["Priya"], durationHours: 1 }} ownerId="owner" token="owner-token" allowReview onUnlock={() => {}} />);
  await screen.findByText("Set up Location");
  await waitFor(() => expect(prepareMainLocationPlan).not.toHaveBeenCalled());
});

test.each(["pin", "check_in"])("a fixed incoming %s does not satisfy a fresh live location request", async shareKind => {
  vi.clearAllMocks();
  location.receivedGrants = [{ id: "fixed", ownerUserId: "priya", recipientUserId: "owner", shareKind,
    status: "active", expiresAt: "2090-01-01T12:00:00Z" } as OneLocationGrant];
  const target = { label: "Priya", personUserId: "priya" };
  vi.mocked(restoreMainLocationPlans).mockResolvedValueOnce([]);
  vi.mocked(resolveMainLocationChoices).mockResolvedValueOnce([{ label: "Priya", targets: [target] }]);
  vi.mocked(prepareMainLocationPlan).mockResolvedValueOnce({ planId: "ask", action: "ask", status: "pending" });
  render(<LocationChatActionPanel proposal={{ id: "ask", action: "ask", people: ["Priya"], durationHours: 1 }}
    ownerId="owner" token="token" allowReview onUnlock={() => {}} />);
  await screen.findByRole("button", { name: "Ask for location" });
  expect(prepareMainLocationPlan).toHaveBeenCalledExactlyOnceWith("token", expect.objectContaining({ action: "ask" }), target);
  expect(executeMainLocationPlan).not.toHaveBeenCalled();
  location.receivedGrants = [];
});

test("retrying a denied live share keeps its recipient, time and prepared plan", async () => {
  vi.clearAllMocks();
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const key = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const target = { label: "Kushal", personUserId: "kushal" };
  const plan = { planId: "private-share", action: "share_live" as const, status: "pending" as const,
    durationHours: 1, recipientKey: { keyId: "kushal-key", publicKeyJwk: key } };
  vi.mocked(restoreMainLocationPlans).mockResolvedValueOnce([]);
  vi.mocked(resolveMainLocationChoices).mockResolvedValueOnce([{ label: "Kushal", targets: [target] }]);
  vi.mocked(getLocationAccountSettings).mockResolvedValue({ sharing_state: "on", precision: "precise" } as Awaited<ReturnType<typeof getLocationAccountSettings>>);
  vi.mocked(prepareMainLocationPlan).mockResolvedValueOnce(plan);
  vi.mocked(executeMainLocationPlan).mockResolvedValueOnce({ ...plan, status: "executed" });
  vi.mocked(OneLocationService.captureCurrentPosition).mockRejectedValueOnce(Object.assign(new Error("Denied"), { name: "LocationPermissionDeniedError" }));
  render(<LocationChatActionPanel proposal={{ id: "share", action: "share_live", people: ["Kushal"], durationHours: 1 }}
    ownerId="owner" token="owner-token" allowReview onUnlock={() => {}} />);
  const confirm = await screen.findByRole("button", { name: "Share live location" });
  expect(OneLocationService.captureCurrentPosition).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  await screen.findByText("Location permission was denied.");
  expect(executeMainLocationPlan).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  await waitFor(() => expect(executeMainLocationPlan).toHaveBeenCalledExactlyOnceWith("owner-token", plan.planId,
    expect.objectContaining({ recipientKeyId: "kushal-key", ciphertext: expect.any(String) })));
  expect(prepareMainLocationPlan).toHaveBeenCalledExactlyOnceWith("owner-token",
    expect.objectContaining({ action: "share_live", durationHours: 1 }), target);
});

test("requesting someone else's location works without enabling sharing or capturing a device position", async () => {
  vi.clearAllMocks();
  location.receivedGrants = [];
  vi.mocked(restoreMainLocationPlans).mockResolvedValueOnce([]);
  vi.mocked(resolveMainLocationChoices).mockResolvedValueOnce([{ label: "Kushal", targets: [{ label: "Kushal", personUserId: "kushal" }] }]);
  const plan = { planId: "request", action: "ask" as const, status: "pending" as const };
  vi.mocked(prepareMainLocationPlan).mockResolvedValueOnce(plan);
  vi.mocked(executeMainLocationPlan).mockResolvedValueOnce({ ...plan, status: "executed" });
  render(<LocationChatActionPanel proposal={{ id: "ask", action: "ask", people: ["Kushal"], durationHours: 1 }}
    ownerId="owner" token="owner-token" allowReview onUnlock={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Ask for location" }));
  await waitFor(() => expect(executeMainLocationPlan).toHaveBeenCalledExactlyOnceWith("owner-token", "request", undefined));
  expect(getLocationAccountSettings).not.toHaveBeenCalled();
  expect(OneLocationService.getPermissionState).not.toHaveBeenCalled();
  expect(OneLocationService.captureCurrentPosition).not.toHaveBeenCalled();
});

test("the pending visibility choice is exposed as a follow-up hint and cleared on unmount", async () => {
  vi.mocked(restoreMainLocationPlans).mockResolvedValueOnce([]);
  const onContinuationChange = vi.fn();
  const view = render(<LocationChatActionPanel
    proposal={{ id: "share-proposal", action: "share_options" }}
    ownerId="owner" token="owner-token" allowReview onUnlock={() => {}}
    onContinuationChange={onContinuationChange}
  />);
  await screen.findByText("Share your location");
  await waitFor(() => expect(onContinuationChange).toHaveBeenLastCalledWith("share-proposal", expect.objectContaining({
    step: "visibility", action: "share_options", people: [], circles: [],
  })));
  view.unmount();
  expect(onContinuationChange).toHaveBeenLastCalledWith("share-proposal", null);
});

test("turning sharing back on when fresh consent is required opens setup in Chat and can be cancelled", async () => {
  vi.clearAllMocks();
  vi.mocked(getLocationAccountSettings).mockResolvedValue({ sharing_state: "off" } as Awaited<ReturnType<typeof getLocationAccountSettings>>);
  vi.mocked(updateLocationAccountSettings).mockRejectedValueOnce(new ApiError("Consent required", 409, { detail: { code: "LOCATION_SHARING_CONSENT_REQUIRED" } }));
  render(<LocationChatActionPanel proposal={{ id: "enable", action: "enable_location" }} ownerId="owner" token="owner-token" allowReview onUnlock={() => {}} />);
  expect(updateLocationAccountSettings).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole("button", { name: "Turn on sharing" }));
  expect(await screen.findByRole("region", { name: "Inline Location setup" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Cancel setup" }));
  expect(await screen.findByText("Cancelled", { exact: false })).toBeVisible();
  expect(updateLocationAccountSettings).toHaveBeenCalledTimes(1);
  expect(prepareMainLocationPlan).not.toHaveBeenCalled();
  expect(executeMainLocationPlan).not.toHaveBeenCalled();
  expect(OneLocationService.captureCurrentPosition).not.toHaveBeenCalled();
});

test("Save My Soul reviews the authoritative audience and separates partial in-app delivery from email", async () => {
  vi.clearAllMocks();
  const recipients = [
    { userId: "priya", displayName: "Priya", canReceiveLocation: true, keyId: "priya-key", publicKeyJwk: { kty: "EC" } },
    { userId: "sam", displayName: "Sam", canReceiveLocation: true, keyId: "sam-key", publicKeyJwk: { kty: "EC" } },
  ];
  const review = { ownerId: "owner", generation: 0, contactUserIds: ["priya", "sam"], recipients, activeGrants: [], incident: null };
  vi.mocked(loadChatSosReview).mockResolvedValue(review as Awaited<ReturnType<typeof loadChatSosReview>>);
  vi.mocked(sendChatSos).mockResolvedValueOnce({
    incident: { grantIds: ["active-grant"], startedAt: new Date().toISOString(), ownerUserId: "owner" },
    delivery: [{ userId: "priya", displayName: "Priya", alerted: true }, { userId: "sam", displayName: "Sam", alerted: null }],
    emailed: 1, withoutEmail: [], skippedNotReady: [], unavailableContactCount: 0,
  });
  const proposal = parseMainLocationProposal({ type: "location.chat_action", action: "sos_review", id: "00000000-0000-4000-8000-000000000000" });
  expect(proposal).not.toBeNull();
  render(<LocationChatActionPanel proposal={proposal!} ownerId="owner" token="owner-token" allowReview onUnlock={() => {}} />);
  expect(await screen.findByText("Live location and optional message Priya, Sam", {}, { timeout: 4_000 })).toBeVisible();
  expect(screen.getByRole("button", { name: "Send reviewed SOS" })).toBeDisabled();
  expect(sendChatSos).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Check device location" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Send reviewed SOS" })).toBeEnabled());
  expect(sendChatSos).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Send reviewed SOS" }));
  expect(await screen.findByText("Active alert controls")).toBeVisible();
  expect(screen.getByText("In-app alerts confirmed Priya")).toBeVisible();
  expect(screen.getByText("In-app delivery unknown Sam")).toBeVisible();
  expect(screen.getByText("Email alerts sent 1")).toBeVisible();
});

test("Circle review opens its inline workspace without restoring or preparing a person-level share plan", async () => {
  vi.clearAllMocks();
  render(<LocationChatActionPanel proposal={{ id: "circles", action: "manage_circles", circles: ["Family"] }}
    ownerId="owner" token="owner-token" vaultKey="fixture-key" allowReview onUnlock={() => {}} />);
  expect(await screen.findByText("Inline workspace circles")).toBeVisible();
  expect(restoreMainLocationPlans).not.toHaveBeenCalled();
  expect(prepareMainLocationPlan).not.toHaveBeenCalled();
});

test("typing an emergency contact edit requires its own confirmation and never starts an alert", async () => {
  vi.clearAllMocks();
  vi.mocked(loadChatSosReview).mockResolvedValue({
    ownerId: "owner", generation: 0, contactUserIds: ["priya"], activeGrants: [], incident: null,
    recipients: [{ userId: "priya", displayName: "Priya", maskedPhone: "••12" }],
  } as Awaited<ReturnType<typeof loadChatSosReview>>);
  vi.mocked(OneLocationService.removeSmsContact).mockResolvedValueOnce([]);
  const router: { reply?: LocationConversationReply | null } = {};
  const transcript = vi.fn();
  render(<LocationChatActionPanel proposal={{ id: "contacts", action: "sms_contacts", conversation: true }}
    ownerId="owner" token="token" allowReview onUnlock={() => {}} onConversationText={transcript}
    onConversationReply={(_, handle) => { router.reply = handle; }} />);
  await waitFor(() => expect(transcript).toHaveBeenLastCalledWith("contacts", expect.stringContaining("Your emergency contacts are Priya")));
  const rosterQuestion = transcript.mock.lastCall?.[1];
  await act(async () => { router.reply?.("remove Priya", rosterQuestion); });
  await waitFor(() => expect(transcript).toHaveBeenLastCalledWith("contacts", expect.stringContaining("Remove Priya from your emergency contacts?")));
  expect(router.reply?.("yes", rosterQuestion)).toBe(false);
  expect(OneLocationService.removeSmsContact).not.toHaveBeenCalled();
  await act(async () => { router.reply?.("yes", transcript.mock.lastCall?.[1]); });
  expect(OneLocationService.removeSmsContact).toHaveBeenCalledExactlyOnceWith({ vaultOwnerToken: "token", recipientUserId: "priya" });
  expect(sendChatSos).not.toHaveBeenCalled();
});

test("a typed SOS confirmation uses the reviewed roster and reports the actual delivery outcome in Chat", async () => {
  vi.clearAllMocks();
  const review = {
    ownerId: "owner", generation: 0, contactUserIds: ["priya"], activeGrants: [], incident: null,
    recipients: [{ userId: "priya", displayName: "Priya", canReceiveLocation: true, keyId: "key", publicKeyJwk: { kty: "EC" } }],
  } as Awaited<ReturnType<typeof loadChatSosReview>>;
  vi.mocked(loadChatSosReview).mockResolvedValue(review);
  vi.mocked(sendChatSos).mockResolvedValueOnce({
    incident: { grantIds: ["grant"], startedAt: new Date().toISOString(), ownerUserId: "owner" },
    delivery: [{ userId: "priya", displayName: "Priya", alerted: null }], emailed: 0, withoutEmail: [],
    skippedNotReady: [], unavailableContactCount: 0,
  });
  const router: { reply?: LocationConversationReply | null } = {};
  const transcript = vi.fn();
  render(<LocationChatActionPanel proposal={{ id: "review", action: "sos_review" }} ownerId="owner" token="owner-token"
    allowReview onUnlock={() => {}} onConversationText={transcript} onConversationReply={(_, handle) => { router.reply = handle; }} />);
  await waitFor(() => expect(transcript).toHaveBeenLastCalledWith("review", expect.stringContaining("live location with Priya?")));
  expect(screen.queryByRole("button", { name: "Send reviewed SOS" })).toBeNull();
  expect(router.reply?.("yes", "Resume location updates?")).toBe(false);
  expect(router.reply?.("yes, but don't send an alert", transcript.mock.lastCall?.[1])).toBe(false);
  const withoutNote = transcript.mock.lastCall?.[1];
  await act(async () => { router.reply?.("note Meet at the entrance", withoutNote); });
  expect(transcript.mock.lastCall?.[1]).toContain("Meet at the entrance");
  expect(router.reply?.("yes", withoutNote)).toBe(false);
  expect(sendChatSos).not.toHaveBeenCalled();
  await act(async () => { router.reply?.("yes", transcript.mock.lastCall?.[1]); });
  expect(sendChatSos).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ ownerId: "owner", review, note: "Meet at the entrance" }));
  expect(transcript).toHaveBeenLastCalledWith("review", expect.stringContaining("delivery unknown: Priya"));
});

test("a standalone current location preview leaves account sharing off and makes no capture until a gesture", async () => {
  vi.clearAllMocks();
  render(<LocationChatActionPanel proposal={{ id: "self", action: "view_self" }}
    ownerId="owner" token="owner-token" allowReview onUnlock={() => {}} />);
  expect(await screen.findByRole("button", { name: "Show current location" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(await screen.findByText("Cancelled", { exact: false })).toBeVisible();
  expect(OneLocationService.captureCurrentPosition).not.toHaveBeenCalled();
  expect(updateLocationAccountSettings).not.toHaveBeenCalled();
  expect(restoreMainLocationPlans).not.toHaveBeenCalled();
});

test("untargeted requests open the searchable paged audience picker in Chat without preparing a share", async () => {
  vi.clearAllMocks();
  vi.mocked(restoreMainLocationPlans).mockResolvedValue([]);
  render(<LocationChatActionPanel proposal={{ id: "ask-picker", action: "ask" }}
    ownerId="owner" token="owner-token" allowReview onUnlock={() => {}} />);
  expect(await screen.findByRole("region", { name: "Choose whose location to request" })).toBeVisible();
  expect(await screen.findByRole("button", { name: "Family", exact: true })).toBeEnabled();
  expect(screen.getByRole("searchbox", { name: "Search connections and Circles" })).toBeVisible();
  expect(prepareMainLocationPlan).not.toHaveBeenCalled();
  expect(OneLocationService.captureCurrentPosition).not.toHaveBeenCalled();
});

test("large Circle batches bound server work and keep every success and retry in recipient order", async () => {
  let active = 0;
  let peak = 0;
  const audience = Array.from({ length: 198 }, (_, index) => index);
  const results = await settleMainLocationBatch(audience, async (recipient) => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 0));
    active -= 1;
    if (recipient === 100) throw new Error("Retry this recipient");
    return recipient;
  });
  expect(peak).toBeLessThanOrEqual(4);
  expect(results).toHaveLength(audience.length);
  expect(results[100]).toMatchObject({ status: "rejected" });
  expect(results.filter((result) => result.status === "fulfilled").map((result) => result.value))
    .toEqual(audience.filter((recipient) => recipient !== 100));
});

test("restoration reads every page, including an empty key-rotated page, and refuses cursor loops", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/main-chat-location")>("@/lib/agent/main-chat-location");
  vi.mocked(apiJson).mockResolvedValueOnce({ plans: [{ planId: "one" }], nextCursor: "page-two" })
    .mockResolvedValueOnce({ plans: [], nextCursor: "page-three" })
    .mockResolvedValueOnce({ plans: [{ planId: "two" }], nextCursor: null });
  expect(await actual.restoreMainLocationPlans("token", "origin")).toEqual([{ planId: "one" }, { planId: "two" }]);
  expect(apiJson).toHaveBeenLastCalledWith("/api/one/location/chat-plans/origin/origin?cursor=page-three", expect.anything());
  vi.mocked(apiJson).mockResolvedValue({ plans: [], nextCursor: "repeated" });
  await expect(actual.restoreMainLocationPlans("token", "origin")).rejects.toThrow("fully restored");
});

test("a typed choice and duration bind an encrypted share to the reviewed recipient; restoration never repeats it", async () => {
  vi.clearAllMocks();
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const targets = [{ label: "Maya", detail: "Connection, 1234", personUserId: "first" },
    { label: "Maya", detail: "Connection, 5678", personUserId: "second" },
    ...Array.from({ length: 5 }, (_, i) => ({ label: "Maya", detail: `Connection, 900${i}`, personUserId: `other-${i}` }))];
  const plan = { planId: "exact-share", action: "share_live" as const, status: "pending" as const,
    personDisplayLabel: "Maya", personUserId: "second", durationHours: 0.5,
    recipientKey: { keyId: "second-key", publicKeyJwk } };
  vi.mocked(restoreMainLocationPlans).mockResolvedValueOnce([]);
  vi.mocked(resolveMainLocationChoices).mockResolvedValueOnce([{ label: "Maya", targets, requiresSelection: true }]);
  vi.mocked(getLocationAccountSettings).mockResolvedValue({ sharing_state: "on", precision: "precise" } as Awaited<ReturnType<typeof getLocationAccountSettings>>);
  vi.mocked(prepareMainLocationPlan).mockResolvedValueOnce(plan);
  vi.mocked(executeMainLocationPlan).mockResolvedValueOnce({ ...plan, status: "executed" });
  let reply: LocationConversationReply | null = null;
  const text = vi.fn();
  const props = { proposal: { id: "proposal", action: "share_live" as const, people: ["Maya"] },
    ownerId: "owner", token: "owner-token", onUnlock: () => {}, allowReview: true, onConversationText: text,
    onConversationReply: (_id: string, handle: LocationConversationReply | null) => { reply = handle; } };
  const view = render(<LocationChatActionPanel {...props} />);
  await waitFor(() => expect(text).toHaveBeenLastCalledWith("proposal", expect.stringContaining("2. Maya (Connection, 5678)")));
  expect(screen.queryByTestId("location-card")).toBeNull();
  expect(reply!("Maya")).toBe(false);
  expect(reply!("yes")).toBe(false);
  expect(text.mock.lastCall![1]).not.toContain("6. Maya");
  expect(reply!("6")).toBe(false);
  act(() => { expect(reply!("more")).toBe(true); });
  await waitFor(() => expect(text).toHaveBeenLastCalledWith("proposal", expect.stringContaining("7. Maya")));
  expect(text.mock.lastCall![1]).not.toContain("2. Maya");
  expect(reply!("2")).toBe(false);
  act(() => { expect(reply!("previous")).toBe(true); });
  await waitFor(() => expect(text).toHaveBeenLastCalledWith("proposal", expect.stringContaining("2. Maya")));
  act(() => { expect(reply!("2")).toBe(true); });
  await waitFor(() => expect(text).toHaveBeenLastCalledWith("proposal", expect.stringContaining("How long")));
  act(() => { expect(reply!("30 minutes")).toBe(true); });
  await waitFor(() => expect(text).toHaveBeenLastCalledWith("proposal", expect.stringContaining("30 min? Reply yes")));
  expect(prepareMainLocationPlan).toHaveBeenCalledExactlyOnceWith("owner-token", expect.objectContaining({ durationHours: 0.5 }), targets[1]);
  expect(reply!("yes, but send it to someone else")).toBe(false);
  expect(executeMainLocationPlan).not.toHaveBeenCalled();
  act(() => { expect(reply!("yes")).toBe(true); });
  await waitFor(() => expect(text).toHaveBeenLastCalledWith("proposal", "Shared your live location with Maya for 30 min."));
  expect(executeMainLocationPlan).toHaveBeenCalledExactlyOnceWith("owner-token", plan.planId,
    expect.objectContaining({ recipientKeyId: "second-key", ciphertext: expect.any(String) }));
  view.unmount();
  vi.mocked(restoreMainLocationPlans).mockResolvedValueOnce([{ ...plan, status: "executed" }]);
  render(<LocationChatActionPanel {...props} />);
  await waitFor(() => expect(restoreMainLocationPlans).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(reply!("yes")).toBe(false));
  expect(executeMainLocationPlan).toHaveBeenCalledTimes(1);
});

test("an explicit fresh enable turn turns on account settings and requests device permission once", async () => {
  vi.clearAllMocks();
  const off = { sharing_state: "off" } as Awaited<ReturnType<typeof getLocationAccountSettings>>;
  const on = { ...off, sharing_state: "on" as const };
  vi.mocked(getLocationAccountSettings).mockResolvedValueOnce(off);
  vi.mocked(updateLocationAccountSettings).mockResolvedValueOnce({ settings: on } as Awaited<ReturnType<typeof updateLocationAccountSettings>>);
  const permission = { state: "prompt", precise: null, background: "foreground-only" } as const;
  vi.mocked(OneLocationService.getPermissionState).mockResolvedValueOnce(permission);
  vi.mocked(OneLocationService.requestLocationPermission).mockResolvedValueOnce({ ...permission, state: "granted" });
  const text = vi.fn();
  const claim = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
  const props = { proposal: { id: "enable", action: "enable_location" as const }, ownerId: "owner", token: "owner-token",
    allowReview: true, onUnlock: () => {}, onConversationText: text, claimEnable: claim };
  const active = render(<LocationChatActionPanel {...props} />);
  await waitFor(() => expect(text).toHaveBeenLastCalledWith("enable", "Location is on for this device and your account."));
  expect(OneLocationService.captureCurrentPosition).not.toHaveBeenCalled();
  expect(executeMainLocationPlan).not.toHaveBeenCalled();
  active.unmount();
  vi.mocked(getLocationAccountSettings).mockResolvedValueOnce(off);
  render(<LocationChatActionPanel {...props} />);
  await waitFor(() => expect(claim).toHaveBeenCalledTimes(2));
  expect(OneLocationService.requestLocationPermission).toHaveBeenCalledTimes(1);
  expect(updateLocationAccountSettings).toHaveBeenCalledTimes(1);
  expect(typedLocationEnableAuthority("Please turn on my location")).toBe("enable_location");
  expect(typedLocationEnableAuthority("Do not turn on my location")).toBeUndefined();
  expect(typedLocationEnableAuthority("How do I enable my location?")).toBeUndefined();
});

test.each(["exact", "exact suffixed", "changed roster", "changed scope", "sharing turned off", "wrong prepared duration"] as const)(
  "a complete direct Circle command sends only the original exact timed audience (%s)", async scenario => {
    vi.clearAllMocks();
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
    const publicKeyJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const proposal = { id: "direct", action: "share_live" as const, conversation: true as const, circles: ["NM"], durationHours: 1 };
    const terms = directLocationShareTerms("Share my location with NM circle for 1 hour.", proposal);
    expect(terms).not.toBeNull();
    for (const text of ["NM circle", "1 hour", "yes", "Do not share my location with NM circle for 1 hour",
      "Share my location with NM circle for 1 hour?", "Share my location with NM circle and Maya for 1 hour",
      "Share my location with NM circle for 2 hours", "Share my current location with NM circle for 1 hour"]) {
      expect(directLocationShareTerms(text, proposal)).toBeNull();
    }
    const circle = { label: scenario === "exact suffixed" ? "NM Circle" : "NM", circleId: "circle-nm" };
    const target = { label: "Maya", personUserId: "maya", circleId: circle.circleId };
    const plan = { planId: "plan-nm-maya", action: "share_live" as const, personUserId: target.personUserId,
      personDisplayLabel: target.label, circleId: circle.circleId, durationMode: "timed" as const,
      durationHours: scenario === "wrong prepared duration" ? 2 : 1, status: "pending" as const,
      expiresAt: new Date(Date.now() + 600_000).toISOString(), nextExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      recipientKey: { keyId: "maya-key", publicKeyJwk } };
    vi.mocked(restoreMainLocationPlans).mockResolvedValueOnce([]);
    vi.mocked(resolveMainLocationChoices).mockResolvedValue([{ label: "NM", targets: [circle], exactMatch: true, requiresSelection: false }]);
    let current = true;
    vi.mocked(expandMainLocationTarget).mockResolvedValueOnce([target]).mockImplementationOnce(async () => {
      if (scenario === "changed scope") current = false;
      return scenario === "changed roster" ? [{ ...target, personUserId: "another" }] : [target];
    });
    vi.mocked(getLocationAccountSettings).mockResolvedValue({ sharing_state: "on", precision: "precise" } as Awaited<ReturnType<typeof getLocationAccountSettings>>);
    if (scenario === "sharing turned off") {
      const on = { sharing_state: "on", precision: "precise" } as Awaited<ReturnType<typeof getLocationAccountSettings>>;
      vi.mocked(getLocationAccountSettings).mockResolvedValueOnce(on).mockResolvedValueOnce(on).mockResolvedValueOnce({ ...on, sharing_state: "off" });
    }
    vi.mocked(prepareMainLocationPlan).mockResolvedValueOnce(plan);
    vi.mocked(executeMainLocationPlan).mockResolvedValueOnce({ ...plan, status: "executed" });
    const text = vi.fn();
    const claim = vi.fn(() => ({ ...terms!, current: () => current }));
    render(<LocationChatActionPanel proposal={proposal} ownerId="owner" token="token" allowReview
      claimDirectShare={claim} onUnlock={() => {}} onConversationText={text} />);
    if (scenario === "exact" || scenario === "exact suffixed") {
      await waitFor(() => expect(text).toHaveBeenLastCalledWith("direct", "Shared your live location with Maya for 1 hour."));
      expect(executeMainLocationPlan).toHaveBeenCalledExactlyOnceWith("token", plan.planId, expect.objectContaining({ recipientKeyId: "maya-key" }));
      expect(resolveMainLocationChoices).toHaveBeenCalledWith(expect.objectContaining({ proposal: expect.objectContaining({ circles: ["nm circle"] }) }));
    } else {
      await waitFor(() => expect(text).toHaveBeenCalledWith("direct", expect.stringMatching(/Reply yes|fresh review/)));
      expect(executeMainLocationPlan).not.toHaveBeenCalled();
    }
    expect(claim).toHaveBeenCalledTimes(1);
    vi.mocked(expandMainLocationTarget).mockReset().mockImplementation(async (_token, _owner, item) => [item]);
    vi.mocked(executeMainLocationPlan).mockReset();
  },
);

test("a fresh retired pin proposal does not execute or substitute a live share", async () => {
  vi.clearAllMocks();
  vi.mocked(restoreMainLocationPlans).mockResolvedValueOnce([]);
  const text = vi.fn();
  render(<LocationChatActionPanel proposal={{ id: "retired", action: "share_pin", people: ["Maya"] }} ownerId="owner"
    token="token" allowReview onUnlock={() => {}} onConversationText={text}/>);
  await waitFor(() => expect(text).toHaveBeenCalledWith("retired", expect.stringContaining("Location sharing is live.")));
  expect(resolveMainLocationChoices).not.toHaveBeenCalled();
  expect(prepareMainLocationPlan).not.toHaveBeenCalled();
  expect(executeMainLocationPlan).not.toHaveBeenCalled();
});

test.each(["on", "off"] as const)("resuming paused updates needs a fresh scoped yes and current account sharing (%s)", async accountAtConfirmation => {
  vi.clearAllMocks();
  const ownerId = "resume-owner";
  const settings = { sharing_state: "on" } as Awaited<ReturnType<typeof getLocationAccountSettings>>;
  updateOneLocationControlState(ownerId, state => ({ ...state, paused: true }));
  vi.mocked(getLocationAccountSettings).mockResolvedValueOnce(settings).mockResolvedValue({ ...settings, sharing_state: accountAtConfirmation });
  vi.mocked(OneLocationService.getPermissionState).mockResolvedValue({ state: "granted", precise: true, background: "foreground-only" });
  let reply: LocationConversationReply | null = null;
  const text = vi.fn();
  try {
    render(<LocationChatActionPanel proposal={{ id: "resume", action: "resume_updates" }} ownerId={ownerId} token="owner-token"
      allowReview onUnlock={() => {}} onConversationText={text}
      onConversationReply={(_id, handle) => { reply = handle; }} />);
    await waitFor(() => expect(text).toHaveBeenCalledWith("resume", expect.stringContaining("restart active shares")));
    expect(readOneLocationControlState(ownerId).paused).toBe(true);
    expect(reply!("yes", "An earlier question")).toBe(false);
    act(() => { expect(reply!("yes", text.mock.lastCall![1])).toBe(true); });
    await waitFor(() => expect(text).toHaveBeenLastCalledWith("resume",
      accountAtConfirmation === "off" ? expect.stringContaining("sharing is off") : "Location updates are on for this device."));
    expect(readOneLocationControlState(ownerId).paused).toBe(accountAtConfirmation === "off");
    expect(updateLocationAccountSettings).not.toHaveBeenCalled();
    expect(OneLocationService.requestLocationPermission).not.toHaveBeenCalled();
  } finally { forgetOneLocationControlPreference(ownerId); }
});

test("a large reviewed Circle exposes its names in pages and reports only confirmed recipients after a partial send", async () => {
  vi.clearAllMocks();
  location.receivedGrants = [];
  const circle = { circleId: "nm", label: "NM" };
  const members = Array.from({ length: 8 }, (_, index) => ({
    circleId: circle.circleId, personUserId: `member-${index}`, label: `Member ${index + 1}`,
  }));
  const plans = members.map((member, index) => ({
    planId: String(index), action: "ask" as const, status: "pending" as const, circleId: circle.circleId,
    personDisplayLabel: member.label, personUserId: member.personUserId, durationHours: 1, durationMode: "timed" as const,
  }));
  vi.mocked(restoreMainLocationPlans).mockResolvedValueOnce([]);
  vi.mocked(resolveMainLocationChoices).mockResolvedValueOnce([{ label: "NM", targets: [circle] }]);
  vi.mocked(expandMainLocationTarget).mockResolvedValueOnce(members);
  vi.mocked(prepareMainLocationPlan).mockImplementation(async (_token, _proposal, target) => plans.find(plan => plan.personUserId === target.personUserId)!);
  vi.mocked(executeMainLocationPlan).mockImplementation(async (_token, id) => {
    if (id === "7") throw new Error("Request to Member 8 failed.");
    return { ...plans[Number(id)]!, status: "executed" };
  });
  const text = vi.fn();
  let reply: LocationConversationReply | null = null;
  render(<LocationChatActionPanel proposal={{ id: "large", action: "ask", circles: ["NM"], durationHours: 1 }}
    ownerId="owner" token="token" allowReview onUnlock={() => {}} onConversationText={text}
    onConversationReply={(_id, handle) => { reply = handle; }} />);
  await waitFor(() => expect(text.mock.lastCall?.[1]).toContain("Ask 8 members of the NM circle to share their location for 1 hour?"));
  expect(text.mock.lastCall![1]).not.toContain("Member 1");
  act(() => { expect(reply!("names")).toBe(true); });
  await waitFor(() => expect(text.mock.lastCall?.[1]).toContain("Member 5"));
  expect(text.mock.lastCall![1]).not.toContain("Member 8");
  act(() => { expect(reply!("more")).toBe(true); });
  await waitFor(() => expect(text.mock.lastCall?.[1]).toContain("Member 8"));
  expect(executeMainLocationPlan).not.toHaveBeenCalled();
  act(() => { expect(reply!("yes")).toBe(true); });
  await waitFor(() => expect(text.mock.lastCall?.[1]).toContain("Sent your location request to 7 members of the NM circle for 1 hour."));
  expect(text.mock.lastCall![1]).toContain("Request to Member 8 failed.");
  expect(text.mock.lastCall![1].match(/Sent your location request/g)).toHaveLength(1);
  act(() => { expect(reply!("names")).toBe(true); });
  await waitFor(() => expect(text.mock.lastCall?.[1]).toContain("Member 1 · confirmed"));
  act(() => { expect(reply!("more")).toBe(true); });
  await waitFor(() => expect(text.mock.lastCall?.[1]).toContain("Member 8 · unconfirmed"));
  expect(executeMainLocationPlan).toHaveBeenCalledTimes(8);
  const differentTerms = [plans[0]!, { ...plans[1]!, durationHours: 2 }];
  expect(locationPlanGroups(differentTerms).map(group => locationPlanSentence(group, [circle], true))).toEqual([
    "Sent your location request to Member 1 for 1 hour.", "Sent your location request to Member 2 for 2 hours.",
  ]);
  expect(locationReviewText(differentTerms, [circle])).toContain("Member 2 to share their location for 2 hours");
});
