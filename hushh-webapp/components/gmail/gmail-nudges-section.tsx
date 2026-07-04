"use client";

import { useCallback, useEffect, useState } from "react";

import { SurfaceInset } from "@/components/app-ui/surfaces";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/lib/morphy-ux/button";
import {
  GmailReceiptsService,
  type GmailNudge,
} from "@/lib/services/gmail-receipts-service";

type Props = {
  userId: string | null;
  vaultOwnerToken: string | null;
  isConnected: boolean;
  idTokenProvider: (() => Promise<string>) | null;
};

/** Relative "time ago" from an ISO timestamp (past). */
function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

function NudgeCard({ nudge }: { nudge: GmailNudge }) {
  const isMeeting = nudge.type === "upcoming_meeting";
  // Meetings show just the title line (no timing subtitle); needs-reply shows sender.
  const subtitle = isMeeting
    ? null
    : `From ${nudge.sender}${nudge.received_at ? ` · ${timeAgo(nudge.received_at)}` : ""}`;
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-[color:var(--app-card-border-standard)] bg-background/60 px-3.5 py-3">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={`inline-block h-2 w-2 shrink-0 rounded-full ${isMeeting ? "bg-sky-500" : "bg-amber-500"}`}
          />
          <p className="truncate text-sm font-semibold text-foreground">{nudge.title}</p>
        </div>
        {subtitle ? (
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
      {isMeeting ? (
        <Button
          variant="muted"
          size="sm"
          onClick={() =>
            window.open(
              nudge.meeting_url ?? gmailThreadUrl(nudge.thread_id),
              "_blank",
              "noopener,noreferrer",
            )
          }
        >
          {nudge.meeting_url ? "Join" : "View"}
        </Button>
      ) : (
        // Draft-reply flow isn't built yet — surface it as coming soon, disabled.
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="secondary" className="whitespace-nowrap text-[10px]">
            Draft coming soon
          </Badge>
          <Button variant="muted" size="sm" disabled>
            Draft
          </Button>
        </div>
      )}
    </div>
  );
}

function NudgeGroup({
  eyebrow,
  blurb,
  emptyText,
  nudges,
  loading,
  loaded,
  error,
  onRefresh,
}: {
  eyebrow: string;
  blurb: string;
  emptyText: string;
  nudges: GmailNudge[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  onRefresh?: () => void;
}) {
  return (
    <SurfaceInset className="space-y-3 px-4 py-4 text-sm sm:px-5 sm:py-5">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            {eyebrow}
          </p>
          <p className="text-sm text-muted-foreground">{blurb}</p>
        </div>
        <div className="flex items-center gap-2">
          {nudges.length > 0 ? <Badge variant="secondary">{nudges.length}</Badge> : null}
          {onRefresh ? (
            <Button variant="none" size="sm" onClick={onRefresh} disabled={loading}>
              {loading ? "Refreshing…" : "Refresh"}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : loading && !loaded ? (
        <p className="text-xs text-muted-foreground">Reading your inbox…</p>
      ) : nudges.length === 0 && loaded ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <div className="space-y-2">
          {nudges.map((nudge) => (
            <NudgeCard key={`${nudge.thread_id}:${nudge.message_id}`} nudge={nudge} />
          ))}
        </div>
      )}
    </SurfaceInset>
  );
}

/**
 * Inbox flashcards for the connected Gmail account: "Needs a reply" (unanswered
 * inbound threads) then "Upcoming meeting" (calendar invites). One fetch, same
 * gmail.readonly connection as receipts — no new scope. Renders nothing until
 * Gmail is connected.
 */
export default function GmailNudgesSection({
  userId,
  vaultOwnerToken,
  isConnected,
  idTokenProvider,
}: Props) {
  const [nudges, setNudges] = useState<GmailNudge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const canLoad = Boolean(isConnected && userId && vaultOwnerToken && idTokenProvider);

  const load = useCallback(async () => {
    if (!userId || !vaultOwnerToken || !idTokenProvider) return;
    setLoading(true);
    setError(null);
    try {
      const idToken = await idTokenProvider();
      const response = await GmailReceiptsService.listNudges({
        idToken,
        vaultOwnerToken,
        userId,
        limit: 10,
      });
      setNudges(response.nudges ?? []);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load inbox nudges.");
    } finally {
      setLoading(false);
    }
  }, [userId, vaultOwnerToken, idTokenProvider]);

  useEffect(() => {
    if (canLoad && !loaded && !loading) {
      void load();
    }
  }, [canLoad, loaded, loading, load]);

  if (!isConnected) return null;

  const needsReply = nudges.filter((nudge) => nudge.type === "needs_reply");
  const meetings = nudges.filter((nudge) => nudge.type === "upcoming_meeting");

  return (
    <>
      <NudgeGroup
        eyebrow="Needs a reply"
        blurb="Inbox threads waiting on your response."
        emptyText="You’re all caught up — nothing needs a reply right now. ✅"
        nudges={needsReply}
        loading={loading}
        loaded={loaded}
        error={error}
        onRefresh={() => void load()}
      />
      <NudgeGroup
        eyebrow="Upcoming meeting"
        blurb="Calendar invites coming up."
        emptyText="No upcoming meetings from your inbox."
        nudges={meetings}
        loading={loading}
        loaded={loaded}
        error={error}
      />
    </>
  );
}
