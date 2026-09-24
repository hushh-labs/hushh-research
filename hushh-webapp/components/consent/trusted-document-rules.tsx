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
      .catch(() => { if (active) setMessage("Could not load document trust rules."); });
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
  return <section aria-label="Trusted for documents" className="space-y-3">
    <h4 className="text-sm font-semibold">Trusted for documents</h4>
    <p className="text-sm text-muted-foreground">Rules work only while their original live Drive connection remains active. You can revoke a rule here after disconnecting.</p>
    {rules.length === 0 ? <p className="text-sm text-muted-foreground">No active document trust rules.</p> : null}
    <ul className="space-y-3">{rules.map((rule) => <li key={rule.ruleId} className="rounded-lg border border-border p-3 text-sm">
      <p className="break-all font-medium">{rule.recipientEmail}</p>
      <p className="break-words">Purpose: {rule.purpose.purpose}</p>
      {rule.purpose.periodStart && rule.purpose.periodEnd ? <p className="text-muted-foreground">{rule.purpose.periodStart} to {rule.purpose.periodEnd}</p> : null}
      <p className="text-muted-foreground">Same request purpose and these exact files while their contents stay unchanged:</p>
      <ul className="list-inside list-disc">{rule.fileNames.map((name, index) => <li key={`${index}:${name}`} className="break-all">{name}</li>)}</ul>
      <Button size="standard" variant="none" disabled={busy} onClick={() => void revoke(rule)}>Revoke document trust</Button>
    </li>)}</ul>
    {message ? <p role="status" className="text-sm">{message}</p> : null}
  </section>;
}
