"use client";

import { useRouter } from "next/navigation";
import { IdentityDocumentsFilingCard } from "./identity-documents-filing-card";
import { SecretItemsPanel } from "./secret-items-panel";
import { useSecretsListModel, type SecretsListModel } from "./use-secrets-list-model";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { SECRET_OFFER_ROUTES } from "@/lib/pkm/secret-offer-handoff";

/** The Profile owner retains one feature model above renderer admission. */
export function SecretsListGroup({ onUnlock, model }: { onUnlock: () => void; model?: SecretsListModel }) {
  return model ? <SecretsListBody onUnlock={onUnlock} model={model} /> : <OwnedSecretsList onUnlock={onUnlock} />;
}
function OwnedSecretsList({ onUnlock }: { onUnlock: () => void }) {
  const model = useSecretsListModel({ active: true, native: false, current: () => true });
  return <SecretsListBody onUnlock={onUnlock} model={model} />;
}
function SecretsListBody({ onUnlock, model }: { onUnlock: () => void; model: SecretsListModel }) {
  const router = useRouter();
  if (model.locked) return null;
  if (!model.items.length) return model.failed ? <Button variant="ghost" onClick={() => void model.refresh()}>Reload Secrets</Button> : null;
  return <>
    <IdentityDocumentsFilingCard model={model} />
    <SecretItemsPanel testId="profile-secrets-list" title="Secrets"
      description="Keys, passwords and ID numbers you sent One. One knows them only by name; values open only here."
      items={model.panelItems} revealed={model.revealed} locked={model.locked} busyId={model.busyId}
      onReveal={id => void model.reveal(id)} onHide={model.hide} onUnlock={onUnlock}
      onOffer={item => { const target = model.offer(item.id); if (target && target !== "kyc_identity_documents") router.push(SECRET_OFFER_ROUTES[target]); }}
      onRemove={item => model.askRemove(item.id)} />
    <AlertDialog open={!!model.target} onOpenChange={open => { if (!open && !model.pending) model.askRemove(null); }}>
      <AlertDialogContent data-testid="secret-remove-confirm">
        <AlertDialogHeader><AlertDialogTitle>Remove {model.target?.label}?</AlertDialogTitle>
          <AlertDialogDescription>It is deleted from your vault. This cannot be undone.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel disabled={model.pending}>Keep</AlertDialogCancel>
          <AlertDialogAction disabled={model.pending || model.uncertain} onClick={event => { event.preventDefault(); void model.remove(); }}>Remove</AlertDialogAction>
        </AlertDialogFooter>
        {model.outcome ? <p role="status" className="text-sm text-muted-foreground">{model.outcome}</p> : null}
        {model.uncertain ? <Button variant="ghost" onClick={() => void model.refresh()}>Refresh</Button> : null}
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
