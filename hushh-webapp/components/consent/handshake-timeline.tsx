"use client";

/**
 * Consent Handshake Timeline
 * ==========================
 *
 * Displays the consent lifecycle between an investor and a counterpart using
 * the canonical ConsentHistoryEventTrail representation. Issue #122.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "@/components/icons";

import {
  ConsentHistoryEventTrail,
  formatLifecycleEventLabel,
} from "@/components/consent/consent-history-trails";
import { useAuth } from "@/hooks/use-auth";
import { humanizeConsentScope } from "@/lib/consent/consent-display";
import { formatRequestedAt } from "@/lib/consent/consent-owner-copy";
import {
  ConsentCenterService,
  type ConsentCenterActor,
  type HandshakeTimelineEntry,
} from "@/lib/services/consent-center-service";
import { cn } from "@/lib/utils";

interface HandshakeTimelineProps {
  counterpartId: string;
  counterpartLabel?: string | null;
  actor?: ConsentCenterActor;
  className?: string;
}

async function getIdTokenFromUser(
  user: ReturnType<typeof useAuth>["user"],
): Promise<string | null> {
  if (!user) return null;
  try {
    return await user.getIdToken();
  } catch {
    return null;
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
      setError(
        err instanceof Error ? err.message : "Failed to load timeline",
      );
    } finally {
      setLoading(false);
    }
  }, [user, counterpartId, actor]);

  useEffect(() => {
    void fetchTimeline();
  }, [fetchTimeline]);

  if (loading) {
    return (
      <div
        className={cn(
          "consent-presentation-surface flex items-center justify-center py-8",
          className,
        )}
        role="status"
      >
        <Loader2
          className="h-5 w-5 animate-spin text-muted-foreground"
          aria-hidden="true"
        />
        <span className="sr-only">Loading timeline...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={cn(
          "consent-presentation-surface rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive",
          className,
        )}
      >
        <span data-consent-role="status">{error}</span>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div
        className={cn(
          "consent-presentation-surface px-4 py-6 text-center text-sm text-muted-foreground",
          className,
        )}
      >
        <span data-consent-role="body">
          No consent history with {counterpartLabel || "this connection"}.
        </span>
      </div>
    );
  }

  return (
    <div className={cn("consent-presentation-surface space-y-3", className)}>
      <h3
        data-consent-role="secondary-heading"
        className="text-sm font-medium text-foreground"
      >
        Consent history{counterpartLabel ? ` with ${counterpartLabel}` : ""}
      </h3>
      <ConsentHistoryEventTrail
        events={entries.map((entry, index) => ({
          key: String(entry.id || `${entry.action}-${entry.issued_at || index}`),
          label: formatLifecycleEventLabel({
            action: entry.action,
            status: entry.status,
          }),
          detail:
            [
              entry.scope
                ? entry.scope_description || humanizeConsentScope(entry.scope)
                : null,
              formatRequestedAt(entry.issued_at),
            ]
              .filter(Boolean)
              .join(" · ") || null,
          tone: entry.status || entry.action || null,
        }))}
      />
    </div>
  );
}
