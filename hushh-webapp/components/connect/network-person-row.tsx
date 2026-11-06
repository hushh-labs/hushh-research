"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { DirectoryMutualLine } from "@/components/connect/connect-person-row";
import { ConnectionsService, type NetworkPerson } from "@/lib/services/connections-service";
import { connectPersonName } from "@/lib/connections/person-label";
import { openPersonProfilePreview } from "@/lib/connections/person-profile-preview";
import { getAuthSessionGeneration } from "@/lib/auth/session-owner";

/** Independent action/profile controls: connecting never opens or selects a profile. */
export function NetworkPersonRow({ person, onOpen, onRemember, onConnect, connecting, connectionError }: {
  person: NetworkPerson; onOpen: (element: HTMLButtonElement) => void; onRemember: () => void;
  onConnect: () => void; connecting: boolean; connectionError?: string;
}) {
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const name = connectPersonName(person);
  const status = person.relationship ?? (person.networkDegree === 1 ? "connected" : undefined);
  const current = (generation: ReturnType<typeof getAuthSessionGeneration>) => mounted.current && generation === getAuthSessionGeneration();
  const openMutual = async (element: HTMLElement) => {
    if (pending.current) return;
    onRemember();
    const count = person.mutualConnectionCount ?? 0;
    const previewRef = person.mutualConnectionPreviews?.[0]?.publicPersonRef ?? person.mutualConnectionPreview?.publicPersonRef;
    if (count > 1) { openPersonProfilePreview({ personRef: person.publicPersonRef, networkList: "mutuals" }, element); return; }
    if (previewRef) { openPersonProfilePreview({ personRef: previewRef }, element); return; }
    if (!user) return;
    const generation = getAuthSessionGeneration();
    pending.current = true; setBusy(true); setError(null);
    try {
      const token = await user.getIdToken();
      if (!current(generation)) return;
      const result = await ConnectionsService.listMutualConnections({ personRef: person.publicPersonRef, idToken: token, page: 1 });
      if (!current(generation)) return;
      if (result.totalCount > 1) openPersonProfilePreview({ personRef: person.publicPersonRef, networkList: "mutuals" }, element);
      else if (result.items[0]) openPersonProfilePreview({ personRef: result.items[0].publicPersonRef }, element);
      else setError("This mutual connection is unavailable.");
    } catch { if (current(generation)) setError("Could not open mutual connections. Please try again."); }
    finally { if (current(generation)) { pending.current = false; setBusy(false); } }
  };
  return <li className="px-3 py-3 sm:px-4">
    <div className="flex items-start gap-3">
      <div className="flex w-20 shrink-0 justify-start pt-1">
        {status === "none" ? <button type="button" data-network-person={person.publicPersonRef} data-network-focus="connect" aria-label={`Connect with ${name}`} disabled={busy || connecting} className="min-h-11 w-full rounded-full border border-primary/40 px-2 text-sm font-medium text-primary hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" onClick={onConnect}>{connecting ? "Sending…" : "Connect"}</button>
          : status === "connected" ? <span className="py-3 text-xs text-muted-foreground">Connected</span>
          : status === "pending_outgoing" ? <span className="py-3 text-xs text-muted-foreground">Request sent</span>
          : status === "pending_incoming" ? <button type="button" data-network-person={person.publicPersonRef} data-network-focus="request" className="min-h-11 w-full rounded-full border px-2 text-xs focus-visible:ring-2 focus-visible:ring-ring" onClick={event => onOpen(event.currentTarget)}>View request</button> : null}
      </div>
      <div className="min-w-0 flex-1">
        <button type="button" data-network-person={person.publicPersonRef} aria-label={`Open ${name}'s profile`} className="flex min-h-12 w-full items-center gap-3 rounded-lg text-left focus-visible:ring-2 focus-visible:ring-ring hover:bg-muted/50" onClick={event => onOpen(event.currentTarget)}>
          <ConnectionPersonAvatar label={name} photoUrl={person.photoUrl} size="list" />
          <span className="min-w-0 flex-1 break-words font-medium [overflow-wrap:anywhere]">{name}{person.networkDegree ? <span className="ml-2 whitespace-nowrap text-xs font-normal text-muted-foreground">· {person.networkDegree === 1 ? "1st" : person.networkDegree === 2 ? "2nd" : "3rd"}</span> : null}</span>
        </button>
        <div className="pl-0 pt-1 sm:pl-[52px]"><DirectoryMutualLine person={person} networkPersonRef={person.publicPersonRef} onOpenMutual={element => void openMutual(element)} /></div>
      </div>
    </div>
    {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
    {connectionError ? <p role="alert" className="mt-2 text-sm text-destructive">{connectionError}</p> : null}
  </li>;
}
