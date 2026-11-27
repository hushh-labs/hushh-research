"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { WebsiteLoginInput } from "@/lib/pkm/website-credential";

export function WebsiteLoginEditor({ initial, busy, disabled, onSave, onCancel }: {
  initial: WebsiteLoginInput | null;
  busy: boolean;
  disabled: boolean;
  onSave: (input: WebsiteLoginInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? "");
  const [origins, setOrigins] = useState(initial?.boundOrigins.join("\n") ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState(initial?.password ?? "");
  const [totpSecret, setTotpSecret] = useState(initial?.totpSecret ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [staySignedInEnabled, setStaySignedInEnabled] = useState(initial?.staySignedInEnabled ?? false);
  return <form className="space-y-4" aria-label={initial ? "Edit website login" : "Add website login"}
    autoComplete="off" onSubmit={event => {
      event.preventDefault();
      if (busy || disabled) return;
      void onSave({ label: label.trim(), boundOrigins: origins.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        username, password, staySignedInEnabled,
        ...(totpSecret.trim() ? { totpSecret: totpSecret.trim() } : {}), ...(notes ? { notes } : {}) });
    }}>
    <fieldset disabled={busy || disabled} className="space-y-4">
      <div className="space-y-2"><Label htmlFor="website-login-label">Login name</Label>
        <Input id="website-login-label" value={label} onChange={event => setLabel(event.target.value)} required maxLength={128} autoComplete="off" /></div>
      <div className="space-y-2"><Label htmlFor="website-login-origins">Approved website origins</Label>
        <Textarea id="website-login-origins" value={origins} onChange={event => setOrigins(event.target.value)} required rows={2} maxLength={2048}
          placeholder="https://portal.example.com" autoComplete="off" aria-describedby="website-login-origin-help" />
        <p id="website-login-origin-help" className="text-sm text-muted-foreground">One exact HTTPS origin per line. Other domains and embedded sign-in forms are not approved.</p></div>
      <div className="space-y-2"><Label htmlFor="website-login-username">Username</Label>
        <Input id="website-login-username" value={username} onChange={event => setUsername(event.target.value)} required maxLength={1024} autoComplete="off" spellCheck={false} autoCapitalize="none" /></div>
      <div className="space-y-2"><Label htmlFor="website-login-password">Password</Label>
        <Input id="website-login-password" type="password" value={password} onChange={event => setPassword(event.target.value)} required maxLength={8192} autoComplete="new-password" /></div>
      <div className="space-y-2"><Label htmlFor="website-login-totp">Authenticator setup key (optional)</Label>
        <Input id="website-login-totp" type="password" value={totpSecret} onChange={event => setTotpSecret(event.target.value)} maxLength={512} autoComplete="new-password" spellCheck={false} />
        <p className="text-sm text-muted-foreground">The saved setup key generates verification codes privately. Passkeys and other verification still use Take control.</p></div>
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={staySignedInEnabled}
        onChange={event => setStaySignedInEnabled(event.target.checked)} />Stay signed in for this site</label>
      <p className="text-sm text-muted-foreground">Only a revocable site session can be remembered after you allow sign-in. Your password always requires your unlocked vault and an Allow tap.</p>
      <div className="space-y-2"><Label htmlFor="website-login-notes">Private notes (optional)</Label>
        <Textarea id="website-login-notes" value={notes} onChange={event => setNotes(event.target.value)} rows={2} maxLength={4096} autoComplete="off" /></div>
    </fieldset>
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={disabled || busy} isLoading={busy} data-voice-control-id="website-login-save">Save login</Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={onCancel} data-voice-control-id="website-login-cancel">Cancel</Button>
    </div>
  </form>;
}
