"use client";

import { useEffect, useRef, useState } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CredentialsVaultService, sealTransientCredentialUse } from "@/lib/pkm/credentials-vault-service";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { useVault } from "@/lib/vault/vault-context";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { ApiService } from "@/lib/services/api-service";
import { agentRecipientFromBinding } from "@/lib/one/ai-selection-recipient";
import type { ComputerUseSnapshot } from "@/lib/computer-use/contracts";
import type { ComputerUseTaskController } from "@/lib/computer-use/task-controller";

/** Owner-only picker. Vault-only secrets are sealed transiently inside the existing vault helper. */
export function ComputerUseCredentials({ controller, snapshot, route, pending }: {
  controller: ComputerUseTaskController; snapshot: ComputerUseSnapshot; route: string; pending: boolean;
}) {
  const { vaultKey, vaultOwnerToken } = useVault();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<readonly { id: string; label: string; hint: string; transient: boolean }[]>([]);
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);
  const chooserOwner = useRef<ReturnType<typeof snapshotValidatedAuthSessionOwner>>(null);
  const chooserRequest = useRef<{ operationId: string; epoch: number; origin: string } | null>(null);
  const close = () => { request.current?.abort(); setRows([]); setOpen(false); setLoading(false); };
  useBackLayer(route, open ? 5 : 0, () => { close(); return true; });
  useEffect(() => () => request.current?.abort(), [controller]);

  async function choose(): Promise<void> {
    const owner = snapshotValidatedAuthSessionOwner();
    const selection = snapshot.credentialRequest;
    if (!selection || owner?.userId !== controller.binding.ownerId || !vaultKey || !vaultOwnerToken) {
      morphyToast.info("Unlock Website logins to choose an account, or take control to sign in privately.");
      return;
    }
    chooserOwner.current = owner;
    chooserRequest.current = { operationId: selection.operationId, epoch: snapshot.controlEpoch, origin: selection.origin };
    const abort = new AbortController();
    request.current?.abort(); request.current = abort;
    const current = async () => {
      const latest = controller.getSnapshot();
      if (abort.signal.aborted || !isValidatedAuthSessionOwnerCurrent(owner) || !latest.verified
        || latest.snapshot?.controlEpoch !== snapshot.controlEpoch
        || latest.snapshot?.credentialRequest?.operationId !== selection.operationId) throw new Error("BROWSER_OWNER_CHANGED");
    };
    setOpen(true); setLoading(true);
    try {
      const transport = controller.transport.credentials;
      if (!transport) throw new Error("BROWSER_CREDENTIALS_UNAVAILABLE");
      const [summaries, available] = await Promise.all([
        CredentialsVaultService.list({ userId: owner.userId, vaultKey, vaultOwnerToken, beforeEffect: current }),
        transport(controller.binding, selection.origin, abort.signal),
      ]);
      await current();
      const admitted = new Set(available.map(item => item.handle));
      setRows(summaries.filter(item => (admitted.has(item.id) || item.autonomyPolicy === "vault_only") && item.boundOrigins.includes(selection.origin))
        .map(item => ({ id: item.id, label: item.label, hint: item.usernameHint, transient: item.autonomyPolicy === "vault_only" })));
    } catch {
      if (!abort.signal.aborted) { close(); morphyToast.error("Couldn’t load saved logins. Take control to sign in privately."); }
    } finally { if (request.current === abort) setLoading(false); }
  }

  function use(id: string, transient: boolean): void {
    const owner = chooserOwner.current;
    const chosen = chooserRequest.current;
    close();
    const operation = (async () => {
      const selection = snapshot.credentialRequest;
      if (!owner || owner.userId !== controller.binding.ownerId || !vaultKey || !vaultOwnerToken || !selection
        || chosen?.operationId !== selection.operationId || chosen.epoch !== snapshot.controlEpoch || chosen.origin !== selection.origin) throw new Error("BROWSER_OWNER_CHANGED");
      const current = async () => {
        const latest = controller.getSnapshot();
        if (!isValidatedAuthSessionOwnerCurrent(owner) || !latest.verified || latest.snapshot?.controlEpoch !== snapshot.controlEpoch
          || latest.snapshot?.credentialRequest?.operationId !== selection.operationId) throw new Error("BROWSER_CREDENTIAL_SELECTION_CHANGED");
      };
      await current();
      if (!transient) return controller.useCredential(id);
      if (!snapshot.authorizationExpiresAt || snapshot.authorizationExpiresAt <= Date.now() / 1000) throw new Error("BROWSER_AUTHORIZATION_EXPIRED");
      const context = await ApiService.ownerCredentialSealContext(owner.userId);
      const recipient = await agentRecipientFromBinding(context, { requiredScope: "browser.control", ownerCloudOnly: false });
      await current();
      const payload = await sealTransientCredentialUse({ userId: owner.userId, vaultKey, vaultOwnerToken, beforeEffect: current }, id,
        { ...controller.binding, taskExpiresAt: snapshot.authorizationExpiresAt, operationId: selection.operationId, controlEpoch: snapshot.controlEpoch, origin: selection.origin, recipient });
      await current();
      return controller.useTransientCredential(id, payload);
    })();
    morphyToast.promise(operation, { loading: "Preparing private sign-in…", success: "Private sign-in requested.",
      error: "Couldn’t confirm private sign-in. Check the current task before continuing." });
    void operation.catch(() => undefined);
  }

  return <>
    <ShellActionSurface variant="pill" className="min-h-11" disabled={pending || snapshot.inputPending || snapshot.credentialEntryActive || Boolean(snapshot.review)}
      onClick={() => { void choose(); }}>Use saved login</ShellActionSurface>
    <Dialog open={open} onOpenChange={next => { if (!next) close(); }} modal>
      <DialogContent><DialogHeader><DialogTitle>Choose a website login</DialogTitle>
        <DialogDescription>Only saved logins for this approved website are available. Passwords stay hidden from the AI model.</DialogDescription></DialogHeader>
        {loading ? <p role="status">Loading saved logins…</p> : rows.length ? rows.map(row =>
          <ShellActionSurface key={row.id} variant="pill" className="min-h-11" onClick={() => use(row.id, row.transient)}>
            {row.label}{row.hint ? ` · ${row.hint}` : ""}
          </ShellActionSurface>) : <p role="status">No available saved login. Take control to sign in privately.</p>}
      </DialogContent>
    </Dialog>
  </>;
}
