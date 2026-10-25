"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { ApiService } from "@/lib/services/api-service";
import { ROUTES } from "@/lib/navigation/routes";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { Button } from "@/lib/morphy-ux/morphy";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription } from "@/components/ui/alert-dialog";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { AccountCloudCleanup } from "./account-cloud-cleanup";

type Provider = "gcp" | "azure";

/** Inspect only the caller's recorded cloud. Opening a menu never starts cleanup. */
function useRemovalProvider(menuOpen: boolean | undefined, provider?: Provider) {
  const { userId: ownerId } = useAuth();
  const [observed, setObserved] = useState<{ provider: Provider; current: () => boolean } | null>(null);
  useEffect(() => {
    if ((!menuOpen && !provider) || !ownerId) return;
    const owner = snapshotValidatedAuthSessionOwner();
    const abort = new AbortController();
    const current = () => !abort.signal.aborted && !!owner && owner.userId === ownerId && isValidatedAuthSessionOwnerCurrent(owner);
    void ApiService.getPersonalAgentCloudRemovalAvailability({ signal: abort.signal }).then((status) => {
      if (!current()) return;
      const found = status.available && (!provider || status.provider === provider) ? status.provider : null;
      setObserved(found ? { provider: found, current } : null);
    }).catch(() => { /* Hosting retains its explicit check/recovery action. */ });
    return () => abort.abort();
  }, [menuOpen, provider, ownerId]);
  return observed?.current() ? observed.provider : null;
}

export function useCloudRemovalControl({ menuOpen, provider }: { menuOpen?: boolean; provider?: Provider }) {
  const router = useRouter();
  const { user, userId: ownerId } = useAuth();
  const { vaultOwnerToken } = useVault();
  const available = useRemovalProvider(menuOpen, provider);
  const [selected, setSelected] = useState<Provider | null>(null);
  const [unlock, setUnlock] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); setUnlock(false); setSelected(null); }, [ownerId]);
  if (!user || !ownerId) return { action: null, dialogs: null };
  const begin = () => { if (available) { setSelected(available); setOpen(true); } };
  const action = available ? menuOpen !== undefined
      ? <DropdownMenuItem variant="destructive" onSelect={begin}>Remove cloud</DropdownMenuItem>
      : <Button variant="muted" onClick={begin}>Remove cloud</Button> : null;
  const dialogs = <>
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove cloud, keep account?</AlertDialogTitle>
          <AlertDialogDescription>Review your private agent’s resources before removing them.</AlertDialogDescription>
        </AlertDialogHeader>
        {open && selected ? <AccountCloudCleanup key={`${ownerId}:${selected}`} userId={ownerId} token={vaultOwnerToken ?? null}
          purpose="remove_cloud" provider={selected}
          onUnlock={() => { setOpen(false); setUnlock(true); }}
          onCancel={() => { setOpen(false); dispatchFeedStateChanged(); router.refresh(); }}
          onFinish={async () => { setOpen(false); dispatchFeedStateChanged(); router.push(ROUTES.ONE_SETUP_CLOUD); router.refresh(); }} /> : null}
        <AlertDialogFooter><AlertDialogCancel>Close</AlertDialogCancel></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {unlock ? <VaultUnlockDialog user={user} open={unlock} onOpenChange={setUnlock} title="Unlock to review cloud removal"
      description="Your account stays. Review and approve the cloud resources separately."
      onSuccess={() => { setUnlock(false); setOpen(true); }} /> : null}
  </>;
  return { action, dialogs };
}

export function CloudRemovalControl({ provider }: { provider: Provider }) {
  const { action, dialogs } = useCloudRemovalControl({ provider });
  return <>{action}{dialogs}</>;
}
