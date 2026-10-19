"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { preload } from "react-dom";
import Image from "next/image";
import { AppPageShell, AppPageHeaderRegion, AppPageContentRegion } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceCard } from "@/components/app-ui/surfaces";
import { CircleWarsPanel } from "@/components/profile/circle-wars-panel";
import { ReferralJourney } from "./referral-journey";
import { ReferralInviteActions } from "./referral-invite-actions";
import { ReferralHeroArtwork, REFERRAL_HERO_ARTWORK_SRC } from "./referral-hero-artwork";
import { IndividualReferralRankings } from "./individual-referral-rankings";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import type { User } from "firebase/auth";
import { Coins, Users, Trophy, Flame } from "@/components/icons";
import "./referral-dashboard.css";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";

import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/lib/firebase/auth-context";
import { useDailyAppActivity } from "@/lib/referral/use-daily-app-activity";
import { useReferralStream } from "@/lib/referral/use-referral-stream";
import { formatWeeklyPrizeCountdown } from "@/lib/referral/weekly-prize-clock";
import { isAirPodsReward, rewardDisplayTitle, referralRewardBoard, referralClaimStatus } from "@/lib/referral/reward-presentation";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";
import { isShareCancellationError, shareLink } from "@/lib/share/share-link";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import {
  ReferralService,
  type EngagementStatus,
  type LeaderboardPage,
  type MilestoneProgress,
  type ReferralSummary,
  type ReferralPolicy,
} from "@/lib/services/referral-service";

type TabKey = "you" | "standings" | "rewards";

const TABS: { key: TabKey; label: string }[] = [
  { key: "you", label: "You" },
  { key: "standings", label: "Ranking" },
  { key: "rewards", label: "Rewards" },
];

/** Fixed reference palette; globals.css scopes accent tokens to this route. */
const COLORS = {
  bg: "#f2f2f7",
  text: "#1d1d1f",
  text2: "#6e6e73",
  text3: "#8e8e93",
  sep: "rgba(60, 60, 67, .12)",
  blue: "var(--app-accent)",
  blueText: "var(--app-accent-deep)",
  blueSoft: "var(--app-accent-tint)",
  meSurface: "var(--app-accent-surface)",
  green: "#34c759",
  greenText: "#137a35",
  gold: "var(--referral-medal-deep)",
  goldSoft: "var(--referral-medal-light)",
  goldText: "#8a6431",
  goldTint: "rgba(212, 165, 116, .2)",
  timerFrom: "#1c1c1e",
  timerTo: "#242426",
  card: "#ffffff",
  fill: "rgba(120, 120, 128, .16)",
  fill2: "rgba(120, 120, 128, .1)",
  chevron: "#c7c7cc",
  orange: "#ff9500",
  orangeSoft: "rgba(255, 149, 0, .16)",
  orangeText: "#c96f00",
} as const;

function fmt(value: number): string {
  return value.toLocaleString("en-IN");
}

// Compatibility export; the small prize clock owns formatting and time math.
export const formatCountdown = formatWeeklyPrizeCountdown;

/**
 * Loading/ready/error for one independently-fetched piece of the dashboard.
 *
 * Every section of this page -- points, the leaderboard, milestones, the
 * engagement, circle standing -- is its own resource with
 * its own status and its own retry. One section failing (the leaderboard,
 * say) must never hide or zero out a DIFFERENT section that loaded fine
 * (points, say): that was the exact bug a single page-wide load()/state pair
 * produced.
 */
type Res<T> =
  | { status: "loading" }
  | { status: "ready"; data: T; refreshFailed?: boolean }
  | { status: "error" };

/** Account-scoped, memory-only reads retain content during background refresh. */
function useReferralResource<T>(
  user: User | null | undefined,
  resource: string,
  fetcher: (idToken: string) => Promise<T>,
): [Res<T>, () => void] {
  const requestScope = useId();
  const { data, error, loading, refreshing, refresh } = useStaleResource<T>({
    requestScope,
    cacheTtlMs: 0,
    retainOnInvalidate: true,
    cacheKey: `referral_dashboard_${user?.uid ?? "signed-out"}_${resource}`,
    enabled: Boolean(user),
    resourceLabel: `referral-${resource}`,
    load: async () => {
      if (!user) throw new Error("not signed in");
      return fetcher(await user.getIdToken());
    },
  });
  const pendingRefresh = useRef(false);
  const ownRefresh = useRef(false);
  const flushRefresh = useCallback(async () => {
    if (ownRefresh.current) return;
    ownRefresh.current = true;
    try {
      do {
        pendingRefresh.current = false;
        await refresh({ force: true });
      } while (pendingRefresh.current);
    } finally { ownRefresh.current = false; }
  }, [refresh]);
  const reload = useCallback(() => {
    pendingRefresh.current = true;
    if (!loading && !refreshing) void flushRefresh();
  }, [loading, refreshing, flushRefresh]);
  useEffect(() => {
    if (!loading && !refreshing && pendingRefresh.current) void flushRefresh();
  }, [loading, refreshing, flushRefresh]);
  const res: Res<T> = data !== null ? { status: "ready", data, refreshFailed: Boolean(error) }
    : error && !loading && !refreshing ? { status: "error" } : { status: "loading" };
  return [res, reload];
}

/** Loading/error text for a small inline stat, never a numeric fallback. */
function statText<T>(res: Res<T>, onReady: (data: T) => string): string {
  if (res.status === "loading") return "…";
  if (res.status === "error") return "—";
  return onReady(res.data);
}

function statSub<T>(res: Res<T>, onReady: (data: T) => string): string {
  if (res.status === "loading") return "Loading";
  if (res.status === "error") return "Unable to load";
  return onReady(res.data);
}

/** A section-level loading/error/ready switch, with its own retry. */
function Section<T>({
  res,
  onRetry,
  retryLabel,
  children,
}: {
  res: Res<T>;
  onRetry: () => void;
  retryLabel: string;
  children: (data: T) => React.ReactNode;
}) {
  if (res.status === "loading") {
    return (
      <div className="flex min-h-[20vh] items-center justify-center referral-type-support" style={{ color: COLORS.text2 }}>
        Loading…
      </div>
    );
  }
  if (res.status === "error") {
    return (
      <div className="flex min-h-[20vh] flex-col items-center justify-center gap-3 text-center">
        <p className="referral-type-support" style={{ color: COLORS.text2 }}>Unable to load {retryLabel}.</p>
        <Button variant="muted" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  return <>{children(res.data)}</>;
}

export function ReferralDashboardPage() {
  // Start the hero request before the summary API gates the You tab.
  preload(REFERRAL_HERO_ARTWORK_SRC, { as: "image", fetchPriority: "high" });
  const { user } = useAuth();
  const ownerId = user?.uid ?? null;
  // Keep cached reads and local UI state isolated when the signed-in owner changes.
  return <ReferralDashboardContent key={ownerId ?? "signed-out"} />;
}

export function useReferralDashboardModel() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>("you");
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const closeHowItWorks = useCallback(() => {
    setShowHowItWorks(false);
    return true;
  }, []);
  useBackLayer(ROUTES.ONE_REFERRALS, showHowItWorks ? 1 : 0, closeHowItWorks);
  const [board, setBoard] = useState<"individual" | "circles">("individual");

  // The summary gates only the You tab: the invite link and
  // referral counts it carries are the minimum the page can mean anything
  // without. Every other read is its own resource below, decoupled so a
  // failure in one (the leaderboard, say) can never hide or zero out a
  // DIFFERENT one that loaded fine (points, say).
  const [summaryRes, reloadSummary] = useReferralResource(user, "summary", (idToken) =>
    ReferralService.getSummary({ idToken }),
  );
  const [pointsRes, reloadPoints] = useReferralResource(user, "points", (idToken) =>
    ReferralService.getPoints({ idToken }),
  );
  const [leaderboardRes, reloadLeaderboard] = useReferralResource(user, "leaderboard", (idToken) =>
    ReferralService.getLeaderboard({ idToken, limit: 10 }),
  );
  const [policyRes, reloadPolicy] = useReferralResource(user, "policy", (idToken) =>
    ReferralService.getPolicy({ idToken }),
  );
  const [milestonesRes, reloadMilestones] = useReferralResource(user, "milestones", (idToken) =>
    ReferralService.getMilestones({ idToken }),
  );
  const [engagementRes, reloadEngagement] = useReferralResource(user, "engagement", (idToken) =>
    ReferralService.getEngagement({ idToken }),
  );
  const [circleRefresh, setCircleRefresh] = useState(0);

  const reloadAll = useCallback(() => {
    reloadSummary();
    reloadPoints();
    reloadLeaderboard();
    reloadMilestones();
    reloadPolicy();
    reloadEngagement();
    setCircleRefresh((value) => value + 1);
  }, [
    reloadSummary,
    reloadPoints,
    reloadLeaderboard,
    reloadMilestones,
    reloadPolicy,
    reloadEngagement,
  ]);

  // A pushed "something changed" doorbell re-reads everything: the server
  // never says WHICH resource changed, and re-fetching these already-cheap
  // reads is simpler than guessing.
  const { connected } = useReferralStream(user, reloadAll);
  const onVisit = useCallback(() => { reloadEngagement(); reloadPoints(); reloadLeaderboard(); }, [reloadEngagement, reloadPoints, reloadLeaderboard]);
  useDailyAppActivity(user, onVisit);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") reloadAll();
    };
    const interval = connected ? null : window.setInterval(refreshIfVisible, 30_000);
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);
    window.addEventListener("online", refreshIfVisible);
    return () => {
      if (interval !== null) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
      window.removeEventListener("online", refreshIfVisible);
    };
  }, [connected, reloadAll]);

  const link = summaryRes.status === "ready" ? summaryRes.data.link : "";
  const claims = useReferralClaims(user, milestonesRes, reloadMilestones);
  const shareVisit = useRef<{ active: boolean; owner: string | undefined; link: string } | null>(null);
  useLayoutEffect(() => {
    const visit = { active: true, owner: user?.uid, link };
    shareVisit.current = visit;
    return () => { visit.active = false; if (shareVisit.current === visit) shareVisit.current = null; };
  }, [user?.uid, link]);

  const onShare = useCallback(async () => {
    const owner = snapshotValidatedAuthSessionOwner();
    const visit = shareVisit.current;
    const isCurrent = () => !!visit && visit.active && visit.link === link && !!owner && owner.userId === visit.owner && isValidatedAuthSessionOwnerCurrent(owner);
    if (!link || !isCurrent()) return;
    try {
      const delivery = await shareLink({ title: "Join me on Hushh One", text: "Join me on Hushh One", dialogTitle: "Share your invite", url: link }, isCurrent);
      if (isCurrent() && delivery === "copied") morphyToast.success("Invite link copied");
    } catch (cause) {
      if (isCurrent() && !isShareCancellationError(cause)) morphyToast.error("Could not share your invite. Please try again.");
    }
  }, [link]);

  return { user, tab, setTab, board, setBoard, showHowItWorks, setShowHowItWorks, summaryRes, pointsRes,
    leaderboardRes, policyRes, milestonesRes, engagementRes, circleRefresh, link, onShare, reloadAll,
    reloadSummary, reloadPoints, reloadLeaderboard, reloadMilestones, reloadPolicy, reloadEngagement, claims };
}
export type ReferralDashboardModel = ReturnType<typeof useReferralDashboardModel>;

/** This rich workspace retains its complete authored dashboard, including on
 * qualified native shells. The settings-row prototype is not visual parity. */
function ReferralDashboardContent() {
  const model = useReferralDashboardModel();
  return <ReferralDashboardBody model={model} />;
}
function ReferralDashboardBody({ model }: { model: ReferralDashboardModel }) {
  const { user, tab, setTab, board, setBoard, showHowItWorks, setShowHowItWorks, summaryRes, pointsRes,
    leaderboardRes, policyRes, milestonesRes, engagementRes, circleRefresh, link, onShare, reloadAll,
    reloadSummary, reloadPoints, reloadLeaderboard, reloadMilestones, reloadPolicy, reloadEngagement, claims } = model;
  const dataState =
    summaryRes.status === "loading"
      ? "loading"
      : summaryRes.status === "error"
        ? "unavailable-valid"
        : "loaded";

  return (
    <ShellRoot dataState={dataState} tab={tab} onTabChange={setTab} showHowItWorks={showHowItWorks} onHowItWorks={() => setShowHowItWorks(true)}>
      {[summaryRes,pointsRes,leaderboardRes,milestonesRes,engagementRes].some((res) => res.status === "ready" && res.refreshFailed) ? <p role="status" className="referral-type-caption">Unable to refresh. Showing the last update. <button onClick={reloadAll}>Try again</button></p> : null}
      {showHowItWorks ? <section aria-label="How referrals work"><RulesTab policyRes={policyRes} onRetry={reloadPolicy} /></section> : <SwipeViews className="relative" tabSetId="referrals" activeValue={tab} options={TABS.map(({ key, label }) => ({ value: key, label }))} onSelectionChange={(value) => setTab(value as TabKey)} viewportMinHeight="fill" heightMode="active">
      <div>
      {summaryRes.status !== "ready" ? <>
        <StatsGrid pointsRes={pointsRes} onRetryPoints={reloadPoints} leaderboardRes={leaderboardRes} onRetryLeaderboard={reloadLeaderboard} summary={null} engagementRes={engagementRes} onRetryEngagement={reloadEngagement} />
      </> : null}
      {summaryRes.status === "loading" ? (
        <div className="flex min-h-[40vh] items-center justify-center referral-type-support" style={{ color: COLORS.text2 }}>
          Loading your referrals…
        </div>
      ) : summaryRes.status === "error" ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
          <p className="referral-type-support" style={{ color: COLORS.text2 }}>Unable to load. Check your connection.</p>
          <Button onClick={reloadSummary}>Try again</Button>
        </div>
      ) : (
        <>
          {summaryRes.status === "ready" ? (
            <YouTab
              active={tab === "you"}
              summary={summaryRes.data}
              pointsRes={pointsRes}
              onRetryPoints={reloadPoints}
              leaderboardRes={leaderboardRes}
              onRetryLeaderboard={reloadLeaderboard}
              engagementRes={engagementRes}
              onRetryEngagement={reloadEngagement}
              link={link}
              onShare={onShare}
              circlePanel={tab === "you" && user ? <CircleWarsPanel userId={user.uid} view="card" refreshKey={circleRefresh} onInvite={onShare} onViewRankings={() => { setTab("standings"); setBoard("circles"); }} /> : null}
            />
          ) : null}
        </>
      )}
      </div>
      <div>
        <StandingsTab
          user={user}
          leaderboardRes={leaderboardRes}
          onRetryLeaderboard={reloadLeaderboard}
          circlePanel={tab === "standings" && board === "circles" && user ? <CircleWarsPanel userId={user.uid} view="leaderboard" refreshKey={circleRefresh} onInvite={onShare} onViewRankings={() => setBoard("circles")} /> : null}
          board={board}
          onBoardChange={setBoard}
        />
      </div>
      <section aria-label="Rewards">
        <RewardsTab milestonesRes={milestonesRes} onRetry={reloadMilestones} claims={claims} />
      </section>
      </SwipeViews>}
    </ShellRoot>
  );
}

/**
 * Shared app chrome owns Back, Profile, Talk to One and bottom navigation.
 * Referral sections and the expanding Share control stay in the scroll content.
 */
function ShellRoot({
  dataState,
  tab,
  onTabChange,
  showHowItWorks,
  onHowItWorks,
  children,
}: {
  dataState: "loading" | "loaded" | "unavailable-valid";
  tab: TabKey;
  onTabChange: (tab: TabKey) => void;
  showHowItWorks: boolean;
  onHowItWorks: () => void;
  children: React.ReactNode;
}) {
  const mainRef = useRef<HTMLElement>(null);
  useScrollReset(showHowItWorks ? "referral-help" : `referral-${tab}`);

  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [showHowItWorks]);

  return (
    <AppPageShell
      as="div"
      width="agent"
      className={`referral-dashboard${showHowItWorks ? " referral-help-page" : ""}`}
      style={{ color: COLORS.text }}
      nativeTest={{ routeId: ROUTES.ONE_REFERRALS, marker: "native-route-one-referrals", authState: "authenticated", dataState }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          title={showHowItWorks ? "How it works" : "Referrals"}
          titleRole={showHowItWorks ? "page" : "agent"}
          actionsInlineMobile
          actions={!showHowItWorks ? (
            <button onClick={onHowItWorks} className="referral-how-it-works">
              <span aria-hidden="true" className="referral-help-icon">?</span>
              How it works
            </button>
          ) : undefined}
        />
        {!showHowItWorks && <div className="referral-tab-row mt-4">
          <SegmentedTabs
            value={tab}
            onValueChange={(value) => onTabChange(value as TabKey)}
            options={TABS.map(({ key, label }) => ({ value: key, label }))}
            ariaLabel="Referral sections"
            tabSetId="referrals"
            variant="agent-top"
            className="referral-tabs"
          />
        </div>}
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <main ref={mainRef} aria-label="Referral dashboard" tabIndex={-1} className="outline-none">{children}</main>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

function Card({
  rewardKey,
  rewardState,
  className,
  style,
  children,
}: {
  rewardKey?: string;
  rewardState?: "earned" | "next" | "locked";
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div
      data-reward={rewardKey}
      data-reward-state={rewardState}
      className={"referral-card " + (className ?? "")}
      style={style}
    >
      {children}
    </div>
  );
}

function YouTab({
  active,
  summary,
  pointsRes,
  onRetryPoints,
  leaderboardRes,
  onRetryLeaderboard,
  engagementRes,
  onRetryEngagement,
  link,
  onShare,
  circlePanel,
}: {
  active: boolean;
  summary: ReferralSummary;
  pointsRes: Res<{ points: number; coins: number }>;
  onRetryPoints: () => void;
  leaderboardRes: Res<LeaderboardPage>;
  onRetryLeaderboard: () => void;
  engagementRes: Res<EngagementStatus>;
  onRetryEngagement: () => void;
  link: string;
  onShare: () => void;
  circlePanel: React.ReactNode;
}) {
  return (
    <>
      <div className="referral-overview-layout">
        <section className="referral-hero" aria-labelledby="referral-hero-heading">
          <div className="referral-hero-copy">
            <h2 id="referral-hero-heading" className="referral-hero-heading ui-text-page-title">
              <span>Good things</span>{" "}<span>grow together</span>
            </h2>
            {link ? (
              <ReferralInviteActions onShare={onShare} />
            ) : null}
          </div>
          <div className="referral-hero-media">
            <ReferralHeroArtwork active={active} />
          </div>
        </section>

        <SurfaceCard className="referral-progress-card">
        <section className="referral-progress-region" aria-labelledby="referral-progress-heading">
          <header className="referral-progress-header">
            <h2 id="referral-progress-heading" className="referral-section-heading">Your progress</h2>
          </header>
          <StatsGrid
            pointsRes={pointsRes}
            onRetryPoints={onRetryPoints}
            leaderboardRes={leaderboardRes}
            onRetryLeaderboard={onRetryLeaderboard}
            summary={summary}
            engagementRes={engagementRes}
            onRetryEngagement={onRetryEngagement}
          />
        </section>
        </SurfaceCard>
      </div>

      {circlePanel}
    </>
  );
}

function StatsGrid({
  pointsRes,
  onRetryPoints,
  leaderboardRes,
  onRetryLeaderboard,
  summary,
  engagementRes,
  onRetryEngagement,
}: {
  pointsRes: Res<{ points: number; coins: number }>;
  onRetryPoints: () => void;
  leaderboardRes: Res<LeaderboardPage>;
  onRetryLeaderboard: () => void;
  summary: ReferralSummary | null;
  engagementRes: Res<EngagementStatus>;
  onRetryEngagement: () => void;
}) {
  const cells: {
    label: string;
    value: string;
    sub: string;
    onRetry?: () => void;
  }[] = [
    {
      label: "Coins",
      value: statText(pointsRes, (p) => fmt(p.coins)),
      sub: statSub(pointsRes, () => ""),
      onRetry: pointsRes.status === "error" ? onRetryPoints : undefined,
    },
    {
      label: "Rank",
      value: statText(leaderboardRes, (lb) => {
        const v = lb.viewer ?? lb.entries.find((e) => e.is_viewer) ?? null;
        return v ? `#${v.rank}` : "—";
      }),
      sub: statSub(leaderboardRes, () => ""),
      onRetry: leaderboardRes.status === "error" ? onRetryLeaderboard : undefined,
    },
    {
      label: "Referrals",
      value: summary ? fmt(summary.joined_count) : "—",
      sub: "",
    },
  ];

  return (
    <div className="referral-overview">
      <dl className="referral-summary-stats">
        {cells.map((cell, index) => (
          <div
            key={cell.label}
            className="referral-stat"
            style={{ borderColor: COLORS.sep }}
          >
            <dt className="referral-type-label" style={{ color: COLORS.text2 }}>
              <span className={`referral-stat-icon referral-stat-icon-${index}`} aria-hidden="true">
                {index === 0 ? <Coins /> : index === 1 ? <Trophy /> : <Users />}
              </span>
              {cell.label}
            </dt>
            <dd className="mt-1 flex items-center gap-2">
              <span className="referral-type-value tabular-nums">
                {cell.value}
              </span>
            </dd>
            {cell.sub && <dd className="mt-0.5 referral-type-caption" style={{ color: COLORS.text2 }}>{cell.sub}</dd>}
            {cell.onRetry ? (
              <button
                onClick={cell.onRetry}
                className="mt-1 referral-type-caption"
                style={{ color: COLORS.blue }}
              >
                Try again
              </button>
            ) : null}
          </div>
        ))}
      </dl>
      <StreakCard engagementRes={engagementRes} onRetry={onRetryEngagement} />
    </div>
  );
}

function StreakCard({
  engagementRes,
  onRetry,
}: {
  engagementRes: Res<EngagementStatus>;
  onRetry: () => void;
}) {
  return (
    <section className="referral-streak-card" aria-label="Referral streak">
      <div className="flex min-w-0 items-center gap-4">
        <StreakFlame engagementRes={engagementRes} />
      </div>
      <div className="referral-streak-count">
        <div className="referral-streak-value">
          <strong className="tabular-nums">{statText(engagementRes, (e) => String(e.streak.current_run_days))}</strong>
          {engagementRes.status === "ready" ? <span className="referral-streak-unit">{engagementRes.data.streak.current_run_days === 1 ? "day" : "days"}</span> : null}
        </div>
        {engagementRes.status !== "ready" && <span>{statSub(engagementRes, () => "")}</span>}
        {engagementRes.status === "error" ? (
          <Button variant="muted" size="sm" onClick={onRetry}>Try again</Button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * A stronger, accessible flame beside the Day streak value. Zero and
 * unavailable are visually distinct from an active streak (a subdued icon,
 * no glow) and never collapse into one another -- a failed read must never
 * read as "zero streak" to someone glancing at the icon alone, which is why
 * the accessible text below is sourced from the same resource state as the
 * number itself rather than assumed from the icon's presence.
 */
function StreakFlame({ engagementRes }: { engagementRes: Res<EngagementStatus> }) {
  if (engagementRes.status !== "ready") return null;
  const days = engagementRes.data.streak.current_run_days;
  const active = days > 0;
  return (
    <span
      role="img"
      aria-label={`${days} day streak`}
      className={"grid shrink-0 place-items-center rounded-full " + (active ? "motion-safe:animate-pulse" : "")}
      style={{ width: 38, height: 38, background: active ? COLORS.orangeSoft : COLORS.fill2 }}
    >
      <Flame className="size-6" style={{ color: COLORS.orange }} aria-hidden="true" />
    </span>
  );
}

function StandingsTab({
  user,
  leaderboardRes,
  onRetryLeaderboard,
  circlePanel,
  board,
  onBoardChange,
}: {
  user: User | null | undefined;
  leaderboardRes: Res<LeaderboardPage>;
  onRetryLeaderboard: () => void;
  circlePanel: React.ReactNode;
  board: "individual" | "circles";
  onBoardChange: (board: "individual" | "circles") => void;
}) {
  return (
    <div className="referral-standings">
      <div className="referral-ranking-toolbar">
        <div
          role="group"
          aria-label="Standings type"
          className="referral-ranking-switch"
        >
          {(["individual", "circles"] as const).map((key) => (
            <button
              key={key}
              aria-pressed={board === key}
              onClick={() => onBoardChange(key)}
              className="referral-ranking-option"
            >
              {key}
            </button>
          ))}
        </div>
      </div>

      {board === "circles" ? circlePanel : <div className="space-y-4">
        <h3 className="ui-text-section-title">Individual rankings</h3>
          <Section res={leaderboardRes} onRetry={onRetryLeaderboard} retryLabel="the individual standings">
            {(leaderboard) => <IndividualReferralRankings key={user?.uid ?? "signed-out"}
              firstPage={leaderboard} user={user} onRefresh={onRetryLeaderboard} />}
          </Section>
      </div>}
    </div>
  );
}

const REWARD_PRODUCTS: Record<string, string> = {
  voucher_10: "voucher", earbuds_100: "earbuds", iphone_10000: "iphone",
};

function RewardArtwork({ milestoneKey, title, priority = false }: { milestoneKey: string; title: string; priority?: boolean }) {
  // Catalogue revisions retain their existing milestone identity.
  const product = milestoneKey === "airpods_500" && title === "Apple Watch"
    ? "apple-watch-premium"
    : milestoneKey === "voucher_10" && title === "$25 Amazon voucher"
      ? "voucher-black"
      : milestoneKey === "iphone_10000" ? "iphone-premium" : REWARD_PRODUCTS[milestoneKey];
  if (!product) return null;
  return <Image src={product === "voucher-black" ? "/referrals/product-voucher-symbols.webp" : `/referrals/product-${product}.svg`} alt={rewardDisplayTitle(title)} width={600} height={600} unoptimized loading="eager" fetchPriority={priority ? "high" : "auto"} className="referral-product-art" />;
}

function RewardsTab({
  milestonesRes,
  onRetry,
  claims,
}: {
  milestonesRes: Res<MilestoneProgress>;
  onRetry: () => void;
  claims: ReferralClaims;
}) {
  return (
    <>
      <Section res={milestonesRes} onRetry={onRetry} retryLabel="your reward progress">
        {(milestones) => {
          // A compatibility gate, never a fallback catalogue or user-value override.

          const board = referralRewardBoard(milestones);
          if (!board) {
            return (
              <Card className="p-[22px]" >
                <h3 className="ui-text-section-title">Rewards policy unavailable</h3>
                <p className="mt-2 referral-type-support" style={{ color: COLORS.text2 }}>
                  Rewards are not available yet. Your progress is saved.
                </p>
                <p className="mt-3 referral-type-support" style={{ color: COLORS.text2 }}>
                  {Number.isSafeInteger(milestones.joined_referral_count) ? `${fmt(milestones.joined_referral_count)} joined referrals · ` : ""}{milestones.earned.length} recorded rewards
                </p>
              </Card>
            );
          }
          const { earnedByKey, ladder, finalReward, count, next, awaitingAward, earnedKeys, previousRewards, nextLabel } = board;

          return (
            <div className="referral-rewards-content grid gap-[18px]">
              {next && !isAirPodsReward(next.reward) ? (
                <Card
                  rewardKey={next.milestone_key}
                  className="referral-reward-feature"
                  style={{ position: "relative", overflow: "hidden" }}
                >
                  <div>
                    <p className="referral-reward-eyebrow"><Trophy size={14} aria-hidden="true" />{awaitingAward ? "Milestone reached" : "Your next reward"}</p>
                    <h3 className="referral-reward-title ui-text-section-title">
                      {rewardDisplayTitle(nextLabel[0] ?? next.reward)}
                    </h3>
                    {awaitingAward ? (
                      <p className="referral-reward-description">Your reward is being confirmed.</p>
                    ) : null}
                  </div>
                  <div className="referral-reward-stage">
                    <RewardArtwork milestoneKey={next.milestone_key} title={nextLabel[0] ?? next.reward} priority />
                  </div>
                  <div className="referral-reward-progress">
                    <div className="flex items-baseline justify-between gap-3 referral-type-caption" style={{ color: COLORS.text2 }}>
                      <strong className="referral-type-support tabular-nums" style={{ color: COLORS.text }}>
                        {fmt(next.progress)} / {fmt(next.threshold)} referrals
                      </strong>
                      <span className="referral-reward-target">{Math.floor(next.progress / next.threshold * 100)}% complete</span>
                    </div>
                    <Progress
                      aria-label={`${rewardDisplayTitle(nextLabel[0] ?? next.reward)} milestone`}
                      aria-valuetext={`${fmt(next.progress)} of ${fmt(next.threshold)} joined referrals; ${fmt(next.threshold - next.progress)} more to go`}
                      value={(next.progress / next.threshold) * 100}
                      className="mt-2.5"
                      indicatorClassName="bg-[var(--app-accent)]"
                    />
                  </div>
                </Card>
              ) : !next && finalReward ? (
                <Card rewardKey={finalReward.milestone_key} className="p-6">
                  <div className="flex items-center gap-6"><div className="h-40 w-28 shrink-0"><RewardArtwork milestoneKey={finalReward.milestone_key} title={finalReward.reward} /></div><div><h3 className="ui-text-section-title">All milestones reached</h3><p className="mt-2 text-sm" style={{ color: COLORS.text2 }}>{fmt(count)} joined referrals. Rewards become claimable after qualification and review.</p></div></div>
                </Card>
              ) : null}

              {ladder.length > 0 ? <><div className="referral-milestones-heading -mb-1.5 flex items-baseline justify-between gap-3">
                <h3 className="ui-text-section-title">Milestones</h3>
                <p className="text-xs" style={{ color: COLORS.text2 }}>
                  {ladder.filter((entry) => earnedKeys.has(entry.milestone_key)).length} of {ladder.length} unlocked
                </p>
              </div>
              <ol className={`referral-reward-grid grid grid-cols-2 gap-3 ${ladder.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-4"}`}>
                {ladder.map((entry) => {
                  const earned = earnedKeys.has(entry.milestone_key);
                  const isNext = next?.milestone_key === entry.milestone_key;

                  const savedReward = earnedByKey.get(entry.milestone_key)?.reward;
                  const label = (savedReward ?? entry.reward).split(/,?\s+worth\s+/i);
                  return (
                    <li key={entry.milestone_key}>
                      <Card
                        rewardKey={entry.milestone_key}
                        className="referral-reward-tile"
                        rewardState={earned ? "earned" : isNext ? "next" : "locked"}
                      >
                        <div className="referral-reward-visual">
                          <span className="referral-product-tile-art grid shrink-0 place-items-center">
                            <RewardArtwork milestoneKey={entry.milestone_key} title={label[0] ?? entry.reward} />
                          </span>
                          {earned || (isNext && awaitingAward) ? (
                            <span
                              className="referral-milestone-status referral-type-caption"
                              style={{ color: earned ? "#137a35" : "#006dcc" }}
                            >{earned ? "Unlocked" : "Confirming"}</span>
                          ) : null}
                        </div>
                        <h4 className="ui-text-headline">{rewardDisplayTitle(label[0] ?? entry.reward)}</h4>
                        <p className={`mt-auto pt-5 referral-type-caption tabular-nums${earned ? " referral-earned" : ""}`} style={{ color: earned ? "#137a35" : COLORS.text2 }}>
                          {earned ? `Unlocked at ${fmt(entry.threshold)}` : `${fmt(entry.threshold)} referrals`}
                        </p>
                        {earned ? <MilestoneClaim milestone={milestones.earned.find((item) => item.milestone_key === entry.milestone_key)!} claims={claims} /> : null}
                      </Card>
                    </li>
                  );
                })}
              </ol></> : <p className="referral-type-support" style={{ color: COLORS.text2 }}>{fmt(count)} joined referrals. Your progress is saved.</p>}
              {previousRewards.length ? <section aria-label="Previously earned rewards"><h3 className="ui-text-section-title">Previously earned rewards</h3><ul>{previousRewards.map((entry) => <li key={entry.milestone_key} className="mt-3"><strong>{entry.reward}</strong><MilestoneClaim milestone={entry} claims={claims} /></li>)}</ul></section> : null}
            </div>
          );
        }}
      </Section>
    </>
  );
}

/** Same server-authoritative writer for either body. Re-reads never claim a
 * reward, and a lost response never schedules another fulfillment operation. */
function useReferralClaims(user: User | null | undefined, milestones: Res<MilestoneProgress>, onClaimed: () => void) {
  const pending = useRef(new Set<string>());
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const live = useRef({ user, milestones, onClaimed });
  useLayoutEffect(() => { live.current = { user, milestones, onClaimed }; });
  const [state, setState] = useState<Record<string, "saving" | "error">>({});
  const claim = async (key: string) => {
    const snapshot = live.current, owner = snapshotValidatedAuthSessionOwner();
    const current = () => mounted.current && !!owner && owner.userId === snapshot.user?.uid && live.current.user?.uid === owner.userId && isValidatedAuthSessionOwnerCurrent(owner);
    const earned = snapshot.milestones.status === "ready" ? snapshot.milestones.data.earned.find(item => item.milestone_key === key) : undefined;
    if (!snapshot.user || !current() || !earned || earned.claimed_at || pending.current.has(key)) return;
    pending.current.add(key); setState(previous => ({ ...previous, [key]: "saving" }));
    try {
      const idToken = await snapshot.user.getIdToken();
      if (!current()) return;
      await ReferralService.claimReward({ idToken, milestoneKey: key });
      if (current()) { setState(previous => { const next = { ...previous }; delete next[key]; return next; }); live.current.onClaimed(); }
    } catch {
      if (current()) { setState(previous => ({ ...previous, [key]: "error" })); live.current.onClaimed(); }
    } finally { pending.current.delete(key); }
  };
  return { state, claim };
}
export type ReferralClaims = ReturnType<typeof useReferralClaims>;

function MilestoneClaim({ milestone, claims }: { milestone: MilestoneProgress["earned"][number]; claims: ReferralClaims }) {
  const saving = claims.state[milestone.milestone_key] === "saving", error = claims.state[milestone.milestone_key] === "error";
  if (milestone.claimed_at) {
    return <p className="mt-2 text-xs">{referralClaimStatus(milestone)}</p>;
  }
  return <div className="mt-2"><Button variant="muted" disabled={saving} onClick={() => void claims.claim(milestone.milestone_key)}>{saving ? "Claiming…" : "Claim reward"}</Button>{error ? <p role="alert" className="mt-1 text-xs">Unable to claim. Refresh your rewards and try again.</p> : null}</div>;
}

function RulesTab({ policyRes, onRetry }: { policyRes: Res<ReferralPolicy>; onRetry: () => void }) {
  return (
    <Section res={policyRes} onRetry={onRetry} retryLabel="referral rules">
      {(policy) => <ReferralJourney policy={policy} />}
    </Section>
  );
}
