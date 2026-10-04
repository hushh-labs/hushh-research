"use client";

import { useEffect, useState } from "react";

import { KycAgentIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/use-auth";
import { clearSecretOffer, peekSecretOffer } from "@/lib/pkm/secret-offer-handoff";
import { SecretsVaultService, type SecretItemSummary } from "@/lib/pkm/secrets-vault-service";
import { identityDocumentTypeFor, KycIdentityDocumentsService } from "@/lib/services/kyc-identity-documents-service";
import { useVault } from "@/lib/vault/vault-context";

const SURFACE =
  "rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4 text-foreground";

/**
 * The KYC end of "Add passport to Identity documents", on the Profile Secrets
 * list. Shown only when the owner chose that offer on a Secrets card in this
 * session. The number is
 * decrypted from the vault at the moment of the owner's tap and written by the
 * KYC feature writer; One never sees it, only its label.
 */
export function IdentityDocumentsFilingCard({ onFiled }: { onFiled?: () => void } = {}) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken, getVaultOwnerToken } = useVault();
  const [item, setItem] = useState<SecretItemSummary | null>(null);
  const [state, setState] = useState<"idle" | "filing" | "filed" | "failed">("idle");

  useEffect(() => {
    const offer = peekSecretOffer({ ownerUserId: user?.uid, fileTo: "kyc_identity_documents" });
    if (!offer || !user?.uid || !vaultKey || !vaultOwnerToken) return;
    let active = true;
    void SecretsVaultService.listSecrets({ userId: user.uid, vaultKey, vaultOwnerToken })
      .then((items) => {
        if (active) setItem(items.find((candidate) => candidate.id === offer.secretId) ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [user?.uid, vaultKey, vaultOwnerToken]);

  if (!item || !user?.uid) return null;
  const noun = item.offerNoun ?? "ID number";

  const file = async () => {
    const token = getVaultOwnerToken();
    setState("filing");
    try {
      const number = await SecretsVaultService.revealSecret({ userId: user.uid, vaultKey, vaultOwnerToken: token, secretId: item.id });
      if (!number) throw new Error("secret_missing");
      const result = await KycIdentityDocumentsService.fileDocument({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken: token,
        documentType: identityDocumentTypeFor(item.patternId),
        number,
        label: item.label,
      });
      if (!result.success) throw new Error("file_failed");
      await SecretsVaultService.markFiled({ userId: user.uid, vaultKey, vaultOwnerToken: token, secretId: item.id, filedTo: "kyc_identity_documents" }).catch(() => undefined);
      clearSecretOffer();
      setState("filed");
      onFiled?.();
    } catch {
      setState("failed");
    }
  };

  return (
    <section aria-label="Identity documents" className={`${SURFACE} motion-step-enter flex flex-col gap-3`} data-testid="identity-documents-filing">
      <header className="flex h-6 items-center gap-2">
        <KycAgentIcon size={20} aria-hidden="true" className="shrink-0" />
        <p className="text-sm font-semibold leading-6" role="status">
          {state === "filed" ? "Filed in Identity documents" : `Add ${noun} to Identity documents`}
        </p>
      </header>
      <p className="text-xs leading-4 text-foreground/70">
        {state === "filed"
          ? `${item.label} is now with your identity documents. Nothing is shared until you approve a request.`
          : `${item.label} is kept in Secrets. Filing it lets you answer KYC requests with it. Nothing is shared until you approve a request.`}
      </p>
      {state === "failed" ? (
        <p className="text-xs leading-4 text-destructive" role="alert">
          That didn&apos;t file. Nothing changed. Try again.
        </p>
      ) : null}
      {state !== "filed" ? (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button size="standard" onClick={() => void file()} isLoading={state === "filing"} disabled={state === "filing"} data-testid="identity-documents-file">
            File {noun}
          </Button>
          <Button
            variant="secondary"
            size="standard"
            onClick={() => {
              clearSecretOffer();
              setItem(null);
            }}
          >
            Not now
          </Button>
        </div>
      ) : null}
    </section>
  );
}
