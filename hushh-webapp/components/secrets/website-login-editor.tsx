"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { CredentialAutonomyPolicy, CredentialInput } from "@/lib/pkm/credentials-contracts";

export function WebsiteLoginEditor({ initial, busy, disabled, onSave, onCancel }: {
  initial: CredentialInput | null;
  busy: boolean;
  disabled: boolean;
  onSave: (input: CredentialInput, durationHours: number) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [origins, setOrigins] = useState(initial?.boundOrigins.join("\n") ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [usernameHint, setUsernameHint] = useState(initial?.usernameHint ?? "");
  const [password, setPassword] = useState(initial?.password ?? "");
  const [totpSecret, setTotpSecret] = useState(initial?.totpSecret ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [policy, setPolicy] = useState<CredentialAutonomyPolicy>(initial?.autonomyPolicy ?? "autonomous");
  const [durationHours, setDurationHours] = useState(24);
  return <form className="space-y-4" aria-label={initial ? "Edit website login" : "Add website login"}
    autoComplete="off" onSubmit={event => {
      event.preventDefault();
      if (busy || disabled) return;
      void onSave({ label: label.trim(), boundOrigins: origins.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        username, usernameHint, password, autonomyPolicy: policy,
        ...(totpSecret.trim() ? { totpSecret: totpSecret.trim() } : {}), ...(notes ? { notes } : {}) }, durationHours);
    }}>
    <fieldset disabled={busy || disabled} className="space-y-4">
      <div className="space-y-2"><Label htmlFor="website-login-label">Login name</Label>
        <Input id="website-login-label" value={label} onChange={event => setLabel(event.target.value)} required maxLength={120} autoComplete="off" /></div>
      <div className="space-y-2"><Label htmlFor="website-login-origins">Approved website origins</Label>
        <Textarea id="website-login-origins" value={origins} onChange={event => setOrigins(event.target.value)} required rows={2} maxLength={2048}
          placeholder="https://portal.example.com" autoComplete="off" aria-describedby="website-login-origin-help" />
        <p id="website-login-origin-help" className="text-sm text-muted-foreground">One exact HTTPS origin per line. Other domains and embedded sign-in forms are not approved.</p></div>
      <div className="space-y-2"><Label htmlFor="website-login-username">Username</Label>
        <Input id="website-login-username" value={username} onChange={event => setUsername(event.target.value)} required maxLength={1024} autoComplete="off" spellCheck={false} autoCapitalize="none" /></div>
      <div className="space-y-2"><Label htmlFor="website-login-password">Password</Label>
        <Input id="website-login-password" type="password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={4096} autoComplete="new-password" /></div>
      <div className="space-y-2"><Label htmlFor="website-login-hint">Username hint (optional)</Label>
        <Input id="website-login-hint" value={usernameHint} onChange={event => setUsernameHint(event.target.value)} maxLength={128} autoComplete="off" />
        <p className="text-sm text-muted-foreground">Use a short reminder, such as “work account”. Keep the full username and password out of this hint.</p></div>
      <div className="space-y-2"><Label htmlFor="website-login-totp">Authenticator setup key (optional)</Label>
        <Input id="website-login-totp" type="password" value={totpSecret} onChange={event => setTotpSecret(event.target.value)} maxLength={512} autoComplete="new-password" spellCheck={false} />
        <p className="text-sm text-muted-foreground">The saved setup key generates verification codes privately. Passkeys and other verification still use Take control.</p></div>
      <div className="space-y-2"><Label htmlFor="website-login-policy">When your private agent can use this login</Label>
        <select id="website-login-policy" value={policy} onChange={event => setPolicy(event.target.value as CredentialAutonomyPolicy)} className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm">
          <option value="autonomous">Automatically during approved tasks</option>
          <option value="confirm_before_fill">Ask before each sign-in</option>
          <option value="vault_only">Only with my unlocked vault</option>
        </select>
        <p className="text-sm text-muted-foreground">Automatic and confirmed sign-in can use encrypted agent custody while this device is closed. Session-only lockdown still pauses unattended use. Saving a login does not start a task or approve sharing.</p></div>
      {policy !== "vault_only" ? <div className="space-y-2"><Label htmlFor="website-login-duration">Allow private-agent access for</Label>
        <select id="website-login-duration" value={durationHours} onChange={event => setDurationHours(Number(event.target.value))}
          className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm">
          <option value={24}>24 hours</option><option value={720}>30 days</option><option value={8760}>365 days</option>
        </select><p className="text-sm text-muted-foreground">Access expires after this period and can be renewed here. The encrypted login stays saved. Remove or restrict it at any time.</p></div> : null}
      <div className="space-y-2"><Label htmlFor="website-login-notes">Private notes (optional)</Label>
        <Textarea id="website-login-notes" value={notes} onChange={event => setNotes(event.target.value)} rows={2} maxLength={4096} autoComplete="off" /></div>
    </fieldset>
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={disabled || busy} isLoading={busy} data-voice-control-id="website-login-save">Save login</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={onCancel} data-voice-control-id="website-login-cancel">Cancel</Button>
    </div>
  </form>;
}
