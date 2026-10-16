import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
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
  recordAppOpen: vi.fn(),
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
    recordAppOpen: mocks.recordAppOpen,
  },
}));

import { CacheService } from "@/lib/services/cache-service";
import { useDailyAppActivity } from "@/lib/referral/use-daily-app-activity";

import { unwindBackLayer } from "@/lib/navigation/back-layers";
import { navigateTopShellBack } from "@/lib/navigation/top-shell-back";
import { ReferralDashboardPage, formatCountdown } from "@/components/referrals/referral-dashboard-page";

const SUMMARY = {
  joined_count: 15,
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

function runningChallenge(bounds: { week_started_at: string; cutoff_at: string }) {
  return { active: true, campaign_active: true, weekly_prizes_enabled: true,
    timezone: "Asia/Kolkata", server_now: new Date().toISOString(),
    received_at_monotonic: performance.now(), ...bounds };
}

describe("formatCountdown", () => {
  it("makes days and remaining hours explicit", () => {
    const ms = (137 * 3600 + 22 * 60 + 10) * 1000;
    expect(formatCountdown(ms)).toBe("5d 17h 22m 10s");
  });

  it("clamps an expired deadline instead of showing a negative value", () => {
    expect(formatCountdown(-5000)).toBe("00h 00m 00s");
    expect(formatCountdown(0)).toBe("00h 00m 00s");
  });
});

describe("ReferralDashboardPage", () => {
  it("uses Apple Watch artwork and label for the approved 500-referral reward", async () => {
    mocks.getMilestones.mockResolvedValue({ joined_referral_count: 120, earned: [],
      next_milestone: { milestone_key: "airpods_500", threshold: 500, reward: "Apple Watch", progress: 120 },
      available_milestones: [{ milestone_key: "airpods_500", threshold: 500, reward: "Apple Watch" }],
    });
    render(<ReferralDashboardPage />);
    await screen.findByText("Weekly prizes end in");
    fireEvent.click(screen.getByRole("tab", { name: "Rewards" }));
    for (const image of screen.getAllByRole("img", { name: "Apple Watch" })) {
      expect(image).toHaveAttribute("src", "/referrals/product-apple-watch-premium.svg");
    }
    expect(screen.queryByText("Apple AirPods")).toBeNull();
  });
  it("renders viewer-permitted profile names in rankings and the rank gap", async () => {
    mocks.getLeaderboard.mockResolvedValue({ entries: [
      { rank: 1, handle: "Anonymous referrer", display_name: "Priya Rao", points: 100, is_viewer: false },
      { rank: 2, handle: "Anonymous referrer", display_name: "Meera Shah", points: 80, is_viewer: true },
    ], viewer: null, stale: false, snapshot_generated_at: null });
    render(<ReferralDashboardPage />);
    await screen.findByText("#2");
    fireEvent.click(screen.getByRole("tab", { name: "Ranking" }));
    expect(screen.getByText("Priya Rao")).toBeInTheDocument();
    expect(screen.getByText("Meera Shah")).toBeInTheDocument();
    expect(screen.getByText("You're #2. 20 coins to pass Priya Rao.")).toBeInTheDocument();
  });

  it("does not imply prizes are active when the prize flags are missing", async () => {
    mocks.getChallenge.mockResolvedValue({ active: true, week_started_at: "2026-10-12T00:00:00+05:30", cutoff_at: "2026-10-19T00:00:00+05:30", timezone: "Asia/Kolkata" });
    render(<ReferralDashboardPage />);
    await screen.findByText("Timing unavailable");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("Weekly prizes end in")).toBeNull();
  });

  it("shows paused prizes without a calendar countdown or track", async () => {
    mocks.getChallenge.mockResolvedValue({ active: true, weekly_prizes_enabled: false, week_started_at: "2026-10-12T00:00:00+05:30", cutoff_at: "2026-10-19T00:00:00+05:30", timezone: "Asia/Kolkata" });
    render(<ReferralDashboardPage />);
    await screen.findByText("Paused");
    expect(screen.queryByText("Weekly prizes end in")).toBeNull();
    expect(screen.queryByRole("img", { name: /Weekly calendar progress/ })).toBeNull();
  });

  it("revalidates a change received while the first request is still in flight", async () => {
    let finish: (value: typeof SUMMARY) => void = () => {};
    mocks.getSummary.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    mocks.getSummary.mockResolvedValue({ ...SUMMARY, qualified_count: 88, in_progress_count: 0, joined_count: 88, total_count: 88 });
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
    mocks.getMilestones.mockResolvedValue({ joined_referral_count: 10, earned: [],
      next_milestone: { milestone_key: "voucher_10", threshold: 10, reward: "Saved voucher", progress: 10 },
      available_milestones: [{ milestone_key: "voucher_10", threshold: 10, reward: "Saved voucher" }],
    });
    render(<ReferralDashboardPage />);
    await screen.findByText("Weekly prizes end in");
    fireEvent.click(screen.getByRole("tab", { name: "Rewards" }));
    expect(screen.getByText("0 of 1 unlocked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Claim reward" })).toBeNull();
    expect(screen.queryByText("All milestones reached")).toBeNull();
  });
  it("keeps progress and earning glyphs free of interior shading", async () => {
    mocks.getPolicy.mockResolvedValue({ version: 4, points: { qualified_referral_points: 100, flash_window_total_points: 200, referral_in_progress_points: 5, referral_qualified_activity_total_points: 15, streak_three_day_bonus_points: 15, pkm_daily_points: 15, connection_created_points: 5, agent_usage_points: 10 }, streak_rules: { run_length_days: 3, bonus_points: 15 }, challenge_duration_days: 7, weekly_prizes_enabled: false, flash_bonus_enabled: true });
    const { container } = render(<ReferralDashboardPage />);
    await screen.findByRole("button", { name: "Invite & earn $" });
    const progress = container.querySelectorAll('.referral-stat-icon svg, .referral-streak-card [role="img"] svg');
    expect(progress).toHaveLength(4);
    for (const icon of progress) expect(icon.querySelector('[opacity="0.2"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "How it works" }));
    const earnings = container.querySelectorAll('[data-earning] > span:first-child svg');
    expect(earnings).toHaveLength(6);
    for (const icon of earnings) expect(icon.querySelector('[opacity="0.2"]')).toBeNull();
  });

  it("renders a configured catalogue without imposing frontend thresholds", async () => {
    mocks.getMilestones.mockResolvedValue({
      joined_referral_count: 0, earned: [],
      next_milestone: { milestone_key: "current_reward", threshold: 42, reward: "Current program reward", progress: 0 },
      available_milestones: [{ milestone_key: "current_reward", threshold: 42, reward: "Current program reward" }],
    });
    await act(async () => { render(<ReferralDashboardPage />); });
    fireEvent.click(screen.getByRole("tab", { name: "Rewards" }));
    expect(await screen.findByRole("heading", { level: 3, name: "Current program reward" })).toBeInTheDocument();
    expect(screen.queryByText("Rewards policy unavailable")).toBeNull();
    expect(screen.queryByText("All milestones reached")).toBeNull();
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
    await screen.findByText("Weekly prizes end in");
    expect(screen.queryByRole("region", { name: "How referrals work" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "How it works" }));
    expect(screen.queryByRole("button", { name: "View welcome screen" })).not.toBeInTheDocument();
    expect(await screen.findByText("123 coins")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Keep your streak" }).closest("article")).toHaveTextContent("+17 coins");
    expect(screen.getByRole("heading", { name: "Flash boost" }).closest("article")).toHaveTextContent("246 coins");
    act(() => { expect(unwindBackLayer("/one/referrals")).toBe(true); });
    expect(screen.queryByRole("region", { name: "How referrals work" })).not.toBeInTheDocument();
    expect(screen.getByText("Weekly prizes end in")).toBeInTheDocument();
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
  ] as const)("selects the correct reward at %s joined referrals", async (count, title, threshold) => {
    const catalogue = [
      { milestone_key: "voucher_10", threshold: 10, reward: "₹250 Amazon voucher" },
      { milestone_key: "earbuds_100", threshold: 100, reward: "Wireless earbuds, worth ₹10,000" },
      { milestone_key: "airpods_500", threshold: 500, reward: "Apple AirPods, worth ₹30,000" },
      { milestone_key: "iphone_10000", threshold: 10000, reward: "iPhone" },
    ];
    const next = catalogue.find((entry) => entry.threshold === threshold);
    mocks.getMilestones.mockResolvedValue({
      joined_referral_count: count,
      earned: catalogue.filter((entry) => entry.threshold <= count).map((entry) => ({ ...entry, earned_at: "2026-10-14T00:00:00Z" })),
      next_milestone: next ? { ...next, progress: count } : null,
      available_milestones: catalogue,
    });
    await act(async () => { render(<ReferralDashboardPage />); });
    await screen.findByText("Weekly prizes end in");
    fireEvent.click(screen.getByRole("tab", { name: "Rewards" }));
    expect(within(screen.getByRole("region", { name: "Rewards" })).getAllByRole("heading", { level: 4 })).toHaveLength(4);
    if (title && threshold) {
      expect(screen.getByRole("heading", { level: 3, name: title })).toBeInTheDocument();
      expect(screen.getByRole("progressbar", { name: `${title} milestone` })).toHaveAttribute(
        "aria-valuetext", `${Number(count).toLocaleString("en-IN")} of ${threshold.toLocaleString("en-IN")} joined referrals; ${(threshold - Number(count)).toLocaleString("en-IN")} more to go`,
      );
    } else {
      expect(screen.getByText("All milestones reached")).toBeInTheDocument();
      expect(within(screen.getByRole("region", { name: "Rewards" })).queryByRole("progressbar")).toBeNull();
    }
    expect(screen.queryByText("hushh_tee")).toBeNull();
  });

  it("preserves historical rewards after a catalogue revision and waits for recorded awards", async () => {
    mocks.getMilestones.mockResolvedValue({
      joined_referral_count: 10000,
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
    await screen.findByText("Weekly prizes end in");
    fireEvent.click(screen.getByRole("tab", { name: "Rewards" }));
    const rewards = within(screen.getByRole("region", { name: "Rewards" }));
    expect(rewards.getByRole("heading", { level: 4, name: "Apple AirPods" })).toBeInTheDocument();
    expect(rewards.queryByText("Apple Watch")).not.toBeInTheDocument();
    expect(rewards.getByRole("img", { name: "Apple AirPods" })).toHaveAttribute("src", "/referrals/product-airpods.svg");
    expect(rewards.getByText("3 of 4 unlocked")).toBeInTheDocument();
    expect(rewards.getByRole("heading", { level: 4, name: "iPhone" }).closest("[data-reward]")).toHaveAttribute("data-reward-state", "next");
    expect(rewards.getByRole("heading", { level: 4, name: "Apple AirPods" }).closest("[data-reward]")).toHaveAttribute("data-reward-state", "earned");
    expect(rewards.getByText("Your reward is being confirmed.")).toBeInTheDocument();
    expect(rewards.queryByText("All milestones reached")).not.toBeInTheDocument();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    CacheService.getInstance().clear();
    mocks.recordAppOpen.mockReturnValue(neverResolves());
    mocks.hasSeenReferralIntroduction.mockReset().mockResolvedValue(true);
    mocks.markReferralIntroductionSeen.mockReset().mockResolvedValue(undefined);
    currentUser = { uid: "user-a", getIdToken: mocks.getIdToken };
    mocks.getIdToken.mockResolvedValue("token-a");
    mocks.getSummary.mockResolvedValue(SUMMARY);
    mocks.getPoints.mockResolvedValue({ points: 2450, coins: 2450 });
    mocks.getPolicy.mockResolvedValue({ version: 2, points: { qualified_referral_points: 100, flash_window_total_points: 200, streak_three_day_bonus_points: 15 }, streak_rules: { run_length_days: 3, bonus_points: 15 }, challenge_duration_days: 7, weekly_prizes_enabled: false });
    mocks.getLeaderboard.mockResolvedValue({
      snapshot_generated_at: null,
      entries: [],
      viewer: null,
      stale: true,
    });
    mocks.getCircleLeaderboard.mockResolvedValue({ teams: [] });
    mocks.getMilestones.mockResolvedValue({
      joined_referral_count: 11,
      earned: [],
      next_milestone: { milestone_key: "earbuds_100", threshold: 100, reward: "Wireless earbuds", progress: 11 },
    });
    mocks.getEngagement.mockResolvedValue({
      streak: { current_run_days: 6, run_length_days: 9 },
      flash: { active: false, ends_at: null },
    });
    mocks.getChallenge.mockImplementation(async () => runningChallenge({
      week_started_at: new Date(Date.now() - 86_400_000).toISOString(),
      cutoff_at: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    }));
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

  it("ticks from server time and reloads at weekly-prize rollover", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T23:59:59+05:30"));
    mocks.getChallenge.mockResolvedValue(runningChallenge({
      week_started_at: "2026-10-05T00:00:00+05:30",
      cutoff_at: "2026-10-12T00:00:00+05:30",
    }));
    const view = render(<ReferralDashboardPage />);
    await act(async () => {});
    expect(screen.getByText("3d 00h 00m 01s")).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText("3d 00h 00m 00s")).toBeInTheDocument();
    view.unmount();
    vi.setSystemTime(new Date("2026-10-11T23:59:59+05:30"));
    mocks.getChallenge.mockResolvedValue(runningChallenge({
      week_started_at: "2026-10-05T00:00:00+05:30",
      cutoff_at: "2026-10-12T00:00:00+05:30",
    }));
    render(<ReferralDashboardPage />);
    await act(async () => {});
    mocks.getChallenge.mockImplementation(async () => runningChallenge({
      week_started_at: "2026-10-12T00:00:00+05:30",
      cutoff_at: "2026-10-19T00:00:00+05:30",
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(mocks.getChallenge).toHaveBeenCalledTimes(3);
    expect(screen.getByText("6d 23h 59m 59s")).toBeInTheDocument();
    expect(screen.getByText("2,450")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "6 day streak" })).toBeInTheDocument();
  });

  it("renders the weekly-prize timer independently of other resources", async () => {
    // Points, leaderboard, milestones, engagement and circle never resolve;
    // only the page-gating summary does. The timer card must not depend on
    // any of them.
    mocks.getPoints.mockReturnValue(neverResolves());
    mocks.getLeaderboard.mockReturnValue(neverResolves());
    mocks.getMilestones.mockReturnValue(neverResolves());
    mocks.getEngagement.mockReturnValue(neverResolves());
    mocks.getCircleSelection.mockReturnValue(neverResolves());

    render(<ReferralDashboardPage />);

    expect(await screen.findByText("Weekly prizes end in")).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /Weekly calendar progress/ })).toBeNull();
  });

  it("keeps the timer card visible when the challenge resource itself fails", async () => {
    mocks.getChallenge.mockRejectedValue(new Error("network"));

    render(<ReferralDashboardPage />);

    await waitFor(() => expect(screen.getByText("Unable to load")).toBeInTheDocument());
    expect(screen.getByText("Weekly prizes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("keeps the reference colours through a route-scoped accent override", async () => {
    render(<ReferralDashboardPage />);

    await screen.findByText("Weekly prizes end in");

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
    const rankLabel = within(screen.getByRole("region", { name: "Your progress" })).getByText("Rank");
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
    await screen.findByText("Weekly prizes end in");

    // Switch accounts before account A's points request resolves.
    currentUser = { uid: "user-b", getIdToken: mocks.getIdToken };
    mocks.getPoints.mockResolvedValue({ points: 9, coins: 9 });
    rerender(<ReferralDashboardPage />);
    await screen.findByText("9");

    // Account A's late response must not overwrite account B's real balance.
    await act(async () => {
      resolvePointsForA?.({ points: 2450, coins: 2450 });
    });
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.queryByText("2,450")).toBeNull();
    // Returning to A must not resurrect its cancelled request through memory cache.
    currentUser = { uid: "user-a", getIdToken: mocks.getIdToken };
    mocks.getPoints.mockReturnValue(neverResolves());
    rerender(<ReferralDashboardPage />);
    expect(screen.queryByText("2,450")).toBeNull();
  });

  it("shows legacy earnings and joined progress without points or qualification subtitles", async () => {
    mocks.getPoints.mockResolvedValue({ points: 50, coins: 50 });
    mocks.getSummary.mockResolvedValue({ ...SUMMARY, joined_count: 2, total_count: 2, qualified_count: 0,
      in_progress_count: 2, referrals: ["one","two"].map((id) => ({id,display_name:id,status:"In progress",step:"Finish setup",started_on:"2026-10-14"})) });
    mocks.getMilestones.mockResolvedValue({joined_referral_count:2,lifetime_qualified_count:0,earned:[],
      next_milestone:{milestone_key:"voucher_10",threshold:10,reward:"Amazon voucher",progress:2},
      available_milestones:[{milestone_key:"voucher_10",threshold:10,reward:"Amazon voucher"}]});
    render(<ReferralDashboardPage />);
    expect(await screen.findByText("50")).toBeInTheDocument();
    expect(screen.queryByText(/total points/i)).toBeNull();
    const referrals=screen.getAllByText("Referrals").find((node)=>node.closest(".referral-stat"))!.closest(".referral-stat")!;
    expect(within(referrals as HTMLElement).getByText("2")).toBeInTheDocument();
    expect(referrals).not.toHaveTextContent(/qualified|in progress/i);
    expect(screen.getAllByText("In progress")).toHaveLength(2);
    fireEvent.click(screen.getByRole("tab",{name:"Rewards"}));
    expect(screen.getByText("2 / 10 referrals")).toBeInTheDocument();
    expect(screen.getByText("20% complete")).toBeInTheDocument();
    expect(screen.queryByRole("button",{name:"Claim reward"})).toBeNull();
  });

  it("retains real warm values on navigation and reports refresh failure", async () => {
    const first=render(<ReferralDashboardPage />);
    await screen.findByText("2,450");first.unmount();
    mocks.getPoints.mockRejectedValue(new Error("offline"));
    render(<ReferralDashboardPage />);
    expect(screen.getByText("2,450")).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("Showing the last update");
    CacheService.getInstance().invalidateUser("user-a");
    expect(CacheService.getInstance().peek("referral_dashboard_user-a_points")).toBeNull();
  });

  it("renders the current user's row even outside an empty leaderboard page", async () => {
    mocks.getLeaderboard.mockResolvedValue({entries:[],viewer:{rank:41,points:50,handle:"safe-handle",is_viewer:true},stale:false,snapshot_generated_at:"2026-10-14T00:00:00Z"});
    render(<ReferralDashboardPage />);
    await screen.findByText("#41");
    fireEvent.click(screen.getByRole("tab",{name:"Ranking"}));
    expect(screen.getByText("safe-handle")).toBeInTheDocument();
    expect(screen.getByText("safe-handle").closest("li")).toHaveTextContent("You");
  });

  it("records only visible dashboard days at the server midnight and retries failures", async () => {
    vi.useFakeTimers();
    const onRecorded=vi.fn();
    mocks.recordAppOpen.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({server_now:"2026-10-14T18:29:59Z",next_day_at:"2026-10-15T00:00:00+05:30"}).mockResolvedValue({server_now:"2026-10-14T18:30:00Z",next_day_at:"2026-10-16T00:00:00+05:30"});
    const hook=renderHook(()=>useDailyAppActivity(currentUser as Parameters<typeof useDailyAppActivity>[0],onRecorded));
    await act(async()=>{});
    expect(onRecorded).not.toHaveBeenCalled();
    await act(async()=>{window.dispatchEvent(new Event("online"));});
    expect(onRecorded).toHaveBeenCalledTimes(1);
    await act(async()=>{await vi.advanceTimersByTimeAsync(1025);});
    expect(onRecorded).toHaveBeenCalledTimes(2);
    Object.defineProperty(document,"visibilityState",{configurable:true,value:"hidden"});
    await act(async()=>{await vi.advanceTimersByTimeAsync(86_400_025);});
    expect(onRecorded).toHaveBeenCalledTimes(2);
    Object.defineProperty(document,"visibilityState",{configurable:true,value:"visible"});
    await act(async()=>{document.dispatchEvent(new Event("visibilitychange"));});
    expect(onRecorded).toHaveBeenCalledTimes(3);
    hook.unmount();
  });
});
