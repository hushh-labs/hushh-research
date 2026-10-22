"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Button } from "@/lib/morphy-ux/button";
import { DriveSharingService, type TrustedDocumentRule } from "@/lib/services/drive-sharing-service";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";

type RuleValue = { rules: TrustedDocumentRule[]; busy: boolean; message: string };
const initial = (): RuleValue => ({ rules: [], busy: false, message: "" });

/** Same rule reader/revoker for either presentation; no consent grant is minted. */
export function useTrustedDocumentRules(token: string | null, enabled = true) {
  const lease = useMemo(() => ({ live: false, busy: false, token, enabled, epoch: snapshotVaultSessionEpoch(), revoked: new Set<string>() }), [token, enabled]);
  const [stored, setStored] = useState<{ lease: typeof lease; value: RuleValue } | null>(null);
  const value = stored?.lease === lease ? stored.value : initial();
  const guard = useCallback(() => { if (!lease.live || !token || !isVaultSessionEpochCurrent(lease.epoch)) throw new Error("session_changed"); }, [lease, token]);
  const change = useCallback((update: (value: RuleValue) => RuleValue) => {
    try { guard(); } catch { return; }
    setStored(previous => ({ lease, value: update(previous?.lease === lease ? previous.value : initial()) }));
  }, [guard, lease]);
  useLayoutEffect(() => { lease.live = enabled && !!token; return () => { lease.live = false; }; }, [enabled, lease, token]);
  useEffect(() => {
    if (!enabled || !token) return;
    let active = true;
    const current = () => { guard(); if (!active) throw new Error("retired_read"); };
    void DriveSharingService.listRules(token, current)
      .then(rules => { current(); change(value => ({ ...value, rules })); })
      .catch(() => { try { current(); change(value => ({ ...value, message: "Trusted documents unavailable." })); } catch { /* Retired read. */ } });
    return () => { active = false; };
  }, [change, enabled, guard, token]);
  const revoke = async (rule: TrustedDocumentRule) => {
    if (!token || lease.busy || lease.revoked.has(rule.ruleId) || !value.rules.includes(rule)) return false;
    try { guard(); } catch { return false; }
    lease.busy = true; change(value => ({ ...value, busy: true, message: "" }));
    try {
      await DriveSharingService.revokeRule(token, rule, guard);
      guard();
      lease.revoked.add(rule.ruleId);
      change(value => ({ ...value, rules: value.rules.filter(item => item.ruleId !== rule.ruleId),
        message: "Document trust revoked. Existing Google access must be removed separately." }));
      return true;
    } catch {
      change(value => ({ ...value, message: "Could not revoke this rule. Refresh and try again." }));
      return false;
    } finally { lease.busy = false; change(value => ({ ...value, busy: false })); }
  };
  return { ...value, revoke, mutationPending: () => lease.busy };
}
export type TrustedDocumentRulesModel = ReturnType<typeof useTrustedDocumentRules>;

export function TrustedDocumentRules({ token }: { token: string }) {
  const model = useTrustedDocumentRules(token);
  return <TrustedDocumentRulesView model={model} />;
}
export function TrustedDocumentRulesView({ model }: { model: TrustedDocumentRulesModel }) {
  const { rules, busy, message, revoke } = model;
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
