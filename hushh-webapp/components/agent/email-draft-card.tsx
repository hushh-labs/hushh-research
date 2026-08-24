"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ROUTES } from "@/lib/navigation/routes";
import { type EmailDraft, GoogleEmailSendService } from "@/lib/services/google-email-send-service";

function splitAddresses(value: string): string[] {
  return value.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
}

type Props = {
  userId: string;
  vaultOwnerToken: string;
  initialBody?: string;
  onSent: () => void;
  onClose: () => void;
};

/** A browser-held, editable email draft. Every edit invalidates confirmation. */
export function EmailDraftCard({ userId, vaultOwnerToken, initialBody = "", onSent, onClose }: Props) {
  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState(initialBody);
  const [actionId, setActionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missingDetails, setMissingDetails] = useState<string[]>([]);

  const draft = (): EmailDraft => ({ to: splitAddresses(to), cc: splitAddresses(cc), bcc: splitAddresses(bcc), subject, body });
  const changed = () => { setActionId(null); setError(null); };
  const prepare = async () => {
    setBusy(true); setError(null);
    try {
      const result = await GoogleEmailSendService.prepare({
        vaultOwnerToken, userId, draft: draft(), idempotencyKey: crypto.randomUUID(),
      });
      setActionId(result.action_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to prepare this email.");
    } finally { setBusy(false); }
  };
  const generate = async () => {
    if (!body.trim()) { setError("Describe the email you want One to draft first."); return; }
    setBusy(true); setError(null);
    try {
      const generated = await GoogleEmailSendService.draft({ vaultOwnerToken, userId, instruction: body });
      setTo(generated.to.join(", ")); setCc(generated.cc.join(", ")); setBcc(generated.bcc.join(", "));
      setSubject(generated.subject); setBody(generated.body); setMissingDetails(generated.missing_details);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "One could not draft that email."); }
    finally { setBusy(false); }
  };
  const send = async () => {
    if (!actionId) return;
    setBusy(true); setError(null);
    try {
      await GoogleEmailSendService.execute({ vaultOwnerToken, userId, actionId, draft: draft() });
      onSent();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Gmail could not send this email.");
      setActionId(null);
    } finally { setBusy(false); }
  };
  return (
    <section className="w-full max-w-2xl rounded-2xl border border-border bg-card p-4 shadow-sm" data-testid="agent-email-draft-card">
      <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">Email draft</h3><p className="mt-1 text-sm text-muted-foreground">Review every field. Sending happens only after the final button below.</p></div><Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>Close</Button></div>
      <div className="mt-4 grid gap-2 text-sm">
        <label>To <input value={to} onChange={(event) => { setTo(event.target.value); changed(); }} placeholder="person@example.com" className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label>
        <label>Cc <input value={cc} onChange={(event) => { setCc(event.target.value); changed(); }} placeholder="Optional, comma-separated" className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label>
        <label>Bcc <input value={bcc} onChange={(event) => { setBcc(event.target.value); changed(); }} placeholder="Optional, comma-separated" className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label>
        <label>Subject <input value={subject} onChange={(event) => { setSubject(event.target.value); changed(); }} className="mt-1 w-full rounded-md border bg-background px-3 py-2" /></label>
        <label>Message <textarea value={body} onChange={(event) => { setBody(event.target.value); changed(); }} rows={7} className="mt-1 w-full resize-y rounded-md border bg-background px-3 py-2" /></label>
      </div>
      {error ? <p className="mt-3 text-sm text-destructive">{error} {error.includes("permission") ? <a className="underline" href={ROUTES.EMAIL}>Enable Gmail sending</a> : null}</p> : null}
      {missingDetails.length > 0 ? <p className="mt-3 text-sm text-muted-foreground">One left these details for you to confirm: {missingDetails.join(", ")}.</p> : null}
      <div className="mt-4 flex justify-end gap-2">
        {!actionId ? <Button type="button" variant="outline" onClick={() => void generate()} disabled={busy}>Ask One to draft</Button> : null}
        {actionId ? <Button type="button" onClick={() => void send()} disabled={busy}>{busy ? "Sending…" : "Send email"}</Button> : <Button type="button" onClick={() => void prepare()} disabled={busy}>{busy ? "Preparing…" : "Review & continue"}</Button>}
      </div>
    </section>
  );
}
