"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { IdentityDocumentsFilingCard } from "@/components/secrets/identity-documents-filing-card";
import { SECRET_KIND_LABELS, SecretItemsPanel, type SecretPanelItem } from "@/components/secrets/secret-items-panel";
import { useSecretReveal } from "@/components/secrets/use-secret-reveal";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { SECRET_OFFER_ROUTES, stageSecretOffer } from "@/lib/pkm/secret-offer-handoff";
import { secretOfferFor } from "@/lib/pkm/secret-span-guard";
import { SecretsVaultService, type SecretItemSummary } from "@/lib/pkm/secrets-vault-service";

const FILED_LABELS = { wallet: "Filed in Wallet", kyc_identity_documents: "Filed in Identity documents" } as const;

function panelItem(item: SecretItemSummary): SecretPanelItem {
  return {
    id: item.id,
    label: item.label,
    kindLabel: SECRET_KIND_LABELS[item.kind] ?? "Secret",
    offer: secretOfferFor(item),
    filedLabel: item.filedTo ? FILED_LABELS[item.filedTo] : null,
  };
}

/**
 * The owner's Secrets on Profile: every kept key, password, token, card or ID
 * number by label, revealed on this device only after unlock. Shown only while
 * the vault is unlocked and only when something is kept.
 */
export function SecretsListGroup({ onUnlock }: { onUnlock: () => void }) {
  const router = useRouter();
  const { locked, revealed, busyId, reveal, hide, vaultContext } = useSecretReveal();
  const [items, setItems] = useState<SecretItemSummary[]>([]);
  const [removeTarget, setRemoveTarget] = useState<SecretPanelItem | null>(null);
  // Remounts the filing card so it reads an offer staged on this screen.
  const [filingKey, setFilingKey] = useState(0);
  const { userId, vaultKey, vaultOwnerToken } = vaultContext;

  const load = useCallback(async () => {
    if (!userId || !vaultKey || !vaultOwnerToken) return;
    try {
      setItems(await SecretsVaultService.listSecrets({ userId, vaultKey, vaultOwnerToken }));
    } catch {
      setItems([]);
    }
  }, [userId, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    void load();
  }, [load]);

  if (locked || items.length === 0) return null;

  return (
    <>
      <IdentityDocumentsFilingCard key={filingKey} onFiled={() => void load()} />
      <SecretItemsPanel
        testId="profile-secrets-list"
        title="Secrets"
        description="Keys, passwords and ID numbers you sent One. One knows them only by name; values open only here."
        items={items.map(panelItem)}
        revealed={revealed}
        locked={locked}
        busyId={busyId}
        onReveal={(id) => void reveal(id)}
        onHide={hide}
        onUnlock={onUnlock}
        onOffer={(item) => {
          if (!item.offer) return;
          stageSecretOffer({ ownerUserId: userId, secretId: item.id, fileTo: item.offer.fileTo });
          // Identity documents are filed right here, on the Profile Secrets list.
          if (item.offer.fileTo === "kyc_identity_documents") {
            setFilingKey((key) => key + 1);
            return;
          }
          router.push(SECRET_OFFER_ROUTES[item.offer.fileTo]);
        }}
        onRemove={setRemoveTarget}
      />
      <AlertDialog open={Boolean(removeTarget)} onOpenChange={(open) => (open ? undefined : setRemoveTarget(null))}>
        <AlertDialogContent data-testid="secret-remove-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.label}?</AlertDialogTitle>
            <AlertDialogDescription>It is deleted from your vault. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = removeTarget;
                setRemoveTarget(null);
                if (!target || !vaultKey || !vaultOwnerToken) return;
                void SecretsVaultService.removeSecret({ userId, vaultKey, vaultOwnerToken, secretId: target.id }).then(load);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
