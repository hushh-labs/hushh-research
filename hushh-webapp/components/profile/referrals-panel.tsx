"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Share2, Users } from "lucide-react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { useAuth } from "@/lib/firebase/auth-context";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import {
  ReferralService,
  type ReferralSummary,
} from "@/lib/services/referral-service";

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

  /**
   * Keep the numbers current without the person having to reload.
   *
   * A referral changes state because of something the OTHER person did --
   * they finished setup, they opened an agent, their minutes crossed the bar --
   * so a count that only moves on a manual refresh is wrong the moment it is
   * rendered. Refetch when the tab comes back to the foreground, and slowly
   * while it is open. A hidden tab polls nothing: it would spend a phone's
   * battery to update a screen nobody is looking at.
   */
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") void load();
    };

    const interval = window.setInterval(refreshIfVisible, 30_000);
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
    };
  }, [load]);

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
            icon={Users}
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
          <SettingsRow icon={Users} title="Loading" />
        </SettingsGroup>
      </div>
    );
  }

  const hasReferrals = summary.referrals.length > 0;
  const inProgressRows = summary.referrals.filter(
    (row) => row.status === "In progress",
  );

  return (
    <div className="space-y-4 sm:space-y-5">
      <SettingsGroup title="Your link">
        <SettingsRow
          icon={Users}
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
        <SettingsRow icon={Users} title="They join" density="compact" />
        <SettingsRow icon={Users} title="Use an agent" density="compact" />
        <SettingsRow icon={Users} title="Referral qualifies" density="compact" />
      </SettingsGroup>

      <SettingsGroup
        title="Your referrals"
        description={`${summary.required_active_minutes} active minutes · New users only`}
      >
        <SettingsRow
          icon={Users}
          title="Qualified"
          trailing={<span data-testid="referral-qualified-count">{summary.qualified_count}</span>}
          density="compact"
        />
        <SettingsRow
          icon={Users}
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
            icon={Users}
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
              icon={Users}
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
              icon={Users}
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
            icon={Users}
            title="No referrals yet"
            description="Share your link to start."
          />
        </SettingsGroup>
      )}
    </div>
  );
}

export default ReferralsPanel;
