"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { Share2, Users, Trophy, Gift, ListChecks, ChevronRight } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SurfaceStack } from "@/components/app-ui/surfaces";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/lib/firebase/auth-context";
import { useReferralStream } from "@/lib/referral/use-referral-stream";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { ROUTES } from "@/lib/navigation/routes";
import {
  ReferralService,
  type CircleLeaderboardEntry,
  type CircleSelection,
  type EngagementStatus,
  type LeaderboardPage,
  type MilestoneProgress,
  type ReferralSummary,
  type WeeklyChallenge,
} from "@/lib/services/referral-service";

type TabKey = "you" | "standings" | "rewards" | "rules";

const TABS: { key: TabKey; label: string }[] = [
  { key: "you", label: "You" },
  { key: "standings", label: "Standings" },
  { key: "rewards", label: "Rewards" },
  { key: "rules", label: "Rules" },
];

function fmt(value: number): string {
  return value.toLocaleString("en-IN");
}

function twoDigit(value: number): string {
  return String(Math.max(0, value)).padStart(2, "0");
}

/** `HH:MM:SS` remaining until `cutoffIso`, or null once it has passed. */
function useCountdown(cutoffIso: string | null): string | null {
  const [label, setLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!cutoffIso) {
      setLabel(null);
      return;
    }
    const cutoff = new Date(cutoffIso).getTime();
    const tick = () => {
      const remainingMs = cutoff - Date.now();
      if (remainingMs <= 0) {
        setLabel("00:00:00");
        return;
      }
      const totalSeconds = Math.floor(remainingMs / 1000);
      const hours = Math.floor(totalSeconds / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      setLabel(`${twoDigit(hours)}:${twoDigit(minutes)}:${twoDigit(seconds)}`);
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
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

/**
 * Fetch one resource, independently retryable, isolated per signed-in
 * account.
 *
 * `seqRef` is bumped on every call to `load` (an explicit retry, or the
 * effect re-running because `user` changed). A response from a superseded
 * call -- the previous account's, or an earlier retry's -- is dropped by the
 * sequence check rather than applied, which is what keeps an account switch
 * from ever showing a stale balance under the new account's name while the
 * fresh read is still in flight.
 */
function useReferralResource<T>(
  user: User | null | undefined,
  fetcher: (idToken: string) => Promise<T>,
): [Res<T>, () => void] {
  const [res, setRes] = useState<Res<T>>({ status: "loading" });
  const seqRef = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const userRef = useRef(user);
  userRef.current = user;

  const load = useCallback(() => {
    const seq = ++seqRef.current;
    setRes({ status: "loading" });
    void (async () => {
      try {
        const current = userRef.current;
        if (!current) throw new Error("not signed in");
        const idToken = await current.getIdToken();
        const data = await fetcherRef.current(idToken);
        if (seq !== seqRef.current) return;
        setRes({ status: "ready", data });
      } catch {
        if (seq !== seqRef.current) return;
        setRes({ status: "error" });
      }
    })();
  }, []);

  useEffect(() => {
    load();
    // Re-running on `user?.uid` (not just `user`) is deliberate: it is the
    // one value that actually identifies "a different signed-in account",
    // so an account switch always restarts every resource from `loading`
    // rather than risk reusing a Firebase User object another account's
    // code path still holds a reference to.
  }, [load, user?.uid]);

  return [res, load];
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
      <div className="flex min-h-[20vh] items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }
  if (res.status === "error") {
    return (
      <div className="flex min-h-[20vh] flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">Unable to load {retryLabel}.</p>
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
  const [tab, setTab] = useState<TabKey>("you");
  const [board, setBoard] = useState<"individual" | "circles">("individual");

  // `summary` is the only hard gate on the page shell: the invite link and
  // referral counts it carries are the minimum the page can mean anything
  // without. Every other read is its own resource below, decoupled so a
  // failure in one (the leaderboard, say) can never hide or zero out a
  // DIFFERENT one that loaded fine (points, say).
  const [summaryRes, reloadSummary] = useReferralResource(user, (idToken) =>
    ReferralService.getSummary({ idToken }),
  );
  const [pointsRes, reloadPoints] = useReferralResource(user, (idToken) =>
    ReferralService.getPoints({ idToken }).then((r) => r.points),
  );
  const [leaderboardRes, reloadLeaderboard] = useReferralResource(user, (idToken) =>
    ReferralService.getLeaderboard({ idToken, limit: 10 }),
  );
  const [circleLeaderboardRes, reloadCircleLeaderboard] = useReferralResource(user, (idToken) =>
    ReferralService.getCircleLeaderboard({ idToken }).then((r) => r.teams),
  );
  const [milestonesRes, reloadMilestones] = useReferralResource(user, (idToken) =>
    ReferralService.getMilestones({ idToken }),
  );
  const [engagementRes, reloadEngagement] = useReferralResource(user, (idToken) =>
    ReferralService.getEngagement({ idToken }),
  );
  const [challengeRes, reloadChallenge] = useReferralResource(user, (idToken) =>
    ReferralService.getChallenge({ idToken }),
  );
  const [circleRes, reloadCircle] = useReferralResource(user, (idToken) =>
    ReferralService.getCircleSelection({ idToken }),
  );

  const reloadAll = useCallback(() => {
    reloadSummary();
    reloadPoints();
    reloadLeaderboard();
    reloadCircleLeaderboard();
    reloadMilestones();
    reloadEngagement();
    reloadChallenge();
    reloadCircle();
  }, [
    reloadSummary,
    reloadPoints,
    reloadLeaderboard,
    reloadCircleLeaderboard,
    reloadMilestones,
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

  if (summaryRes.status === "loading") {
    return (
      <DashboardShell dataState="loading">
        <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
          Loading your referrals…
        </div>
      </DashboardShell>
    );
  }

  if (summaryRes.status === "error") {
    return (
      <DashboardShell dataState="unavailable-valid">
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm text-muted-foreground">Unable to load. Check your connection.</p>
          <Button onClick={reloadSummary}>Try again</Button>
        </div>
      </DashboardShell>
    );
  }

  const summary = summaryRes.data;

  return (
    <DashboardShell
      dataState="loaded"
      tabBar={
        <TabBar
          tab={tab}
          onChange={setTab}
        />
      }
    >
      {tab === "you" ? (
        <YouTab
          summary={summary}
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
      {tab === "rules" ? <RulesTab /> : null}
    </DashboardShell>
  );
}

function DashboardShell({
  children,
  tabBar,
  dataState,
}: {
  children: React.ReactNode;
  tabBar?: React.ReactNode;
  dataState: "loading" | "loaded" | "empty-valid" | "unavailable-valid";
}) {
  return (
    <AppPageShell
      as="main"
      width="standard"
      className="relative isolate pb-[calc(var(--app-bottom-fixed-ui,96px)+1.5rem)]"
      nativeTest={{
        routeId: ROUTES.ONE_REFERRALS,
        marker: "native-route-one-referrals",
        authState: "authenticated",
        dataState,
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          title="Referrals"
          description="One week. One winner. Invite friends, keep your streak, win with your circle."
        />
        {tabBar}
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <SurfaceStack>{children}</SurfaceStack>
      </AppPageContentRegion>
    </AppPageShell>
  );
}

function TabBar({
  tab,
  onChange,
}: {
  tab: TabKey;
  onChange: (tab: TabKey) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Referral sections"
      className="mt-3 flex gap-1 rounded-[14px] bg-[var(--app-grouped-background)] p-1"
    >
      {TABS.map((item) => (
        <button
          key={item.key}
          role="tab"
          aria-selected={tab === item.key}
          onClick={() => onChange(item.key)}
          className={
            "flex-1 rounded-[11px] px-3 py-1.5 text-sm font-medium transition-colors " +
            (tab === item.key
              ? "bg-[var(--card)] text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground")
          }
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function Card({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={
        "rounded-[var(--app-card-radius-standard,18px)] border border-border bg-card p-4 sm:p-5 " +
        (className ?? "")
      }
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
  const weekProgress = useMemo(() => {
    if (challengeRes.status !== "ready" || !challengeRes.data.active) return null;
    const { week_started_at, cutoff_at } = challengeRes.data;
    if (!week_started_at || !cutoff_at) return null;
    const start = new Date(week_started_at).getTime();
    const end = new Date(cutoff_at).getTime();
    const now = Date.now();
    const totalDays = Math.max(1, Math.round((end - start) / 86_400_000));
    const elapsedDays = Math.min(totalDays, Math.max(0, (now - start) / 86_400_000));
    return { totalDays, elapsedDays };
  }, [challengeRes]);

  const challengeHeadline =
    challengeRes.status === "loading"
      ? { label: "Weekly challenge", value: "…" }
      : challengeRes.status === "error"
        ? { label: "Weekly challenge", value: "Unable to load" }
        : challengeRes.data.active
          ? { label: "Weekly challenge ends in", value: countdown ?? "—" }
          : { label: "Weekly challenge", value: "Not yet scheduled" };

  return (
    <>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <span className="relative inline-flex size-1.5 rounded-full bg-[var(--app-accent)]" />
              {challengeHeadline.label}
            </p>
            <p className="font-mono text-3xl font-semibold tabular-nums text-foreground">
              {challengeHeadline.value}
            </p>
            {challengeRes.status === "error" ? (
              <Button
                variant="muted"
                className="mt-2"
                onClick={onRetryChallenge}
              >
                Try again
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button variant="muted" onClick={onSeeStandings}>
              See standings
            </Button>
          </div>
        </div>
        {weekProgress ? (
          <div
            className="mt-4 grid gap-1"
            style={{ gridTemplateColumns: `repeat(${weekProgress.totalDays}, minmax(0, 1fr))` }}
            role="img"
            aria-label={`Weekly challenge progress: day ${Math.ceil(weekProgress.elapsedDays)} of ${weekProgress.totalDays}`}
          >
            {Array.from({ length: weekProgress.totalDays }, (_, i) => {
              const fill = Math.max(0, Math.min(1, weekProgress.elapsedDays - i)) * 100;
              return (
                <div key={i} className="h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
                  <div
                    className="h-full rounded-full bg-[var(--app-accent)] transition-[width]"
                    style={{ width: `${fill}%` }}
                  />
                </div>
              );
            })}
          </div>
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground">
          Your points, connected to your One profile
        </p>
      </Card>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="Your points"
          value={statText(pointsRes, (p) => fmt(p))}
          sub={statSub(pointsRes, () => "Recorded total")}
          onRetry={pointsRes.status === "error" ? onRetryPoints : undefined}
        />
        <StatTile
          label="Published rank"
          value={statText(leaderboardRes, (lb) => {
            const v = lb.viewer ?? lb.entries.find((e) => e.is_viewer) ?? null;
            return v ? `#${v.rank}` : "—";
          })}
          sub={statSub(leaderboardRes, (lb) => (lb.stale ? "Updating" : "Latest standings"))}
          onRetry={leaderboardRes.status === "error" ? onRetryLeaderboard : undefined}
        />
        <StatTile
          label="Referrals"
          value={fmt(summary.qualified_count)}
          sub={`${summary.in_progress_count} in progress`}
        />
        <StatTile
          label="Day streak"
          value={statText(engagementRes, (e) => String(e.streak.current_run_days))}
          sub={statSub(engagementRes, (e) => `best run is ${e.streak.run_length_days} days`)}
          onRetry={engagementRes.status === "error" ? onRetryEngagement : undefined}
        />
      </dl>

      <Card>
        <h3 className="text-sm font-semibold">Connected to your One profile</h3>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Your invitation link and earned points belong to the One account you are signed in to.
          Your public leaderboard name is a separate display name.
        </p>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <h3 className="text-sm font-semibold">Invite</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            100 points when a friend finishes onboarding.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="muted"
              onClick={() =>
                window.open(
                  `https://wa.me/?text=${encodeURIComponent(
                    `Join me on Hushh One for the weekly referral challenge: ${link}`,
                  )}`,
                  "_blank",
                  "noopener",
                )
              }
            >
              WhatsApp
            </Button>
            <Button
              variant="muted"
              onClick={() =>
                window.open(`sms:?&body=${encodeURIComponent(`Join me on Hushh One: ${link}`)}`)
              }
            >
              SMS
            </Button>
            <Button variant="muted" onClick={onShare}>
              <Share2 className="size-4" aria-hidden="true" />
              Share
            </Button>
            <Button onClick={onCopy}>Copy link</Button>
          </div>
          {summary.referrals.length > 0 ? (
            <ul className="mt-4 space-y-2 border-t border-border pt-3">
              {summary.referrals.slice(0, 3).map((row, index) => (
                <li
                  key={`${row.started_on}:${index}`}
                  className="flex items-center justify-between text-sm"
                >
                  <div className="flex items-center gap-2">
                    <Users className="size-4 text-muted-foreground" aria-hidden="true" />
                    <div>
                      <p className="font-medium">New member</p>
                      <p className="text-xs text-muted-foreground">{row.started_on}</p>
                    </div>
                  </div>
                  <span className="text-xs font-medium text-muted-foreground">{row.status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">No referrals yet. Share your link to start.</p>
          )}
        </Card>

        <Card>
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
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
          <div className="mt-4 rounded-[12px] bg-[var(--app-grouped-background)] p-3">
            <p className="text-xs font-semibold text-muted-foreground">Circle Wars · Preview</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Team battles, matchups and prizes are a concept preview. The current referral rules
              do not award automatic points for a circle battle win.
            </p>
          </div>
        </Card>
      </div>
    </>
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
      <p className="mt-2 text-sm text-muted-foreground">
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
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Team rank</dt>
                <dd className="font-medium">{index >= 0 ? `#${index + 1}` : "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Team referrals</dt>
                <dd className="font-medium">{myCircle ? fmt(myCircle.contribution_count) : "—"}</dd>
              </div>
            </dl>
          </>
        );
      }}
    </Section>
  );
}

function StatTile({
  label,
  value,
  sub,
  onRetry,
}: {
  label: string;
  value: string;
  sub: string;
  onRetry?: () => void;
}) {
  return (
    <Card className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
      <dd className="text-xs text-muted-foreground">{sub}</dd>
      {onRetry ? (
        <button
          onClick={onRetry}
          className="mt-1 self-start text-xs font-medium text-[var(--app-accent)]"
        >
          Try again
        </button>
      ) : null}
    </Card>
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
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Standings</h2>
        <div className="flex gap-1 rounded-[12px] bg-[var(--app-grouped-background)] p-1">
          {(["individual", "circles"] as const).map((key) => (
            <button
              key={key}
              aria-pressed={board === key}
              onClick={() => onBoardChange(key)}
              className={
                "rounded-[9px] px-3 py-1 text-xs font-medium capitalize " +
                (board === key ? "bg-[var(--card)] text-foreground shadow-sm" : "text-muted-foreground")
              }
            >
              {key}
            </button>
          ))}
        </div>
      </div>

      {board === "individual" ? (
        <Section res={leaderboardRes} onRetry={onRetryLeaderboard} retryLabel="the individual standings">
          {(leaderboard) =>
            leaderboard.entries.length === 0 ? (
              <EmptyBoard note={leaderboard.stale ? "Standings have not published yet." : "No entries yet."} />
            ) : (
              <ol className="mt-4 divide-y divide-border">
                {leaderboard.entries.map((entry) => (
                  <li
                    key={entry.rank}
                    className={
                      "flex items-center gap-3 py-2.5 text-sm " +
                      (entry.is_viewer ? "font-semibold text-[var(--app-accent)]" : "")
                    }
                  >
                    <span className="w-6 text-right text-muted-foreground">{entry.rank}</span>
                    <span className="flex-1 truncate">{entry.handle}</span>
                    <span className="tabular-nums">{fmt(entry.points)}</span>
                  </li>
                ))}
                {leaderboard.viewer && !leaderboard.entries.some((e) => e.is_viewer) ? (
                  <li className="flex items-center gap-3 py-2.5 text-sm font-semibold text-[var(--app-accent)]">
                    <span className="w-6 text-right">{leaderboard.viewer.rank}</span>
                    <span className="flex-1 truncate">{leaderboard.viewer.handle}</span>
                    <span className="tabular-nums">{fmt(leaderboard.viewer.points)}</span>
                  </li>
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
              <ol className="mt-4 divide-y divide-border">
                {teams.map((team, index) => (
                  <li key={team.circle_id} className="flex items-center gap-3 py-2.5 text-sm">
                    <span className="w-6 text-right text-muted-foreground">{index + 1}</span>
                    <span className="flex-1 truncate">{team.circle_name}</span>
                    <span className="tabular-nums">{fmt(team.contribution_count)}</span>
                  </li>
                ))}
              </ol>
            )
          }
        </Section>
      )}
    </Card>
  );
}

function EmptyBoard({ note }: { note: string }) {
  return <p className="mt-6 text-center text-sm text-muted-foreground">{note}</p>;
}

const REWARD_LADDER = [
  { key: "voucher_10", threshold: 10, reward: "₹250 Amazon voucher" },
  { key: "earbuds_100", threshold: 100, reward: "Wireless earbuds, worth ₹10,000" },
  { key: "airpods_500", threshold: 500, reward: "Apple AirPods, worth ₹30,000" },
  { key: "iphone_10000", threshold: 10000, reward: "iPhone" },
];

function RewardsTab({
  milestonesRes,
  onRetry,
}: {
  milestonesRes: Res<MilestoneProgress>;
  onRetry: () => void;
}) {
  return (
    <Section res={milestonesRes} onRetry={onRetry} retryLabel="your reward progress">
      {(milestones) => {
        const earnedKeys = new Set(milestones.earned.map((m) => m.milestone_key));
        const next = milestones.next_milestone;
        return (
          <>
            {next ? (
              <Card>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Your next reward</p>
                    <h3 className="text-lg font-semibold">{next.reward}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {milestones.lifetime_qualified_count} referrals so far ·{" "}
                      {Math.max(0, next.threshold - milestones.lifetime_qualified_count)} more to go
                    </p>
                  </div>
                  <Gift className="size-10 text-[var(--app-accent)]" aria-hidden="true" />
                </div>
                <div className="mt-4">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {fmt(next.progress)} / {fmt(next.threshold)} referrals
                    </span>
                    <span>Next milestone</span>
                  </div>
                  <Progress
                    value={(next.progress / next.threshold) * 100}
                    className="mt-1.5"
                    indicatorClassName="bg-[var(--app-accent)]"
                  />
                </div>
              </Card>
            ) : (
              <Card>
                <p className="text-sm font-medium">All milestones earned. Incredible work.</p>
              </Card>
            )}

            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Milestones</h3>
              <p className="text-xs text-muted-foreground">
                {milestones.earned.length} of {REWARD_LADDER.length} unlocked
              </p>
            </div>
            <ol className="grid gap-3 sm:grid-cols-2">
              {REWARD_LADDER.map((entry) => {
                const earned = earnedKeys.has(entry.key);
                const isNext = next?.milestone_key === entry.key;
                return (
                  <li key={entry.key}>
                    <Card className={earned ? "border-[var(--app-accent)]/40" : undefined}>
                      <div className="flex items-center justify-between">
                        <Trophy
                          className={
                            "size-6 " + (earned ? "text-[var(--app-accent)]" : "text-muted-foreground")
                          }
                          aria-hidden="true"
                        />
                        <span className="text-xs font-medium text-muted-foreground">
                          {earned ? "Unlocked" : isNext ? "Up next" : "Milestone"}
                        </span>
                      </div>
                      <h4 className="mt-2 font-semibold">{entry.reward}</h4>
                      <p className="text-xs text-muted-foreground">
                        {earned ? `Unlocked at ${entry.threshold}` : `${fmt(entry.threshold)} referrals`}
                      </p>
                    </Card>
                  </li>
                );
              })}
            </ol>
          </>
        );
      }}
    </Section>
  );
}

function RulesTab() {
  return (
    <>
      <Card>
        <ol className="flex flex-wrap gap-2 text-xs font-medium text-muted-foreground">
          {["Invite", "Verify", "Finish setup", "Earn points", "Unlock rewards"].map((step, i) => (
            <li key={step} className="flex items-center gap-2">
              {i > 0 ? <ChevronRight className="size-3" aria-hidden="true" /> : null}
              {step}
            </li>
          ))}
        </ol>
      </Card>

      <Card>
        <ul className="divide-y divide-border text-sm">
          {[
            ["Qualified referral", "100 points"],
            ["Referral streak bonus", "+15 points"],
            ["Flash referral, when active", "200 total"],
            ["Clicks or incomplete sign-ups", "0 points"],
            ["Challenge duration", "7 days"],
            ["Milestone progress", "Qualified referrals"],
            ["Circle contribution", "1 per referral"],
          ].map(([label, value]) => (
            <li key={label} className="flex items-center justify-between py-2">
              <span>{label}</span>
              <span className="font-semibold">{value}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          Example point amounts are shown. Your active program sets the actual amounts. Points
          appear after a referral qualifies and is processed.
        </p>
      </Card>

      <Card>
        <RuleSection title="What makes a referral count?">
          <ol className="list-decimal space-y-1 pl-4">
            <li>Share your personal invitation link with a friend who is new to One.</li>
            <li>
              Your friend opens your link, creates their account, verifies their phone and
              finishes the required One setup.
            </li>
            <li>
              Each eligible account can credit one referrer. The first eligible referral linked to
              that account is kept; another link cannot replace it later.
            </li>
            <li>
              Self-referrals and duplicate referrals do not count. Link clicks and unfinished
              sign-ups earn no points.
            </li>
          </ol>
        </RuleSection>
        <RuleSection title="Your points and One profile">
          <ul className="list-disc space-y-1 pl-4">
            <li>
              Your link, recorded points and milestone progress belong to the One account you are
              signed in to. Your public display name does not create a separate points balance.
            </li>
            <li>
              The standard award is 100 points per qualified referral in these example settings.
              During an announced flash window, 200 total replaces the standard award; it is not
              an extra 200 points.
            </li>
            <li>
              The example streak bonus is +15 points for each non-overlapping run of three
              consecutive program-calendar days with at least one qualified referral on each day.
              Multiple referrals on one day still count as one streak day.{" "}
              <b>This is a separate referral bonus. The weekly challenge still lasts seven days.</b>{" "}
              A streak can continue across weekly rounds.
            </li>
            <li>
              Your recorded total includes awarded bonuses and corrections. Points may appear
              before your published rank updates; pending referrals are not yet earned points.
            </li>
          </ul>
        </RuleSection>
        <RuleSection title="Weekly challenge and rewards">
          <ul className="list-disc space-y-1 pl-4">
            <li>
              Each challenge lasts <b>seven days</b>, closing every Sunday at 23:59 India time.
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
              Rewards unlock at <b>10, 100, 500 and 10,000 qualified referrals</b>, as shown on the
              Rewards page. Bonus points do not increase your referral count.
            </li>
            <li>
              Unlocked means the milestone has been reached. Reward availability, claiming and
              delivery follow the published reward terms.
            </li>
          </ul>
        </RuleSection>
        <RuleSection title="Circles and Circle Wars">
          <ul className="list-disc space-y-1 pl-4">
            <li>Choose one referral circle from the circles you already belong to.</li>
            <li>
              Each qualified referral adds <b>one contribution</b> to the circle selected when
              your friend qualifies. Personal bonus points do not multiply this contribution.
            </li>
            <li>
              Changing circles affects future contributions. Earlier contributions stay with the
              circle that received them.
            </li>
            <li>
              Circle Wars matchups and team prizes are <b>concept previews</b>. The current
              referral rules do not award automatic points for a circle battle win.
            </li>
          </ul>
        </RuleSection>
      </Card>
    </>
  );
}

function RuleSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group border-b border-border py-3 last:border-0" open={title.startsWith("What")}>
      <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold">
        {title}
        <ListChecks className="size-4 text-muted-foreground group-open:hidden" aria-hidden="true" />
      </summary>
      <div className="mt-2 text-sm text-muted-foreground">{children}</div>
    </details>
  );
}
