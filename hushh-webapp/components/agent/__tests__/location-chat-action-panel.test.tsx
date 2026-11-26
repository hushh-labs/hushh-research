import { act, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { executeMainLocationPlan, prepareMainLocationPlan, resolveMainLocationChoices, restoreMainLocationPlans } from "@/lib/agent/main-chat-location";
import { getLocationAccountSettings } from "@/lib/location/account-settings";
import type { OneLocationGrant } from "@/lib/one-location/types";
import { LocationChatActionPanel } from "../location-chat-action-panel";

const location = vi.hoisted(() => ({
  expiry: "2090-01-01T11:00:00.000Z",
  change: null as null | ((detail: { userId: string }) => void),
  stateLoads: 0,
  receivedGrants: [] as OneLocationGrant[],
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
vi.mock("@/lib/location/account-settings", () => ({ getLocationAccountSettings: vi.fn() }));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: { viewEnvelope: vi.fn(async () => ({})) } }));
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
  LocationChatActionCard: ({ model }: { model: { title: string; endAt?: string; status?: string } }) =>
    <div data-testid="location-card"><span>{model.title}</span>{model.status}<time dateTime={model.endAt}>{model.endAt}</time></div>,
}));

test("a restored chat card follows the workspace’s new expiry for the same grant", async () => {
  render(<LocationChatActionPanel proposal={{ id: "proposal-1", action: "share_live" }} ownerId="owner" token="owner-token" allowReview onUnlock={() => {}} />);
  await screen.findByText("2090-01-01T11:00:00.000Z");

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
  await screen.findByText("View location");
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
