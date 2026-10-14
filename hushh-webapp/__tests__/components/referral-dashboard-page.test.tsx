import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  onReferralChange: () => {},
  claimReward: vi.fn(),
  hasSeenReferralIntroduction: vi.fn(),
  markReferralIntroductionSeen: vi.fn(),
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
  useReferralStream: (_user: unknown, onChange: () => void) => { mocks.onReferralChange = onChange; return { connected: true }; },
}));

vi.mock("@/lib/services/onboarding-local-service", () => ({
  OnboardingLocalService: {
    hasSeenReferralIntroduction: mocks.hasSeenReferralIntroduction,
    markReferralIntroductionSeen: mocks.markReferralIntroductionSeen,
  },
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
    claimReward: mocks.claimReward,
  },
}));

import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { navigateTopShellBack } from "@/lib/navigation/top-shell-back";
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
  it("revalidates a change received while the first request is still in flight", async () => {
    let finish: (value: typeof SUMMARY) => void = () => {};
    mocks.getSummary.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    mocks.getSummary.mockResolvedValue({ ...SUMMARY, qualified_count: 88, in_progress_count: 0, total_count: 88 });
    render(<ReferralDashboardPage />);
    await act(async () => { mocks.onReferralChange(); finish(SUMMARY); });
    expect(await screen.findByText("88")).toBeInTheDocument();
    expect(mocks.getSummary).toHaveBeenCalledTimes(2);
  });
  it("shows the owner's server circle rank outside the first leaderboard page", async () => {
    mocks.getCircleSelection.mockResolvedValue({ circle_id: "network", circle_name: "Our circle", rank: 41, contribution_count: 3 });
    mocks.getCircleLeaderboard.mockResolvedValue({ teams: [] });
    render(<ReferralDashboardPage />);
    expect(await screen.findByText("#41")).toBeInTheDocument();
    expect(screen.getByText("Our circle")).toBeInTheDocument();
  });

  it("keeps a threshold unearned until the backend records an entitlement", async () => {
    mocks.getMilestones.mockResolvedValue({ lifetime_qualified_count: 10, earned: [],
      next_milestone: { milestone_key: "voucher_10", threshold: 10, reward: "Saved voucher", progress: 10 },
      available_milestones: [{ milestone_key: "voucher_10", threshold: 10, reward: "Saved voucher" }],
    });
    render(<ReferralDashboardPage />);
    await screen.findByText("Weekly challenge ends in");
    fireEvent.click(screen.getByRole("tab", { name: "Rewards" }));
    expect(screen.getByText("0 of 1 unlocked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Claim reward" })).toBeNull();
    expect(screen.queryByText("All rewards unlocked")).toBeNull();
  });
  it("renders a configured catalogue without imposing frontend thresholds", async () => {
    mocks.getMilestones.mockResolvedValue({
      lifetime_qualified_count: 0, earned: [],
      next_milestone: { milestone_key: "current_reward", threshold: 42, reward: "Current program reward", progress: 0 },
      available_milestones: [{ milestone_key: "current_reward", threshold: 42, reward: "Current program reward" }],
    });
    await act(async () => { render(<ReferralDashboardPage />); });
    fireEvent.click(screen.getByRole("tab", { name: "Rewards" }));
    expect(await screen.findByRole("heading", { level: 3, name: "Current program reward" })).toBeInTheDocument();
    expect(screen.queryByText("Rewards policy unavailable")).toBeNull();
    expect(screen.queryByText("All rewards unlocked")).toBeNull();
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

  it("shows rules independently of a pending summary and lets shared Back return to One", async () => {
    mocks.getSummary.mockReturnValue(neverResolves());
    render(<ReferralDashboardPage />);
    fireEvent.click(await screen.findByRole("button", { name: "How it works" }));
    expect(await screen.findByText("100 coins")).toBeInTheDocument();
    const navigate = ({ href }: { href: string }) => mocks.push(href);
    act(() => { navigateTopShellBack({ pathname: "/one/referrals", navigate }); });
    expect(screen.getByText("Loading your referrals…")).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
    act(() => { navigateTopShellBack({ pathname: "/one/referrals", navigate }); });
    expect(mocks.push).toHaveBeenCalledWith("/one");
  });

  it("closes sharing before route Back and releases the layer when its pane is inactive or unmounted", async () => {
    let unmount!: () => void;
    await act(async () => { ({ unmount } = render(<ReferralDashboardPage />)); });
    const share = await screen.findByRole("button", { name: "Invite & earn $", expanded: false });
    expect(screen.queryByRole("button", { name: "More share options" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Share on WhatsApp" })).toBeNull();

    fireEvent.click(share);
    expect(screen.getByRole("button", { name: "Close share options", expanded: true })).toBeInTheDocument();
    // The menu must share the trigger's scroll/clipping context. A body portal
    // used to leave floating actions behind or flip them when the page moved.
    expect(screen.getByRole("group", { name: "Share your invite link" })).toContainElement(
      screen.getByRole("link", { name: "Share on WhatsApp" }),
    );
    expect(screen.getByRole("link", { name: "Share by SMS" })).toHaveAttribute(
      "href", `sms:?&body=${encodeURIComponent(`Join me on Hushh One: ${SUMMARY.link}`)}`,
    );
    const navigate = ({ href }: { href: string }) => mocks.push(href);
    act(() => { navigateTopShellBack({ pathname: "/one/referrals", navigate }); });
    expect(screen.getByRole("button", { name: "Invite & earn $", expanded: false })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "More share options" })).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();
    act(() => { navigateTopShellBack({ pathname: "/one/referrals", navigate }); });
    expect(mocks.push).toHaveBeenCalledWith("/one");

    fireEvent.click(share);
    fireEvent.click(screen.getByRole("tab", { name: "Ranking" }));
    expect(unwindBackLayer("/one/referrals")).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "You" }));
    expect(screen.getByRole("button", { name: "Invite & earn $", expanded: false })).toBeInTheDocument();
    fireEvent.click(share);
    unmount();
    expect(unwindBackLayer("/one/referrals")).toBe(false);
  });

  it("restores focus to Invite & earn $ when Escape hides a focused sharing action", async () => {
    await act(async () => { render(<ReferralDashboardPage />); });
    const share = await screen.findByRole("button", { name: "Invite & earn $" });
    fireEvent.click(share);
    const sms = screen.getByRole("link", { name: "Share by SMS" });
    sms.focus();
    fireEvent.keyDown(sms, { key: "Escape" });
    expect(share).toHaveFocus();
    expect(share).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Share by SMS" })).toBeNull();
    expect(unwindBackLayer("/one/referrals")).toBe(false);
  });

  it("preserves outside focus when the sharing bubbles are dismissed", async () => {
    await act(async () => { render(<ReferralDashboardPage />); });
    const share = await screen.findByRole("button", { name: "Invite & earn $" });
    fireEvent.click(share);
    const ranking = screen.getByRole("tab", { name: "Ranking" });
    act(() => { ranking.focus(); });
    await waitFor(() => expect(share).toHaveAttribute("aria-expanded", "false"));
    expect(ranking).toHaveFocus();
    expect(unwindBackLayer("/one/referrals")).toBe(false);
  });

  it("renders Rules amounts from the active backend policy", async () => {
    mocks.getPolicy.mockResolvedValue({ version: 3, points: { qualified_referral_points: 123, flash_window_total_points: 246 }, streak_rules: { run_length_days: 3, bonus_points: 17 }, challenge_duration_days: 7, weekly_prizes_enabled: false });
    render(<ReferralDashboardPage />);
    await screen.findByText("Weekly challenge ends in");
    expect(screen.queryByRole("region", { name: "How referrals work" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "How it works" }));
    expect(screen.queryByRole("button", { name: "View welcome screen" })).not.toBeInTheDocument();
    expect(await screen.findByText("123 coins")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Keep your streak" }).closest("article")).toHaveTextContent("+17 coins");
    expect(screen.getByRole("heading", { name: "Flash boost" }).closest("article")).toHaveTextContent("246 coins");
    act(() => { expect(unwindBackLayer("/one/referrals")).toBe(true); });
    expect(screen.queryByRole("region", { name: "How referrals work" })).not.toBeInTheDocument();
    expect(screen.getByText("Weekly challenge ends in")).toBeInTheDocument();
    expect(mocks.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "How it works" }));
    act(() => { expect(unwindBackLayer("/one/referrals")).toBe(true); });
    expect(screen.queryByRole("region", { name: "How referrals work" })).not.toBeInTheDocument();
    expect(unwindBackLayer("/one/referrals")).toBe(false);
  });

  it.each([
    [0, "₹250 Amazon voucher", 10], [9, "₹250 Amazon voucher", 10],
    [10, "Wireless earbuds", 100], [99, "Wireless earbuds", 100],
    [100, "Apple AirPods", 500], [499, "Apple AirPods", 500],
    [500, "iPhone", 10000], [9999, "iPhone", 10000],
    [10000, null, null], [12000, null, null],
  ] as const)("selects the correct reward at %s qualified referrals", async (count, title, threshold) => {
    const catalogue = [
      { milestone_key: "voucher_10", threshold: 10, reward: "₹250 Amazon voucher" },
      { milestone_key: "earbuds_100", threshold: 100, reward: "Wireless earbuds, worth ₹10,000" },
      { milestone_key: "airpods_500", threshold: 500, reward: "Apple AirPods, worth ₹30,000" },
      { milestone_key: "iphone_10000", threshold: 10000, reward: "iPhone" },
    ];
    const next = catalogue.find((entry) => entry.threshold === threshold);
    mocks.getMilestones.mockResolvedValue({
      lifetime_qualified_count: count,
      earned: catalogue.filter((entry) => entry.threshold <= count).map((entry) => ({ ...entry, earned_at: "2026-10-14T00:00:00Z" })),
      next_milestone: next ? { ...next, progress: count } : null,
      available_milestones: catalogue,
    });
    await act(async () => { render(<ReferralDashboardPage />); });
    await screen.findByText("Weekly challenge ends in");
    fireEvent.click(screen.getByRole("tab", { name: "Rewards" }));
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

  it("preserves historical rewards after a catalogue revision and waits for recorded awards", async () => {
    mocks.getMilestones.mockResolvedValue({
      lifetime_qualified_count: 10000,
      earned: [
        { milestone_key: "voucher_10", reward: "₹250 Amazon voucher", earned_at: "2026-10-01T00:00:00Z" },
        { milestone_key: "earbuds_100", reward: "Wireless earbuds", earned_at: "2026-10-01T00:00:00Z" },
        { milestone_key: "airpods_500", reward: "Apple AirPods, worth ₹30,000", earned_at: "2026-10-01T00:00:00Z" },
      ],
      next_milestone: { milestone_key: "iphone_10000", threshold: 10000, reward: "iPhone", progress: 10000 },
      available_milestones: [
        { milestone_key: "voucher_10", threshold: 10, reward: "$25 Amazon voucher" },
        { milestone_key: "earbuds_100", threshold: 100, reward: "Wireless earbuds" },
        { milestone_key: "airpods_500", threshold: 500, reward: "Apple Watch" },
        { milestone_key: "iphone_10000", threshold: 10000, reward: "iPhone" },
      ],
    });
    await act(async () => { render(<ReferralDashboardPage />); });
    await screen.findByText("Weekly challenge ends in");
    fireEvent.click(screen.getByRole("tab", { name: "Rewards" }));
    const rewards = within(screen.getByRole("region", { name: "Rewards" }));
    expect(rewards.getByRole("heading", { level: 4, name: "Apple AirPods" })).toBeInTheDocument();
    expect(rewards.queryByText("Apple Watch")).not.toBeInTheDocument();
    expect(rewards.getByRole("img", { name: "Apple AirPods" })).toHaveAttribute("src", "/referrals/product-airpods.svg");
    expect(rewards.getByText("3 of 4 unlocked")).toBeInTheDocument();
    expect(rewards.getByRole("heading", { level: 4, name: "iPhone" }).closest("[data-reward]")).toHaveAttribute("data-reward-state", "next");
    expect(rewards.getByRole("heading", { level: 4, name: "Apple AirPods" }).closest("[data-reward]")).toHaveAttribute("data-reward-state", "earned");
    expect(rewards.getByText("Your reward is being confirmed.")).toBeInTheDocument();
    expect(rewards.queryByText("All rewards unlocked")).not.toBeInTheDocument();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasSeenReferralIntroduction.mockReset().mockResolvedValue(true);
    mocks.markReferralIntroductionSeen.mockReset().mockResolvedValue(undefined);
    currentUser = { uid: "user-a", getIdToken: mocks.getIdToken };
    mocks.getIdToken.mockResolvedValue("token-a");
    mocks.getSummary.mockResolvedValue(SUMMARY);
    mocks.getPoints.mockResolvedValue({ points: 2465, coins: 2450 });
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

  it("opens the dashboard directly without reading or writing welcome preferences", async () => {
    mocks.hasSeenReferralIntroduction.mockResolvedValue(false);
    render(<ReferralDashboardPage />);
    expect(await screen.findByText("2,450")).toBeInTheDocument();
    expect(screen.queryByText("Your agents. Yours to own.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View welcome screen" })).not.toBeInTheDocument();
    expect(mocks.hasSeenReferralIntroduction).not.toHaveBeenCalled();
    expect(mocks.markReferralIntroductionSeen).not.toHaveBeenCalled();
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

    await screen.findByText("Weekly challenge ends in");

    const inviteButton = screen.getByRole("button", { name: "Invite & earn $" });
    // The shared token is deliberately overridden at this route, so a saved
    // account accent cannot recolour the approved referral design.
    const css = readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
    const routeStyle = document.createElement("style");
    routeStyle.textContent = css.match(/^\.referral-dashboard(?:\s*,\s*\[data-referral-introduction="true"\])?\s*\{[^}]*\}/m)?.[0] ?? "";
    document.head.appendChild(routeStyle);
    try {
      const dashboard = inviteButton.closest(".referral-dashboard")!;
      expect(getComputedStyle(dashboard).getPropertyValue("--app-accent").trim()).toBe("#007aff");
    } finally {
      routeStyle.remove();
    }
  });

  it("shows the Day streak flame for an active streak and marks it accessibly", async () => {
    render(<ReferralDashboardPage />);

    expect(await screen.findByText("6")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "6 day streak" })).toBeInTheDocument();
    expect(screen.queryByText("9-day bonus target")).not.toBeInTheDocument();
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
    let resolvePointsForA: ((value: { points: number; coins: number }) => void) | undefined;
    mocks.getPoints.mockImplementation(() => {
      return new Promise((resolve) => {
        resolvePointsForA = resolve;
      });
    });

    const { rerender } = render(<ReferralDashboardPage />);
    await screen.findByText("Weekly challenge ends in");

    // Switch accounts before account A's points request resolves.
    currentUser = { uid: "user-b", getIdToken: mocks.getIdToken };
    mocks.getPoints.mockResolvedValue({ points: 19, coins: 9 });
    rerender(<ReferralDashboardPage />);
    await screen.findByText("9");

    // Account A's late response must not overwrite account B's real balance.
    await act(async () => {
      resolvePointsForA?.({ points: 2465, coins: 2450 });
    });
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.queryByText("2,450")).toBeNull();
  });
});
