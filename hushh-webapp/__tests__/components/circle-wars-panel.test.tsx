import { createContext } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircleWarsPanel } from "@/components/profile/circle-wars-panel";
import { VaultContext } from "@/lib/vault/vault-context";
import { CircleWarsService, type CircleWarsState, type CircleWarsTeam } from "@/lib/services/circle-wars-service";
import { OneLocationService } from "@/lib/one-location/service";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { ApiError } from "@/lib/services/api-client";

vi.mock("@/lib/vault/vault-context", () => ({ VaultContext: createContext(null) }));
vi.mock("@/lib/cache/cache-sync-service", () => ({ CacheSyncService: { onOneLocationStateMutated: vi.fn() } }));
vi.mock("@/lib/one-location/service", () => ({ OneLocationService: { listCircles: vi.fn(), createNamedCircle: vi.fn() } }));
vi.mock("@/lib/services/circle-wars-service", () => ({ CircleWarsService: { getState: vi.fn(), getLeaderboard: vi.fn(), optIn: vi.fn() } }));
// The shared Circle form has its own existing behavioral suite. Here its submit
// port exercises this host's real creation and separate enrollment lifecycle.
vi.mock("@/components/one-location/redesign/circles/named-circle-flows", () => ({
  CreateCircleFlow: ({ onSubmit, onComplete, busy }: { onSubmit: (name: string, kind: string) => Promise<{ id: string }>; onComplete: (circleId: string) => void; busy: boolean }) =>
    <button disabled={busy} onClick={() => void onSubmit("New real Circle", "friends").then((circle) => onComplete(circle.id)).catch(() => {})}>Submit existing Circle form</button>,
}));

const team: CircleWarsTeam = {
  team_key: "team-key", circle_id: "circle-existing", name: "My Circle", anonymous: false,
  rank: 4, participating_members: 6, qualified_referrals: 8, is_your_circle: true,
  next_rank: 3, referrals_to_next_rank: 2, relative_progress: 0.5,
};
const empty: CircleWarsState = {
  period: { round_id: "round-one", week_start: "2026-10-12", starts_at: "2026-10-12T00:00:00Z", ends_at: "2026-10-19T00:00:00Z", timezone: "UTC", server_now: "2026-10-16T15:00:00Z", seconds_remaining: 205200 },
  participation: null,
};
const active: CircleWarsState = { ...empty, participation: { status: "active", opted_in_at: "2026-10-16T15:00:00Z", team } };
const circle = { id: "circle-existing", name: "My Circle", kind: "friends" as const, role: "owner" as const, memberCount: 9, memberLimit: 100 };
const onInvite = vi.fn();
const onViewRankings = vi.fn();

function panel({ owner = "alice", locked = false, view = "card" as "card" | "leaderboard" } = {}) {
  return <VaultContext.Provider value={locked ? null : { vaultOwnerToken: "memory-owner-token" } as never}>
    <CircleWarsPanel userId={owner} view={view} refreshKey={0} onInvite={onInvite} onViewRankings={onViewRankings} />
  </VaultContext.Provider>;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(CircleWarsService.getState).mockResolvedValue(empty);
  vi.mocked(CircleWarsService.optIn).mockResolvedValue(active);
  vi.mocked(CircleWarsService.getLeaderboard).mockResolvedValue({ period: empty.period, teams: [], total_teams: 0, offset: 0, limit: 10, has_more: false });
  vi.mocked(OneLocationService.listCircles).mockResolvedValue([circle]);
});
afterEach(() => vi.useRealTimers());

describe("Circle Wars", () => {
  it("requires explicit selection and enrollment of an existing Circle", async () => {
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Join Circle Wars" }));
    const dialog = screen.getByRole("dialog");
    const option = await within(dialog).findByRole("radio", { name: /My Circle/ });
    expect(within(dialog).getByText("9 members")).toBeTruthy();
    expect(CircleWarsService.optIn).not.toHaveBeenCalled();
    fireEvent.click(option);
    vi.mocked(CircleWarsService.getState).mockResolvedValue(active);
    fireEvent.click(within(dialog).getByRole("button", { name: "Join with this Circle" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(CircleWarsService.optIn).toHaveBeenCalledExactlyOnceWith("memory-owner-token", circle.id);
    expect(await screen.findByText("6 participating members")).toBeTruthy();
    expect(screen.getByText("You're 2 referrals away from Rank #3!")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Invite Friends" }));
    fireEvent.click(screen.getByRole("button", { name: "View Rankings" }));
    expect(onInvite).toHaveBeenCalledOnce();
    expect(onViewRankings).toHaveBeenCalledOnce();
  });

  it("reuses creation without automatically enrolling the new Circle", async () => {
    vi.mocked(OneLocationService.listCircles).mockResolvedValue([]);
    vi.mocked(OneLocationService.createNamedCircle).mockResolvedValue({ ...circle, id: "new-circle", name: "New real Circle", members: [] } as never);
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Join Circle Wars" }));
    expect(await screen.findByText(/You have no Circles yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create New Circle" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit existing Circle form" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /New real Circle/ })).toBeChecked());
    expect(OneLocationService.createNamedCircle).toHaveBeenCalledExactlyOnceWith({ vaultOwnerToken: "memory-owner-token", name: "New real Circle", kind: "friends" });
    expect(CacheSyncService.onOneLocationStateMutated).toHaveBeenCalledWith("alice", ["workspace", "circles", "sms_roster"], { notificationType: "location_circle_created", circleId: "new-circle" });
    expect(CircleWarsService.optIn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Join with this Circle" }));
    await waitFor(() => expect(CircleWarsService.optIn).toHaveBeenCalledExactlyOnceWith("memory-owner-token", "new-circle"));
  });

  it("keeps selection retryable after an enrollment failure and prevents duplicate presses", async () => {
    let rejectJoin: (cause: Error) => void = () => {};
    vi.mocked(CircleWarsService.optIn).mockImplementation(() => new Promise((_resolve, reject) => { rejectJoin = reject; }));
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Join Circle Wars" }));
    fireEvent.click(await screen.findByRole("radio", { name: /My Circle/ }));
    const join = screen.getByRole("button", { name: "Join with this Circle" });
    fireEvent.click(join);
    fireEvent.click(join);
    expect(CircleWarsService.optIn).toHaveBeenCalledOnce();
    rejectJoin(new Error("offline"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Join with this Circle" })).not.toBeDisabled());
    expect(screen.getByRole("radio", { name: /My Circle/ })).toBeChecked();
    vi.mocked(CircleWarsService.optIn).mockResolvedValue(active);
    vi.mocked(CircleWarsService.getState).mockResolvedValue(active);
    fireEvent.click(screen.getByRole("button", { name: "Join with this Circle" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("renders real standings, your highlight and server pagination", async () => {
    vi.mocked(CircleWarsService.getState).mockResolvedValue(active);
    vi.mocked(CircleWarsService.getLeaderboard).mockResolvedValue({ period: empty.period, teams: [team], total_teams: 40, offset: 0, limit: 10, has_more: true });
    render(panel({ view: "leaderboard" }));
    const row = await screen.findByText("My Circle");
    expect(screen.queryByRole("timer")).toBeNull();
    expect(screen.queryByRole("button", { name: "Join Circle Wars" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite Friends" })).toBeNull();
    expect(row.closest("li")).toHaveAttribute("data-viewer", "true");
    expect(screen.queryByText("1 circle")).toBeNull();
    expect(screen.queryByText("Rank")).toBeNull();
    expect(screen.queryByText("Referrals")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(within(row.closest("li")!).getByText("Rank 4")).toBeTruthy();
    expect(screen.getByText("8")).toBeTruthy();
    vi.mocked(CircleWarsService.getLeaderboard).mockResolvedValue({ period: empty.period, teams: [team], total_teams: 40, offset: 10, limit: 10, has_more: false });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(CircleWarsService.getLeaderboard).toHaveBeenLastCalledWith("memory-owner-token", 10));
  });

  it("does not display old private names after account changes or lock", async () => {
    vi.mocked(CircleWarsService.getState).mockResolvedValue(active);
    const view = render(panel());
    expect(await screen.findByText("My Circle")).toBeTruthy();
    vi.mocked(CircleWarsService.getState).mockImplementation(() => new Promise(() => {}));
    view.rerender(panel({ owner: "bob" }));
    expect(screen.queryByText("My Circle")).toBeNull();
    view.rerender(panel({ locked: true }));
    expect(screen.queryByText("My Circle")).toBeNull();
    expect(screen.getByText(/Open your vault/)).toBeTruthy();
  });

  it("offers retries for server and Circle-list errors without presenting an empty account", async () => {
    vi.mocked(CircleWarsService.getState).mockRejectedValueOnce(new Error("offline"));
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    fireEvent.click(await screen.findByRole("button", { name: "Join Circle Wars" }));
    vi.mocked(OneLocationService.listCircles).mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Join Circle Wars" }));
    expect(await screen.findByText("Could not load your Circles.")).toBeTruthy();
    expect(screen.queryByText(/You have no Circles yet/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try loading Circles again" }));
    expect(await screen.findByRole("radio", { name: /My Circle/ })).toBeTruthy();
  });

  it("does not let an older Circle-list response erase the newly created selection", async () => {
    let finishList: (value: typeof circle[]) => void = () => {};
    vi.mocked(OneLocationService.listCircles).mockImplementation(() => new Promise((resolve) => { finishList = resolve; }));
    vi.mocked(OneLocationService.createNamedCircle).mockResolvedValue({ ...circle, id: "new-circle", name: "New real Circle", members: [] } as never);
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Join Circle Wars" }));
    fireEvent.click(screen.getByRole("button", { name: "Create New Circle" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit existing Circle form" }));
    expect(await screen.findByRole("radio", { name: /New real Circle/ })).toBeChecked();
    await act(async () => finishList([circle]));
    expect(screen.getByRole("radio", { name: /New real Circle/ })).toBeChecked();
  });

  it("does not skip leaderboard pages on repeated presses or failed page reads", async () => {
    const firstPage = { period: empty.period, teams: [team], total_teams: 40, offset: 0, limit: 10, has_more: true };
    vi.mocked(CircleWarsService.getLeaderboard).mockResolvedValue(firstPage);
    render(panel({ view: "leaderboard" }));
    const next = await screen.findByRole("button", { name: "Next" });
    let rejectPage: (cause: Error) => void = () => {};
    vi.mocked(CircleWarsService.getLeaderboard).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPage = reject; }));
    fireEvent.click(next);
    fireEvent.click(next);
    await waitFor(() => expect(CircleWarsService.getLeaderboard).toHaveBeenLastCalledWith("memory-owner-token", 10));
    expect(vi.mocked(CircleWarsService.getLeaderboard).mock.calls.every(([, offset]) => (offset ?? 0) <= 10)).toBe(true);
    await act(async () => rejectPage(new Error("offline")));
    await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).not.toBeDisabled());
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
  });

  it.each(["button", "escape"])("recovers Circle selection through %s after failed creation invalidates a pending listing", async (back) => {
    vi.mocked(OneLocationService.listCircles).mockImplementationOnce(() => new Promise(() => {}));
    vi.mocked(OneLocationService.createNamedCircle).mockRejectedValueOnce(new Error("offline"));
    render(panel());
    fireEvent.click(await screen.findByRole("button", { name: "Join Circle Wars" }));
    fireEvent.click(screen.getByRole("button", { name: "Create New Circle" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit existing Circle form" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Back to Circles" })).not.toBeDisabled());
    if (back === "escape") fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    else fireEvent.click(screen.getByRole("button", { name: "Back to Circles" }));
    expect(await screen.findByRole("radio", { name: /My Circle/ })).toBeTruthy();
    expect(CircleWarsService.optIn).not.toHaveBeenCalled();
  });

  it("clears previously authorized private content on an authority failure", async () => {
    vi.mocked(CircleWarsService.getState).mockResolvedValue(active);
    render(panel());
    expect(await screen.findByText("My Circle")).toBeTruthy();
    vi.mocked(CircleWarsService.getState).mockRejectedValue(new ApiError("expired", 403));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(screen.queryByText("My Circle")).toBeNull());
    expect(screen.getByText(/Circle Wars could not refresh/)).toBeTruthy();
  });

  it("returns to the first leaderboard page when the weekly period rolls over", async () => {
    const firstPage = { period: empty.period, teams: [team], total_teams: 40, offset: 0, limit: 10, has_more: true };
    vi.mocked(CircleWarsService.getLeaderboard).mockResolvedValue(firstPage);
    render(panel({ view: "leaderboard" }));
    const next = await screen.findByRole("button", { name: "Next" });
    vi.mocked(CircleWarsService.getLeaderboard).mockResolvedValue({ ...firstPage, offset: 10, has_more: false });
    fireEvent.click(next);
    expect(await screen.findByRole("button", { name: "Previous" })).toBeTruthy();
    const newPeriod = { ...empty.period, round_id: "round-two", week_start: "2026-10-19" };
    vi.mocked(CircleWarsService.getState).mockResolvedValue({ ...empty, period: newPeriod });
    vi.mocked(CircleWarsService.getLeaderboard).mockRejectedValueOnce(new Error("offline during rollover")).mockImplementation(async (_token, offset = 0) => ({
      ...firstPage, period: newPeriod, offset, total_teams: 1, has_more: false,
      teams: offset === 0 ? [{ ...team, name: "New week Circle", rank: 1 }] : [],
    }));
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText(/Circle Wars could not refresh/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("New week Circle")).toBeTruthy();
    expect(CircleWarsService.getLeaderboard).toHaveBeenLastCalledWith("memory-owner-token", 0);
    expect(screen.queryByRole("button", { name: "Previous" })).toBeNull();
    expect(screen.queryByText(/No participating Circles yet/)).toBeNull();
  });

  it("uses the configured weekly timezone", async () => {
    vi.mocked(CircleWarsService.getState).mockResolvedValue({ ...active, period: { ...active.period, timezone: "Asia/Kolkata" } });
    render(panel());
    expect(await screen.findByRole("timer", { name: /Asia\/Kolkata/ })).toBeTruthy();
  });

  it("refreshes at the server cutoff and does not spin on an expired response", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance"] });
    const nearCutoff = { ...empty, period: { ...empty.period, server_now: "2026-10-18T23:59:57Z", seconds_remaining: 3 } };
    vi.mocked(CircleWarsService.getState).mockResolvedValueOnce(nearCutoff).mockResolvedValue({
      ...empty, period: { ...empty.period, server_now: empty.period.ends_at, seconds_remaining: 0 },
    });
    await act(async () => { render(panel()); });
    expect(CircleWarsService.getState).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("timer")).toHaveTextContent("3s left");
    await act(async () => { await vi.advanceTimersByTimeAsync(3001); });
    expect(CircleWarsService.getState).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("timer")).toHaveTextContent("New round starting");
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(CircleWarsService.getState).toHaveBeenCalledTimes(2);
  });
});
