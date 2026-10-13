"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import { AppPageShell, AppPageHeaderRegion, AppPageContentRegion } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { ReferralJourney } from "./referral-journey";
import { ReferralInviteActions } from "./referral-invite-actions";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import type { User } from "firebase/auth";
import { Coins, Users, Trophy, Flame } from "@/components/icons";
import "./referral-dashboard.css";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
import { SegmentedTabs } from "@/lib/morphy-ux/ui/segmented-tabs";

import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/lib/firebase/auth-context";
import { useReferralStream } from "@/lib/referral/use-referral-stream";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";
import {
  ReferralService,
  type CircleLeaderboardEntry,
  type CircleSelection,
  type EngagementStatus,
  type LeaderboardPage,
  type MilestoneProgress,
  type ReferralSummary,
  type ReferralPolicy,
  type WeeklyChallenge,
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

function twoDigit(value: number): string {
  return String(Math.max(0, value)).padStart(2, "0");
}

/**
 * Total-hours `HHH:MM:SS` remaining until `remainingMs` from now, clamped to
 * `00:00:00` once passed. A pure function so the countdown math is testable
 * without rendering or faking a timer.
 */
export function formatCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return "00:00:00";
  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${twoDigit(hours)}:${twoDigit(minutes)}:${twoDigit(seconds)}`;
}

/**
 * `HHH:MM:SS` remaining until the absolute `cutoffIso` the backend reports,
 * recomputed every tick from that fixed instant -- never a client-side
 * `Date.now() + demo duration`, and never reset by a re-render, a route
 * change, a tab switch, or an account switch (those can only ever change
 * which `cutoffIso` the caller passes in, which is itself sourced from
 * `GET /api/one/referrals/challenge`, not invented here).
 */
function useCountdown(cutoffIso: string | null): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!cutoffIso) {
      setLabel(null);
      return;
    }
    const cutoff = new Date(cutoffIso).getTime();
    const tick = () => setLabel(formatCountdown(cutoff - Date.now()));
    tick();
    const interval = window.setInterval(tick, 1000);
    // A backgrounded tab throttles `setInterval`; recompute immediately from
    // the absolute cutoff the moment it becomes visible again rather than
    // waiting up to a second for the next throttled tick.
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [cutoffIso]);

  return label;
}

/**
 * Loading/ready/error for one independently-fetched piece of the dashboard.
 *
 * Every section of this page -- points, the leaderboard, milestones, the
 * weekly countdown, engagement, circle standing -- is its own resource with
 * its own status and its own retry. One section failing (the leaderboard,
 * say) must never hide or zero out a DIFFERENT section that loaded fine
 * (points, say): that was the exact bug a single page-wide load()/state pair
 * produced.
 */
type Res<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
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
    cacheKey: `referral_dashboard_${resource}_${user?.uid ?? "signed-out"}`,
    enabled: Boolean(user),
    resourceLabel: `referral-${resource}`,
    load: async () => {
      if (!user) throw new Error("not signed in");
      return fetcher(await user.getIdToken());
    },
  });
  const reload = useCallback(() => { void refresh({ force: true }); }, [refresh]);
  const res: Res<T> = error && !loading && !refreshing ? { status: "error" }
    : data !== null ? { status: "ready", data } : { status: "loading" };
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
      <div className="flex min-h-[20vh] items-center justify-center text-sm" style={{ color: COLORS.text2 }}>
        Loading…
      </div>
    );
  }
  if (res.status === "error") {
    return (
      <div className="flex min-h-[20vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm" style={{ color: COLORS.text2 }}>Unable to load {retryLabel}.</p>
        <Button variant="muted" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }
  return <>{children(res.data)}</>;
}

export function ReferralDashboardPage() {
  const { user } = useAuth();
  const ownerId = user?.uid ?? null;
  // Keep cached reads and local UI state isolated when the signed-in owner changes.
  return <ReferralDashboardContent key={ownerId ?? "signed-out"} />;
}

function ReferralDashboardContent() {
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
    ReferralService.getPoints({ idToken }).then((r) => r.points),
  );
  const [leaderboardRes, reloadLeaderboard] = useReferralResource(user, "leaderboard", (idToken) =>
    ReferralService.getLeaderboard({ idToken, limit: 10 }),
  );
  const [circleLeaderboardRes, reloadCircleLeaderboard] = useReferralResource(user, "circleleaderboard", (idToken) =>
    ReferralService.getCircleLeaderboard({ idToken }).then((r) => r.teams),
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
  const [challengeRes, reloadChallenge] = useReferralResource(user, "challenge", (idToken) =>
    ReferralService.getChallenge({ idToken }),
  );
  const [circleRes, reloadCircle] = useReferralResource(user, "circleselection", (idToken) =>
    ReferralService.getCircleSelection({ idToken }),
  );

  const reloadAll = useCallback(() => {
    reloadSummary();
    reloadPoints();
    reloadLeaderboard();
    reloadCircleLeaderboard();
    reloadMilestones();
    reloadPolicy();
    reloadEngagement();
    reloadChallenge();
    reloadCircle();
  }, [
    reloadSummary,
    reloadPoints,
    reloadLeaderboard,
    reloadCircleLeaderboard,
    reloadMilestones,
    reloadPolicy,
    reloadEngagement,
    reloadChallenge,
    reloadCircle,
  ]);

  // A pushed "something changed" doorbell re-reads everything: the server
  // never says WHICH resource changed, and re-fetching eight already-cheap
  // reads is simpler than guessing.
  const { connected } = useReferralStream(user, reloadAll);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") reloadAll();
    };
    const interval = connected ? null : window.setInterval(refreshIfVisible, 30_000);
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);
    return () => {
      if (interval !== null) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [connected, reloadAll]);

  const link = summaryRes.status === "ready" ? summaryRes.data.link : "";
  const countdown = useCountdown(
    challengeRes.status === "ready" && challengeRes.data.active
      ? challengeRes.data.cutoff_at
      : null,
  );

  const cutoffAt = challengeRes.status === "ready" ? challengeRes.data.cutoff_at : null;
  useEffect(() => {
    if (!cutoffAt) return;
    const delay = new Date(cutoffAt).getTime() - Date.now();
    if (!Number.isFinite(delay)) return;
    const timer = window.setTimeout(reloadChallenge, Math.max(0, delay) + 1000);
    return () => window.clearTimeout(timer);
  }, [cutoffAt, reloadChallenge]);

  const onCopy = useCallback(async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      morphyToast.success("Invite link copied");
    } catch {
      morphyToast.error("Could not copy");
    }
  }, [link]);

  const onShare = useCallback(async () => {
    if (!link) return;
    const share = navigator.share?.bind(navigator);
    if (!share) {
      void onCopy();
      return;
    }
    try {
      await share({ text: "Join me on Hushh One", url: link });
    } catch {
      // Cancelling the native share sheet is a choice, not a failure.
    }
  }, [link, onCopy]);

  const dataState =
    summaryRes.status === "loading"
      ? "loading"
      : summaryRes.status === "error"
        ? "unavailable-valid"
        : "loaded";

  return (
    <ShellRoot dataState={dataState} tab={tab} onTabChange={setTab} showHowItWorks={showHowItWorks} onHowItWorks={() => setShowHowItWorks(true)}>
      {showHowItWorks ? <section aria-label="How referrals work"><RulesTab policyRes={policyRes} onRetry={reloadPolicy} /></section> : <SwipeViews tabSetId="referrals" activeValue={tab} options={TABS.map(({ key, label }) => ({ value: key, label }))} onSelectionChange={(value) => setTab(value as TabKey)} viewportMinHeight="fill" heightMode="active">
      <div>
      {summaryRes.status === "loading" ? (
        <div className="flex min-h-[40vh] items-center justify-center text-sm" style={{ color: COLORS.text2 }}>
          Loading your referrals…
        </div>
      ) : summaryRes.status === "error" ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm" style={{ color: COLORS.text2 }}>Unable to load. Check your connection.</p>
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
              circleLeaderboardRes={circleLeaderboardRes}
              onRetryCircleLeaderboard={reloadCircleLeaderboard}
              engagementRes={engagementRes}
              onRetryEngagement={reloadEngagement}
              challengeRes={challengeRes}
              onRetryChallenge={reloadChallenge}
              circleRes={circleRes}
              onRetryCircle={reloadCircle}
              countdown={countdown}
              link={link}
              onCopy={onCopy}
              onShare={onShare}
            />
          ) : null}
        </>
      )}
      </div>
      <div>
        <StandingsTab
          leaderboardRes={leaderboardRes}
          onRetryLeaderboard={reloadLeaderboard}
          circleLeaderboardRes={circleLeaderboardRes}
          onRetryCircleLeaderboard={reloadCircleLeaderboard}
          board={board}
          onBoardChange={setBoard}
        />
      </div>
      <section aria-label="Rewards">
        <RewardsTab milestonesRes={milestonesRes} onRetry={reloadMilestones} />
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
  useScrollReset(showHowItWorks ? "referral-help" : "referral-dashboard");

  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, [showHowItWorks]);

  return (
    <AppPageShell
      as="div"
      width="agent"
      className={`referral-dashboard${showHowItWorks ? " referral-help-page" : ""}`}
      style={{ background: "transparent", color: COLORS.text }}
      nativeTest={{ routeId: ROUTES.ONE_REFERRALS, marker: "native-route-one-referrals", authState: "authenticated", dataState }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          title={showHowItWorks ? "How it works" : "Referrals"}
          actionsInlineMobile
          actions={!showHowItWorks ? (
            <button onClick={onHowItWorks} className="referral-how-it-works">
              <span aria-hidden="true" className="referral-help-icon">?</span>
              How it works
            </button>
          ) : undefined}
        />
        {!showHowItWorks && <div className="referral-tab-row mt-6">
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
  className,
  style,
  children,
}: {
  rewardKey?: string;
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div
      data-reward={rewardKey}
      className={"referral-card rounded-[18px] " + (className ?? "")}
      style={{ background: COLORS.card, ...style }}
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
  circleLeaderboardRes,
  onRetryCircleLeaderboard,
  engagementRes,
  onRetryEngagement,
  challengeRes,
  onRetryChallenge,
  circleRes,
  onRetryCircle,
  countdown,
  link,
  onCopy,
  onShare,
}: {
  active: boolean;
  summary: ReferralSummary;
  pointsRes: Res<number>;
  onRetryPoints: () => void;
  leaderboardRes: Res<LeaderboardPage>;
  onRetryLeaderboard: () => void;
  circleLeaderboardRes: Res<CircleLeaderboardEntry[]>;
  onRetryCircleLeaderboard: () => void;
  engagementRes: Res<EngagementStatus>;
  onRetryEngagement: () => void;
  challengeRes: Res<WeeklyChallenge>;
  onRetryChallenge: () => void;
  circleRes: Res<CircleSelection>;
  onRetryCircle: () => void;
  countdown: string | null;
  link: string;
  onCopy: () => void;
  onShare: () => void;
}) {
  return (
    <>
      <div className="referral-hero">
        <div className="referral-hero-copy">
          <p className="referral-hero-eyebrow"><Users aria-hidden="true" />Invite &amp; earn</p>
          <h1 className="referral-hero-title">Good things<br />grow <span>together.</span></h1>
          {link ? (
            <ReferralInviteActions key={link} active={active} link={link} onCopy={onCopy} onShare={onShare} />
          ) : null}
        </div>
        <Image
          src="/referrals/friends-hero-professionals.svg"
          alt=""
          width={1599}
          height={984}
          className="referral-hero-art"
          loading="eager"
          unoptimized
        />
      </div>

      <StatsGrid
        pointsRes={pointsRes}
        onRetryPoints={onRetryPoints}
        leaderboardRes={leaderboardRes}
        onRetryLeaderboard={onRetryLeaderboard}
        summary={summary}
        engagementRes={engagementRes}
        onRetryEngagement={onRetryEngagement}
      />

      <ChallengeClock
        challengeRes={challengeRes}
        onRetryChallenge={onRetryChallenge}
        countdown={countdown}
      />

      <div className="referral-duo grid gap-4 sm:grid-cols-2">
        <Card className="referral-activity-card p-[22px]">
          <h3 className="ui-text-section-title">Recent referrals</h3>
          {summary.referrals.length > 0 ? (
            <ul className="mt-[14px] -mb-2.5 divide-y" style={{ borderColor: COLORS.sep }}>
              {summary.referrals.slice(0, 3).map((row, index) => (
                <li
                  key={`${row.started_on}:${index}`}
                  className="grid min-h-[58px] grid-cols-[34px_minmax(0,1fr)_auto] items-center gap-3"
                >
                  <span
                    className="grid size-[34px] place-items-center rounded-[9px]"
                    style={{ background: "rgba(52,199,89,.16)", color: "#1e9a47" }}
                  >
                    <Users className="size-[18px]" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <strong className="block truncate text-base font-medium">New member</strong>
                    <time className="block text-sm" style={{ color: COLORS.text2 }}>
                      {row.started_on}
                    </time>
                  </div>
                  <span className="referral-status-chip whitespace-nowrap text-xs font-medium">
                    {row.status}
                  </span>
                </li>
              ))}
            </ul>
          ) : <p className="mt-3 text-sm" style={{ color: COLORS.text2 }}>No referrals yet.</p>}
        </Card>

        <Card className="referral-circle-card p-[22px]">
          <h3 className="ui-text-section-title referral-circle-heading">
            <span className="referral-circle-symbol" aria-hidden="true"><Users size={19} /></span>
            Your circle
          </h3>
          <Section res={circleRes} onRetry={onRetryCircle} retryLabel="your circle">
            {(circle) => (
              <CircleCardBody
                circle={circle}
                circleLeaderboardRes={circleLeaderboardRes}
                onRetryCircleLeaderboard={onRetryCircleLeaderboard}
              />
            )}
          </Section>
          <div className="referral-circle-preview">
            <Trophy size={20} weight="fill" aria-hidden="true" />
            <span>Circle Wars</span>
            <span className="referral-preview-label">Not active</span>
          </div>
        </Card>
      </div>
    </>
  );
}

function ChallengeClock({
  challengeRes,
  onRetryChallenge,
  countdown,
}: {
  challengeRes: Res<WeeklyChallenge>;
  onRetryChallenge: () => void;
  countdown: string | null;
}) {
  // The seven-day track and Day 1-7 labels are a structural part of the card
  // footprint, not a thing that depends on the challenge resource: they stay
  // on screen (at zero fill) while loading, on error, and while no challenge
  // is yet scheduled, and only gain a real fill and "now" marker once a live
  // window is confirmed active.
  const weekProgress = (() => {
    if (challengeRes.status === "ready" && challengeRes.data.active) {
      const { week_started_at, cutoff_at } = challengeRes.data;
      if (week_started_at && cutoff_at) {
        const start = new Date(week_started_at).getTime();
        const end = new Date(cutoff_at).getTime();
        const now = Date.now();
        const totalDays = Math.max(1, Math.round((end - start) / 86_400_000));
        const elapsedDays = Math.min(totalDays, Math.max(0, (now - start) / 86_400_000));
        return { totalDays, elapsedDays, live: true };
      }
    }
    return { totalDays: 7, elapsedDays: 0, live: false };
  })();

  const headline =
    challengeRes.status === "loading"
      ? { label: "Weekly challenge", value: "…" }
      : challengeRes.status === "error"
        ? { label: "Weekly challenge", value: "Unable to load" }
        : challengeRes.data.active
          ? { label: "Weekly challenge ends in", value: countdown ?? "—" }
          : { label: "Weekly challenge", value: "Not yet scheduled" };

  return (
    <div
      className="referral-clock relative isolate overflow-hidden rounded-[20px] text-white"
      style={{
        padding: "26px 30px 28px",
        background: "#172333",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,.08)",
      }}
    >
      <p className="referral-challenge-heading">
        <span className="inline-flex items-center gap-[9px]">
          <span
            className="inline-flex size-[7px] rounded-full"
            style={{ background: "#34c759" }}
            aria-hidden="true"
          />
          {headline.label}
        </span>
      </p>
      <div className="referral-challenge-status">
        <span className={`tabular-nums${challengeRes.status === "ready" && challengeRes.data.active ? " referral-countdown-value" : ""}`}>
          {headline.value}
        </span>
      {challengeRes.status === "error" ? (
        <button onClick={onRetryChallenge} className="min-h-11 text-sm font-medium underline">
          Try again
        </button>
      ) : null}
      </div>
      <div
        className="referral-challenge-track grid gap-2"
        style={{ gridTemplateColumns: `repeat(${weekProgress.totalDays}, minmax(0, 1fr))` }}
        role="img"
        aria-label={
          weekProgress.live
            ? `Weekly challenge progress: day ${Math.min(7, Math.floor(weekProgress.elapsedDays) + 1)} of ${weekProgress.totalDays}`
            : "Weekly challenge progress: not yet started"
        }
      >
        {Array.from({ length: weekProgress.totalDays }, (_, i) => {
          const fill = weekProgress.live
            ? Math.max(0, Math.min(1, weekProgress.elapsedDays - i)) * 100
            : 0;
          const isNow =
            weekProgress.live &&
            i === Math.min(weekProgress.totalDays - 1, Math.floor(weekProgress.elapsedDays));
          return (
            <div
              key={i}
              className="relative h-[6px] rounded-full"
              style={{ background: "rgba(255,255,255,.14)" }}
            >
              <div
                    className="h-full rounded-full bg-white"
                style={{ width: `${fill}%` }}
              />
              {isNow ? (
                <span
                  aria-hidden="true"
                  className="absolute top-1/2 size-[14px] -translate-y-1/2 rounded-full bg-white"
                  style={{ left: `calc(${fill}% - 7px)`, boxShadow: "0 0 0 5px rgba(255,255,255,.16)" }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <ol className="referral-challenge-days grid gap-2" style={{ gridTemplateColumns: `repeat(${weekProgress.totalDays}, minmax(0, 1fr))` }}>
        {Array.from({ length: weekProgress.totalDays }, (_, i) => {
          const isNow =
            weekProgress.live &&
            i === Math.min(weekProgress.totalDays - 1, Math.floor(weekProgress.elapsedDays));
          return (
            <li key={i} className="min-w-0 text-center text-xs leading-[1.4]" style={{ color: isNow ? "#aeaeb2" : "#8e8e93" }}>
              <b className="block whitespace-nowrap font-semibold" style={{ fontSize: "clamp(10px, 2.8vw, 13px)", color: isNow ? "#fff" : "#aeaeb2" }}>
                Day {i + 1}
              </b>
            </li>
          );
        })}
      </ol>
    </div>
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
  pointsRes: Res<number>;
  onRetryPoints: () => void;
  leaderboardRes: Res<LeaderboardPage>;
  onRetryLeaderboard: () => void;
  summary: ReferralSummary;
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
      label: "Your coins",
      value: statText(pointsRes, (p) => fmt(p)),
      sub: statSub(pointsRes, () => ""),
      onRetry: pointsRes.status === "error" ? onRetryPoints : undefined,
    },
    {
      label: "Published rank",
      value: statText(leaderboardRes, (lb) => {
        const v = lb.viewer ?? lb.entries.find((e) => e.is_viewer) ?? null;
        return v ? `#${v.rank}` : "—";
      }),
      sub: statSub(leaderboardRes, () => ""),
      onRetry: leaderboardRes.status === "error" ? onRetryLeaderboard : undefined,
    },
    {
      label: "Referrals",
      value: fmt(summary.qualified_count),
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
            <dt className="text-xs font-medium" style={{ color: COLORS.text2 }}>
              <span className={`referral-stat-icon referral-stat-icon-${index}`} aria-hidden="true">
                {index === 0 ? <Coins /> : index === 1 ? <Trophy /> : <Users />}
              </span>
              {cell.label}
            </dt>
            <dd className="mt-1 flex items-center gap-2">
              <span className="text-[28px] font-bold leading-[34px] tracking-[-0.025em] tabular-nums">
                {cell.value}
              </span>
            </dd>
            {cell.sub && <dd className="mt-0.5 text-xs" style={{ color: COLORS.text2 }}>{cell.sub}</dd>}
            {cell.onRetry ? (
              <button
                onClick={cell.onRetry}
                className="mt-1 text-xs font-medium"
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
        <div className="min-w-0">
          <h2 className="ui-text-section-title">Day streak</h2>
        </div>
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

function CircleCardBody({
  circle,
  circleLeaderboardRes,
  onRetryCircleLeaderboard,
}: {
  circle: CircleSelection;
  circleLeaderboardRes: Res<CircleLeaderboardEntry[]>;
  onRetryCircleLeaderboard: () => void;
}) {
  if (!circle.circle_id) {
    return (
      <p className="mt-2 text-sm" style={{ color: COLORS.text2 }}>
        Choose your circle.
      </p>
    );
  }
  return (
    <Section
      res={circleLeaderboardRes}
      onRetry={onRetryCircleLeaderboard}
      retryLabel="your team's standing"
    >
      {(teams) => {
        // `get_team_rankings` returns rows already ordered by
        // contribution_count DESC; rank is the 1-based position in that
        // order, not a server field.
        const index = teams.findIndex((t) => t.circle_id === circle.circle_id);
        const myCircle = index >= 0 ? teams[index] : null;
        return (
          <>
            <p className="mt-1 text-lg font-semibold">
              {myCircle?.circle_name ?? "Selected circle"}
            </p>
            <dl className="mt-4 flex justify-between gap-4 border-t pt-4" style={{ borderColor: COLORS.sep }}>
              <div>
                <dt className="text-xs" style={{ color: COLORS.text2 }}>Team rank</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums">
                  {index >= 0 ? `#${index + 1}` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs" style={{ color: COLORS.text2 }}>Team referrals</dt>
                <dd className="mt-0.5 text-base font-semibold tabular-nums">
                  {myCircle ? fmt(myCircle.contribution_count) : "—"}
                </dd>
              </div>
            </dl>
          </>
        );
      }}
    </Section>
  );
}

function StandingsTab({
  leaderboardRes,
  onRetryLeaderboard,
  circleLeaderboardRes,
  onRetryCircleLeaderboard,
  board,
  onBoardChange,
}: {
  leaderboardRes: Res<LeaderboardPage>;
  onRetryLeaderboard: () => void;
  circleLeaderboardRes: Res<CircleLeaderboardEntry[]>;
  onRetryCircleLeaderboard: () => void;
  board: "individual" | "circles";
  onBoardChange: (board: "individual" | "circles") => void;
}) {
  const gapText =
    board === "individual"
      ? leaderboardRes.status === "ready"
        ? gapCopy(leaderboardRes.data)
        : null
      : null;

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
        {gapText ? (
          <p
            className="referral-ranking-summary"
            style={{ color: COLORS.text2 }}
          >
            {gapText}
          </p>
        ) : null}
      </div>

      <Card className="referral-leaderboard-card p-2">
        <div className="referral-leaderboard-columns" aria-hidden="true">
          <span>Rank</span><span>{board === "individual" ? "Member" : "Circle"}</span><span>{board === "individual" ? "Coins" : "Referrals"}</span>
        </div>
        {board === "individual" ? (
          <Section res={leaderboardRes} onRetry={onRetryLeaderboard} retryLabel="the individual standings">
            {(leaderboard) =>
              leaderboard.entries.length === 0 ? (
                <EmptyBoard note={leaderboard.stale ? "Standings have not published yet." : "No entries yet."} />
              ) : (
                <ol className="divide-y" style={{ borderColor: COLORS.sep }}>
                  {leaderboard.entries.map((entry) => (
                    <BoardRow
                      key={entry.rank}
                      rank={entry.rank}
                      who={entry.handle}
                      points={entry.points}
                      top={leaderboard.entries[0]?.points ?? entry.points}
                      me={entry.is_viewer}
                      first={entry.rank === 1}
                    />
                  ))}
                  {leaderboard.viewer && !leaderboard.entries.some((e) => e.is_viewer) ? (
                    <BoardRow
                      rank={leaderboard.viewer.rank}
                      who={leaderboard.viewer.handle}
                      points={leaderboard.viewer.points}
                      top={leaderboard.entries[0]?.points ?? leaderboard.viewer.points}
                      me
                      first={false}
                    />
                  ) : null}
                </ol>
              )
            }
          </Section>
        ) : (
          <Section res={circleLeaderboardRes} onRetry={onRetryCircleLeaderboard} retryLabel="the circle standings">
            {(teams) =>
              teams.length === 0 ? (
                <EmptyBoard note="No circle standings yet." />
              ) : (
                <ol className="divide-y" style={{ borderColor: COLORS.sep }}>
                  {teams.map((team, index) => (
                    <BoardRow
                      key={team.circle_id}
                      rank={index + 1}
                      who={team.circle_name}
                      points={team.contribution_count}
                      top={teams[0]?.contribution_count ?? team.contribution_count}
                      me={false}
                      first={index === 0}
                    />
                  ))}
                </ol>
              )
            }
          </Section>
        )}
      </Card>
    </div>
  );
}

function gapCopy(lb: LeaderboardPage): string | null {
  const v = lb.viewer ?? lb.entries.find((e) => e.is_viewer) ?? null;
  if (!v) return null;
  const ahead = lb.entries.find((e) => e.rank === v.rank - 1);
  if (!ahead) return `You're #${v.rank}.`;
  const gap = ahead.points - v.points;
  if (gap <= 0) return `You're #${v.rank}.`;
  return `You're #${v.rank}. ${fmt(gap)} coins to pass ${ahead.handle}.`;
}

function BoardRow({
  rank,
  who,
  points,
  top,
  me,
  first,
}: {
  rank: number;
  who: string;
  points: number;
  top: number;
  me: boolean;
  first: boolean;
}) {
  const fillPct = top > 0 ? Math.max(0, Math.min(100, (points / top) * 100)) : 0;
  return (
    <li
      className="grid grid-cols-[22px_minmax(0,1fr)_auto] items-baseline gap-x-3.5 gap-y-2 rounded-xl px-3.5 py-3"
      style={{ background: me ? COLORS.meSurface : undefined }}
    >
      <span
        className="text-sm font-semibold tabular-nums"
        style={{ color: first ? "#8a6431" : rank <= 3 ? COLORS.text : COLORS.text2 }}
      >
        {rank}
      </span>
      <span className="min-w-0 truncate text-base font-semibold">
        {who}
        {me ? (
          <small className="ml-2 text-sm font-normal" style={{ color: COLORS.blue }}>
            You
          </small>
        ) : null}
      </span>
      <span className="text-base font-semibold tabular-nums">{fmt(points)}</span>
      <div
        className="col-span-2 col-start-2 h-1.5 overflow-hidden rounded-full"
        style={{ background: me ? "rgba(0,122,255,.14)" : COLORS.fill2 }}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${fillPct}%`,
            background: first
              ? "linear-gradient(90deg, var(--referral-medal-deep), var(--referral-medal-light))"
              : me
                ? COLORS.blue
                : COLORS.chevron,
          }}
        />
      </div>
    </li>
  );
}

function EmptyBoard({ note }: { note: string }) {
  return <div className="referral-ranking-empty"><Trophy aria-hidden="true" /><p>{note}</p></div>;
}

const REWARD_PRODUCTS: Record<string, string> = {
  voucher_10: "voucher", earbuds_100: "earbuds", airpods_500: "airpods", iphone_10000: "iphone",
};

function RewardArtwork({ milestoneKey, title }: { milestoneKey: string; title: string }) {
  const product = REWARD_PRODUCTS[milestoneKey];
  if (!product) return null;
  return <span role="img" aria-label={title} className="referral-product-art" style={{ backgroundImage: `url(/referrals/product-${product}.svg)` }} />;
}

function RewardsTab({
  milestonesRes,
  onRetry,
}: {
  milestonesRes: Res<MilestoneProgress>;
  onRetry: () => void;
}) {
  return (
    <>
      <Section res={milestonesRes} onRetry={onRetry} retryLabel="your reward progress">
        {(milestones) => {
          // A compatibility gate, never a fallback catalogue or user-value override.
          const expected = { voucher_10: 10, earbuds_100: 100, airpods_500: 500, iphone_10000: 10000 };
          const catalogue = milestones.available_milestones;
          if (!catalogue || catalogue.length !== 4 ||
            !Number.isSafeInteger(milestones.lifetime_qualified_count) || milestones.lifetime_qualified_count < 0 ||
            new Set(catalogue.map((entry) => entry.milestone_key)).size !== 4 ||
            catalogue.some((entry) => expected[entry.milestone_key as keyof typeof expected] !== entry.threshold)) {
            return (
              <Card className="p-[22px]" >
                <h3 className="ui-text-section-title">Rewards policy unavailable</h3>
                <p className="mt-2 text-sm" style={{ color: COLORS.text2 }}>
                  Rewards are not available yet. Your progress is saved.
                </p>
                <p className="mt-3 text-sm" style={{ color: COLORS.text2 }}>
                  {fmt(milestones.lifetime_qualified_count)} lifetime qualified referrals · {milestones.earned.length} recorded rewards
                </p>
              </Card>
            );
          }
          const ladder = [...catalogue].sort((a, b) => a.threshold - b.threshold);
          const count = milestones.lifetime_qualified_count;
          const nextEntry = ladder.find((entry) => count < entry.threshold);
          const next = nextEntry ? { ...nextEntry, progress: count } : null;
          const earnedKeys = new Set(ladder.filter((entry) => count >= entry.threshold).map((entry) => entry.milestone_key));
          const nextLabel = next?.reward.split(/,?\s+worth\s+/i) ?? [];

          return (
            <div className="referral-rewards-content grid gap-[18px]">
              {next ? (
                <Card
                  rewardKey={next.milestone_key}
                  className="referral-reward-feature"
                  style={{ position: "relative", overflow: "hidden" }}
                >
                  <div>
                    <p className="referral-reward-eyebrow"><Trophy size={14} aria-hidden="true" />Your next reward</p>
                    <h3 className="referral-reward-title ui-text-section-title">
                      {nextLabel[0]}
                    </h3>
                  </div>
                  <div className="referral-reward-stage">
                    <RewardArtwork milestoneKey={next.milestone_key} title={nextLabel[0] ?? next.reward} />
                  </div>
                  <div className="referral-reward-progress">
                    <div className="flex items-baseline justify-between gap-3 text-xs" style={{ color: COLORS.text2 }}>
                      <strong className="text-sm font-semibold tabular-nums" style={{ color: COLORS.text }}>
                        {fmt(next.progress)} / {fmt(next.threshold)} referrals
                      </strong>
                      <span className="referral-reward-target">{Math.floor(next.progress / next.threshold * 100)}% complete</span>
                    </div>
                    <Progress
                      aria-label={`${nextLabel[0]} milestone`}
                      aria-valuetext={`${fmt(next.progress)} of ${fmt(next.threshold)} qualified referrals; ${fmt(next.threshold - next.progress)} more to go`}
                      value={(next.progress / next.threshold) * 100}
                      className="mt-2.5"
                      indicatorClassName="bg-[var(--app-accent)]"
                    />
                  </div>
                </Card>
              ) : (
                <Card rewardKey="iphone_10000" className="p-6">
                  <div className="flex items-center gap-6"><div className="h-40 w-28 shrink-0"><RewardArtwork milestoneKey="iphone_10000" title="iPhone" /></div><div><h3 className="ui-text-section-title">All rewards unlocked</h3><p className="mt-2 text-sm" style={{ color: COLORS.text2 }}>{fmt(count)} qualified referrals. You have reached all four milestones.</p></div></div>
                </Card>
              )}

              <div className="-mb-1.5 flex items-baseline justify-between gap-3">
                <h3 className="ui-text-section-title">Milestones</h3>
                <p className="text-xs" style={{ color: COLORS.text2 }}>
                  {earnedKeys.size} of 4 unlocked
                </p>
              </div>
              <ol className="referral-reward-grid grid grid-cols-2 gap-3 sm:grid-cols-4">
                {ladder.map((entry) => {
                  const earned = earnedKeys.has(entry.milestone_key);
                  const isNext = next?.milestone_key === entry.milestone_key;

                  const label = entry.reward.split(/,?\s+worth\s+/i);
                  return (
                    <li key={entry.milestone_key}>
                      <Card
                        rewardKey={entry.milestone_key}
                        className="referral-reward-tile flex min-h-[182px] flex-col p-4 sm:min-h-[204px] sm:p-5"
                        style={{ border: `1px solid ${isNext ? "rgba(0,122,255,.24)" : "transparent"}` }}
                      >
                        <div className="mb-[18px] flex items-center justify-between gap-2">
                          <span className="referral-product-tile-art grid shrink-0 place-items-center">
                            <RewardArtwork milestoneKey={entry.milestone_key} title={label[0] ?? entry.reward} />
                          </span>
                          <span
                            className="referral-milestone-status text-xs font-semibold"
                            aria-hidden={!earned && !isNext ? true : undefined}
                            style={{ color: earned ? "#137a35" : "#006dcc", visibility: earned || isNext ? "visible" : "hidden" }}
                          >{earned ? "Unlocked" : "Up next"}</span>
                        </div>
                        <h4 className="ui-text-headline">{label[0]}</h4>
                        <p className="mt-auto pt-5 text-xs tabular-nums" style={{ color: earned ? "#137a35" : COLORS.text2, fontWeight: earned ? 600 : 400 }}>
                          {earned ? `Unlocked at ${entry.threshold}` : `${fmt(entry.threshold)} referrals`}
                        </p>
                      </Card>
                    </li>
                  );
                })}
              </ol>
            </div>
          );
        }}
      </Section>
    </>
  );
}

function RulesTab({ policyRes, onRetry }: { policyRes: Res<ReferralPolicy>; onRetry: () => void }) {
  return (
    <Section res={policyRes} onRetry={onRetry} retryLabel="referral rules">
      {(policy) => <ReferralJourney policy={policy} />}
    </Section>
  );
}
