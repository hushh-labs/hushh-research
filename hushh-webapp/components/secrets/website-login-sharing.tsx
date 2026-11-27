"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { approveCredentialShare, cancelCredentialShare, prepareCredentialShare, type CredentialShareReview } from "@/lib/services/credential-sharing-service";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES, normalizeStaticExportPathname } from "@/lib/navigation/routes";
import { usePathname } from "next/navigation";
import { useProfilePanePresentation } from "@/lib/navigation/use-profile-pane-presentation";
import type { WebsiteLoginSummary } from "@/lib/pkm/website-credential";
import type { WebsiteLoginsModel } from "./use-website-logins";

export function WebsiteLoginSharing({ item, model, onClose, onBusy }: {
  item: WebsiteLoginSummary; model: WebsiteLoginsModel; onClose: () => void; onBusy: (busy: boolean) => void;
}) {
  const route = normalizeStaticExportPathname(usePathname() ?? ROUTES.PKM);
  const pane = useProfilePanePresentation();
  const [appId, setAppId] = useState("");
  const [review, setReview] = useState<CredentialShareReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const live = useRef(true);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const current = () => live.current && model.current();
  const context = () => ({ ...model.shareContext(), beforeEffect: async () => {
    if (!current()) throw new Error("CREDENTIAL_OWNER_RETIRED");
    await model.shareContext().beforeEffect();
    if (!current()) throw new Error("CREDENTIAL_OWNER_RETIRED");
  } });
  const run = async (approve: boolean) => {
    if (busy || uncertain || !current()) return;
    setBusy(true); onBusy(true); setError(null);
    try {
      if (approve && review) {
        const requestId = await approveCredentialShare(context(), review);
        if (current()) { setReceipt(requestId); setReview(null); }
      } else {
        const next = await prepareCredentialShare(context(), { credentialId: item.id, appId, branch: "items", durationHours: 24 });
        if (current()) setReview(next);
      }
    } catch {
      if (current()) {
        setError(approve ? "Sharing was not confirmed. Check Consent Center before trying again." : "The recipient could not be prepared. Check the registered application ID and refresh the login.");
        setUncertain(approve);
      }
    } finally {
      if (current()) { setBusy(false); onBusy(false); }
    }
  };
  const cancel = async () => {
    if (busy || !current()) return;
    if (!review || receipt || uncertain) { onClose(); return; }
    setBusy(true); onBusy(true);
    try {
      await cancelCredentialShare(context(), review);
      if (current()) onClose();
    } catch {
      if (current()) setError("The pending request could not be cancelled. Check Consent Center before trying again.");
    } finally {
      if (current()) { setBusy(false); onBusy(false); }
    }
  };
  useBackLayer(route, 3, () => { void cancel(); return true; }, pane?.open ? { profile_pane: "1" } : undefined);
  return <section className="space-y-4 rounded-xl border p-4" aria-label="Share saved website login">
    <h2 className="font-semibold">Share {item.label}</h2>
    {error ? <p role="alert" className="text-sm">{error}</p> : null}
    {receipt ? <p role="status" className="break-all text-sm">Access approved for the selected application for up to 24 hours. Request reference: {receipt}. You can revoke it in Consent Center.</p> : review ? <>
      <p className="text-sm">Recipient: <strong>{review.recipient.label}</strong> ({review.recipient.app_id})</p>
      <p className="text-sm">Share this website login, including the username, password, verification setup key and notes where saved. The selected recipient can decrypt it.</p>
      <p className="text-sm text-muted-foreground">This is a selected snapshot for up to 24 hours. Changes to saved logins can require a new sharing review. Revocation stops future reads; it cannot recall a copy the recipient has already decrypted.</p>
      <Button disabled={busy || uncertain} isLoading={busy} onClick={() => { void run(true); }} data-voice-control-id="website-login-share-confirm">Approve sharing</Button>
    </> : !uncertain ? <>
      <div className="space-y-2"><Label htmlFor="website-login-recipient">Registered recipient application ID</Label>
        <Input id="website-login-recipient" value={appId} maxLength={128} onChange={event => setAppId(event.target.value)} disabled={busy} autoComplete="off" /></div>
      <Button disabled={busy || !appId.trim()} isLoading={busy} onClick={() => { void run(false); }} data-voice-control-id="website-login-share-review">Review recipient and access</Button>
    </> : null}
    <Button variant="secondary" disabled={busy} onClick={() => { void cancel(); }} data-voice-control-id="website-login-share-cancel">{receipt ? "Done" : "Cancel"}</Button>
  </section>;
}
