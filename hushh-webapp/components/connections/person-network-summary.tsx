"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRight } from "@/components/icons";
import { useAuth } from "@/hooks/use-auth";
import { ConnectionsService, type NetworkSummary } from "@/lib/services/connections-service";
import { getAuthSessionGeneration, subscribeAuthSessionGeneration } from "@/lib/auth/session-owner";
import { subscribeToConnectionGraphChanges } from "@/lib/connections/connection-graph-events";
import { openPersonProfilePreview } from "@/lib/connections/person-profile-preview";
import { networkDegreeLabel } from "@/components/connect/network-people-list";

export function PersonNetworkSummary({ personRef, onReady }: { personRef: string; onReady?: () => void }) {
  const { user, userId } = useAuth();
  const generation = useSyncExternalStore(subscribeAuthSessionGeneration, getAuthSessionGeneration, () => null);
  return user && userId ? <SummarySession key={`${userId}:${generation}:${personRef}`} personRef={personRef} onReady={onReady} /> : null;
}
function SummarySession({ personRef, onReady }: { personRef: string; onReady?: () => void }) {
  const { user, userId } = useAuth();
  const [summary, setSummary] = useState<NetworkSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [opening, setOpening] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { if (summary || error) onReady?.(); }, [summary, error, onReady]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const refresh = () => { setSummary(null); setRevision(value => value + 1); };
    const unsubscribe = subscribeToConnectionGraphChanges(event => { if (event.userId === userId) refresh(); });
    window.addEventListener("focus", refresh);
    return () => { unsubscribe(); window.removeEventListener("focus", refresh); };
  }, [userId]);
  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    const generation = getAuthSessionGeneration();
    setError(null);
    void user.getIdToken().then(idToken => ConnectionsService.getNetworkSummary({ idToken, personRef, signal: controller.signal }))
      .then(value => { if (!controller.signal.aborted && generation === getAuthSessionGeneration()) setSummary(value); })
      .catch(() => { if (!controller.signal.aborted && generation === getAuthSessionGeneration()) setError("Network details are unavailable."); });
    return () => controller.abort();
  }, [user, personRef, revision]);
  const openMutual = async (returnFocus: HTMLElement) => {
    if (!summary || !user || opening) return;
    if (summary.mutualConnectionCount > 1) { openPersonProfilePreview({ personRef, networkList: "mutuals" }, returnFocus); return; }
    const preview = summary.mutualConnectionPreview?.publicPersonRef;
    if (preview) { openPersonProfilePreview({ personRef: preview }, returnFocus); return; }
    setOpening(true); setError(null);
    const generation = getAuthSessionGeneration();
    try {
      const idToken = await user.getIdToken();
      if (!mounted.current || generation !== getAuthSessionGeneration()) return;
      const page = await ConnectionsService.listMutualConnections({ idToken, personRef, page: 1 });
      if (!mounted.current || generation !== getAuthSessionGeneration()) return;
      if (page.totalCount > 1) openPersonProfilePreview({ personRef, networkList: "mutuals" }, returnFocus);
      else if (page.items[0]) openPersonProfilePreview({ personRef: page.items[0].publicPersonRef }, returnFocus);
      else setError("This mutual connection’s profile is unavailable.");
    } catch { if (mounted.current && generation === getAuthSessionGeneration()) setError("Could not open this mutual connection. Please try again."); }
    finally { if (mounted.current && generation === getAuthSessionGeneration()) setOpening(false); }
  };
  const degree = networkDegreeLabel(summary?.networkDegree);
  const mutualCount = summary?.mutualConnectionCount ?? 0;
  const canBrowse = summary?.canBrowseConnections === true;
  const count = summary?.visibleConnectionCount;
  const countLabel = count == null ? "View connections"
    : count > 500 ? "500+ connections"
    : `${count} ${count === 1 ? "connection" : "connections"}`;
  if (!canBrowse && !degree && mutualCount === 0 && !error) return null;

  return (
    <section aria-label="Network" className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {canBrowse ? (
        <button
          type="button"
          data-voice-control-id="person-network-connections"
          aria-haspopup="dialog"
          className="inline-flex min-h-11 items-center gap-1 rounded-md text-start font-semibold text-primary hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={event => openPersonProfilePreview({ personRef, networkList: "connections" }, event.currentTarget)}
        >
          {countLabel}
          <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 rtl:rotate-180" />
        </button>
      ) : null}
      {degree ? <span className="rounded-full bg-muted px-3 py-1">{degree} connection</span> : null}
      {mutualCount > 0 ? <button type="button" data-voice-control-id="person-network-mutuals" className="min-h-11 rounded-md text-primary hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring" disabled={opening} onClick={event => void openMutual(event.currentTarget)}>{mutualCount} mutual {mutualCount === 1 ? "connection" : "connections"}</button> : null}
      {error ? <span role="status" className="text-muted-foreground">{error} <button type="button" className="min-h-11 px-2 underline" onClick={() => setRevision(value => value + 1)}>Retry</button></span> : null}
    </section>
  );
}
