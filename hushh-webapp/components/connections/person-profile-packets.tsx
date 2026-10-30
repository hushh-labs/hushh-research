"use client";

import { DrivePacketCatalog } from "@/components/consent/drive-packet-catalog";
import { FinancialPacketSummaries } from "@/components/consent/packets/financial-packet-summaries";
import type { PersonRelationship } from "@/lib/services/person-profile-service";

type Options = {
  signedIn: boolean; personRef: string; ownerName: string; relationship?: PersonRelationship["status"];
  privateCatalog: boolean; connecting: boolean; onConnect: () => Promise<unknown>; onUnlock: () => void;
};
/** One packet attachment owner for person routes and their native Profile panes. */
export function usePersonProfilePackets(options: Options) {
  return { content: <>
    {options.signedIn && <FinancialPacketSummaries personRef={options.personRef} ownerName={options.ownerName}
      refreshKey={options.relationship} connecting={options.connecting} onConnect={options.onConnect} onUnlock={options.onUnlock} />}
    {options.privateCatalog && <DrivePacketCatalog ownerPersonRef={options.personRef} ownerName={options.ownerName} customPacketsOnly />}
  </> };
}
