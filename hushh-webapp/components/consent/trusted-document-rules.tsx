"use client";

import { useEffect, useState } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { DriveSharingService, type TrustedDocumentRule } from "@/lib/services/drive-sharing-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

export function TrustedDocumentRules({ token }: { token: string }) {
  const [rules, setRules] = useState<TrustedDocumentRule[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    const epoch = snapshotVaultSessionEpoch();
    const guard = () => {
      if (!active || !isVaultSessionEpochCurrent(epoch)) throw new Error("session_changed");
    };
    void DriveSharingService.listRules(token, guard)
      .then((items) => { guard(); setRules(items); })
      .catch(() => { if (active) setMessage("Trusted documents unavailable."); });
    return () => { active = false; };
  }, [token]);
  const revoke = async (rule: TrustedDocumentRule) => {
    if (busy) return;
    const epoch = snapshotVaultSessionEpoch();
    const guard = () => {
      if (!isVaultSessionEpochCurrent(epoch)) throw new Error("session_changed");
    };
    setBusy(true);
    setMessage("");
    try {
      await DriveSharingService.revokeRule(token, rule, guard);
      guard();
      setRules((current) => current.filter((item) => item.ruleId !== rule.ruleId));
      setMessage("Document trust revoked. Existing Google access must be removed separately.");
    } catch {
      setMessage("Could not revoke this rule. Refresh and try again.");
    } finally {
      setBusy(false);
    }
  };
  return <section aria-label="Trusted documents" className="space-y-2 rounded-2xl bg-foreground/5 px-4 py-3">
    <h4 className="text-sm font-medium">Trusted documents</h4>
    {rules.length === 0 && !message ? <p className="text-sm text-muted-foreground">None yet</p> : rules.length > 0 ?
      <p className="text-sm text-muted-foreground">Matching files may be shared without asking again while their original Drive connection is active.</p> : null}
    <ul className="space-y-3">{rules.map((rule) => <li key={rule.ruleId} className="rounded-lg border border-border p-3 text-sm">
      <p className="break-all font-medium">{rule.recipientEmail}</p>
      {rule.scope === "any_requested_drive_file" ? <p>Any requested Drive file, including future files.</p> : <>
      <p className="break-words">Purpose: {rule.purpose.purpose}</p>
      {rule.purpose.periodStart && rule.purpose.periodEnd ? <p className="text-muted-foreground">{rule.purpose.periodStart} to {rule.purpose.periodEnd}</p> : null}
      <p className="text-muted-foreground">Same request purpose and these exact files while their contents stay unchanged:</p>
      <ul className="list-inside list-disc">{rule.fileNames.map((name, index) => <li key={`${index}:${name}`} className="break-all">{name}</li>)}</ul></>}
      {rule.readiness === "background_off" ? <p>Enable background preparation to handle requests while away.</p> : rule.readiness === "reconnect_required" ? <p>Reconnect Drive to resume.</p> : null}
      <Button size="standard" variant="none" disabled={busy} onClick={() => void revoke(rule)}>Revoke document trust</Button>
    </li>)}</ul>
    {message ? <p role="status" className="text-sm">{message}</p> : null}
  </section>;
}
