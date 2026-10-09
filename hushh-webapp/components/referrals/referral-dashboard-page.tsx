"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { useStaleResource } from "@/lib/cache/use-stale-resource";
import type { User } from "firebase/auth";
import { ArrowLeft, Link2, Users, ShieldCheck, Zap, Trophy } from "@/components/icons";
import "./referral-dashboard.css";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/lib/firebase/auth-context";
import { useReferralStream } from "@/lib/referral/use-referral-stream";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import { navigateTopShellBack } from "@/lib/navigation/top-shell-back";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";
import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import { ReferralIntroduction } from "./referral-introduction";
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

type TabKey = "you" | "standings" | "rewards" | "rules";

const TABS: { key: TabKey; label: string }[] = [
  { key: "you", label: "You" },
  { key: "standings", label: "Standings" },
  { key: "rewards", label: "Rewards" },
  { key: "rules", label: "Rules" },
];

/** Fixed reference palette; globals.css scopes accent tokens to this route. */
const COLORS = {
  bg: "#f2f2f7",
  text: "#1d1d1f",
  text2: "#6e6e73",
  text3: "#8e8e93",
  sep: "rgba(60, 60, 67, .12)",
  blue: "var(--app-accent)",
  blueText: "#006dcc",
  blueSoft: "rgba(0, 122, 255, .1)",
  meSurface: "#e6f0ff",
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

/** Exact embedded mark from the approved standalone reference. */
function OneMark({ dotSize }: { emojiSize: number; dotSize: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden className="referral-reference-mark" style={{ width: dotSize ? 24 : 60, height: dotSize ? 24 : 60 }} />
      {dotSize > 0 ? <span className="font-semibold leading-none tracking-[-0.01em]" style={{ fontSize: dotSize }}>One<span style={{ color: COLORS.blue }}>.</span></span> : null}
    </span>
  );
}

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
  // Remount on account changes: even an A → B → A switch gets a new local
  // session, so an old native preference write cannot dismiss a later replay.
  return <ReferralDashboardGate key={ownerId ?? "signed-out"} ownerId={ownerId} />;
}

function ReferralDashboardGate({ ownerId }: { ownerId: string | null }) {
  const router = useRouter();
  const [introduction, setIntroduction] = useState<{ ownerId: string; seen: boolean } | null>(null);
  const [savingOwnerId, setSavingOwnerId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (ownerId) {
      void OnboardingLocalService.hasSeenReferralIntroduction(ownerId).then((seen) => {
        if (!cancelled) setIntroduction({ ownerId, seen });
      });
    }
    return () => { cancelled = true; };
  }, [ownerId]);

  const completeIntroduction = async () => {
    if (!ownerId || savingOwnerId === ownerId) return;
    setSavingOwnerId(ownerId);
    await OnboardingLocalService.markReferralIntroductionSeen(ownerId);
    setIntroduction((current) => current?.ownerId === ownerId ? { ownerId, seen: true } : current);
    setSavingOwnerId((current) => current === ownerId ? null : current);
  };

  if (!ownerId || introduction?.ownerId !== ownerId) {
    return (
      <div className="referral-dashboard flex min-h-dvh items-center justify-center text-sm">
        <NativeTestBeacon routeId={ROUTES.ONE_REFERRALS} marker="native-route-one-referrals" authState="authenticated" dataState="loading" />
        <p role="status">Loading your referrals…</p>
      </div>
    );
  }

  if (!introduction.seen) {
    return (
      <ReferralIntroduction
        onContinue={() => { void completeIntroduction(); }}
        onBack={() => navigateTopShellBack({ pathname: ROUTES.ONE_REFERRALS, navigate: ({ href, mode }) => router[mode](href) })}
        busy={savingOwnerId === ownerId}
      />
    );
  }

  return <ReferralDashboardContent onReplayIntroduction={() => setIntroduction({ ownerId, seen: false })} />;
}

function ReferralDashboardContent({ onReplayIntroduction }: { onReplayIntroduction: () => void }) {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabKey>("you");
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
    <ShellRoot dataState={dataState} tab={tab} onTabChange={setTab} link={link} onCopy={onCopy} onReplayIntroduction={onReplayIntroduction}>
      {tab === "you" && summaryRes.status === "loading" ? (
        <div className="flex min-h-[40vh] items-center justify-center text-sm" style={{ color: COLORS.text2 }}>
          Loading your referrals…
        </div>
      ) : tab === "you" && summaryRes.status === "error" ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm" style={{ color: COLORS.text2 }}>Unable to load. Check your connection.</p>
          <Button onClick={reloadSummary}>Try again</Button>
        </div>
      ) : (
        <>
          {tab === "you" && summaryRes.status === "ready" ? (
            <YouTab
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
              onSeeStandings={() => setTab("standings")}
              link={link}
              onCopy={onCopy}
              onShare={onShare}
            />
          ) : null}
          {tab === "standings" ? (
            <StandingsTab
              leaderboardRes={leaderboardRes}
              onRetryLeaderboard={reloadLeaderboard}
              circleLeaderboardRes={circleLeaderboardRes}
              onRetryCircleLeaderboard={reloadCircleLeaderboard}
              board={board}
              onBoardChange={setBoard}
            />
          ) : null}
          {tab === "rewards" ? (
            <RewardsTab milestonesRes={milestonesRes} onRetry={reloadMilestones} />
          ) : null}
          {tab === "rules" ? <RulesTab policyRes={policyRes} onRetry={reloadPolicy} /> : null}
        </>
      )}
    </ShellRoot>
  );
}

/**
 * This route owns its full viewport: `app-route-layout.contract.json` marks
 * `/one/referrals` `mode: "hidden"` with `persistentChrome: "none"`, the same
 * recipe `/one/location/map` uses for an immersive, chrome-free screen (see
 * `location-map-route-layout.test.ts`). So there is no app TopShell bar and
 * no bottom "Talk to One" / navigation shell to clear here -- this component
 * is the entire page, sticky header and floating invite dock included.
 */
function ShellRoot({
  dataState,
  tab,
  onTabChange,
  link,
  onCopy,
  onReplayIntroduction,
  children,
}: {
  dataState: "loading" | "loaded" | "unavailable-valid";
  tab: TabKey;
  onTabChange: (tab: TabKey) => void;
  link: string;
  onCopy: () => void;
  onReplayIntroduction: () => void;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const mainRef = useRef<HTMLElement>(null);
  useScrollReset("referral-dashboard");

  useEffect(() => {
    mainRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="referral-dashboard min-h-dvh" style={{ background: COLORS.bg, color: COLORS.text }}>
      <NativeTestBeacon
        routeId={ROUTES.ONE_REFERRALS}
        marker="native-route-one-referrals"
        authState="authenticated"
        dataState={dataState}
      />
      <header
        className="sticky top-0 z-50 backdrop-blur-xl"
        style={{ background: "rgba(242, 242, 247, .82)" }}
      >
        <div className="mx-auto grid h-16 max-w-[1008px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 px-6">
          <div className="flex items-center gap-3">
            <ShellActionSurface aria-label="Back to One home" title="Back to One home" onClick={() => navigateTopShellBack({ pathname: ROUTES.ONE_REFERRALS, navigate: ({ href, mode }) => router[mode](href) })} className="referral-back-button !h-11 !w-11">
              <ArrowLeft className="size-5" aria-hidden="true" />
            </ShellActionSurface>
            <OneMark emojiSize={19} dotSize={17} />
          </div>
          <div
            role="tablist"
            aria-label="Referral sections"
            className="flex gap-0.5 rounded-xl p-0.5"
            style={{ background: COLORS.fill }}
          >
            {TABS.map((item) => (
              <button
                key={item.key}
                role="tab"
                aria-selected={tab === item.key}
                onClick={() => onTabChange(item.key)}
                className="whitespace-nowrap rounded-[10px] px-3.5 text-[13px] font-semibold transition-colors"
                style={{
                  height: 32,
                  background: tab === item.key ? COLORS.card : "transparent",
                  color: tab === item.key ? COLORS.blueText : COLORS.text2,
                  boxShadow: tab === item.key ? "0 1px 2px rgba(0,0,0,.1)" : undefined,
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span aria-hidden />
        </div>
      </header>

      <main ref={mainRef} aria-label="Referral dashboard" tabIndex={-1} className="mx-auto max-w-[1008px] px-6 pb-[calc(128px+env(safe-area-inset-bottom,0px))] pt-3 outline-none">
        <section role="tabpanel" aria-label={TABS.find((item) => item.key === tab)?.label}>{children}</section>
        <footer className="mt-9 text-center text-xs leading-[1.6]" style={{ color: COLORS.text3 }}>
          <p><span className="referral-reference-mark mr-1.5 size-4 align-[-3px]" aria-hidden />Your agents. Yours to own.</p>
          <button onClick={onReplayIntroduction} className="min-h-11 px-3 text-xs underline underline-offset-4">View welcome screen</button>
        </footer>
      </main>

      {link ? (
        <div
          role="group"
          aria-label="Your invite link"
          className="fixed left-1/2 z-[60] flex h-[54px] w-[min(640px,calc(100%-32px))] -translate-x-1/2 items-center gap-2.5 rounded-full border pl-[18px] pr-[9px] shadow-lg backdrop-blur-xl"
          style={{
            bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
            background: "rgba(255, 255, 255, .96)",
            borderColor: "rgba(0,0,0,.08)",
          }}
        >
          <Link2 className="size-[18px] shrink-0" style={{ color: COLORS.text3 }} aria-hidden="true" />
          <small className="hidden shrink-0 text-sm sm:inline" style={{ color: COLORS.text3 }}>
            Invite with
          </small>
          <code className="min-w-0 flex-1 truncate text-sm font-medium">{link}</code>
          <Button size="sm" onClick={onCopy}>
            Copy
          </Button>
        </div>
      ) : null}
    </div>
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
  onSeeStandings,
  link,
  onCopy,
  onShare,
}: {
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
  onSeeStandings: () => void;
  link: string;
  onCopy: () => void;
  onShare: () => void;
}) {
  return (
    <>
      <div className="relative px-0 pb-[26px] pt-1 text-center">
        <div
          aria-hidden="true"
          className="mx-auto -mb-[58px] -mt-11 grid h-[200px] w-[240px] place-items-center"
          style={{
            background:
              "radial-gradient(circle 100px at center, rgba(0,122,255,.15), rgba(0,122,255,.05) 56%, transparent 100%)",
          }}
        >
          <OneMark emojiSize={50} dotSize={0} />
        </div>
        <h1
          className="relative font-bold leading-[1.12] tracking-[-0.022em]"
          style={{ fontSize: "clamp(28px, 4.4vw, 40px)" }}
        >
          Good things grow together
          <i className="not-italic" style={{ color: COLORS.blue }}>
            .
          </i>
        </h1>
        <p className="relative mt-2 text-[15px]" style={{ color: COLORS.text2 }}>
          Invite friends, build your streak, and unlock your next reward.
        </p>
      </div>

      <ChallengeClock
        challengeRes={challengeRes}
        onRetryChallenge={onRetryChallenge}
        countdown={countdown}
        onSeeStandings={onSeeStandings}
        onCopy={onCopy}
      />

      <StatsGrid
        pointsRes={pointsRes}
        onRetryPoints={onRetryPoints}
        leaderboardRes={leaderboardRes}
        onRetryLeaderboard={onRetryLeaderboard}
        summary={summary}
        engagementRes={engagementRes}
        onRetryEngagement={onRetryEngagement}
      />

      <Card className="my-4 p-[22px]">
        <h3 className="text-[20px] font-semibold leading-[25px] tracking-[-0.012em]">
          Connected to your One profile
        </h3>
        <p className="mt-1 text-sm" style={{ color: COLORS.text2 }}>
          In the app, your invitation link and earned points belong to the One account you are
          signed in to. Your public leaderboard name is a separate display name.
        </p>
        <p className="mt-2 text-sm" style={{ color: COLORS.text2 }}>
          Your points shows your recorded total, including bonuses and adjustments. Published
          rank updates when the standings are published. You can track your points even before
          you have a rank.
        </p>
      </Card>

      <div className="referral-duo grid gap-4 sm:grid-cols-2">
        <Card className="p-[22px]">
          <h3 className="text-[20px] font-semibold leading-[25px] tracking-[-0.012em]">Invite</h3>
          <p className="mt-1 text-sm" style={{ color: COLORS.text2 }}>
            Earn points when an eligible referral qualifies.
          </p>
          <div className="mt-[18px] grid grid-cols-2 gap-2.5">
            <a
              className="flex h-11 items-center justify-center rounded-[14px] px-5 text-[15px] font-semibold"
              style={{ background: "rgba(0,122,255,.1)", color: "#006dcc" }}
              href={`https://wa.me/?text=${encodeURIComponent(
                `Join me on Hushh One for the weekly referral challenge: ${link}`,
              )}`}
              target="_blank"
              rel="noopener"
            >
              WhatsApp
            </a>
            <a
              className="flex h-11 items-center justify-center rounded-[14px] px-5 text-[15px] font-semibold"
              style={{ background: "rgba(0,122,255,.1)", color: "#006dcc" }}
              href={`sms:?&body=${encodeURIComponent(`Join me on Hushh One: ${link}`)}`}
            >
              SMS
            </a>
          </div>
          <button
            onClick={onShare}
            className="mt-2.5 w-full text-center text-xs font-medium underline underline-offset-2" style={{ color: COLORS.text2 }}
          >
            More share options
          </button>
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
                    <strong className="block truncate text-[15px] font-medium">New member</strong>
                    <time className="block text-[13px]" style={{ color: COLORS.text2 }}>
                      {row.started_on}
                    </time>
                  </div>
                  <span className="whitespace-nowrap text-xs font-medium" style={{ color: COLORS.text2 }}>
                    {row.status}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-[14px] text-sm" style={{ color: COLORS.text2 }}>
              No referrals yet. Share your link to start.
            </p>
          )}
        </Card>

        <Card className="p-[22px]">
          <p
            className="flex items-center gap-[9px] text-[13px] font-semibold"
            style={{ color: "#137a35" }}
          >
            <span
              className="relative inline-flex size-[7px] rounded-full"
              style={{ background: "#34c759" }}
              aria-hidden="true"
            />
            Your circle
          </p>
          <Section res={circleRes} onRetry={onRetryCircle} retryLabel="your circle">
            {(circle) => (
              <CircleCardBody
                circle={circle}
                circleLeaderboardRes={circleLeaderboardRes}
                onRetryCircleLeaderboard={onRetryCircleLeaderboard}
              />
            )}
          </Section>
          <div
            className="mt-4 rounded-[12px] p-3"
            style={{ background: COLORS.fill2 }}
          >
            <p className="text-xs font-semibold" style={{ color: COLORS.text2 }}>Circle Wars · Preview</p>
            <p className="mt-1 text-xs" style={{ color: COLORS.text2 }}>
              Team battles, matchups and prizes are not active. The current referral rules
              do not award automatic points for a circle battle win.
            </p>
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
  onSeeStandings,
  onCopy,
}: {
  challengeRes: Res<WeeklyChallenge>;
  onRetryChallenge: () => void;
  countdown: string | null;
  onSeeStandings: () => void;
  onCopy: () => void;
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
        background: "linear-gradient(180deg, #1c1c1e, #242426)",
        boxShadow: "inset 0 0 0 1px rgba(212,165,116,.24)",
      }}
    >
      <p className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-[13px] font-medium" style={{ color: "#aeaeb2" }}>
        <span className="inline-flex items-center gap-[9px]">
          <span
            className="inline-flex size-[7px] rounded-full"
            style={{ background: "#34c759" }}
            aria-hidden="true"
          />
          {headline.label}
        </span>
        <span>Your points, connected to your One profile</span>
      </p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div
          className="font-bold leading-none tabular-nums"
          style={{ fontSize: "clamp(46px, 13.5vw, 84px)", letterSpacing: "-0.04em" }}
        >
          {headline.value}
        </div>
        <div className="flex gap-2.5 pb-2">
          <button
            onClick={onSeeStandings}
            className="flex h-11 items-center justify-center rounded-[14px] px-5 text-[15px] font-semibold"
            style={{ background: "rgba(255,255,255,.12)" }}
          >
            See standings
          </button>
          <button
            onClick={onCopy}
            className="flex h-11 items-center justify-center rounded-[14px] px-5 text-[15px] font-semibold"
            style={{ background: COLORS.blue }}
          >
            Copy invite link
          </button>
        </div>
      </div>
      {challengeRes.status === "error" ? (
        <button onClick={onRetryChallenge} className="mt-3 text-xs font-medium underline" style={{ color: "#aeaeb2" }}>
          Try again
        </button>
      ) : null}
      <div
        className="mt-7 grid gap-1"
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
      <ol className="mt-3.5 grid gap-1" style={{ gridTemplateColumns: `repeat(${weekProgress.totalDays}, minmax(0, 1fr))` }}>
        {Array.from({ length: weekProgress.totalDays }, (_, i) => {
          const isNow =
            weekProgress.live &&
            i === Math.min(weekProgress.totalDays - 1, Math.floor(weekProgress.elapsedDays));
          return (
            <li key={i} className="min-w-0 text-center text-[11px] leading-[1.4]" style={{ color: isNow ? "#aeaeb2" : "#8e8e93" }}>
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
    trailing?: React.ReactNode;
  }[] = [
    {
      label: "Your points",
      value: statText(pointsRes, (p) => fmt(p)),
      sub: statSub(pointsRes, () => "Recorded total"),
      onRetry: pointsRes.status === "error" ? onRetryPoints : undefined,
    },
    {
      label: "Published rank",
      value: statText(leaderboardRes, (lb) => {
        const v = lb.viewer ?? lb.entries.find((e) => e.is_viewer) ?? null;
        return v ? `#${v.rank}` : "—";
      }),
      sub: statSub(leaderboardRes, (lb) => {
        // A nonzero ledger balance (its own, separately-loaded stat) can
        // exist with no published rank at all: not yet ranked, or no
        // snapshot has published since this account joined. That is an
        // honest "unranked" state, not an error and not a zero.
        const v = lb.viewer ?? lb.entries.find((e) => e.is_viewer) ?? null;
        if (!v) return "Not yet ranked";
        return lb.stale ? "Updating" : "Latest standings";
      }),
      onRetry: leaderboardRes.status === "error" ? onRetryLeaderboard : undefined,
    },
    {
      label: "Referrals",
      value: fmt(summary.qualified_count),
      sub: `${summary.in_progress_count} in progress`,
    },
    {
      label: "Day streak",
      value: statText(engagementRes, (e) => String(e.streak.current_run_days)),
      sub: statSub(engagementRes, (e) => `${e.streak.run_length_days}-day bonus target`),
      onRetry: engagementRes.status === "error" ? onRetryEngagement : undefined,
      trailing: <StreakFlame engagementRes={engagementRes} />,
    },
  ];

  return (
    <dl className="my-4 grid grid-cols-2 rounded-[18px] sm:grid-cols-4" style={{ background: COLORS.card }}>
      {cells.map((cell, index) => (
        <div
          key={cell.label}
          className={
            "px-[18px] py-4 sm:px-[22px] sm:py-[18px] " +
            (index === 0 ? "border-l-0" : index % 2 === 0 ? "border-l-0 sm:border-l" : "sm:border-l") +
            (index >= 2 ? " border-t sm:border-t-0" : "")
          }
          style={{ borderColor: COLORS.sep }}
        >
          <dt className="text-[13px] font-medium" style={{ color: COLORS.text2 }}>{cell.label}</dt>
          <dd className="mt-1 flex items-center gap-2">
            <span className="text-[28px] font-bold leading-[36px] tracking-[-0.025em] tabular-nums sm:text-[32px]">
              {cell.value}
            </span>
            {cell.trailing}
          </dd>
          <dd className="mt-0.5 text-[13px]" style={{ color: COLORS.text2 }}>{cell.sub}</dd>
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
      style={{ width: 26, height: 26, background: active ? COLORS.orangeSoft : COLORS.fill2 }}
    >
      <FlameIcon className="size-[16px]" active={active} />
    </span>
  );
}

function FlameIcon({ className, active }: { className?: string; active: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      fill={COLORS.orange} data-active={active}
    >
      <path d="M12 2c.6 3.2-1 5-2.6 6.7C7.8 10.5 6.5 12.1 6.5 14.5A5.5 5.5 0 0 0 12 20a5.5 5.5 0 0 0 5.5-5.5c0-1.7-.7-2.9-1.5-4 .1 1.4-.4 2.3-1.2 2.9-.3-2.2-1.1-3.6-2-4.8C12.2 7.1 12.6 4.6 12 2z" />
    </svg>
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
        You have not chosen a referral-contest team yet.
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
                <dd className="mt-0.5 text-[15px] font-semibold tabular-nums">
                  {index >= 0 ? `#${index + 1}` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs" style={{ color: COLORS.text2 }}>Team referrals</dt>
                <dd className="mt-0.5 text-[15px] font-semibold tabular-nums">
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
    <div className="referral-standings grid gap-6 sm:grid-cols-[280px_minmax(0,1fr)] sm:items-start">
      <aside className="sm:sticky sm:top-20">
        <h2 className="my-4 text-[28px] font-bold leading-[34px] tracking-[-0.022em] sm:mt-0">
          Standings
          <i className="not-italic" style={{ color: COLORS.blue }}>
            .
          </i>
        </h2>
        <div
          role="group"
          aria-label="Standings type"
          className="inline-flex gap-0.5 rounded-xl p-0.5"
          style={{ background: COLORS.fill }}
        >
          {(["individual", "circles"] as const).map((key) => (
            <button
              key={key}
              aria-pressed={board === key}
              onClick={() => onBoardChange(key)}
              className="rounded-[10px] px-[15px] text-[13px] font-semibold capitalize"
              style={{
                height: 32,
                background: board === key ? COLORS.card : "transparent",
                color: board === key ? COLORS.blueText : COLORS.text2,
                boxShadow: board === key ? "0 1px 2px rgba(0,0,0,.1)" : undefined,
              }}
            >
              {key}
            </button>
          ))}
        </div>
        {gapText ? (
          <p
            className="mt-5 text-lg font-semibold leading-[1.3] sm:text-xl"
            style={{ color: COLORS.text2 }}
          >
            {gapText}
          </p>
        ) : null}
      </aside>

      <Card className="p-2">
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
  return `You're #${v.rank}. ${fmt(gap)} points to pass ${ahead.handle}.`;
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
      <span className="min-w-0 truncate text-[15px] font-semibold">
        {who}
        {me ? (
          <small className="ml-2 text-[13px] font-normal" style={{ color: COLORS.blue }}>
            You
          </small>
        ) : null}
      </span>
      <span className="text-[15px] font-semibold tabular-nums">{fmt(points)}</span>
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
  return <p className="mt-6 text-center text-sm" style={{ color: COLORS.text2 }}>{note}</p>;
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
      <h2 className="my-4 text-[28px] font-bold leading-[34px] tracking-[-0.022em]">
        Rewards
        <i className="not-italic" style={{ color: COLORS.blue }}>
          .
        </i>
      </h2>
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
                <h3 className="text-xl font-semibold">Rewards policy unavailable</h3>
                <p className="mt-2 text-sm" style={{ color: COLORS.text2 }}>
                  The new reward catalogue has not been activated. Your qualified referrals and previously earned rewards are preserved.
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
            <div className="grid gap-[18px]">
              {next ? (
                <Card
                  rewardKey={next.milestone_key}
                  className="referral-reward-feature"
                  style={{ position: "relative", overflow: "hidden" }}
                >
                  <div>
                    <p className="referral-reward-eyebrow">Your next reward</p>
                    <h3 className="referral-reward-title">
                      {nextLabel[0]}
                    </h3>
                    {nextLabel[1] ? <p className="mt-[5px] text-sm" style={{ color: COLORS.text2 }}>Worth {nextLabel[1]}</p> : null}
                    <p className="referral-reward-remaining"><strong>{fmt(next.threshold - count)} more.</strong><span>Qualified referrals to make it yours.</span></p>
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
                  <div className="flex items-center gap-6"><div className="h-40 w-28 shrink-0"><RewardArtwork milestoneKey="iphone_10000" title="iPhone" /></div><div><h3 className="text-[28px] font-semibold">All rewards unlocked</h3><p className="mt-2 text-sm" style={{ color: COLORS.text2 }}>{fmt(count)} qualified referrals. You have reached all four milestones.</p></div></div>
                </Card>
              )}

              <div className="-mb-1.5 flex items-baseline justify-between gap-3">
                <h3 className="text-lg font-semibold">Milestones</h3>
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
                        style={{
                          border: `1px solid ${isNext ? "rgba(0,122,255,.24)" : "transparent"}`,
                        }}
                      >
                        <div className="mb-[18px] flex items-center justify-between gap-2">
                          <span
                            className="referral-product-tile-art grid shrink-0 place-items-center"
                            style={{
                              background: earned
                                ? "rgba(52,199,89,.16)"
                                : isNext
                                  ? "rgba(0,122,255,.1)"
                                  : COLORS.fill2,
                              color: earned ? "#137a35" : isNext ? COLORS.blue : COLORS.text2,
                            }}
                          >
                            <RewardArtwork milestoneKey={entry.milestone_key} title={label[0] ?? entry.reward} />
                          </span>
                          <span
                            className="text-[10px] font-semibold sm:text-[11px]"
                            style={{ color: earned ? "#137a35" : isNext ? "#006dcc" : COLORS.text2 }}
                          >
                            {earned ? "Unlocked" : isNext ? "Up next" : "Milestone"}
                          </span>
                        </div>
                        <h4 className="text-[15px] font-semibold leading-[1.4] tracking-[-0.01em]">
                          {label[0]}
                        </h4>
                        {label[1] ? <p className="mt-[3px] text-xs" style={{ color: COLORS.text2 }}>Worth {label[1]}</p> : null}
                        <p
                          className="mt-auto pt-5 text-xs tabular-nums"
                          style={{ color: earned ? "#137a35" : COLORS.text2, fontWeight: earned ? 600 : 400 }}
                        >
                          {earned ? `Unlocked at ${entry.threshold}` : `${fmt(entry.threshold)} referrals`}
                        </p>
                      </Card>
                    </li>
                  );
                })}
              </ol>
              <p className="text-xs" style={{ color: COLORS.text2 }}>Unlocked shows qualified-referral progress. Reward fulfillment follows your recorded entitlements.</p>
            </div>
          );
        }}
      </Section>
    </>
  );
}

function RulesTab({ policyRes, onRetry }: { policyRes: Res<ReferralPolicy>; onRetry: () => void }) {
  return (
    <>
      <h2 className="my-4 text-[28px] font-bold leading-[34px] tracking-[-0.022em]">
        How referrals work
        <i className="not-italic" style={{ color: COLORS.blue }}>
          .
        </i>
      </h2>
      <ol className="referral-rules-steps">
        {["Invite", "Verify", "Finish setup", "Earn points", "Unlock rewards"].map((step, i) => (
          <li key={step} className="flex items-center gap-1.5">
            <span className="referral-rule-step-number">{i + 1}</span>{step}
          </li>
        ))}
      </ol>
      <div className="referral-duo grid gap-4 sm:grid-cols-2">
        <div>
          <Section res={policyRes} onRetry={onRetry} retryLabel="referral rules">{(policy) => <Card className="referral-rules-points p-[22px]">
            <div className="referral-rules-card-title"><Zap className="size-5" aria-hidden="true" /><h3>Make every invite count</h3></div>
            <ul className="-mt-2.5 -mb-3">
              {[
                ["Qualified referral", `${fmt(policy.points.qualified_referral_points)} points`],
                ["Referral streak bonus", `+${fmt(policy.streak_rules.bonus_points)} points`],
                ["Flash referral, when active", `${fmt(policy.points.flash_window_total_points)} total`],
                ["Clicks or incomplete sign-ups", "0 points"],
                ["Challenge duration", policy.challenge_duration_days ? `${policy.challenge_duration_days} days` : "Not yet scheduled"],
                ["Milestone progress", "Qualified referrals"],
                ["Circle contribution", "1 per referral"],
              ].map(([label, value], i) => (
                <li
                  key={label}
                  className="flex min-h-[50px] items-center justify-between gap-4 text-[15px]"
                  style={{ borderTop: i === 0 ? undefined : `1px solid ${COLORS.sep}` }}
                >
                  <span className="referral-rule-label">{i < 3 ? (i === 1 ? <FlameIcon active /> : <Zap aria-hidden="true" />) : <ShieldCheck aria-hidden="true" />}{label}</span>
                  <b className="referral-rule-value text-right font-semibold tabular-nums">{value}</b>
                </li>
              ))}
            </ul>
          </Card>}</Section>
          <p className="mx-[22px] mt-2.5 text-xs" style={{ color: COLORS.text2 }}>
            Your active program sets point amounts. Recorded points
            appear after a referral qualifies and is processed.
          </p>
        </div>
        <Card className="referral-rules-details p-1" aria-label="Referral rules">
          <div className="referral-rules-card-title"><Trophy className="size-5" aria-hidden="true" /><h3>The path to your rewards</h3></div>
          <RuleSection title="What makes a referral count?" defaultOpen>
            <ol className="list-decimal space-y-1.5 pl-4">
              <li>Share your personal invitation link with a friend who is new to One.</li>
              <li>
                Your friend opens your link, creates their account, verifies their phone and
                finishes the required One setup.
              </li>
              <li>
                Each eligible account can credit one referrer. The first eligible referral linked
                to that account is kept; another link cannot replace it later.
              </li>
              <li>
                Self-referrals and duplicate referrals do not count. Link clicks and unfinished
                sign-ups earn no points.
              </li>
            </ol>
          </RuleSection>
          <RuleSection title="Your points and One profile">
            <ul className="list-disc space-y-1.5 pl-4">
              <li>
                Your link, recorded points and milestone progress belong to the One account you
                are signed in to. Your public display name does not create a separate points
                balance.
              </li>
              <li>
                The active program determines the award per qualified referral. During an
                active flash window, its total award replaces the standard award.
              </li>
              <li>
                Streak bonuses follow the active program's run length and point rules.
                Each streak day requires a qualified referral. Multiple referrals on one day
                still count as one streak day.{" "}
                <b className="font-semibold" style={{ color: COLORS.text }}>
                  This is a separate referral bonus. The weekly challenge still lasts seven days.
                </b>{" "}
                A streak can continue across weekly rounds.
              </li>
              <li>
                Your recorded total includes awarded bonuses and corrections. Points may appear
                before your published rank updates; pending referrals are not yet earned points.
              </li>
            </ul>
          </RuleSection>
          <RuleSection title="Weekly challenge and rewards">
            <ul className="list-disc space-y-1.5 pl-4">
              <li>
                The You tab shows the deadline from the active program schedule. An unset
                schedule is shown as not yet scheduled.
              </li>
              <li>
                Your recorded points and milestone progress carry forward. They do not restart at
                the beginning of each week.
              </li>
              <li>
                Published individual standings use cumulative point totals. Weekly prize
                eligibility, closing times and tie rules follow the announced program terms.
              </li>
              <li>
                The Rewards tab shows the active program's milestone thresholds and recorded
                entitlements. Bonus points do not increase your referral count.
              </li>
              <li>
                Unlocked means the milestone has been reached. Reward availability, claiming and
                delivery follow the published reward terms.
              </li>
            </ul>
          </RuleSection>
          <RuleSection title="Circles and Circle Wars">
            <ul className="list-disc space-y-1.5 pl-4">
              <li>Choose one referral circle from the circles you already belong to.</li>
              <li>
                Each qualified referral adds{" "}
                <b className="font-semibold" style={{ color: COLORS.text }}>one contribution</b> to the circle
                selected when your friend qualifies. Personal bonus points do not multiply this
                contribution.
              </li>
              <li>
                Changing circles affects future contributions. Earlier contributions stay with the
                circle that received them.
              </li>
              <li>
                Circle standings show recorded referral contributions. A circle's position
                does not by itself award a prize.
              </li>
            </ul>
          </RuleSection>
        </Card>
      </div>
    </>
  );
}

function RuleSection({
  title,
  defaultOpen,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      className="group px-[22px] py-3 last:border-0"
      style={{ borderBottom: `1px solid ${COLORS.sep}` }}
      open={defaultOpen}
    >
      <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-4 text-[16px] font-medium">
        {title}
        <ChevronGlyph />
      </summary>
      <div className="pb-4 text-sm leading-[1.5]" style={{ color: COLORS.text2 }}>{children}</div>
    </details>
  );
}

function ChevronGlyph() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2 shrink-0 rotate-[-45deg] border-r-2 border-b-2 transition-transform group-open:rotate-45"
      style={{ borderColor: COLORS.chevron }}
    />
  );
}
