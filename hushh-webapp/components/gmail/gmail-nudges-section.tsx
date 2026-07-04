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

/** Relative "time ago" label from an ISO timestamp (e.g. "2h ago", "3d ago"). */
function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Deep-link to the thread in the Gmail web UI. */
function gmailThreadUrl(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
}

function NudgeCard({ nudge }: { nudge: GmailNudge }) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl border border-[color:var(--app-card-border-standard)] bg-background/60 px-3.5 py-3">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2 w-2 shrink-0 rounded-full bg-amber-500"
          />
          <p className="truncate text-sm font-semibold text-foreground">
            {nudge.title}
          </p>
        </div>
        <p className="truncate text-xs text-muted-foreground">
          From {nudge.sender}
          {nudge.received_at ? ` · ${timeAgo(nudge.received_at)}` : ""}
        </p>
      </div>
      <Button
        variant="muted"
        size="sm"
        onClick={() => window.open(gmailThreadUrl(nudge.thread_id), "_blank", "noopener,noreferrer")}
      >
        Draft reply
      </Button>
    </div>
  );
}

/**
 * "Needs a reply" flashcards for the connected Gmail inbox. Reads inbox nudges
 * from the backend (same gmail.readonly connection as receipts — no new scope)
 * and renders them above the receipts. Renders nothing until Gmail is connected.
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

  const canLoad = Boolean(
    isConnected && userId && vaultOwnerToken && idTokenProvider,
  );

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

  return (
    <SurfaceInset className="space-y-3 px-4 py-4 text-sm sm:px-5 sm:py-5">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
            Needs a reply
          </p>
          <p className="text-sm text-muted-foreground">
            Inbox threads waiting on your response.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {nudges.length > 0 ? (
            <Badge variant="secondary">{nudges.length}</Badge>
          ) : null}
          <Button variant="none" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>

      {error ? (
        <p className="text-xs text-red-600">{error}</p>
      ) : loading && !loaded ? (
        <p className="text-xs text-muted-foreground">Reading your inbox…</p>
      ) : nudges.length === 0 && loaded ? (
        <p className="text-xs text-muted-foreground">
          You’re all caught up — nothing needs a reply right now. ✅
        </p>
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
