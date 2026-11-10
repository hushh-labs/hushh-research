"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { PERSON_ROW_FEEDBACK_CLASSNAME } from "@/components/connections/person-selection-surface";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { DirectoryMutualLine } from "@/components/connect/connect-person-row";
import { ConnectionsService, type NetworkPerson } from "@/lib/services/connections-service";
import { connectPersonName } from "@/lib/connections/person-label";
import { openPersonProfilePreview } from "@/lib/connections/person-profile-preview";
import { getAuthSessionGeneration } from "@/lib/auth/session-owner";

const rowActionClassName = "inline-flex min-h-11 min-w-20 items-center justify-center whitespace-nowrap rounded-full border border-primary/40 px-2.5 text-sm font-medium text-primary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:min-w-24 [@media(hover:hover)]:hover:bg-primary/5";

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
  return <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-2.5 py-1.5 sm:gap-x-3 sm:px-3">
    <div className="min-w-0">
      <button type="button" data-network-person={person.publicPersonRef} aria-label={`Open ${name}'s profile`} className={cn("flex min-h-11 w-full items-center gap-2 rounded-lg py-1 text-left focus-visible:ring-2 focus-visible:ring-ring", PERSON_ROW_FEEDBACK_CLASSNAME)} onClick={event => onOpen(event.currentTarget)}>
        <ConnectionPersonAvatar label={name} photoUrl={person.photoUrl} size="list" className="size-9" />
        <span className="min-w-0 text-sm leading-snug font-medium [overflow-wrap:anywhere] sm:text-base">
          {name}{person.networkDegree ? <> <span className="whitespace-nowrap text-xs font-normal text-muted-foreground">· {person.networkDegree === 1 ? "1st" : person.networkDegree === 2 ? "2nd" : "3rd"}</span></> : null}
        </span>
      </button>
      <div className="pl-11">
        <DirectoryMutualLine person={person} networkPersonRef={person.publicPersonRef} className="text-xs leading-snug text-muted-foreground [@media(pointer:fine)]:min-h-7" onOpenMutual={element => void openMutual(element)} />
      </div>
    </div>
    {status === "none" ? <button type="button" data-network-person={person.publicPersonRef} data-network-focus="connect" aria-label={`Connect with ${name}`} disabled={busy || connecting} className={rowActionClassName} onClick={onConnect}>{connecting ? "Sending…" : "Connect"}</button>
      : status === "pending_incoming" ? <button type="button" data-network-person={person.publicPersonRef} data-network-focus="request" className={rowActionClassName} onClick={event => onOpen(event.currentTarget)}>View request</button>
      : status === "connected" || status === "pending_outgoing" ? <span className="whitespace-nowrap text-right text-xs text-muted-foreground">{status === "connected" ? "Connected" : "Request sent"}</span> : null}
    {error ? <p role="alert" className="col-span-full text-sm text-destructive">{error}</p> : null}
    {connectionError ? <p role="alert" className="col-span-full text-sm text-destructive">{connectionError}</p> : null}
  </li>;
}
