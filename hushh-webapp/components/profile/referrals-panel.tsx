"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ShareNetworkIcon as Share2 } from "@/components/icons";
import {
  InviteFriendsProfileIcon,
  JoinRowIcon,
  LinkRowIcon,
  PeopleRowIcon,
  ProgressRowIcon,
  QualifiedRowIcon,
  ReviewRowIcon,
  SuccessRowIcon,
  UseAgentRowIcon,
  WarningRowIcon,
} from "@/components/icons/agents";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/lib/firebase/auth-context";
import { useReferralStream } from "@/lib/referral/use-referral-stream";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { apiErrorCode } from "@/lib/services/api-client";
import {
  ReferralService,
  type CircleLeaderboardEntry,
  type CircleSelection,
  type EngagementStatus,
  type LeaderboardPage,
  type MilestoneProgress,
  type ReferralSummary,
} from "@/lib/services/referral-service";

type GamificationState = {
  leaderboard: LeaderboardPage | null;
  circleLeaderboard: CircleLeaderboardEntry[] | null;
  milestones: MilestoneProgress | null;
  engagement: EngagementStatus | null;
  circleSelection: CircleSelection | null;
  handle: string | null;
};

type LoadState = "loading" | "ready" | "error";

/**
 * The Referrals tab.
 *
 * Reads one server-owned summary and renders it. It computes nothing: the
 * counts, the statuses and the link all arrive decided, because a referral
 * count the client could influence would not be worth showing.
 */
export function ReferralsPanel() {
  const { user } = useAuth();
  const [state, setState] = useState<LoadState>("loading");
  const [showProgress, setShowProgress] = useState(false);
  const [summary, setSummary] = useState<ReferralSummary | null>(null);

  // Guards against a slow first request landing after a fast retry and
  // overwriting the newer answer with the older one.
  const requestSeq = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setState("loading");
    try {
      if (!user) throw new Error("not signed in");
      const idToken = await user.getIdToken();
      const next = await ReferralService.getSummary({ idToken });
      if (!mounted.current || seq !== requestSeq.current) return;
      setSummary(next);
      setState("ready");
    } catch {
      if (!mounted.current || seq !== requestSeq.current) return;
      setState("error");
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  // Gamification reads, loaded independently of the core summary above: a
  // leaderboard outage must never take down the referral link or the
  // qualified count, and vice versa.
  const [gamification, setGamification] = useState<GamificationState>({
    leaderboard: null,
    circleLeaderboard: null,
    milestones: null,
    engagement: null,
    circleSelection: null,
    handle: null,
  });
  const gamificationSeq = useRef(0);

  const loadGamification = useCallback(async () => {
    const seq = ++gamificationSeq.current;
    if (!user) return;
    const idToken = await user.getIdToken();
    const [leaderboard, circleLeaderboard, milestones, engagement, circleSelection, handle] =
      await Promise.all([
        ReferralService.getLeaderboard({ idToken, limit: 10 }).catch(() => null),
        ReferralService.getCircleLeaderboard({ idToken })
          .then((res) => res.teams)
          .catch(() => null),
        ReferralService.getMilestones({ idToken }).catch(() => null),
        ReferralService.getEngagement({ idToken }).catch(() => null),
        ReferralService.getCircleSelection({ idToken }).catch(() => null),
        ReferralService.getHandle({ idToken })
          .then((res) => res.handle)
          .catch(() => null),
      ]);
    if (!mounted.current || seq !== gamificationSeq.current) return;
    setGamification({ leaderboard, circleLeaderboard, milestones, engagement, circleSelection, handle });
  }, [user]);

  useEffect(() => {
    void loadGamification();
  }, [loadGamification]);

  const [handleInput, setHandleInput] = useState("");
  const [handleSaving, setHandleSaving] = useState(false);
  const [handleErrorMessage, setHandleErrorMessage] = useState<string | null>(null);

  const onSaveHandle = useCallback(async () => {
    if (!user || !handleInput.trim()) return;
    setHandleSaving(true);
    setHandleErrorMessage(null);
    try {
      const idToken = await user.getIdToken();
      const { handle } = await ReferralService.setHandle({ idToken, handle: handleInput.trim() });
      if (!mounted.current) return;
      setGamification((prev) => ({ ...prev, handle }));
      setHandleInput("");
      morphyToast.success("Handle set");
    } catch (error) {
      if (!mounted.current) return;
      const code = apiErrorCode(error);
      setHandleErrorMessage(
        code === "REFERRAL_HANDLE_TAKEN"
          ? "That handle is already taken."
          : "Enter 3-24 letters, numbers, or hyphens."
      );
    } finally {
      if (mounted.current) setHandleSaving(false);
    }
  }, [user, handleInput]);

  // Live push. While this is connected the numbers arrive as they change, and
  // the timer below stands down.
  const { connected } = useReferralStream(user, load);

  /**
   * Fallback only, for when the stream is not up.
   *
   * A stream can fail to open for reasons that have nothing to do with us -- an
   * old browser, a corporate proxy that eats long connections, a captive
   * network. When that happens the screen must go slow, not stale, so the timer
   * takes over. While the stream IS connected the interval is not armed at all:
   * polling on top of a push is the same screen asking a question it has
   * already been answered.
   *
   * The foreground refetch stays either way. A tab that was asleep may have
   * missed a doorbell while the socket was down, and coming back to a screen
   * that is quietly out of date is exactly what this whole change is about.
   */
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") void load();
    };

    const interval = connected
      ? null
      : window.setInterval(refreshIfVisible, 30_000);
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);

    return () => {
      if (interval !== null) window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [connected, load]);

  // Read out of state once. An optional chain inside a dependency array is
  // opaque to the React compiler, which then refuses to preserve the memo.
  const link = summary?.link ?? "";

  const onCopy = useCallback(async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      morphyToast.success("Link copied");
    } catch {
      // A denied clipboard is a normal browser state, not a broken screen.
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
      await share({ text: "Join me on Hushh", url: link });
    } catch {
      // Cancelling the share sheet is a choice, not a failure. Say nothing.
    }
  }, [link, onCopy]);

  if (state === "error") {
    return (
      <div className="space-y-4 sm:space-y-5">
        <SettingsGroup>
          <SettingsRow
            icon={WarningRowIcon}
            iconTone="capability"
            title="Unable to load"
            description="Check your connection."
          />
        </SettingsGroup>
        <Button onClick={() => void load()}>Try again</Button>
      </div>
    );
  }

  if (state === "loading" || !summary) {
    return (
      <div className="space-y-4 sm:space-y-5" aria-busy="true">
        <SettingsGroup>
          <SettingsRow icon={InviteFriendsProfileIcon} iconTone="capability" title="Loading" />
        </SettingsGroup>
      </div>
    );
  }

  const hasReferrals = summary.referrals.length > 0;
  const inProgressRows = summary.referrals.filter(
    (row) => row.status === "In progress",
  );
  const viewerLeaderboardRow =
    gamification.leaderboard?.viewer ??
    gamification.leaderboard?.entries.find((entry) => entry.is_viewer) ??
    null;

  return (
    <div className="space-y-4 sm:space-y-5">
      <SettingsGroup title="Your link">
        <SettingsRow
          icon={LinkRowIcon}
          iconTone="capability"
          title={summary.slug}
          description={summary.link}
        />
      </SettingsGroup>

      <div className="flex gap-3">
        <Button onClick={() => void onCopy()}>Copy</Button>
        <Button variant="muted" onClick={() => void onShare()}>
          <Share2 className="size-4" aria-hidden="true" />
          Share
        </Button>
      </div>

      <SettingsGroup title="How it works">
        <SettingsRow icon={JoinRowIcon} iconTone="capability" title="They join" density="compact" />
        <SettingsRow icon={UseAgentRowIcon} iconTone="capability" title="Use an agent" density="compact" />
        <SettingsRow icon={QualifiedRowIcon} iconTone="capability" title="Referral qualifies" density="compact" />
      </SettingsGroup>

      <SettingsGroup
        title="Overview"
        description="All contributions carry forward"
      >
        <SettingsRow
          icon={SuccessRowIcon}
          iconTone="capability"
          title="Overall rank"
          trailing={
            <span data-testid="referral-overall-rank">
              {viewerLeaderboardRow ? `#${viewerLeaderboardRow.rank}` : "Not yet ranked"}
            </span>
          }
          density="compact"
        />
        <SettingsRow
          icon={SuccessRowIcon}
          iconTone="capability"
          title="Cumulative points"
          trailing={<span data-testid="referral-cumulative-points">{viewerLeaderboardRow?.points ?? 0}</span>}
          density="compact"
        />
        {gamification.circleSelection?.circle_id ? (
          <SettingsRow
            icon={PeopleRowIcon}
            iconTone="capability"
            title="Your team"
            description="Raw qualified referrals, counted for your team"
            trailing={
              <span>
                {gamification.circleLeaderboard?.find(
                  (team) => team.circle_id === gamification.circleSelection?.circle_id,
                )?.contribution_count ?? 0}
              </span>
            }
            density="compact"
          />
        ) : null}
      </SettingsGroup>

      {gamification.milestones ? (
        <SettingsGroup title="Your next reward">
          {gamification.milestones.next_milestone ? (
            <SettingsRow
              icon={ProgressRowIcon}
              iconTone="capability"
              title={gamification.milestones.next_milestone.reward}
              density="compact"
              description={
                <div className="flex w-full flex-col gap-2 pt-1">
                  <div className="flex items-center justify-end text-sm">
                    <span data-testid="referral-milestone-progress">
                      {gamification.milestones.next_milestone.progress}/
                      {gamification.milestones.next_milestone.threshold}
                    </span>
                  </div>
                  <Progress
                    value={
                      (gamification.milestones.next_milestone.progress /
                        gamification.milestones.next_milestone.threshold) *
                      100
                    }
                  />
                </div>
              }
            />
          ) : (
            <SettingsRow
              icon={SuccessRowIcon}
              iconTone="capability"
              title="Every reward earned"
              density="compact"
            />
          )}
          {gamification.milestones.earned.map((item) => (
            <SettingsRow
              key={item.milestone_key}
              icon={SuccessRowIcon}
              iconTone="capability"
              title={item.reward}
              description="Earned"
              density="compact"
            />
          ))}
        </SettingsGroup>
      ) : null}

      {gamification.engagement &&
      (gamification.engagement.streak.current_run_days > 0 || gamification.engagement.flash.active) ? (
        <SettingsGroup title="Keep it going">
          {gamification.engagement.streak.current_run_days > 0 ? (
            <SettingsRow
              icon={ProgressRowIcon}
              iconTone="capability"
              title="Referral streak"
              description={`${gamification.engagement.streak.current_run_days} of ${gamification.engagement.streak.run_length_days} days`}
              density="compact"
            />
          ) : null}
          {gamification.engagement.flash.active ? (
            <SettingsRow
              icon={SuccessRowIcon}
              iconTone="capability"
              title="Flash bonus is live"
              description="Referrals qualifying now earn double points"
              density="compact"
            />
          ) : null}
        </SettingsGroup>
      ) : null}

      {gamification.handle === null ? (
        <SettingsGroup
          title="Appear on the leaderboard"
          description="Choose a handle to show your rank to other referrers. Your real name is never shown."
        >
          <SettingsRow
            icon={PeopleRowIcon}
            iconTone="capability"
            title="Your leaderboard handle"
            density="compact"
            description={
              <div className="flex w-full flex-col gap-2 pt-1 sm:flex-row sm:items-center">
                <Input
                  value={handleInput}
                  onChange={(event) => setHandleInput(event.target.value)}
                  placeholder="your-handle"
                  maxLength={32}
                  aria-label="Leaderboard handle"
                />
                <Button
                  onClick={() => void onSaveHandle()}
                  disabled={handleSaving || !handleInput.trim()}
                >
                  Save
                </Button>
              </div>
            }
          />
          {handleErrorMessage ? (
            <SettingsRow
              icon={WarningRowIcon}
              iconTone="capability"
              title={handleErrorMessage}
              density="compact"
            />
          ) : null}
        </SettingsGroup>
      ) : null}

      {gamification.leaderboard && gamification.leaderboard.entries.length > 0 ? (
        <SettingsGroup
          title="Leaderboard"
          description={
            gamification.leaderboard.snapshot_generated_at
              ? `As of ${new Date(gamification.leaderboard.snapshot_generated_at).toLocaleString()}`
              : undefined
          }
        >
          {gamification.leaderboard.entries.map((entry) => (
            <SettingsRow
              key={entry.rank}
              icon={entry.is_viewer ? SuccessRowIcon : PeopleRowIcon}
              iconTone="capability"
              title={`#${entry.rank} ${entry.handle}`}
              trailing={<span>{entry.points} pts</span>}
              density="compact"
            />
          ))}
          {gamification.leaderboard.viewer ? (
            <SettingsRow
              icon={SuccessRowIcon}
              iconTone="capability"
              title={`#${gamification.leaderboard.viewer.rank} ${gamification.leaderboard.viewer.handle} (you)`}
              trailing={<span>{gamification.leaderboard.viewer.points} pts</span>}
              density="compact"
            />
          ) : null}
        </SettingsGroup>
      ) : null}

      {gamification.circleLeaderboard && gamification.circleLeaderboard.length > 0 ? (
        <SettingsGroup title="Team leaderboard">
          {gamification.circleLeaderboard.map((team) => (
            <SettingsRow
              key={team.circle_id}
              icon={PeopleRowIcon}
              iconTone="capability"
              title={team.circle_name}
              trailing={<span>{team.contribution_count}</span>}
              density="compact"
            />
          ))}
        </SettingsGroup>
      ) : null}

      <SettingsGroup
        title="Your referrals"
        description={`${summary.required_active_minutes} active minutes · New users only`}
      >
        <SettingsRow
          icon={QualifiedRowIcon}
          iconTone="capability"
          title="Qualified"
          trailing={<span data-testid="referral-qualified-count">{summary.qualified_count}</span>}
          density="compact"
        />
        <SettingsRow
          icon={ProgressRowIcon}
          iconTone="capability"
          title="In progress"
          trailing={
            <span data-testid="referral-in-progress-count">
              {summary.in_progress_count}
            </span>
          }
          density="compact"
          testId="referral-in-progress-row"
          chevron={summary.in_progress_count > 0}
          onClick={
            summary.in_progress_count > 0
              ? () => setShowProgress((open) => !open)
              : undefined
          }
          ariaPressed={summary.in_progress_count > 0 ? showProgress : undefined}
        />
        {summary.under_review_count > 0 ? (
          <SettingsRow
            icon={ReviewRowIcon}
            iconTone="capability"
            title="Under review"
            trailing={<span>{summary.under_review_count}</span>}
            density="compact"
          />
        ) : null}
      </SettingsGroup>

      {showProgress && inProgressRows.length > 0 ? (
        <SettingsGroup
          title="Progress"
          description="Nobody is named. You see the step, not the person."
        >
          {inProgressRows.map((row, index) => (
            <SettingsRow
              key={`progress:${row.started_on}:${index}`}
              icon={ProgressRowIcon}
              iconTone="capability"
              title={row.step}
              description={`${row.active_minutes} of ${row.required_minutes} active minutes · joined ${row.started_on}`}
              trailing={
                <span data-testid="referral-progress-minutes">
                  {row.active_minutes}/{row.required_minutes}
                </span>
              }
              density="compact"
            />
          ))}
        </SettingsGroup>
      ) : null}

      {hasReferrals ? (
        <SettingsGroup title="Recent">
          {summary.referrals.slice(0, 10).map((row, index) => (
            <SettingsRow
              key={`${row.started_on}:${index}`}
              icon={JoinRowIcon}
              iconTone="capability"
              title="New member"
              description={row.started_on}
              trailing={<span>{row.status}</span>}
              density="compact"
            />
          ))}
        </SettingsGroup>
      ) : (
        <SettingsGroup>
          <SettingsRow
            icon={InviteFriendsProfileIcon}
            iconTone="capability"
            title="No referrals yet"
            description="Share your link to start."
          />
        </SettingsGroup>
      )}
    </div>
  );
}

export default ReferralsPanel;
