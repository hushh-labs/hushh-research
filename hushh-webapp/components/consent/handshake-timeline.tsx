"use client";

/**
 * Consent Handshake Timeline
 * ==========================
 *
 * Displays the full consent lifecycle between an investor and an RIA as a
 * chronological timeline.  Covers invites, requests, approvals, denials,
 * revocations, and timeouts.  Issue #122.
 */

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Clock,
  Loader2,
  Mail,
  ShieldOff,
  Timer,
  XCircle,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import {
  ConsentCenterService,
  type ConsentCenterActor,
  type HandshakeTimelineEntry,
} from "@/lib/services/consent-center-service";
import { humanizeConsentScope } from "@/lib/consent/consent-display";
import { cn } from "@/lib/utils";

interface HandshakeTimelineProps {
  counterpartId: string;
  counterpartLabel?: string | null;
  actor?: ConsentCenterActor;
  className?: string;
}

async function getIdTokenFromUser(user: ReturnType<typeof useAuth>["user"]): Promise<string | null> {
  if (!user) return null;
  try {
    return await user.getIdToken();
  } catch {
    return null;
  }
}

function actionIcon(action: string) {
  switch (action) {
    case "CONSENT_GRANTED":
      return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
    case "CONSENT_DENIED":
      return <XCircle className="h-4 w-4 text-rose-500" />;
    case "REVOKED":
      return <ShieldOff className="h-4 w-4 text-rose-500" />;
    case "CANCELLED":
      return <XCircle className="h-4 w-4 text-zinc-400" />;
    case "TIMEOUT":
      return <Timer className="h-4 w-4 text-amber-500" />;
    case "REQUESTED":
      return <Clock className="h-4 w-4 text-sky-500" />;
    case "INVITE_SENT":
      return <Mail className="h-4 w-4 text-indigo-500" />;
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />;
  }
}

function actionLabel(action: string): string {
  const labels: Record<string, string> = {
    CONSENT_GRANTED: "Consent granted",
    CONSENT_DENIED: "Consent denied",
    REVOKED: "Consent revoked",
    CANCELLED: "Request cancelled",
    TIMEOUT: "Request timed out",
    REQUESTED: "Consent requested",
    INVITE_SENT: "Invite sent",
  };
  return labels[action] || action.replace(/_/g, " ").toLowerCase();
}

function formatTimelineDate(value: number | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function statusDot(status: string): string {
  switch (status) {
    case "approved":
      return "bg-emerald-500";
    case "request_pending":
    case "pending":
      return "bg-amber-500";
    case "revoked":
    case "denied":
    case "cancelled":
      return "bg-rose-500";
    case "expired":
      return "bg-zinc-400";
    default:
      return "bg-muted-foreground";
  }
}

export function HandshakeTimeline({
  counterpartId,
  counterpartLabel,
  actor = "investor",
  className,
}: HandshakeTimelineProps) {
  const { user } = useAuth();
  const [entries, setEntries] = useState<HandshakeTimelineEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchTimeline = useCallback(async () => {
    const idToken = await getIdTokenFromUser(user);
    if (!idToken) return;
    setLoading(true);
    setError(null);
    try {
      const result = await ConsentCenterService.getHandshakeHistory({
        idToken,
        counterpartId,
        actor,
      });
      setEntries(result.timeline);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load timeline");
    } finally {
      setLoading(false);
    }
  }, [user, counterpartId, actor]);

  useEffect(() => {
    fetchTimeline();
  }, [fetchTimeline]);

  if (loading) {
    return (
      <div className={cn("flex items-center justify-center py-8", className)}>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className={cn("rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive", className)}>
        {error}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className={cn("px-4 py-6 text-center text-sm text-muted-foreground", className)}>
        No consent history with {counterpartLabel || "this connection"}.
      </div>
    );
  }

  return (
    <div className={cn("space-y-0", className)}>
      <h3 className="mb-3 text-sm font-medium text-foreground">
        Consent history{counterpartLabel ? ` with ${counterpartLabel}` : ""}
      </h3>
      <ol className="relative border-l border-border ml-3">
        {entries.map((entry, index) => (
          <li key={entry.id || index} className="mb-4 ml-6 last:mb-0">
            {/* Dot on the timeline line */}
            <span
              className={cn(
                "absolute -left-[5px] flex h-2.5 w-2.5 rounded-full ring-4 ring-background",
                statusDot(entry.status)
              )}
            />

            {/* Content */}
            <div className="flex items-start gap-2">
              {actionIcon(entry.action)}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground leading-snug">
                  {actionLabel(entry.action)}
                </p>
                {entry.scope && (
                  <p className="mt-0.5 text-xs text-muted-foreground truncate">
                    {entry.scope_description || humanizeConsentScope(entry.scope)}
                  </p>
                )}
                {entry.issued_at && (
                  <p className="mt-0.5 text-xs text-muted-foreground/70">
                    {formatTimelineDate(entry.issued_at)}
                  </p>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
