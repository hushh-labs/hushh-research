"use client";

import dynamic from "next/dynamic";

import { useAuth } from "@/hooks/use-auth";
import type { OwnerConsentUnlockPrompt } from "@/lib/consent/use-owner-consent-decision";

// Loaded on first use. The unlock flow is the whole vault ceremony; the Feed
// and chat should not carry it until someone taps Allow on a locked vault.
const VaultUnlockDialog = dynamic(
  () =>
    import("@/components/vault/vault-unlock-dialog").then(
      (module) => module.VaultUnlockDialog,
    ),
  { ssr: false },
);

/**
 * The unlock step of an inline Allow or Don't allow.
 *
 * Rendered by whichever surface owns the decision (the Feed, the chat card).
 * Unlocking lets the waiting decision run; closing it drops the decision and
 * nothing is sent.
 */
export function OwnerConsentUnlockPrompt({
  prompt,
}: {
  prompt: OwnerConsentUnlockPrompt;
}) {
  const { user } = useAuth();
  if (!user || !prompt.open) return null;
  return (
    <VaultUnlockDialog
      user={user}
      open={prompt.open}
      onOpenChange={(open) => {
        if (!open) prompt.cancel();
      }}
      // The decision runs from the hook once the key is present; there is
      // nothing else to do here.
      onSuccess={() => undefined}
      title={prompt.title}
      description={prompt.description}
      allowVaultCreation={false}
    />
  );
}
