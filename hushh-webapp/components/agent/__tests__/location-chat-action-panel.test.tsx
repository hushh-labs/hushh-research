import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MouseEvent, ReactNode } from "react";
import { expect, test, vi } from "vitest";
import { executeMainLocationPlan, prepareMainLocationPlan, resolveMainLocationChoices, restoreMainLocationPlans } from "@/lib/agent/main-chat-location";
import { getLocationAccountSettings, updateLocationAccountSettings } from "@/lib/location/account-settings";
import { parseMainLocationProposal } from "@/lib/agent/main-chat-location-contract";
import { loadChatSosReview, sendChatSos } from "@/lib/one-location/chat-sos";
import { OneLocationService } from "@/lib/one-location/service";
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
  OneLocationStateResource: { load: vi.fn(async () => {
    location.stateLoads += 1;
    return { ownerGrants: [{ id: "grant-1", ownerUserId: "owner", recipientUserId: "priya", status: "active", expiresAt: location.expiry }], receivedGrants: location.receivedGrants, requests: [] };
  }) },
}));
vi.mock("@/lib/one-location/one-location-state-events", () => ({
  subscribeToOneLocationStateChanges: vi.fn((callback) => { location.change = callback; return () => { location.change = null; }; }),
}));
vi.mock("@/components/one-location/live-map", () => ({ LiveMap: () => null }));
vi.mock("@/components/agent/location-chat-action/location-chat-action-card", () => ({
  LocationChatActionCard: ({ model, onRecover, map }: { model: { title: string; endAt?: string; status?: string; facts?: { label: string; value: string }[]; actions?: { id: string; label: string }[] };
    onRecover?: (action: string, event: MouseEvent<HTMLButtonElement>) => void; map?: ReactNode }) =>
    <div data-testid="location-card">
      <span>{model.title}</span>{model.status}<time dateTime={model.endAt}>{model.endAt}</time>{map}
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
