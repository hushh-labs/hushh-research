"use client";

import { ExternalLink } from "@/components/icons";

import { Button } from "@/components/ui/button";
import type { GmailNudge } from "@/lib/services/gmail-receipts-service";

export type AgentGmailNudgeCardProps = {
  nudges: GmailNudge[];
  onDismiss: () => void;
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

/** Relative "in X" from a future ISO timestamp. */
function timeUntil(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.round((then - Date.now()) / 60000);
  if (minutes < 1) return "starting now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function NudgeRow({ nudge }: { nudge: GmailNudge }) {
  const isMeeting = nudge.type === "upcoming_meeting";
  const subtitle = isMeeting
    ? `With ${nudge.sender}${nudge.starts_at ? ` · ${timeUntil(nudge.starts_at)}` : ""}`
    : `From ${nudge.sender}${nudge.received_at ? ` · ${timeAgo(nudge.received_at)}` : ""}`;

  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-[color:var(--app-card-border-standard)] bg-background/60 px-3.5 py-3">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className={
              isMeeting
                ? "inline-block h-2 w-2 shrink-0 rounded-full bg-sky-500"
                : "inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500"
            }
          />
          <p className="truncate text-sm font-semibold text-foreground">{nudge.title}</p>
        </div>
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>
      {isMeeting && nudge.meeting_url ? (
        <Button
          asChild
          size="sm"
          variant="ghost"
          className="shrink-0"
          data-testid="agent-gmail-nudge-join"
        >
          <a href={nudge.meeting_url} target="_blank" rel="noopener noreferrer">
            Join
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        </Button>
      ) : null}
    </div>
  );
}

/**
 * A one-time, inline proactive-nudge card shown at the top of a fresh Agent
 * One chat when Gmail is already connected and has real, already-derived
 * nudges pending (needs-reply threads, meetings parsed from invites --
 * GmailReceiptsService.listNudges(), same source as the /one/gmail settings
 * page's "Needs a reply" section). Capped and sorted soonest-meeting /
 * most-recent-reply first; never fabricates a signal listNudges doesn't
 * already derive.
 */
export function AgentGmailNudgeCard({ nudges, onDismiss }: AgentGmailNudgeCardProps) {
  const sorted = [...nudges]
    .sort((a, b) => {
      const aTime = a.type === "upcoming_meeting" && a.starts_at
        ? new Date(a.starts_at).getTime()
        : a.received_at
          ? new Date(a.received_at).getTime()
          : 0;
      const bTime = b.type === "upcoming_meeting" && b.starts_at
        ? new Date(b.starts_at).getTime()
        : b.received_at
          ? new Date(b.received_at).getTime()
          : 0;
      // Meetings sort soonest-first (ascending); replies sort most-recent-first
      // (descending). Mixed list: meetings float first since they're
      // time-sensitive, then replies by recency.
      if (a.type !== b.type) return a.type === "upcoming_meeting" ? -1 : 1;
      return a.type === "upcoming_meeting" ? aTime - bTime : bTime - aTime;
    })
    .slice(0, 3);

  if (sorted.length === 0) return null;

  const lead =
    sorted.length === 1 ? "One thing waiting on you:" : "A few things waiting on you:";

  return (
    <div
      data-testid="agent-gmail-nudge-card"
      className="rounded-2xl border border-[color:var(--app-card-border-standard)] bg-muted/50 p-4"
    >
      <p className="text-xs text-muted-foreground">Reading now. Touching nothing.</p>
      <p className="mt-1 text-sm font-semibold text-foreground">{lead}</p>
      <div className="mt-3 space-y-2">
        {sorted.map((nudge) => (
          <NudgeRow key={`${nudge.thread_id}:${nudge.message_id}`} nudge={nudge} />
        ))}
      </div>
      <div className="mt-3">
        <Button
          data-testid="agent-gmail-nudge-dismiss"
          size="sm"
          variant="ghost"
          onClick={onDismiss}
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
