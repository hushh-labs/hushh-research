"use client";

import { Capacitor } from "@capacitor/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useOwnerPresentationState } from "@/hooks/use-owner-presentation-state";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CredentialsVaultService, sealTransientCredentialUse } from "@/lib/pkm/credentials-vault-service";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent, subscribeAuthSessionGeneration, getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { useVault } from "@/lib/vault/vault-context";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { ApiService } from "@/lib/services/api-service";
import { agentRecipientFromBinding } from "@/lib/one/ai-selection-recipient";
import type { ComputerUseSnapshot } from "@/lib/computer-use/contracts";
import type { ComputerUseTaskController } from "@/lib/computer-use/task-controller";

type LoginChoice = Readonly<{ id: string; label: string; hint: string; transient: boolean }>;
const EMPTY_VIEW: Readonly<{ open: boolean; rows: readonly LoginChoice[]; loading: boolean }> = { open: false, rows: [], loading: false };

/** Owner-only picker. Vault-only secrets are sealed transiently inside the existing vault helper. */
export function ComputerUseCredentials({ controller, snapshot, route, pending }: {
  controller: ComputerUseTaskController; snapshot: ComputerUseSnapshot; route: string; pending: boolean;
}) {
  const { vaultKey, getVaultKey, getVaultOwnerToken } = useVault();
  const authGeneration = useSyncExternalStore(subscribeAuthSessionGeneration, getAuthSessionGeneration, () => null);
  const owner = snapshotValidatedAuthSessionOwner();
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const privacy = useSyncExternalStore(subscribeNativePrivacyObservation, () => nativePrivacyObservation().state, () => undefined);
  const [visibility, setVisibility] = useState(0);
  const allowed = owner?.userId === controller.binding.ownerId && !!vaultKey && getVaultKey() === vaultKey && !!getVaultOwnerToken() &&
    !privacy?.shielded && privacy?.appIsActive !== false && !privacy?.presentationsRetiring &&
    (!Capacitor.isNativePlatform() || !!privacy) && typeof document !== "undefined" && document.visibilityState !== "hidden";
  const presentation = useMemo(() => ({ live: false, epoch, vaultKey, generation: privacy?.generation, controller, allowed, visibility, authGeneration }),
    [controller, epoch, vaultKey, privacy?.generation, allowed, visibility, authGeneration]);
  const latest = useRef(presentation);
  const request = useRef<AbortController | null>(null);
  const chooserOwner = useRef<ReturnType<typeof snapshotValidatedAuthSessionOwner>>(null);
  const chooserRequest = useRef<{ operationId: string; epoch: number; origin: string } | null>(null);
  const chooserPresentation = useRef(presentation);
  useLayoutEffect(() => {
    latest.current = presentation;
    presentation.live = allowed;
    return () => { presentation.live = false; request.current?.abort(); };
  }, [presentation, allowed]);
  useEffect(() => {
    const changed = () => {
      if (document.visibilityState === "hidden") { presentation.live = false; request.current?.abort(); }
      setVisibility(value => value + 1);
    };
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, [presentation]);
  const presentationCurrent = () => {
    const observation = nativePrivacyObservation().state;
    return presentation.live && latest.current === presentation && snapshotVaultSessionEpoch() === epoch &&
      !!vaultKey && getVaultKey() === vaultKey && !!getVaultOwnerToken() && document.visibilityState !== "hidden" &&
      observation?.generation === presentation.generation && !observation?.shielded && observation?.appIsActive !== false &&
      !observation?.presentationsRetiring && (!Capacitor.isNativePlatform() || !!observation);
  };
  const [view, setView] = useOwnerPresentationState(presentation, EMPTY_VIEW);
  const { open, rows, loading } = view;
  const close = () => { request.current?.abort(); setView(EMPTY_VIEW); };
  useBackLayer(route, open ? 5 : 0, () => { close(); return true; });

  async function choose(): Promise<void> {
    const owner = snapshotValidatedAuthSessionOwner();
    const selection = snapshot.credentialRequest;
    const vaultOwnerToken = getVaultOwnerToken();
    if (!selection || owner?.userId !== controller.binding.ownerId || !presentationCurrent() || !vaultKey || !vaultOwnerToken) {
      morphyToast.info("Unlock Website logins to choose an account, or take control to sign in privately.");
      return;
    }
    chooserOwner.current = owner;
    chooserPresentation.current = presentation;
    chooserRequest.current = { operationId: selection.operationId, epoch: snapshot.controlEpoch, origin: selection.origin };
    const abort = new AbortController();
    request.current?.abort(); request.current = abort;
    const current = () => {
      const latest = controller.getSnapshot();
      if (!presentationCurrent() || abort.signal.aborted || !isValidatedAuthSessionOwnerCurrent(owner) || !latest.verified
        || latest.snapshot?.controlEpoch !== snapshot.controlEpoch
        || latest.snapshot?.credentialRequest?.operationId !== selection.operationId) throw new Error("BROWSER_OWNER_CHANGED");
    };
    setView({ open: true, rows: [], loading: true });
    try {
      const transport = controller.transport.credentials;
      if (!transport) throw new Error("BROWSER_CREDENTIALS_UNAVAILABLE");
      const [summaries, available] = await Promise.all([
        CredentialsVaultService.list({ userId: owner.userId, vaultKey, vaultOwnerToken, beforeEffect: async () => current() }),
        transport(controller.binding, selection.origin, abort.signal),
      ]);
      current();
      const admitted = new Set(available.map(item => item.handle));
      const rows = summaries.filter(item => (admitted.has(item.id) || item.autonomyPolicy === "vault_only") && item.boundOrigins.includes(selection.origin))
        .map(item => ({ id: item.id, label: item.label, hint: item.usernameHint, transient: item.autonomyPolicy === "vault_only" }));
      setView({ open: true, rows, loading: false });
    } catch {
      if (presentationCurrent() && !abort.signal.aborted) { close(); morphyToast.error("Couldn’t load saved logins. Take control to sign in privately."); }
    } finally { if (request.current === abort) setView(value => ({ ...value, loading: false })); }
  }

  function use(id: string, transient: boolean): void {
    const owner = chooserOwner.current;
    const chosen = chooserRequest.current;
    close();
    const operation = (async () => {
      const selection = snapshot.credentialRequest;
      const vaultOwnerToken = getVaultOwnerToken();
      if (!presentationCurrent() || chooserPresentation.current !== presentation || !owner || owner.userId !== controller.binding.ownerId || !vaultKey || !vaultOwnerToken || !selection
        || chosen?.operationId !== selection.operationId || chosen.epoch !== snapshot.controlEpoch || chosen.origin !== selection.origin) throw new Error("BROWSER_OWNER_CHANGED");
      const current = () => {
        const latest = controller.getSnapshot();
        if (!presentationCurrent() || !isValidatedAuthSessionOwnerCurrent(owner) || !latest.verified || latest.snapshot?.controlEpoch !== snapshot.controlEpoch
          || latest.snapshot?.credentialRequest?.operationId !== selection.operationId) throw new Error("BROWSER_CREDENTIAL_SELECTION_CHANGED");
      };
      current();
      if (!transient) return controller.useCredential(id);
      if (!snapshot.authorizationExpiresAt || snapshot.authorizationExpiresAt <= Date.now() / 1000) throw new Error("BROWSER_AUTHORIZATION_EXPIRED");
      const context = await ApiService.ownerCredentialSealContext(owner.userId, () => { try { current(); return true; } catch { return false; } });
      const recipient = await agentRecipientFromBinding(context, { requiredScope: "browser.control", ownerCloudOnly: false });
      current();
      const payload = await sealTransientCredentialUse({ userId: owner.userId, vaultKey, vaultOwnerToken, beforeEffect: async () => current() }, id,
        { ...controller.binding, taskExpiresAt: snapshot.authorizationExpiresAt, operationId: selection.operationId, controlEpoch: snapshot.controlEpoch, origin: selection.origin, recipient });
      current();
      return controller.useTransientCredential(id, payload);
    })();
    morphyToast.promise(operation, { loading: "Preparing private sign-in…", success: "Private sign-in requested.",
      error: "Couldn’t confirm private sign-in. Check the current task before continuing." });
    void operation.catch(() => undefined);
  }

  return <>
    <ShellActionSurface variant="pill" className="min-h-11" disabled={!allowed || pending || snapshot.inputPending || snapshot.credentialEntryActive || Boolean(snapshot.review)}
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
