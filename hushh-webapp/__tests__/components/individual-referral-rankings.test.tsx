import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "firebase/auth";
import { IndividualReferralRankings } from "@/components/referrals/individual-referral-rankings";
import { ReferralService, type LeaderboardPage } from "@/lib/services/referral-service";

vi.mock("@/lib/services/referral-service", () => ({ ReferralService: { getLeaderboard: vi.fn() } }));
const owner = { uid: "owner", getIdToken: vi.fn().mockResolvedValue("memory-token") } as unknown as User;
const onRefresh = vi.fn();
const makePage = (start: number, next: number | null): LeaderboardPage => ({
  snapshot_id: "snapshot-one", next_after_rank: next, stale: false, snapshot_generated_at: null,
  entries: Array.from({ length: 10 }, (_, index) => ({
    rank: start + index, handle: `Member ${start + index}`, points: 1000 - start - index, is_viewer: false,
  })), viewer: { rank: 41, handle: "Owner", points: 100, is_viewer: true },
});
beforeEach(() => { vi.clearAllMocks(); });

describe("individual ranking pagination", () => {
  it("shows ten entries and navigates both directions on one snapshot without duplicate presses", async () => {
    let finish: (page: LeaderboardPage) => void = () => {};
    vi.mocked(ReferralService.getLeaderboard).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    render(<IndividualReferralRankings firstPage={makePage(1, 10)} user={owner} onRefresh={onRefresh} />);
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(10);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(ReferralService.getLeaderboard).toHaveBeenCalledExactlyOnceWith({ idToken: "memory-token", limit: 10, afterRank: 10, snapshotId: "snapshot-one" }));
    await act(async () => finish(makePage(11, 20)));
    expect(screen.getByText("Page 2")).toBeTruthy();
    expect(screen.getByText("Member 11")).toBeTruthy();
    vi.mocked(ReferralService.getLeaderboard).mockResolvedValueOnce(makePage(1, 10));
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(await screen.findByText("Page 1")).toBeTruthy();
    expect(ReferralService.getLeaderboard).toHaveBeenLastCalledWith({ idToken: "memory-token", limit: 10, afterRank: 0, snapshotId: "snapshot-one" });
  });

  it("takes the owner to their page rather than inserting an eleventh entry", async () => {
    vi.mocked(ReferralService.getLeaderboard).mockResolvedValue(makePage(41, null));
    render(<IndividualReferralRankings firstPage={makePage(1, 10)} user={owner} onRefresh={onRefresh} />);
    expect(screen.queryByText("Owner")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Your rank #41" }));
    expect(await screen.findByText("Page 5")).toBeTruthy();
    expect(ReferralService.getLeaderboard).toHaveBeenLastCalledWith({ idToken: "memory-token", limit: 10, afterRank: 40, snapshotId: "snapshot-one" });
    expect(within(screen.getByRole("list")).getAllByRole("listitem")).toHaveLength(10);
  });

  it("keeps the current page on failure and handles a legacy empty last-page continuation", async () => {
    vi.mocked(ReferralService.getLeaderboard).mockRejectedValueOnce(new Error("offline"));
    render(<IndividualReferralRankings firstPage={makePage(1, 10)} user={owner} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/Could not load that page/)).toBeTruthy();
    expect(screen.getByText("Member 1")).toBeTruthy();
    vi.mocked(ReferralService.getLeaderboard).mockResolvedValueOnce({ ...makePage(11, null), entries: [] });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Next" })).toBeNull());
    expect(screen.getByText("Page 1")).toBeTruthy();
    expect(screen.getByText("Member 1")).toBeTruthy();
  });

  it("refreshes the first page when a pinned snapshot has expired", async () => {
    vi.mocked(ReferralService.getLeaderboard).mockResolvedValue({ entries: [], viewer: null, stale: true, snapshot_generated_at: null });
    render(<IndividualReferralRankings firstPage={makePage(1, 10)} user={owner} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledOnce());
    expect(screen.getByText("Member 1")).toBeTruthy();
    expect(screen.queryByText("No entries yet.")).toBeNull();
  });

  it("preserves the browsing snapshot during background refresh until latest rankings is selected", async () => {
    vi.mocked(ReferralService.getLeaderboard).mockResolvedValue(makePage(11, 20));
    const view = render(<IndividualReferralRankings firstPage={makePage(1, 10)} user={owner} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Page 2")).toBeTruthy();
    const latest = { ...makePage(1, 10), snapshot_id: "snapshot-two" };
    view.rerender(<IndividualReferralRankings firstPage={latest} user={owner} onRefresh={onRefresh} />);
    expect(screen.getByText("Page 2")).toBeTruthy();
    expect(screen.getByText("Member 11")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Latest rankings" }));
    expect(screen.getByText("Page 1")).toBeTruthy();
    expect(screen.queryByText("Member 11")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(ReferralService.getLeaderboard).toHaveBeenLastCalledWith({ idToken: "memory-token", limit: 10, afterRank: 10, snapshotId: "snapshot-two" }));
  });
});
