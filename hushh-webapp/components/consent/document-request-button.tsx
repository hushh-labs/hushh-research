"use client";
import { useState, type ReactNode, type RefObject } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import type { PersonConnectorAvailability } from "@/lib/connections/use-person-connector-features";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { Button } from "@/lib/morphy-ux/button";
import { UnlockedRequestButton, type RequestDraft } from "./unlocked-document-request-button";

/**
 * Two ways to ask a connection about their Drive. A question gets an answer
 * with file titles and needs no Google account. A file request gets the
 * original Drive links after they approve the exact files. Sending either
 * creates a pending request only. Drafts and retry keys never leave memory.
 */
export function DocumentRequestButton({
  personRef,
  personName,
  draft,
  renderTrigger,
  canRequest = true,
  availability,
  onAvailabilityRetry,
  showTrigger = true,
  returnFocusRef,
}: {
  personRef: string;
  personName: string;
  draft?: RequestDraft;
  renderTrigger?: (label: string) => ReactNode;
  canRequest?: boolean;
  availability?: PersonConnectorAvailability;
  onAvailabilityRetry?: () => unknown;
  showTrigger?: boolean;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const { user, userId } = useAuth();
  const { isVaultUnlocked, getVaultOwnerToken, vaultOwnerToken } = useVault();
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [intent, setIntent] = useState<"files" | "query" | null>(null);
  if (!user || !userId) return null;
  if (!isVaultUnlocked) return draft ? null : <>
    {showTrigger && (["files", "query"] as const).map((action) => <Button data-consent-role="compact-action" key={action} size="standard" variant="none" onClick={() => { setIntent(action); setUnlockOpen(true); }}>
      {renderTrigger?.(action === "files" ? "Request files" : "Ask about files") ?? (action === "files" ? "Request files" : "Ask about files")}
    </Button>)}
    <VaultUnlockDialog user={user} open={unlockOpen} onOpenChange={setUnlockOpen} onSuccess={() => setUnlockOpen(false)} title="Unlock to request" description="Unlock your vault to continue this request." presentationClassName="consent-presentation-surface" />
  </>;
  return (
    <UnlockedRequestButton
      key={`${userId}:${personRef}:${draft?.clientRequestId ?? "manual"}`}
      userId={userId}
      personRef={personRef}
      personName={personName}
      draft={draft}
      renderTrigger={renderTrigger}
      getToken={getVaultOwnerToken}
      credentialReady={Boolean(vaultOwnerToken || getVaultOwnerToken())}
      canRequest={canRequest}
      availability={availability}
      onAvailabilityRetry={onAvailabilityRetry}
      initialAction={intent}
      showTrigger={showTrigger}
      returnFocusRef={returnFocusRef}
    />
  );
}
