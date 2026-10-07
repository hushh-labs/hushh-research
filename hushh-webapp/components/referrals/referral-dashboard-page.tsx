"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { Link2, Users } from "lucide-react";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
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

/** The app's own emoji mark -- the same "shush" glyph and gradient-dot
 * wordmark the signed-in top shell renders for the One brand (see
 * `top-app-bar.tsx`'s `showOneHomeBrand` block). Reused here rather than the
 * reference design's placeholder art, since this route owns its own chrome
 * and the real app logo is what belongs in it. */
function OneMark({ emojiSize, dotSize }: { emojiSize: number; dotSize: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-flex items-center justify-center leading-none"
        style={{
          fontSize: emojiSize,
          fontFamily: '"Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", emoji',
        }}
      >
        🤫
      </span>
      <span className="font-semibold leading-none tracking-[-0.03em]" style={{ fontSize: dotSize }}>
        One
        <span
          style={{
            backgroundImage:
              "linear-gradient(120deg, var(--app-accent-hero-from, var(--app-accent)), var(--app-accent-hero-mid, var(--app-accent)), var(--app-accent-hero-to, var(--app-accent)))",
            backgroundClip: "text",
            WebkitBackgroundClip: "text",
            color: "transparent",
          }}
        >
          .
        </span>
      </span>
    </span>
  );
}

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

  const dataState =
    summaryRes.status === "loading"
      ? "loading"
      : summaryRes.status === "error"
        ? "unavailable-valid"
        : "loaded";

  return (
    <ShellRoot dataState={dataState} tab={tab} onTabChange={setTab} link={link} onCopy={onCopy}>
      {summaryRes.status === "loading" ? (
        <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
          Loading your referrals…
        </div>
      ) : summaryRes.status === "error" ? (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm text-muted-foreground">Unable to load. Check your connection.</p>
          <Button onClick={reloadSummary}>Try again</Button>
        </div>
      ) : (
        <>
          {tab === "you" ? (
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
          {tab === "rules" ? <RulesTab /> : null}
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
  children,
}: {
  dataState: "loading" | "loaded" | "unavailable-valid";
  tab: TabKey;
  onTabChange: (tab: TabKey) => void;
  link: string;
  onCopy: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="min-h-dvh"
      style={{ background: "var(--app-grouped-background)", color: "var(--foreground)" }}
    >
      <NativeTestBeacon
        routeId={ROUTES.ONE_REFERRALS}
        marker="native-route-one-referrals"
        authState="authenticated"
        dataState={dataState}
      />
      <header
        className="sticky top-0 z-50 backdrop-blur-xl"
        style={{ background: "color-mix(in srgb, var(--app-grouped-background) 82%, transparent)" }}
      >
        <div className="mx-auto grid h-16 max-w-[1008px] grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 px-6">
          <OneMark emojiSize={19} dotSize={17} />
          <div
            role="tablist"
            aria-label="Referral sections"
            className="flex gap-0.5 rounded-xl p-0.5"
            style={{ background: "var(--muted)" }}
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
                  background: tab === item.key ? "var(--card)" : "transparent",
                  color: tab === item.key ? "var(--app-accent-deep, var(--app-accent))" : "var(--muted-foreground)",
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

      <main className="mx-auto max-w-[1008px] px-6 pb-[calc(140px+env(safe-area-inset-bottom,0px))] pt-3">
        {children}
      </main>

      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[55] h-[104px]"
        style={{
          background: "linear-gradient(to top, var(--app-grouped-background) 18%, transparent)",
        }}
      />
      {link ? (
        <div
          role="group"
          aria-label="Your invite link"
          className="fixed left-1/2 z-[60] flex h-[54px] w-[min(640px,calc(100%-32px))] -translate-x-1/2 items-center gap-2.5 rounded-full border pl-[18px] pr-[9px] shadow-lg backdrop-blur-xl"
          style={{
            bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
            background: "color-mix(in srgb, var(--card) 96%, transparent)",
            borderColor: "rgba(0,0,0,.08)",
          }}
        >
          <Link2 className="size-[18px] shrink-0 text-muted-foreground" aria-hidden="true" />
          <small className="hidden shrink-0 text-sm text-muted-foreground sm:inline">
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
  className,
  style,
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <div
      className={"rounded-[18px] " + (className ?? "")}
      style={{ background: "var(--card)", ...style }}
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
          One week. One winner
          <i className="not-italic" style={{ color: "var(--app-accent)" }}>
            .
          </i>
        </h1>
        <p className="relative mt-2 text-[15px] text-muted-foreground">
          Invite friends, keep your streak, win with your circle.
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
        <p className="mt-1 text-sm text-muted-foreground">
          In the app, your invitation link and earned points belong to the One account you are
          signed in to. Your public leaderboard name is a separate display name.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Your points shows your recorded total, including bonuses and adjustments. Published
          rank updates when the standings are published. You can track your points even before
          you have a rank.
        </p>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="p-[22px]">
          <h3 className="text-[20px] font-semibold leading-[25px] tracking-[-0.012em]">Invite</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            100 points when a friend finishes onboarding.
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
            className="mt-2.5 w-full text-center text-xs font-medium text-muted-foreground underline underline-offset-2"
          >
            More share options
          </button>
          {summary.referrals.length > 0 ? (
            <ul className="mt-[14px] -mb-2.5 divide-y" style={{ borderColor: "var(--border)" }}>
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
                    <time className="block text-[13px] text-muted-foreground">
                      {row.started_on}
                    </time>
                  </div>
                  <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
                    {row.status}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-[14px] text-sm text-muted-foreground">
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
            style={{ background: "var(--muted)" }}
          >
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
      className="relative isolate overflow-hidden rounded-[20px] text-white"
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
          className="font-mono font-bold leading-none tabular-nums"
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
            style={{ background: "var(--app-accent)" }}
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
      {weekProgress ? (
        <>
          <div
            className="mt-7 grid gap-1"
            style={{ gridTemplateColumns: `repeat(${weekProgress.totalDays}, minmax(0, 1fr))` }}
            role="img"
            aria-label={`Weekly challenge progress: day ${Math.ceil(weekProgress.elapsedDays)} of ${weekProgress.totalDays}`}
          >
            {Array.from({ length: weekProgress.totalDays }, (_, i) => {
              const fill = Math.max(0, Math.min(1, weekProgress.elapsedDays - i)) * 100;
              const isNow = i === Math.min(weekProgress.totalDays - 1, Math.floor(weekProgress.elapsedDays));
              return (
                <div
                  key={i}
                  className="relative h-[6px] overflow-hidden rounded-full"
                  style={{ background: "rgba(255,255,255,.14)" }}
                >
                  <div
                    className="h-full rounded-full bg-white transition-[width]"
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
              const isNow = i === Math.min(weekProgress.totalDays - 1, Math.floor(weekProgress.elapsedDays));
              return (
                <li key={i} className="min-w-0 text-center text-[11px] leading-[1.4]" style={{ color: isNow ? "#aeaeb2" : "#8e8e93" }}>
                  <b className="block whitespace-nowrap font-semibold" style={{ fontSize: "clamp(10px, 2.8vw, 13px)", color: isNow ? "#fff" : "#aeaeb2" }}>
                    Day {i + 1}
                  </b>
                </li>
              );
            })}
          </ol>
        </>
      ) : null}
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
      sub: statSub(engagementRes, (e) => `best run is ${e.streak.run_length_days} days`),
      onRetry: engagementRes.status === "error" ? onRetryEngagement : undefined,
    },
  ];

  return (
    <dl className="my-4 grid grid-cols-2 rounded-[18px] sm:grid-cols-4" style={{ background: "var(--card)" }}>
      {cells.map((cell, index) => (
        <div
          key={cell.label}
          className={
            "px-[18px] py-4 sm:px-[22px] sm:py-[18px] " +
            (index === 0 ? "border-l-0" : index % 2 === 0 ? "border-l-0 sm:border-l" : "sm:border-l") +
            (index >= 2 ? " border-t sm:border-t-0" : "")
          }
          style={{ borderColor: "var(--border)" }}
        >
          <dt className="text-[13px] font-medium text-muted-foreground">{cell.label}</dt>
          <dd className="mt-1 text-[28px] font-bold leading-[36px] tracking-[-0.025em] tabular-nums sm:text-[32px]">
            {cell.value}
          </dd>
          <dd className="mt-0.5 text-[13px] text-muted-foreground">{cell.sub}</dd>
          {cell.onRetry ? (
            <button
              onClick={cell.onRetry}
              className="mt-1 text-xs font-medium"
              style={{ color: "var(--app-accent)" }}
            >
              Try again
            </button>
          ) : null}
        </div>
      ))}
    </dl>
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
            <dl className="mt-4 flex justify-between gap-4 border-t pt-4" style={{ borderColor: "var(--border)" }}>
              <div>
                <dt className="text-xs text-muted-foreground">Team rank</dt>
                <dd className="mt-0.5 text-[15px] font-semibold tabular-nums">
                  {index >= 0 ? `#${index + 1}` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Team referrals</dt>
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
    <div className="grid gap-6 sm:grid-cols-[280px_minmax(0,1fr)] sm:items-start">
      <aside className="sm:sticky sm:top-20">
        <h2 className="my-4 text-[28px] font-bold leading-[34px] tracking-[-0.022em] sm:mt-0">
          Standings
          <i className="not-italic" style={{ color: "var(--app-accent)" }}>
            .
          </i>
        </h2>
        <div
          role="group"
          aria-label="Standings type"
          className="inline-flex gap-0.5 rounded-xl p-0.5"
          style={{ background: "var(--muted)" }}
        >
          {(["individual", "circles"] as const).map((key) => (
            <button
              key={key}
              aria-pressed={board === key}
              onClick={() => onBoardChange(key)}
              className="rounded-[10px] px-[15px] text-[13px] font-semibold capitalize"
              style={{
                height: 32,
                background: board === key ? "var(--card)" : "transparent",
                color: board === key ? "var(--app-accent-deep, var(--app-accent))" : "var(--muted-foreground)",
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
            style={{ color: "var(--muted-foreground)" }}
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
                <ol className="divide-y" style={{ borderColor: "var(--border)" }}>
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
                <ol className="divide-y" style={{ borderColor: "var(--border)" }}>
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
      style={{ background: me ? "var(--accent-surface, rgba(0,122,255,.08))" : undefined }}
    >
      <span
        className="text-sm font-semibold tabular-nums"
        style={{ color: first ? "#8a6431" : rank <= 3 ? "var(--foreground)" : "var(--muted-foreground)" }}
      >
        {rank}
      </span>
      <span className="min-w-0 truncate text-[15px] font-semibold">
        {who}
        {me ? (
          <small className="ml-2 text-[13px] font-normal" style={{ color: "var(--app-accent)" }}>
            You
          </small>
        ) : null}
      </span>
      <span className="text-[15px] font-semibold tabular-nums">{fmt(points)}</span>
      <div
        className="col-span-2 col-start-2 h-1.5 overflow-hidden rounded-full"
        style={{ background: me ? "rgba(0,122,255,.14)" : "var(--muted)" }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500"
          style={{
            width: `${fillPct}%`,
            background: first
              ? "linear-gradient(90deg, #b8894d, #d4a574)"
              : me
                ? "var(--app-accent)"
                : "var(--chevron, #c7c7cc)",
          }}
        />
      </div>
    </li>
  );
}

function EmptyBoard({ note }: { note: string }) {
  return <p className="mt-6 text-center text-sm text-muted-foreground">{note}</p>;
}

const REWARD_LADDER = [
  { key: "voucher_10", threshold: 10, reward: "₹250 Amazon voucher", icon: VoucherIcon },
  { key: "earbuds_100", threshold: 100, reward: "Wireless earbuds", value: "Worth ₹10k", icon: EarbudsIcon },
  { key: "airpods_500", threshold: 500, reward: "Apple AirPods", value: "Worth ₹30k", icon: AirpodsIcon },
  { key: "iphone_10000", threshold: 10000, reward: "iPhone", icon: PhoneIcon },
];

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
        <i className="not-italic" style={{ color: "var(--app-accent)" }}>
          .
        </i>
      </h2>
      <Section res={milestonesRes} onRetry={onRetry} retryLabel="your reward progress">
        {(milestones) => {
          const earnedKeys = new Set(milestones.earned.map((m) => m.milestone_key));
          const next = milestones.next_milestone;
          const ladderNext = next ? REWARD_LADDER.find((r) => r.key === next.milestone_key) : null;
          return (
            <div className="grid gap-[18px]">
              {next ? (
                <Card
                  className="grid items-center gap-x-7 gap-y-4 p-6 sm:grid-cols-[minmax(0,1fr)_160px]"
                  style={{ position: "relative", overflow: "hidden" }}
                >
                  <div>
                    <p className="mb-2 text-xs font-semibold" style={{ color: "#006dcc" }}>
                      Your next reward
                    </p>
                    <h3 className="text-[23px] font-bold leading-[1.2] tracking-[-0.025em] sm:text-[28px]">
                      {next.reward}
                    </h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {fmt(milestones.lifetime_qualified_count)} referrals so far ·{" "}
                      {fmt(Math.max(0, next.threshold - milestones.lifetime_qualified_count))} more to
                      go
                    </p>
                  </div>
                  <div
                    className="mx-auto grid size-[88px] place-items-center rounded-full sm:size-[160px]"
                    style={{
                      background:
                        "radial-gradient(ellipse at center, rgba(0,122,255,.08), rgba(0,122,255,.015) 65%, transparent 73%)",
                      color: "var(--app-accent)",
                    }}
                  >
                    {ladderNext ? <ladderNext.icon className="size-[72px] sm:size-[132px]" /> : null}
                  </div>
                  <div className="sm:col-span-2">
                    <div className="flex items-baseline justify-between gap-3 text-xs text-muted-foreground">
                      <strong className="text-sm font-semibold tabular-nums" style={{ color: "var(--foreground)" }}>
                        {fmt(next.progress)} / {fmt(next.threshold)} referrals
                      </strong>
                      <span>Next milestone</span>
                    </div>
                    <Progress
                      value={(next.progress / next.threshold) * 100}
                      className="mt-2.5"
                      indicatorClassName="bg-[var(--app-accent)]"
                    />
                  </div>
                </Card>
              ) : (
                <Card className="p-6">
                  <p className="text-sm font-medium">All milestones earned. Incredible work.</p>
                </Card>
              )}

              <div className="-mb-1.5 flex items-baseline justify-between gap-3">
                <h3 className="text-lg font-semibold">Milestones</h3>
                <p className="text-xs text-muted-foreground">
                  {milestones.earned.length} of {REWARD_LADDER.length} unlocked
                </p>
              </div>
              <ol className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {REWARD_LADDER.map((entry) => {
                  const earned = earnedKeys.has(entry.key);
                  const isNext = next?.milestone_key === entry.key;
                  const Icon = entry.icon;
                  return (
                    <li key={entry.key}>
                      <Card
                        className="flex min-h-[182px] flex-col p-4 sm:min-h-[204px] sm:p-5"
                        style={{
                          border: `1px solid ${isNext ? "rgba(0,122,255,.24)" : "transparent"}`,
                        }}
                      >
                        <div className="mb-[18px] flex items-center justify-between gap-2">
                          <span
                            className="grid size-9 shrink-0 place-items-center rounded-xl sm:size-[42px]"
                            style={{
                              background: earned
                                ? "rgba(52,199,89,.16)"
                                : isNext
                                  ? "rgba(0,122,255,.1)"
                                  : "var(--muted)",
                              color: earned ? "#137a35" : isNext ? "var(--app-accent)" : "var(--muted-foreground)",
                            }}
                          >
                            <Icon className="size-5 sm:size-[25px]" />
                          </span>
                          <span
                            className="text-[10px] font-semibold sm:text-[11px]"
                            style={{ color: earned ? "#137a35" : isNext ? "#006dcc" : "var(--muted-foreground)" }}
                          >
                            {earned ? "Unlocked" : isNext ? "Up next" : "Milestone"}
                          </span>
                        </div>
                        <h4 className="text-[15px] font-semibold leading-[1.4] tracking-[-0.01em]">
                          {entry.reward}
                        </h4>
                        {entry.value ? (
                          <p className="mt-0.5 text-xs text-muted-foreground">{entry.value}</p>
                        ) : null}
                        <p
                          className="mt-auto pt-5 text-xs tabular-nums"
                          style={{ color: earned ? "#137a35" : "var(--muted-foreground)", fontWeight: earned ? 600 : 400 }}
                        >
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

function RulesTab() {
  return (
    <>
      <h2 className="my-4 text-[28px] font-bold leading-[34px] tracking-[-0.022em]">
        How referrals work
        <i className="not-italic" style={{ color: "var(--app-accent)" }}>
          .
        </i>
      </h2>
      <ol className="-mt-2 mb-[18px] flex flex-wrap gap-1.5 text-sm font-semibold">
        {["Invite", "Verify", "Finish setup", "Earn points", "Unlock rewards"].map((step, i) => (
          <li key={step} className="flex items-center gap-1.5">
            {i > 0 ? <span className="font-normal text-muted-foreground">→</span> : null}
            {step}
          </li>
        ))}
      </ol>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Card className="p-[22px]">
            <ul className="-mt-2.5 -mb-3">
              {[
                ["Qualified referral", "100 points"],
                ["Referral streak bonus", "+15 points"],
                ["Flash referral, when active", "200 total"],
                ["Clicks or incomplete sign-ups", "0 points"],
                ["Challenge duration", "7 days"],
                ["Milestone progress", "Qualified referrals"],
                ["Circle contribution", "1 per referral"],
              ].map(([label, value], i) => (
                <li
                  key={label}
                  className="flex min-h-[50px] items-center justify-between gap-4 text-[15px]"
                  style={{ borderTop: i === 0 ? undefined : "1px solid var(--border)" }}
                >
                  <span className="text-muted-foreground">{label}</span>
                  <b className="text-right font-semibold tabular-nums">{value}</b>
                </li>
              ))}
            </ul>
          </Card>
          <p className="mx-[22px] mt-2.5 text-xs text-muted-foreground">
            Example point amounts are shown. Your active program sets the actual amounts. Points
            appear after a referral qualifies and is processed.
          </p>
        </div>
        <Card className="p-1" aria-label="Referral rules">
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
                The standard award is 100 points per qualified referral in these example
                settings. During an announced flash window, 200 total replaces the standard
                award; it is not an extra 200 points.
              </li>
              <li>
                The example streak bonus is +15 points for each non-overlapping run of three
                consecutive program-calendar days with at least one qualified referral on each
                day. Multiple referrals on one day still count as one streak day.{" "}
                <b className="font-semibold text-foreground">
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
                Each challenge lasts <b className="font-semibold text-foreground">seven days</b>,
                closing every Sunday at 23:59 India time.
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
                Rewards unlock at{" "}
                <b className="font-semibold text-foreground">10, 100, 500 and 10,000 qualified referrals</b>,
                as shown on the Rewards page. Bonus points do not increase your referral count.
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
                <b className="font-semibold text-foreground">one contribution</b> to the circle
                selected when your friend qualifies. Personal bonus points do not multiply this
                contribution.
              </li>
              <li>
                Changing circles affects future contributions. Earlier contributions stay with the
                circle that received them.
              </li>
              <li>
                Circle Wars matchups and team prizes are{" "}
                <b className="font-semibold text-foreground">concept previews</b>. The current
                referral rules do not award automatic points for a circle battle win.
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
      style={{ borderBottom: "1px solid var(--border)" }}
      open={defaultOpen}
    >
      <summary className="flex min-h-[52px] cursor-pointer list-none items-center justify-between gap-4 text-[16px] font-medium">
        {title}
        <ChevronGlyph />
      </summary>
      <div className="pb-4 text-sm leading-[1.5] text-muted-foreground">{children}</div>
    </details>
  );
}

function ChevronGlyph() {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2 shrink-0 rotate-[-45deg] border-r-2 border-b-2 transition-transform group-open:rotate-45"
      style={{ borderColor: "var(--chevron, #c7c7cc)" }}
    />
  );
}

/* Reward icons -- inlined from the approved reference design so the exact
 * voucher / earbuds / AirPods / iPhone artwork carries over pixel-for-pixel,
 * rather than substituting a generic icon set. */

function VoucherIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={className} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="22" height="17" rx="3" />
      <path d="M3 12h22M10 6v17M10 6C5 6 5 1 8 2c2 .5 2 4 2 4s0-4 2-4c3-1 4 4-2 4M16 17l2 2 4-4" />
    </svg>
  );
}

function EarbudsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={className} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 17h20v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM4 20h20M4 7a4 4 0 1 1 5 3.9V14H6V10.5A4 4 0 0 1 4 7zM24 7a4 4 0 1 0-5 3.9V14h3V10.5A4 4 0 0 0 24 7z" />
    </svg>
  );
}

function AirpodsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={className} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 7a4 4 0 1 1 5 3.9V18a1.5 1.5 0 0 1-3 0V10.5A4 4 0 0 1 5 7zM23 7a4 4 0 1 0-5 3.9V18a1.5 1.5 0 0 0 3 0V10.5A4 4 0 0 0 23 7zM7 23h14" />
    </svg>
  );
}

function PhoneIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={className} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="2" width="14" height="24" rx="3" />
      <path d="M11 5h6M12 23h4" />
      <path d="M10 18l8-9" strokeOpacity={0.4} />
    </svg>
  );
}
