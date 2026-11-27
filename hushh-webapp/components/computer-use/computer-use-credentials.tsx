"use client";

import { Capacitor } from "@capacitor/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useOwnerPresentationState } from "@/hooks/use-owner-presentation-state";
import { nativePrivacyObservation, subscribeNativePrivacyObservation } from "@/lib/capacitor/session-privacy";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SecretsVaultService } from "@/lib/pkm/secrets-vault-service";
import { assertBrowserCredentialFillEligible, sealTransientCredentialUse, type BrowserLoginSelection } from "@/lib/pkm/website-credential-lease";
import { WebsiteCredentialError, type WebsiteLoginSummary } from "@/lib/pkm/website-credential";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent, subscribeAuthSessionGeneration, getAuthSessionGeneration } from "@/lib/auth/session-owner";
import { useVault } from "@/lib/vault/vault-context";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import type { ComputerUseSnapshot } from "@/lib/computer-use/contracts";
import type { ComputerUseTaskController } from "@/lib/computer-use/task-controller";

type LoginChoice = WebsiteLoginSummary;
type Prepared = { item: WebsiteLoginSummary; selection: BrowserLoginSelection; reviewId: string; operationId: string; epoch: number; leaseKeyId: string };
const EMPTY_VIEW: Readonly<{ open: boolean; rows: readonly LoginChoice[]; loading: boolean }> = { open: false, rows: [], loading: false };

/** Fixed host security chrome. Only Allow can approve and dispatch a one-use lease. */
export function ComputerUseCredentials({ controller, snapshot, route, pending, onTypeMyself }: {
  controller: ComputerUseTaskController; snapshot: ComputerUseSnapshot; route: string; pending: boolean; onTypeMyself: () => void;
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
  const [prepared, setPrepared] = useOwnerPresentationState<Prepared | null>(presentation, null);
  const [dispatching, setDispatching] = useOwnerPresentationState(presentation, false);
  const close = () => { request.current?.abort(); setView(EMPTY_VIEW); };
  useBackLayer(route, open ? 5 : 0, () => { close(); return true; });

  const selection = snapshot.credentialRequest;
  const assertCurrent = () => {
    const latest = controller.getSnapshot();
    if (!presentationCurrent() || !owner || !isValidatedAuthSessionOwnerCurrent(owner) || !latest.verified ||
      !selection || latest.snapshot?.controlEpoch !== snapshot.controlEpoch ||
      latest.snapshot?.credentialRequest?.operationId !== selection.operationId ||
      latest.snapshot.credentialRequest.leaseKey.id !== selection.leaseKey.id ||
      latest.snapshot.credentialRequest.origin !== selection.origin || latest.snapshot.controlOwner !== "agent") throw new Error("BROWSER_CREDENTIAL_SELECTION_CHANGED");
  };
  const context = () => {
    assertCurrent();
    return { userId: owner!.userId, vaultKey, vaultOwnerToken: getVaultOwnerToken(), beforeEffect: async () => assertCurrent() };
  };
  async function choose(): Promise<void> {
    if (!selection || !allowed || pending || dispatching) return;
    const abort = new AbortController();
    request.current?.abort(); request.current = abort;
    setView({ open: true, rows: [], loading: true });
    try {
      const summaries = await SecretsVaultService.listWebsiteLogins(context());
      assertCurrent();
      if (!abort.signal.aborted) setView({ open: true, rows: summaries.filter(item => item.boundOrigins.includes(selection.origin)), loading: false });
    } catch {
      if (presentationCurrent() && !abort.signal.aborted) { close(); morphyToast.error("Couldn’t load saved logins. Type the sign-in yourself or try again."); }
    } finally { if (request.current === abort) setView(value => ({ ...value, loading: false })); }
  }
  async function prepare(item: WebsiteLoginSummary, rememberSession = item.staySignedInEnabled): Promise<void> {
    if (!selection || pending || dispatching) return;
    setPrepared(null); close(); setDispatching(true);
    try {
      const fresh = await SecretsVaultService.websiteLoginSnapshot(context(), item.id);
      assertCurrent();
      if (fresh.item.revision !== item.revision || fresh.item.updated_at !== item.updatedAt) throw new Error("BROWSER_CREDENTIAL_SELECTION_CHANGED");
      assertBrowserCredentialFillEligible(fresh.item);
      const selected = { recordRevision: fresh.item.revision, sourceContentRevision: fresh.contentRevision, sourceManifestRevision: fresh.manifestRevision, rememberSession };
      await controller.prepareCredential(item.id, selected);
      assertCurrent();
      const review = controller.getSnapshot().snapshot?.review;
      if (review?.purpose !== "credential_fill") throw new Error("BROWSER_CREDENTIAL_REVIEW_REQUIRED");
      setPrepared({ item, selection: selected, reviewId: review.id, operationId: selection.operationId, epoch: snapshot.controlEpoch, leaseKeyId: selection.leaseKey.id });
    } catch (error) {
      if (presentationCurrent()) morphyToast.error(error instanceof WebsiteCredentialError && error.code === "WEBSITE_BROWSER_MANUAL_REQUIRED"
        ? "Use Type myself for this saved login." : "Couldn’t prepare this sign-in. Check the current task before continuing.");
    } finally { if (presentationCurrent()) setDispatching(false); }
  }
  async function allow(): Promise<void> {
    if (!prepared || !selection || pending || dispatching) return;
    setDispatching(true);
    try {
      assertCurrent();
      const review = controller.getSnapshot().snapshot?.review;
      if (review?.purpose !== "credential_fill" || review.id !== prepared.reviewId || prepared.operationId !== selection.operationId ||
        prepared.epoch !== snapshot.controlEpoch || prepared.leaseKeyId !== selection.leaseKey.id) throw new Error("BROWSER_CREDENTIAL_SELECTION_CHANGED");
      // This explicit human action consumes the existing exact review receipt.
      await controller.review(prepared.reviewId);
      assertCurrent();
      if (controller.getSnapshot().snapshot?.review) throw new Error("BROWSER_CREDENTIAL_REVIEW_REQUIRED");
      if (!snapshot.authorizationExpiresAt) throw new Error("BROWSER_AUTHORIZATION_EXPIRED");
      const payload = await sealTransientCredentialUse(context(), prepared.item.id, { ...prepared.selection,
        podId: controller.binding.podId, taskId: controller.binding.taskId, incarnation: controller.binding.incarnation,
        taskExpiresAt: snapshot.authorizationExpiresAt, operationId: selection.operationId, controlEpoch: snapshot.controlEpoch,
        origin: selection.origin, leaseKey: selection.leaseKey });
      assertCurrent();
      await controller.useTransientCredential(prepared.item.id, payload);
      if (presentationCurrent()) setPrepared(null);
    } catch {
      if (presentationCurrent()) { setPrepared(null); morphyToast.error("Sign-in was not confirmed. Check the current task; it will not be sent again automatically."); }
    } finally { if (presentationCurrent()) setDispatching(false); }
  }
  return <section className="space-y-2" aria-label="Private website sign-in" data-testid="browser-saved-login-prompt">
    <p className="font-medium">Sign in to {selection?.origin}?</p>
    <p className="text-xs text-muted-foreground">Only you can allow this sign-in. One never sees your password.</p>
    {prepared ? <><p className="text-sm">{prepared.item.label}</p>
      <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={prepared.selection.rememberSession} disabled={pending || dispatching}
        onChange={event => { void prepare(prepared.item, event.target.checked); }} />Stay signed in for this site</label></> : null}
    <div className="flex flex-wrap gap-2">
      <ShellActionSurface variant="pill" className="min-h-11" disabled={!allowed || pending || dispatching || snapshot.credentialEntryActive ||
        Boolean(snapshot.review && snapshot.review.purpose !== "credential_fill")}
        onClick={() => { void choose(); }}>Choose saved login</ShellActionSurface>
      <ShellActionSurface variant="pill" className="min-h-11" disabled={!allowed || pending || dispatching || !prepared}
        onClick={() => { void allow(); }}>Allow</ShellActionSurface>
      <ShellActionSurface variant="pill" className="min-h-11" disabled={pending || dispatching}
        onClick={() => { setPrepared(null); close(); onTypeMyself(); }}>Type myself</ShellActionSurface>
    </div>
    <Dialog open={open} onOpenChange={next => { if (!next) close(); }} modal>
      <DialogContent><DialogHeader><DialogTitle>Choose a saved login</DialogTitle>
        <DialogDescription>Only logins for the verified website are shown. Choosing an account does not sign in.</DialogDescription></DialogHeader>
        {loading ? <p role="status">Loading saved logins…</p> : rows.length ? rows.map(row =>
          <ShellActionSurface key={row.id} variant="pill" className="min-h-11" onClick={() => { void prepare(row); }}>{row.label}</ShellActionSurface>
        ) : <p role="status">No saved login for this site. Choose Type myself to sign in privately.</p>}
      </DialogContent>
    </Dialog>
  </section>;
}
