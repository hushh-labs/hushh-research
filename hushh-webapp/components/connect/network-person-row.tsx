"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { Button } from "@/lib/morphy-ux/button";
import { CONNECT_ROW_ACTION_CLASSNAME, CONNECT_ROW_ACTION_PILL_CLASSNAME } from "./connect-row-action";
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
  const trailingClassName = cn(
    "col-span-full justify-self-end min-[300px]:col-span-1 min-[300px]:col-start-2 min-[300px]:row-start-1",
    (person.mutualConnectionCount ?? 0) > 0 && "sm:row-span-2",
  );
  return <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 px-3 py-2 sm:gap-x-4 sm:px-4">
    <button
      type="button"
      data-network-person={person.publicPersonRef}
      aria-label={`Open ${name}'s profile`}
      className="group/network-person col-span-full row-start-1 grid min-h-11 min-w-0 grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-x-2.5 rounded-lg py-1 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:opacity-80 min-[300px]:col-span-1 sm:grid-cols-[2.5rem_minmax(0,1fr)] sm:gap-x-3"
      onClick={event => onOpen(event.currentTarget)}
    >
      <ConnectionPersonAvatar label={name} photoUrl={person.photoUrl} size="list" className="!size-9 sm:!size-10" />
      <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span data-connect-role="name" dir="auto" className="min-w-0 text-sm leading-snug font-medium underline-offset-4 group-hover/network-person:underline [overflow-wrap:anywhere] sm:text-base">{name}</span>
        {person.networkDegree ? (
          <span data-connect-role="description" className="rounded-full bg-muted px-1.5 py-0.5 text-xs leading-none text-muted-foreground">
            {person.networkDegree === 1 ? "1st" : person.networkDegree === 2 ? "2nd" : "3rd"}
          </span>
        ) : null}
      </span>
    </button>
    <DirectoryMutualLine
      person={person}
      networkPersonRef={person.publicPersonRef}
      className="ui-text-row-description col-span-full row-start-2 ms-[2.875rem] min-h-11 justify-self-start text-xs leading-snug text-muted-foreground sm:col-span-1 sm:ms-[3.25rem]"
      onOpenMutual={element => void openMutual(element)}
    />
    {status === "none" ? <Button variant="none" effect="fade" size="compact" type="button" data-network-person={person.publicPersonRef} data-network-focus="connect" aria-label={`Connect with ${name}`} disabled={busy || connecting} data-connect-role="action" className={cn(CONNECT_ROW_ACTION_CLASSNAME, trailingClassName)} onClick={onConnect}><span data-slot="connect-row-action-pill" className={CONNECT_ROW_ACTION_PILL_CLASSNAME}>{connecting ? "Sending…" : "Connect"}</span></Button>
      : status === "pending_incoming" ? <Button variant="none" effect="fade" size="compact" type="button" data-network-person={person.publicPersonRef} data-network-focus="request" data-connect-role="action" className={cn(CONNECT_ROW_ACTION_CLASSNAME, trailingClassName)} onClick={event => onOpen(event.currentTarget)}><span data-slot="connect-row-action-pill" className={CONNECT_ROW_ACTION_PILL_CLASSNAME}>View request</span></Button>
      : status === "connected" || status === "pending_outgoing" ? <span data-connect-role="description" className={cn("w-20 text-end text-xs leading-snug text-muted-foreground sm:w-24", trailingClassName)}>{status === "connected" ? "Connected" : "Request sent"}</span> : null}
    {error ? <p data-connect-role="description" role="alert" className="col-span-full text-sm text-destructive">{error}</p> : null}
    {connectionError ? <p data-connect-role="description" role="alert" className="col-span-full text-sm text-destructive">{connectionError}</p> : null}
  </li>;
}
