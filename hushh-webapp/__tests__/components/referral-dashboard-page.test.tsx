import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  getIdToken: vi.fn(),
  getSummary: vi.fn(),
  getPoints: vi.fn(),
  getPolicy: vi.fn(),
  getLeaderboard: vi.fn(),
  getCircleLeaderboard: vi.fn(),
  getMilestones: vi.fn(),
  getEngagement: vi.fn(),
  getChallenge: vi.fn(),
  getCircleSelection: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));

let currentUser: { uid: string; getIdToken: typeof mocks.getIdToken } | null = {
  uid: "user-a",
  getIdToken: mocks.getIdToken,
};

vi.mock("@/lib/firebase/auth-context", () => ({
  useAuth: () => ({ user: currentUser }),
}));

vi.mock("@/lib/referral/use-referral-stream", () => ({
  useReferralStream: () => ({ connected: true }),
}));

vi.mock("@/lib/services/referral-service", () => ({
  ReferralService: {
    getSummary: mocks.getSummary,
    getPoints: mocks.getPoints,
    getPolicy: mocks.getPolicy,
    getLeaderboard: mocks.getLeaderboard,
    getCircleLeaderboard: mocks.getCircleLeaderboard,
    getMilestones: mocks.getMilestones,
    getEngagement: mocks.getEngagement,
    getChallenge: mocks.getChallenge,
    getCircleSelection: mocks.getCircleSelection,
  },
}));

import { ReferralDashboardPage, formatCountdown } from "@/components/referrals/referral-dashboard-page";

const SUMMARY = {
  slug: "ankit-42",
  link: "https://one.hushh.ai/r/ankit-42-real",
  qualified_count: 11,
  in_progress_count: 4,
  under_review_count: 0,
  required_active_minutes: 30,
  new_users_only: true,
  referrals: [],
};

function neverResolves<T = unknown>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe("formatCountdown", () => {
  it("formats total hours:minutes:seconds, not days+hours", () => {
    // 137h 22m 10s, matching the reference design's example -- the total
    // must stay in the hours column rather than rolling over into a day
    // count once it exceeds 24 hours.
    const ms = (137 * 3600 + 22 * 60 + 10) * 1000;
    expect(formatCountdown(ms)).toBe("137:22:10");
  });

  it("clamps an expired deadline to 00:00:00, never a negative value", () => {
    expect(formatCountdown(-5000)).toBe("00:00:00");
    expect(formatCountdown(0)).toBe("00:00:00");
  });
});

describe("ReferralDashboardPage", () => {
  it("hides incompatible backend rewards until the new catalogue is active", async () => {
    mocks.getMilestones.mockResolvedValue({
      lifetime_qualified_count: 0,
      earned: [],
      next_milestone: null,
      available_milestones: [
        { milestone_key: "current_reward", threshold: 42, reward: "Current program reward" },
      ],
    });
    await act(async () => { render(<ReferralDashboardPage />); });
    expect(await screen.findByText("Rewards policy unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Current program reward")).toBeNull();
    expect(screen.queryByText("42 referrals")).toBeNull();
    expect(screen.queryByText("₹250 Amazon voucher")).toBeNull();
    expect(screen.queryByText("All milestones earned. Incredible work.")).toBeNull();
  });

  it("keeps loaded content visible and deduplicates focus refreshes", async () => {
    render(<ReferralDashboardPage />);
    await screen.findByText("2,450");
    mocks.getSummary.mockReturnValue(neverResolves());
    mocks.getPoints.mockReturnValue(neverResolves());
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.queryByText("Loading your referrals…")).toBeNull();
    expect(screen.getByText("2,450")).toBeInTheDocument();
    expect(mocks.getSummary).toHaveBeenCalledTimes(2);
    expect(mocks.getPoints).toHaveBeenCalledTimes(2);
  });

  it("shows rules independently of a pending summary and navigates back to One", async () => {
    mocks.getSummary.mockReturnValue(neverResolves());
    render(<ReferralDashboardPage />);
    expect(await screen.findByText("100 points")).toBeInTheDocument();
    expect(screen.getByText("Loading your referrals…")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to One home" }));
    expect(mocks.push).toHaveBeenCalledWith("/one");
  });

  it("renders Rules amounts from the active backend policy", async () => {
    mocks.getPolicy.mockResolvedValue({ version: 3, points: { qualified_referral_points: 123, flash_window_total_points: 246 }, streak_rules: { run_length_days: 3, bonus_points: 17 }, challenge_duration_days: 7, weekly_prizes_enabled: false });
    render(<ReferralDashboardPage />);
    await screen.findByText("Weekly challenge ends in");
    expect(await screen.findByText("123 points")).toBeInTheDocument();
    expect(screen.getByText("+17 points")).toBeInTheDocument();
    expect(screen.getByText("246 total")).toBeInTheDocument();
  });

  it.each([
    [0, "₹250 Amazon voucher", 10], [9, "₹250 Amazon voucher", 10],
    [10, "Wireless earbuds", 100], [99, "Wireless earbuds", 100],
    [100, "Apple AirPods", 500], [499, "Apple AirPods", 500],
    [500, "iPhone", 10000], [9999, "iPhone", 10000],
    [10000, null, null], [12000, null, null],
  ] as const)("selects the correct reward at %s qualified referrals", async (count, title, threshold) => {
    mocks.getMilestones.mockResolvedValue({
      lifetime_qualified_count: count, earned: [], next_milestone: null,
      available_milestones: [
        { milestone_key: "voucher_10", threshold: 10, reward: "₹250 Amazon voucher" },
        { milestone_key: "earbuds_100", threshold: 100, reward: "Wireless earbuds, worth ₹10,000" },
        { milestone_key: "airpods_500", threshold: 500, reward: "Apple AirPods, worth ₹30,000" },
        { milestone_key: "iphone_10000", threshold: 10000, reward: "iPhone" },
      ],
    });
    render(<ReferralDashboardPage />);
    await screen.findByText("Weekly challenge ends in");
    expect(within(screen.getByRole("region", { name: "Rewards" })).getAllByRole("heading", { level: 4 })).toHaveLength(4);
    if (title && threshold) {
      expect(screen.getByRole("heading", { level: 3, name: title })).toBeInTheDocument();
      expect(screen.getByRole("progressbar", { name: `${title} milestone` })).toHaveAttribute(
        "aria-valuetext", `${Number(count).toLocaleString("en-IN")} of ${threshold.toLocaleString("en-IN")} qualified referrals; ${(threshold - Number(count)).toLocaleString("en-IN")} more to go`,
      );
    } else {
      expect(screen.getByText("All rewards unlocked")).toBeInTheDocument();
      expect(within(screen.getByRole("region", { name: "Rewards" })).queryByRole("progressbar")).toBeNull();
    }
    expect(screen.queryByText("hushh_tee")).toBeNull();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { uid: "user-a", getIdToken: mocks.getIdToken };
    mocks.getIdToken.mockResolvedValue("token-a");
    mocks.getSummary.mockResolvedValue(SUMMARY);
    mocks.getPoints.mockResolvedValue({ points: 2450 });
    mocks.getPolicy.mockResolvedValue({ version: 2, points: { qualified_referral_points: 100, flash_window_total_points: 200, streak_three_day_bonus_points: 15 }, streak_rules: { run_length_days: 3, bonus_points: 15 }, challenge_duration_days: 7, weekly_prizes_enabled: false });
    mocks.getLeaderboard.mockResolvedValue({
      snapshot_generated_at: null,
      entries: [],
      viewer: null,
      stale: true,
    });
    mocks.getCircleLeaderboard.mockResolvedValue({ teams: [] });
    mocks.getMilestones.mockResolvedValue({
      lifetime_qualified_count: 11,
      earned: [],
      next_milestone: { milestone_key: "earbuds_100", threshold: 100, reward: "Wireless earbuds", progress: 11 },
    });
    mocks.getEngagement.mockResolvedValue({
      streak: { current_run_days: 6, run_length_days: 9 },
      flash: { active: false, ends_at: null },
    });
    mocks.getChallenge.mockResolvedValue({
      active: true,
      week_started_at: new Date(Date.now() - 86_400_000).toISOString(),
      cutoff_at: new Date(Date.now() + 6 * 86_400_000).toISOString(),
      timezone: "Asia/Kolkata",
    });
    mocks.getCircleSelection.mockResolvedValue({ circle_id: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances the day segments at midnight and reloads the backend at weekly rollover", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T23:59:59+05:30"));
    mocks.getChallenge.mockResolvedValue({
      active: true,
      week_started_at: "2026-10-05T00:00:00+05:30",
      cutoff_at: "2026-10-12T00:00:00+05:30",
      timezone: "Asia/Kolkata",
    });
    const view = render(<ReferralDashboardPage />);
    await act(async () => {});
    expect(screen.getByText("72:00:01")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Weekly challenge progress: day 4 of 7" })).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText("72:00:00")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Weekly challenge progress: day 5 of 7" })).toBeInTheDocument();
    view.unmount();
    vi.setSystemTime(new Date("2026-10-11T23:59:59+05:30"));
    render(<ReferralDashboardPage />);
    await act(async () => {});
    mocks.getChallenge.mockResolvedValue({
      active: true,
      week_started_at: "2026-10-12T00:00:00+05:30",
      cutoff_at: "2026-10-19T00:00:00+05:30",
      timezone: "Asia/Kolkata",
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mocks.getChallenge).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("img", { name: "Weekly challenge progress: day 1 of 7" })).toBeInTheDocument();
    expect(screen.getByText("2,450")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "6 day streak" })).toBeInTheDocument();
  });

  it("always renders the dark weekly-challenge card, even while every other resource is loading", async () => {
    // Points, leaderboard, milestones, engagement and circle never resolve;
    // only the page-gating summary does. The timer card must not depend on
    // any of them.
    mocks.getPoints.mockReturnValue(neverResolves());
    mocks.getLeaderboard.mockReturnValue(neverResolves());
    mocks.getMilestones.mockReturnValue(neverResolves());
    mocks.getEngagement.mockReturnValue(neverResolves());
    mocks.getCircleSelection.mockReturnValue(neverResolves());

    render(<ReferralDashboardPage />);

    expect(await screen.findByText("Weekly challenge ends in")).toBeInTheDocument();
    // Seven structural progress segments and Day 1..Day 7 labels are present
    // even though nothing else on the page has resolved yet.
    for (let day = 1; day <= 7; day++) {
      expect(screen.getByText(`Day ${day}`)).toBeInTheDocument();
    }
  });

  it("keeps the timer card visible when the challenge resource itself fails", async () => {
    mocks.getChallenge.mockRejectedValue(new Error("network"));

    render(<ReferralDashboardPage />);

    expect(await screen.findByText("Unable to load")).toBeInTheDocument();
    expect(screen.getByText("Day 1")).toBeInTheDocument();
    expect(screen.getByText("Day 7")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("keeps the reference colours through a route-scoped accent override", async () => {
    render(<ReferralDashboardPage />);

    const clockHeadline = await screen.findByText("Weekly challenge ends in");
    const clockCard = clockHeadline.closest("div") as HTMLElement;
    expect(clockCard.style.background).toContain("#1c1c1e");
    expect(clockCard.style.background).toContain("#242426");

    const copyButton = screen.getByRole("button", { name: "Copy invite link" });
    expect(copyButton.style.background).toBe("var(--app-accent)");
    // The shared token is deliberately overridden at this route, so a saved
    // account accent cannot recolour the approved referral design.
    const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
    const routeStyle = document.createElement("style");
    routeStyle.textContent = css.match(/\.referral-dashboard\s*\{[^}]*\}/)?.[0] ?? "";
    document.head.appendChild(routeStyle);
    try {
      const dashboard = copyButton.closest(".referral-dashboard")!;
      expect(getComputedStyle(dashboard).getPropertyValue("--app-accent").trim()).toBe("#007aff");
    } finally {
      routeStyle.remove();
    }
  });

  it("shows the Day streak flame for an active streak and marks it accessibly", async () => {
    render(<ReferralDashboardPage />);

    expect(await screen.findByText("6")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "6 day streak" })).toBeInTheDocument();
    expect(screen.getByText("9-day bonus target")).toBeInTheDocument();
    expect(screen.queryByText(/best run is/)).toBeNull();
  });

  it("never turns an unavailable streak into a zero", async () => {
    mocks.getEngagement.mockRejectedValue(new Error("network"));

    render(<ReferralDashboardPage />);

    const cell = await screen.findByRole("region", { name: "Referral streak" });
    expect(within(cell).getByText("—")).toBeInTheDocument();
    expect(within(cell).queryByText("0")).toBeNull();
    expect(within(cell).queryByRole("img")).toBeNull();
  });

  it("keeps personal points visible when the leaderboard fails", async () => {
    mocks.getLeaderboard.mockRejectedValue(new Error("network"));

    render(<ReferralDashboardPage />);

    expect(await screen.findByText("2,450")).toBeInTheDocument();
    const rankLabel = screen.getByText("Published rank");
    const rankCell = rankLabel.parentElement as HTMLElement;
    expect(within(rankCell).getByText("Unable to load")).toBeInTheDocument();
  });

  it("discards a stale account's in-flight response after an account switch", async () => {
    let resolvePointsForA: ((value: { points: number }) => void) | undefined;
    mocks.getPoints.mockImplementation(() => {
      return new Promise((resolve) => {
        resolvePointsForA = resolve;
      });
    });

    const { rerender } = render(<ReferralDashboardPage />);
    await screen.findByText("Weekly challenge ends in");

    // Switch accounts before account A's points request resolves.
    currentUser = { uid: "user-b", getIdToken: mocks.getIdToken };
    mocks.getPoints.mockResolvedValue({ points: 9 });
    rerender(<ReferralDashboardPage />);
    await screen.findByText("9");

    // Account A's late response must not overwrite account B's real balance.
    await act(async () => {
      resolvePointsForA?.({ points: 2450 });
    });
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.queryByText("2,450")).toBeNull();
  });
});
