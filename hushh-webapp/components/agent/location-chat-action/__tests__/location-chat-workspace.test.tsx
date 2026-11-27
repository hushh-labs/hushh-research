import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LocationChatCircles } from "../location-chat-circles";
import { LocationChatSettings } from "../location-chat-settings";
import { LocationChatCheckIn } from "../location-chat-check-in";
import { readOneLocationControlState } from "@/lib/one-location/location-control-state";
import { OneLocationStateResource } from "@/lib/one-location/one-location-state-resource";
import { ROUTES } from "@/lib/navigation/routes";
import type { LocationConversationReply } from "@/lib/agent/main-chat-location-conversation";

const mock = vi.hoisted(() => ({
  listCircles: vi.fn(),
  listNamedCircleMemberInvites: vi.fn(),
  getCircleOverview: vi.fn(),
  listCircleMembersPage: vi.fn(),
  listNamedCircleEligibleConnectionsPage: vi.fn(),
  removeNamedCircleMember: vi.fn(),
  updateNamedCircle: vi.fn(),
  getState: vi.fn(),
  getMapPreferences: vi.fn(),
  checkoutNearby: vi.fn(),
  updateAutoApprovePreference: vi.fn(),
  getLocationAccountSettings: vi.fn(),
  updateLocationAccountSettings: vi.fn(),
  writeAccountSettings: vi.fn(),
  onOneLocationStateMutated: vi.fn(),
}));

vi.mock("@/lib/one-location/service", () => ({ OneLocationService: mock }));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: mock }));
vi.mock("@/components/feed/feed-push-prompt", () => ({ useFeedPushPrompt: () => null, FeedPushPromptView: () => null }));
vi.mock("@/lib/one-location/nearby-check-in-availability", () => ({ isOneLocationNearbyCheckInAvailable: () => true }));
vi.mock("@/lib/location/account-settings", () => ({
  getLocationAccountSettings: mock.getLocationAccountSettings,
  updateLocationAccountSettings: mock.updateLocationAccountSettings,
  LocationAccountSettingsResource: { write: mock.writeAccountSettings },
  locationSettingsErrorCode: (caught: { code?: string }) => caught.code ?? null,
}));

const circle = {
  id: "family",
  role: "owner",
  name: "Family",
  kind: "family",
  memberCount: 2,
  memberLimit: 20,
};

describe("inline Location workspace", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.listCircles.mockResolvedValue([circle]);
    mock.listNamedCircleMemberInvites.mockResolvedValue([]);
    mock.getCircleOverview.mockResolvedValue(circle);
    mock.listNamedCircleEligibleConnectionsPage.mockResolvedValue({
      eligibleConnections: [], pendingInvites: [], remainingCapacity: 18, page: 1, hasMore: false, totalCount: 0,
    });
  });

  it("reads every roster page and removes only the exact member the owner confirms", async () => {
    const first = { userId: "riley-first", displayName: "Riley", role: "member", joinedAt: "2026-08-02T12:00:00Z" };
    const second = { userId: "riley-second", displayName: "Riley", role: "member", joinedAt: "2026-09-02T12:00:00Z" };
    mock.listCircleMembersPage.mockImplementation(async ({ page }) => ({
      items: page === 1 ? [first] : [second], page, hasMore: page === 1, totalCount: 2,
    }));
    mock.removeNamedCircleMember.mockResolvedValue(undefined);

    render(<LocationChatCircles token="owner-token" ownerId="owner" suggestedCircleName="Family" suggestedPersonName="Riley" />);
    fireEvent.click(await screen.findByRole("button", { name: "Family" }));

    const secondDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(second.joinedAt));
    expect(mock.removeNamedCircleMember).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: `Remove Riley, joined ${secondDate}` }));
    expect(mock.removeNamedCircleMember).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove member" }));
    expect(await screen.findByText("Removed Riley from Family.")).toBeInTheDocument();
    expect(mock.listCircleMembersPage).toHaveBeenCalledWith({ page: 2, circleId: "family", limit: 100, vaultOwnerToken: "owner-token" });
    expect(mock.removeNamedCircleMember).toHaveBeenCalledExactlyOnceWith({
      vaultOwnerToken: "owner-token", circleId: "family", memberUserId: "riley-second",
    });
    expect(window.location.pathname).toBe("/");
  });

  it("does not remove a member who rejoined after their original membership was reviewed", async () => {
    const member = { userId: "riley", displayName: "Riley", role: "member", joinedAt: "2026-08-02T12:00:00Z" };
    const rejoined = { ...member, joinedAt: "2026-11-01T12:00:00Z" };
    mock.listCircleMembersPage
      .mockResolvedValueOnce({ items: [member], page: 1, hasMore: false, totalCount: 1 })
      .mockResolvedValue({ items: [rejoined], page: 1, hasMore: false, totalCount: 1 });

    render(<LocationChatCircles token="owner-token" ownerId="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Family" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Remove Riley/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove member" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("This Circle changed.");
    expect(mock.removeNamedCircleMember).not.toHaveBeenCalled();
  });

  it("sends only the new name when the Circle type was not edited", async () => {
    mock.listCircleMembersPage.mockResolvedValue({ items: [], page: 1, hasMore: false, totalCount: 0 });
    mock.updateNamedCircle.mockResolvedValue({ ...circle, name: "Family travel" });

    render(<LocationChatCircles token="owner-token" ownerId="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Family" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit name or type" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Circle name" }), { target: { value: "Family travel" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mock.updateNamedCircle).toHaveBeenCalledExactlyOnceWith({
      vaultOwnerToken: "owner-token", circleId: "family", name: "Family travel",
    }));
  });

  it("requires a new scope review when the automatic approval rule changed elsewhere", async () => {
    mock.getLocationAccountSettings.mockResolvedValue({ user_id: "owner", sharingState: "off", precision: "precise" });
    mock.getMapPreferences.mockResolvedValue({ presenceMode: "ghost" });
    mock.getState
      .mockResolvedValueOnce({ autoApprovePreference: { enabled: false, scope: null, ruleVersion: 1 } })
      .mockResolvedValueOnce({ autoApprovePreference: { enabled: true, scope: { kind: "all_contacts" }, ruleVersion: 2 } });

    render(<LocationChatSettings token="owner-token" ownerId="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Choose approval scope" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Family" }));
    fireEvent.click(screen.getByRole("button", { name: "Review scope" }));
    fireEvent.click(screen.getByRole("button", { name: "Save approval scope" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Automatic approval changed.");
    expect(mock.updateAutoApprovePreference).not.toHaveBeenCalled();
    expect(screen.getByText("On for all contacts")).toBeInTheDocument();
  });

  it("reviews the named Circle directly in Chat and publishes the saved approval preference", async () => {
    const owner = "auto-approval-owner";
    const preference = { enabled: true, scope: { kind: "circles", circleIds: ["family"] }, ruleVersion: 2 };
    mock.getState.mockResolvedValue({ autoApprovePreference: { enabled: false, scope: null, ruleVersion: 1 } });
    mock.updateAutoApprovePreference.mockResolvedValue(preference);
    const onChanged = vi.fn();
    render(<LocationChatSettings token="owner-token" ownerId={owner} autoApprovalIntent="enable"
      suggestedCircles={["Family"]} onChanged={onChanged} />);

    expect(await screen.findByRole("checkbox", { name: "Family" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "All contacts" })).not.toBeChecked();
    expect(mock.getMapPreferences).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review scope" }));
    expect(screen.getByText(/Automatically approve new requests from Family/)).toBeInTheDocument();
    expect(mock.updateAutoApprovePreference).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save approval scope" }));

    expect(await screen.findByText("On for Family")).toBeInTheDocument();
    expect(mock.updateAutoApprovePreference).toHaveBeenCalledExactlyOnceWith({
      vaultOwnerToken: "owner-token", enabled: true, scope: preference.scope,
    });
    expect(OneLocationStateResource.readPresentation(owner)?.autoApprovePreference).toEqual(preference);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(window.location.pathname).toBe(ROUTES.HOME);
  });

  it("saves standing approval only after the owner types the Circle and confirms its scope", async () => {
    const scope = { kind: "circles", circleIds: ["family"] };
    mock.getState.mockResolvedValue({ autoApprovePreference: { enabled: false, ruleVersion: 1 } });
    mock.listCircles.mockResolvedValue([circle]);
    mock.updateAutoApprovePreference.mockResolvedValue({ enabled: true, scope, ruleVersion: 2 });
    const transcript = vi.fn();
    const input: { handle?: LocationConversationReply | null } = {};
    const reply = (answer: string) => input.handle?.(answer, transcript.mock.lastCall?.[0]);
    render(<LocationChatSettings token="token" ownerId="owner" autoApprovalIntent="enable"
      onConversationText={transcript} onConversationReply={(handler) => { input.handle = handler; }} />);
    await waitFor(() => expect(transcript).toHaveBeenLastCalledWith(expect.stringContaining("Whose location requests")));
    expect(screen.queryByRole("checkbox")).toBeNull();
    act(() => { expect(reply("Family")).toBe(true); });
    await waitFor(() => expect(transcript).toHaveBeenLastCalledWith(expect.stringContaining("new requests from Family")));
    expect(reply("yes, but use all contacts")).toBeFalsy();
    expect(mock.updateAutoApprovePreference).not.toHaveBeenCalled();
    await act(async () => { reply("yes"); });
    expect(mock.updateAutoApprovePreference).toHaveBeenCalledExactlyOnceWith({ vaultOwnerToken: "token", enabled: true, scope });
    expect(transcript).toHaveBeenLastCalledWith(expect.stringContaining("Automatic approval is on"));
  });

  it.each([[], ["Family", "Missing"], ["Family", "Team"]])("requires an explicit scope for unresolved or ambiguous audience hints %j", async (...names: string[]) => {
    mock.getState.mockResolvedValue({ autoApprovePreference: { enabled: false, scope: null, ruleVersion: 1 } });
    mock.listCircles.mockResolvedValue([circle, { ...circle, id: "team-a", name: "Team" }, { ...circle, id: "team-b", name: "Team" }]);
    render(<LocationChatSettings token="owner-token" ownerId="owner" autoApprovalIntent="enable" suggestedCircles={names} />);
    expect(await screen.findByRole("button", { name: "Review scope" })).toBeDisabled();
    expect(screen.getAllByRole("checkbox").every((checkbox) => !(checkbox as HTMLInputElement).checked)).toBe(true);
    expect(mock.updateAutoApprovePreference).not.toHaveBeenCalled();
  });

  it("offers a direct off confirmation and persists it only when pressed", async () => {
    mock.getState.mockResolvedValue({ autoApprovePreference: { enabled: true, scope: { kind: "all_contacts" }, ruleVersion: 2 } });
    mock.updateAutoApprovePreference.mockResolvedValue({ enabled: false, scope: null, ruleVersion: 3 });
    render(<LocationChatSettings token="owner-token" ownerId="owner" autoApprovalIntent="disable" />);
    const confirm = await screen.findByRole("button", { name: "Turn off auto-approval" });
    expect(mock.listCircles).not.toHaveBeenCalled();
    expect(mock.updateAutoApprovePreference).not.toHaveBeenCalled();
    fireEvent.click(confirm);
    expect(await screen.findByText("Automatic approval is off.")).toBeInTheDocument();
    expect(mock.updateAutoApprovePreference).toHaveBeenCalledExactlyOnceWith({
      vaultOwnerToken: "owner-token", enabled: false, scope: null,
    });
  });

  it("restores a nearby check-in with a link to its canonical screen without capturing location", () => {
    const capture = vi.fn();
    render(<LocationChatCheckIn proposal={{ id: "proposal", action: "nearby_check_in" }}
      token="owner-token" ownerId="owner" capturePoint={capture} renderPoint={() => null} onBack={vi.fn()} onChanged={vi.fn()} />);
    expect(screen.getByRole("link", { name: "Open check-in" })).toHaveAttribute("href", ROUTES.ONE_LOCATION_CHECK_IN);
    expect(window.location.pathname).toBe(ROUTES.HOME);
    expect(capture).not.toHaveBeenCalled();
  });

  it("requires separate acknowledgement before switching off an active emergency share", async () => {
    const account = { user_id: "owner", sharingState: "on", sharingConsentAcceptedAt: "2026-11-01T00:00:00Z", precision: "precise" };
    const saved = { ...account, sharingState: "off" };
    mock.getLocationAccountSettings.mockResolvedValue(account);
    mock.getMapPreferences.mockResolvedValue({ presenceMode: "ghost" });
    mock.getState.mockResolvedValue({});
    mock.updateLocationAccountSettings
      .mockRejectedValueOnce({ code: "LOCATION_SOS_ACTIVE" })
      .mockResolvedValueOnce({ settings: saved, transition: { changed: true, revoked_grant_ids: ["sos"], revoked_link_ids: [] } });

    render(<LocationChatSettings token="owner-token" ownerId="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off sharing" }));
    expect(mock.updateLocationAccountSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Turn off", exact: true }));
    const includeSos = await screen.findByRole("button", { name: "Turn off including Save My Soul" });
    expect(mock.updateLocationAccountSettings).toHaveBeenCalledExactlyOnceWith("owner-token", { sharingState: "off", includeSos: false });
    expect(mock.writeAccountSettings).not.toHaveBeenCalled();

    fireEvent.click(includeSos);
    await waitFor(() => expect(mock.writeAccountSettings).toHaveBeenCalledWith("owner", saved));
    expect(mock.updateLocationAccountSettings).toHaveBeenLastCalledWith("owner-token", { sharingState: "off", includeSos: true });
    expect(window.location.pathname).toBe("/");
  });

  it("pauses updates only after confirmation and reports an unverified Nearby checkout", async () => {
    const ownerId = "device-pause-owner";
    mock.getLocationAccountSettings.mockResolvedValue({ user_id: ownerId, sharingState: "on", precision: "precise" });
    mock.getMapPreferences.mockResolvedValue({ presenceMode: "ghost" });
    mock.getState.mockResolvedValue({});
    mock.checkoutNearby.mockRejectedValueOnce(new Error("Unavailable"));

    render(<LocationChatSettings token="owner-token" ownerId={ownerId} />);
    fireEvent.click(await screen.findByRole("button", { name: "Pause updates" }));
    expect(readOneLocationControlState(ownerId).paused).toBe(false);
    expect(mock.checkoutNearby).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Pause updates" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Nearby checkout could not be confirmed");
    expect(readOneLocationControlState(ownerId).paused).toBe(true);
    expect(mock.checkoutNearby).toHaveBeenCalledExactlyOnceWith({ vaultOwnerToken: "owner-token" });
    expect(mock.updateLocationAccountSettings).not.toHaveBeenCalled();
  });
});
