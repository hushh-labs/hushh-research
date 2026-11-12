"use client";

import { useRef, useState } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";

import { SpinnerGapIcon as Loader2 } from "@/components/icons";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { PkmDomainSharing } from "@/components/profile/pkm-domain-sharing";
import { buildPkmShareBundles } from "@/lib/profile/pkm-memory-tree";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";

type Props = {
  userId: string;
  active: boolean;
  /** Optional parent-owned accordion state, retained across renderer handoffs. */
  owner?: PkmSharingExpansion;
  domains: ReadonlyArray<{ key: string; displayName: string }>;
  sharingManifests: Record<string, DomainManifest | null>;
  sharingManifestsLoading: boolean;
  retrySharing: () => void;
  sharingActionKey: string | null;
  isVaultUnlocked: boolean;
  exportBusy: boolean;
  exportStatus: string | null;
  exportError: string | null;
  handleExportMemory: () => Promise<void>;
  updateSharingBundles: (params: { domain: string; manifest: DomainManifest; scopeHandles: string[]; enabled: boolean }) => Promise<void>;
};

export type PkmSharingExpansion = { section: string; setSection: (value: string) => void };

/** The expansion state and its Back layer have one owner per Memory visit. */
export function usePkmSharingExpansion(userId: string, active: boolean, session: string | symbol = userId): PkmSharingExpansion {
  const currentOwner = useRef({ userId, session, token: Symbol("memory-sharing") });
  if (currentOwner.current.userId !== userId || currentOwner.current.session !== session) {
    currentOwner.current = { userId, session, token: Symbol("memory-sharing") };
  }
  const token = currentOwner.current.token;
  const [expanded, setExpanded] = useState({ token, value: "" });
  const section = expanded.token === token ? expanded.value : "";
  const setSection = (value: string) => {
    if (currentOwner.current.token === token) setExpanded({ token, value });
  };
  useBackLayer(ROUTES.PKM, active && section ? 1 : 0, () => {
    setSection("");
    return true;
  });
  return { section, setSection };
}

/** Saved section controls reuse the existing exact-scope owner mutations. */
export function PkmSavedSharing(props: Props) {
  return props.owner ? <PkmSavedSharingBody {...props} owner={props.owner} /> : <LocalPkmSavedSharing {...props} />;
}

function LocalPkmSavedSharing(props: Props) {
  const owner = usePkmSharingExpansion(props.userId, props.active);
  return <PkmSavedSharingBody {...props} owner={owner} />;
}

function PkmSavedSharingBody({ userId, active, domains, sharingManifests, sharingManifestsLoading, retrySharing, sharingActionKey, isVaultUnlocked, exportBusy, exportStatus, exportError, handleExportMemory, updateSharingBundles, owner }: Props & { owner: PkmSharingExpansion }) {
  const { section, setSection } = owner;
  const sharingUnavailable = domains.some(domain => !sharingManifests[domain.key]);
  return (
          <div className="space-y-4 pb-1 pr-px" data-pkm-memory-sharing="true">
            {sharingManifestsLoading ? (
              <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Checking sharing settings…
              </p>
            ) : null}

            <SettingsGroup separatorInset testId="memory-export-group">
              <SettingsRow
                title={exportBusy ? "Preparing…" : "Download Memory"}
                description={isVaultUnlocked
                  ? "Readable file. Keep it private."
                  : "Unlock to download."}
                onClick={() => void handleExportMemory()}
                disabled={!isVaultUnlocked || exportBusy}
                trailing={exportBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : undefined}
                ariaLabel="Download Memory"
                testId="memory-export-button"
              />
            </SettingsGroup>

            {exportStatus ? (
              <p className="px-1 text-sm text-muted-foreground" role="status">
                {exportStatus}
              </p>
            ) : null}
            {exportError ? (
              <p className="px-1 text-sm text-[color:var(--app-destructive)]" role="alert">
                {exportError}
              </p>
            ) : null}

            <Accordion type="single" collapsible value={section} onValueChange={setSection}>
              <AccordionItem value="sharing"><AccordionTrigger data-pkm-section-heading="true">Sharing settings</AccordionTrigger><AccordionContent className="space-y-4">
                <p data-pkm-body="true" className="text-sm text-muted-foreground">Choose which sections people can request and set their price. Every requester needs your approval.</p>
            {!sharingManifestsLoading && active ? domains.map(domain => {
              const manifest = sharingManifests[domain.key];
              return manifest ? <PkmDomainSharing key={`${userId}:${domain.key}`} userId={userId}
                title={domain.displayName} heading={domain.displayName} manifest={manifest}
                pendingKey={sharingActionKey} onChange={updateSharingBundles} /> : null;
            }) : null}

              </AccordionContent></AccordionItem>
            </Accordion>
            {!sharingManifestsLoading && sharingUnavailable ? (
              <div className="px-1 text-sm text-muted-foreground" role="status">
                <p>Some sharing settings could not be checked. Try again before changing access.</p>
                <button type="button" data-pkm-utility="true" className="min-h-11 underline" onClick={retrySharing}>Retry sharing settings</button>
              </div>
            ) : null}

            {!sharingManifestsLoading && !sharingUnavailable &&
            domains.length > 0 &&
            Object.values(sharingManifests).every(
              (manifest) => buildPkmShareBundles(manifest).length === 0,
            ) ? (
              <p className="px-1 text-sm text-muted-foreground">Nothing to share yet.</p>
            ) : null}
          </div>
  );
}
