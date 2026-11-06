"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  return <section aria-label="Network" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-sm">
    {networkDegreeLabel(summary?.networkDegree) ? <span className="rounded-full bg-muted px-3 py-1">{networkDegreeLabel(summary?.networkDegree)} connection</span> : null}
    {(summary?.mutualConnectionCount ?? 0) > 0 ? <button type="button" data-voice-control-id="person-network-mutuals" className="min-h-11 rounded-full px-3 text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring" disabled={opening} onClick={event => void openMutual(event.currentTarget)}>{summary!.mutualConnectionCount} mutual {summary!.mutualConnectionCount === 1 ? "connection" : "connections"}</button> : null}
    {summary?.canBrowseConnections === true ? <button type="button" data-voice-control-id="person-network-connections" className="min-h-11 rounded-full px-3 text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring" onClick={event => openPersonProfilePreview({ personRef, networkList: "connections" }, event.currentTarget)}>View connections</button> : null}
    {error ? <span role="status" className="text-muted-foreground">{error} <button type="button" className="min-h-11 px-2 underline" onClick={() => setRevision(value => value + 1)}>Retry</button></span> : null}
  </section>;
}
