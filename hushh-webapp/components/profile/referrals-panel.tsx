"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { ShareNetworkIcon as Share2 } from "@/components/icons";
import { PROFILE_ICONS } from "@/components/icons/profile-icons";
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
import typographyStyles from "@/components/profile/profile-secondary-typography.module.css";

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
import { cn } from "@/lib/utils";
import { isShareCancellationError, shareLink } from "@/lib/share/share-link";

type GamificationState = {
  balance: { points: number; coins: number } | null;
  leaderboard: LeaderboardPage | null;
  circleLeaderboard: CircleLeaderboardEntry[] | null;
  milestones: MilestoneProgress | null;
  engagement: EngagementStatus | null;
  circleSelection: CircleSelection | null;
  handle: string | null;
};

type LoadState = "loading" | "ready" | "error";
const emptyGamification = (): GamificationState => ({ leaderboard: null, circleLeaderboard: null,
  milestones: null, engagement: null, circleSelection: null, handle: null, balance: null });

/**
 * The Referrals tab.
 *
 * Reads one server-owned summary and renders it. It computes nothing: the
 * counts, the statuses and the link all arrive decided, because a referral
 * count the client could influence would not be worth showing.
 */
export function ReferralsPanel({ panePresentation = false }: { panePresentation?: boolean }) {
  const { user } = useAuth();
  return <ReferralsPanelContent key={user?.uid ?? "signed-out"} panePresentation={panePresentation} />;
}

export function useReferralsPanelModel(active = true) {
  const { user } = useAuth();
  const stateOwner = useRef(user?.uid);
  const ownsState = stateOwner.current === user?.uid;
  // One feature owner for both renderers. An old request cannot publish into
  // a different account or a later visit, including after leaving Profile.
  const visit = useMemo(() => ({ live: false, owner: user?.uid, active }), [user?.uid, active]);
  useLayoutEffect(() => { visit.live = active; return () => { visit.live = false; }; }, [visit, active]);
  const [state, setState] = useState<LoadState>("loading");
  const [showProgress, setShowProgress] = useState(false);
  const [summary, setSummary] = useState<ReferralSummary | null>(null);
  const [copyOutcome, setCopyOutcome] = useState<{ link: string; copied: boolean } | null>(null);

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
    if (!visit.live) return;
    const seq = ++requestSeq.current;
    setState("loading");
    try {
      if (!user) throw new Error("not signed in");
      const idToken = await user.getIdToken();
      if (!visit.live) return;
      const next = await ReferralService.getSummary({ idToken });
      if (!mounted.current || !visit.live || seq !== requestSeq.current) return;
      setSummary(next);
      setState("ready");
    } catch {
      if (!mounted.current || !visit.live || seq !== requestSeq.current) return;
      setState("error");
    }
  }, [user, visit]);

  useEffect(() => {
    void load();
  }, [load]);

  // Gamification reads, loaded independently of the core summary above: a
  // leaderboard outage must never take down the referral link or the
  // qualified count, and vice versa.
  const [gamification, setGamification] = useState<GamificationState>(emptyGamification);
  const gamificationSeq = useRef(0);

  const loadGamification = useCallback(async () => {
    const seq = ++gamificationSeq.current;
    if (!user || !visit.live) return;
    let idToken: string;
    try { idToken = await user.getIdToken(); } catch { return; }
    if (!visit.live) return;
    const [leaderboard, circleLeaderboard, milestones, engagement, circleSelection, handle, balance] =
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
        ReferralService.getPoints({ idToken }).catch(() => null),
      ]);
    if (!mounted.current || !visit.live || seq !== gamificationSeq.current) return;
    setGamification({ leaderboard, circleLeaderboard, milestones, engagement, circleSelection, handle, balance });
  }, [user, visit]);

  useEffect(() => {
    void loadGamification();
  }, [loadGamification]);

  const [handleInput, setHandleInput] = useState("");
  const [handleSaving, setHandleSaving] = useState(false);
  const [handleErrorMessage, setHandleErrorMessage] = useState<string | null>(null);
  const handlePending = useRef(false);
  const handleRevision = useRef(0);
  const handleDraft = useRef("");
  const changeHandle = useCallback((value: string) => {
    if (!visit.live || handlePending.current) return;
    handleDraft.current = value; handleRevision.current += 1;
    setHandleInput(value); setHandleErrorMessage(null);
  }, [visit]);

  const onSaveHandle = useCallback(async () => {
    if (!user || !visit.live || handlePending.current || !handleDraft.current.trim()) return false;
    handlePending.current = true;
    setHandleSaving(true);
    setHandleErrorMessage(null);
    try {
      const idToken = await user.getIdToken();
      if (!visit.live) return false;
      const { handle } = await ReferralService.setHandle({ idToken, handle: handleDraft.current.trim() });
      if (!mounted.current || !visit.live) return false;
      setGamification((prev) => ({ ...prev, handle }));
      handleDraft.current = ""; handleRevision.current += 1; setHandleInput("");
      morphyToast.success("Handle set");
      return true;
    } catch (error) {
      if (!mounted.current || !visit.live) return false;
      const code = apiErrorCode(error);
      setHandleErrorMessage(
        code === "REFERRAL_HANDLE_TAKEN"
          ? "That handle is already taken."
          : "Enter 3-24 letters, numbers, or hyphens."
      );
      return false;
    } finally {
      handlePending.current = false;
      // This only releases the synchronous pending guard. Results and private
      // content above still require the original live visit.
      if (mounted.current) setHandleSaving(false);
    }
  }, [user, visit]);

  // Live push. While this is connected the numbers arrive as they change, and
  // the timer below stands down.
  const refreshAll = useCallback(() => { void load(); void loadGamification(); }, [load, loadGamification]);
  const { connected } = useReferralStream(active ? user : null, refreshAll);

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
    if (!active) return;
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") refreshAll();
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
  }, [active, connected, refreshAll]);

  // Read out of state once. An optional chain inside a dependency array is
  // opaque to the React compiler, which then refuses to preserve the memo.
  const link = ownsState ? summary?.link ?? "" : "";

  const onCopy = useCallback(async (writer?: (link: string) => Promise<boolean>) => {
    if (!visit.live || !link) return;
    try {
      if (writer) {
        if (!await writer(link)) throw new Error("COPY_NOT_ACKNOWLEDGED");
      } else await navigator.clipboard.writeText(link);
      if (!visit.live) return;
      setCopyOutcome({ link, copied: true });
      morphyToast.success("Link copied");
    } catch {
      if (!visit.live) return;
      setCopyOutcome({ link, copied: false });
      // A denied clipboard is a normal browser state, not a broken screen.
      morphyToast.error("Could not copy");
    }
  }, [link, visit]);

  const onShare = useCallback(async () => {
    if (!visit.live || !link) return;
    try {
      if (!Capacitor.isNativePlatform()) {
        // Web Share must remain in the original DOM activation; importing a
        // native adapter first can consume Safari's user-activation window.
        if (typeof navigator.share === "function") await navigator.share({ text: "Join me on Hushh", url: link });
        else await onCopy();
        return;
      }
      const delivery = await shareLink({ title: "Join me on Hushh", text: "Join me on Hushh",
        dialogTitle: "Share invitation", url: link }, () => visit.live);
      if (delivery === "copied" && visit.live) morphyToast.success("Link copied");
    } catch (error) {
      if (visit.live && !isShareCancellationError(error)) morphyToast.error("Could not share");
    }
  }, [link, onCopy, visit]);

  const current = useCallback(() => visit.live, [visit]);
  useLayoutEffect(() => {
    stateOwner.current = user?.uid;
    setSummary(null); setState("loading"); setShowProgress(false);
    setCopyOutcome(null);
    setGamification(emptyGamification());
    handleDraft.current = ""; handleRevision.current += 1; setHandleInput("");
    setHandleErrorMessage(null);
  }, [user?.uid]);

  return { state: ownsState ? state : "loading" as LoadState, summary: ownsState ? summary : null,
    gamification: ownsState ? gamification : emptyGamification(), showProgress: ownsState && showProgress,
    setShowProgress, load, onCopy, onShare,
    handleInput: ownsState ? handleInput : "", changeHandle, handleSaving, handleErrorMessage: ownsState ? handleErrorMessage : null, onSaveHandle,
    copyStatus: ownsState && copyOutcome?.link === link ? copyOutcome.copied ? "copied" as const : "error" as const : "idle" as const,
    current, handleRevision: () => handleRevision.current };
}
export type ReferralsPanelModel = ReturnType<typeof useReferralsPanelModel>;

function ReferralsPanelContent({ panePresentation = false }: { panePresentation?: boolean }) {
  const model = useReferralsPanelModel();
  return <ReferralsPanelView panePresentation={panePresentation} model={model} />;
}

export function ReferralsPanelView({ panePresentation = false, model }: { panePresentation?: boolean; model: ReferralsPanelModel }) {
  const { state, summary, gamification, showProgress, setShowProgress, load, onCopy, onShare,
    handleInput, changeHandle, handleSaving, handleErrorMessage, onSaveHandle } = model;
  const icons = panePresentation ? {
    invite: PROFILE_ICONS.invite,
    link: PROFILE_ICONS.referralLink,
    join: PROFILE_ICONS.referralJoin,
    agent: PROFILE_ICONS.referralAgent,
    qualified: PROFILE_ICONS.referralQualified,
    success: PROFILE_ICONS.referralSuccess,
    people: PROFILE_ICONS.people,
    progress: PROFILE_ICONS.referralProgress,
    review: PROFILE_ICONS.review,
    warning: PROFILE_ICONS.referralWarning,
  } : {
    invite: InviteFriendsProfileIcon,
    link: LinkRowIcon,
    join: JoinRowIcon,
    agent: UseAgentRowIcon,
    qualified: QualifiedRowIcon,
    success: SuccessRowIcon,
    people: PeopleRowIcon,
    progress: ProgressRowIcon,
    review: ReviewRowIcon,
    warning: WarningRowIcon,
  };

  if (state === "error") {
    return (
      <div
        className={cn(
          "profile-inner-referrals space-y-4 sm:space-y-5",
          panePresentation && typographyStyles.paneReferrals,
        )}
      >
        <SettingsGroup>
          <SettingsRow
            icon={icons.warning}
            iconTone="capability"
            title="Unable to load"
            description="Check your connection."
          />
        </SettingsGroup>
        <Button
          className={panePresentation ? typographyStyles.action : undefined}
          onClick={() => void load()}
        >
          Try again
        </Button>
      </div>
    );
  }

  if (state === "loading" || !summary) {
    return (
      <div
        className={cn(
          "profile-inner-referrals space-y-4 sm:space-y-5",
          panePresentation && typographyStyles.paneReferrals,
        )}
        aria-busy="true"
      >
        <SettingsGroup>
          <SettingsRow icon={icons.invite} iconTone="capability" title="Loading" />
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
    <div
      className={cn(
        "profile-inner-referrals space-y-4 sm:space-y-5",
        panePresentation && typographyStyles.paneReferrals,
      )}
    >
      <SettingsGroup title="Your link">
        <SettingsRow
          icon={icons.link}
          iconTone="capability"
          title={summary.slug}
          description={summary.link}
        />
      </SettingsGroup>

      <div className="flex gap-3">
        <Button
          className={panePresentation ? typographyStyles.action : undefined}
          onClick={() => void onCopy()}
        >
          Copy
        </Button>
        <Button
          className={panePresentation ? typographyStyles.action : undefined}
          variant="muted"
          onClick={() => void onShare()}
        >
          <Share2 className="size-4" aria-hidden="true" />
          Share
        </Button>
      </div>

      <SettingsGroup title="How it works">
        <SettingsRow icon={icons.join} iconTone="capability" title="They join" density="compact" />
        <SettingsRow icon={icons.agent} iconTone="capability" title="Use an agent" density="compact" />
        <SettingsRow icon={icons.qualified} iconTone="capability" title="Referral qualifies" density="compact" />
      </SettingsGroup>

      <SettingsGroup
        title="Overview"
        description="All contributions carry forward"
      >
        <SettingsRow
          icon={icons.success}
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
          icon={icons.success}
          iconTone="capability"
          title="Coins"
          trailing={<span data-testid="referral-cumulative-points">{gamification.balance?.coins ?? "—"}</span>}
          density="compact"
        />
        {gamification.circleSelection?.circle_id ? (
          <SettingsRow
            icon={icons.people}
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
              icon={icons.progress}
              iconTone="capability"
              title={gamification.milestones.next_milestone.reward}
              density="compact"
              description={
                <div className="flex w-full flex-col gap-2 pt-1">
                  <div
                    className={cn(
                      "flex items-center justify-end text-sm",
                      panePresentation && typographyStyles.progressCount,
                    )}
                  >
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
              icon={icons.success}
              iconTone="capability"
              title="All milestones reached"
              density="compact"
            />
          )}
          {gamification.milestones.earned.map((item) => (
            <SettingsRow
              key={item.milestone_key}
              icon={icons.success}
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
              icon={icons.progress}
              iconTone="capability"
              title="Dashboard streak"
              description={`${gamification.engagement.streak.current_run_days} consecutive days`}
              density="compact"
            />
          ) : null}
          {gamification.engagement.flash.active ? (
            <SettingsRow
              icon={icons.success}
              iconTone="capability"
              title="Flash bonus is live"
              description="Referrals qualifying now earn the configured coin boost"
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
            icon={icons.people}
            iconTone="capability"
            title="Your leaderboard handle"
            density="compact"
            description={
              <div className="flex w-full flex-col gap-2 pt-1 sm:flex-row sm:items-center">
                <Input
                  className={panePresentation ? typographyStyles.field : undefined}
                  value={handleInput}
                  onChange={(event) => changeHandle(event.target.value)}
                  placeholder="your-handle"
                  maxLength={32}
                  aria-label="Leaderboard handle"
                />
                <Button
                  className={panePresentation ? typographyStyles.action : undefined}
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
              icon={icons.warning}
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
              icon={entry.is_viewer ? icons.success : icons.people}
              iconTone="capability"
              title={`#${entry.rank} ${entry.handle}`}
              trailing={<span>{entry.points} coins</span>}
              density="compact"
            />
          ))}
          {gamification.leaderboard.viewer ? (
            <SettingsRow
              icon={icons.success}
              iconTone="capability"
              title={`#${gamification.leaderboard.viewer.rank} ${gamification.leaderboard.viewer.handle} (you)`}
              trailing={<span>{gamification.leaderboard.viewer.points} coins</span>}
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
              icon={icons.people}
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
          icon={icons.qualified}
          iconTone="capability"
          title="Qualified"
          trailing={<span data-testid="referral-qualified-count">{summary.qualified_count}</span>}
          density="compact"
        />
        <SettingsRow
          icon={icons.progress}
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
            icon={icons.review}
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
              icon={icons.progress}
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
              icon={icons.join}
              iconTone="capability"
              title={row.display_name ?? "Member"}
              description={`${row.started_on} · ${row.step}`}
              trailing={<span>{row.status}</span>}
              density="compact"
            />
          ))}
        </SettingsGroup>
      ) : (
        <SettingsGroup>
          <SettingsRow
            icon={icons.invite}
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
