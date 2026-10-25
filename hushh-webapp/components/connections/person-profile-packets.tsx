"use client";

import { Button } from "@/lib/morphy-ux/button";
import styles from "./person-profile-page.module.css";
import { useRef } from "react";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { DrivePacketCatalog } from "@/components/consent/drive-packet-catalog";
import { FinancialPacketSummaries } from "@/components/consent/packets/financial-packet-summaries";
import type { PersonRelationship } from "@/lib/services/person-profile-service";

type Options = {
  signedIn: boolean; personRef: string; ownerName: string; relationship?: PersonRelationship["status"];
  privateCatalog: boolean; connecting: boolean; onConnect: () => Promise<unknown>; onUnlock: () => void;
};
/** One packet attachment and navigation owner for person routes and their native Profile panes. */
export function usePersonProfilePackets(options: Options) {
  const section = useRef<HTMLDivElement | null>(null), privateSection = useRef<HTMLDivElement | null>(null);
  const browse = () => {
    if (!options.signedIn || !section.current) return false;
    section.current.scrollIntoView({ block: "start", behavior: "auto" });
    return true;
  };
  useLocalOnboardingActionHandler("people.profile.browse_financial_summaries", async () => browse()
    ? { status: "succeeded", summary: "Showing available document packets." }
    : { status: "blocked", summary: "Sign in to view published packet summaries." }, { enabled: options.signedIn });
  const browsePrivate = () => {
    if (!options.privateCatalog || !privateSection.current) return false;
    privateSection.current.scrollIntoView({ block: "start", behavior: "auto" });
    return true;
  };
  useLocalOnboardingActionHandler("people.profile.browse_packets", async () => browsePrivate()
    ? { status: "succeeded", summary: "Showing available document packets." }
    : { status: "blocked", summary: "Connect with this person and unlock to view available packets." }, { enabled: options.privateCatalog });
  return { browse, privateTrigger: options.privateCatalog ? <Button type="button" size="compact" variant="none" effect="fade" className={styles.packets}
    data-voice-control-id="person-profile-browse-packets" onClick={browsePrivate}>Available packets</Button> : null, content: <>
    {options.signedIn && <div ref={section}><FinancialPacketSummaries personRef={options.personRef} ownerName={options.ownerName}
      refreshKey={options.relationship} connecting={options.connecting} onConnect={options.onConnect} onUnlock={options.onUnlock} /></div>}
    {options.privateCatalog && <div ref={privateSection}><DrivePacketCatalog ownerPersonRef={options.personRef} ownerName={options.ownerName} /></div>}
  </> };
}
