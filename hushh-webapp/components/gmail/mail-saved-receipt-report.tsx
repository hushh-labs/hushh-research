"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { receiptAccountBinding } from "@/lib/mail/receipt-snapshot";
import { receiptSessionGuard, type ReceiptStoreSession } from "@/lib/mail/receipt-store";
import { subscribeDurableOwnerReset } from "@/lib/services/secure-durable-resource-service";
import { listSavedReceiptAccounts, runSavedReceiptReport, type SavedReceiptAccount } from "@/lib/mail/receipt-report-store";
import type { ReceiptAccountReport } from "@/lib/mail/receipt-account-report";
import { MailActionButton } from "./mail-action-button";
import styles from "./mail-workspace.module.css";

type ReportState = { tag: string; report?: ReceiptAccountReport; error?: string; busy?: boolean };
function previousMonth() {
  const now = new Date();
  const month = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`;
}
function monthRange(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month) || Number(month.slice(5)) < 1 || Number(month.slice(5)) > 12)
    throw new Error("Choose a valid month.");
  const year = Number(month.slice(0, 4)), value = Number(month.slice(5));
  if (year < 1900 || year > 9998) throw new Error("Choose a valid month.");
  return { from_date: `${month}-01`, to_date: `${value === 12 ? year + 1 : year}-${String(value === 12 ? 1 : value + 1).padStart(2, "0")}-01` };
}

/** Saved-only reporting: this never implies a disconnected or unsynced inbox was searched. */
export function MailSavedReceiptReport({ session, activeAccount, activeEmail, receiptRevision, enabled = true, availableAccounts }: {
  session: ReceiptStoreSession; activeAccount: string | null; activeEmail?: string | null; receiptRevision: string; enabled?: boolean;
  availableAccounts?: readonly { accountId: string; email: string | null }[];
}) {
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const [month, setMonth] = useState(previousMonth);
  const [scope, setScope] = useState("all_saved");
  const [kind, setKind] = useState("spending");
  const [reset, setReset] = useState(0);
  const [accounts, setAccounts] = useState<{ tag: string; rows: (SavedReceiptAccount & { label?: string })[]; active: string | null; error?: string }>();
  const [state, setState] = useState<ReportState>();
  const requestId = useRef(0);
  const availableTag = JSON.stringify(availableAccounts?.map(a => [a.accountId, a.email]));
  const ownerTag = JSON.stringify([session.userId, epoch, reset, receiptRevision, availableTag]);
  const tag = JSON.stringify([ownerTag, scope, month, kind]);
  const current = receiptSessionGuard(session);
  const visible = current() && state?.tag === tag ? state : undefined;
  const rows = current() && accounts?.tag === ownerTag ? accounts.rows : [];
  const { userId, vaultKey, vaultOwnerToken, isCurrent: parentCurrent } = session;
  const stableSession = useMemo(() => ({ userId, vaultKey, vaultOwnerToken, isCurrent: parentCurrent }), [userId, vaultKey, vaultOwnerToken, parentCurrent]);

  useEffect(() => subscribeDurableOwnerReset(owner => {
    if (owner !== userId) return;
    requestId.current += 1; setState(undefined); setAccounts(undefined); setReset(value => value + 1);
  }), [userId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const id = requestId.current;
    const isCurrent = receiptSessionGuard(stableSession);
    void (async () => {
      try {
        let saved: (SavedReceiptAccount & { label?: string })[] = await listSavedReceiptAccounts(stableSession);
        if (availableAccounts) saved = await Promise.all(availableAccounts.map(async (account, index) => {
          const binding = await receiptAccountBinding(account.accountId);
          return { binding, freshness: '', count: 0, partial: true, ...saved.find(row => row.binding === binding), label: account.email || `Google mailbox ${index + 1}` };
        }));
        const active = activeAccount ? await receiptAccountBinding(activeAccount) : null;
        if (!cancelled && id === requestId.current && isCurrent()) {
          setAccounts({ tag: ownerTag, rows: saved, active });
          setState(previous => previous?.busy ? undefined : previous);
        }
      } catch {
        if (!cancelled && id === requestId.current && isCurrent()) setAccounts({ tag: ownerTag, rows: [], active: null, error: "Saved receipts could not be loaded. Unlock your vault and try again." });
      }
    })();
    return () => { cancelled = true; requestId.current += 1; };
  }, [stableSession, ownerTag, activeAccount, enabled, availableAccounts]);

  async function runReport() {
    const id = ++requestId.current;
    const isCurrent = receiptSessionGuard(stableSession);
    setState({ tag, busy: true });
    try {
      const reportScope = scope === 'all_saved' ? availableAccounts ? rows.map(row => row.binding) : scope : [scope];
      const report = await runSavedReceiptReport(stableSession, reportScope, {
        ...monthRange(month), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, recurring_only: kind === "recurring",
      });
      if (id === requestId.current && isCurrent()) {
        if (scope === "all_saved" && !availableAccounts) setAccounts(previous => ({ tag: ownerTag, active: previous?.tag === ownerTag ? previous.active : null,
          rows: report.accounts.map(account => ({ binding: account.binding, freshness: account.freshness,
            count: account.canonical_count, partial: account.coverage.partial || account.coverage.truncated })) }));
        setState({ tag, report });
      }
    } catch (error) {
      if (id === requestId.current && isCurrent()) setState({ tag, error: error instanceof Error ? error.message : "The report is unavailable. Try again." });
    }
  }

  if (!enabled || !rows.length && !(current() && accounts?.tag === ownerTag && accounts.error)) return null;
  const labels = Object.fromEntries(rows.map((account, index) => [account.binding,
    account.label || (account.binding === accounts?.active ? activeEmail || "Current mailbox" : `Saved mailbox ${index + 1}`)]));
  return <section className="space-y-3 border-t border-[color:var(--app-separator)] py-4" aria-label="Saved receipt report">
    <h2 className={styles.sectionTitle}>Spending from receipts</h2>
    <p className={`${styles.support} text-muted-foreground`}>Choose a mailbox or combine saved receipts. This does not search mail that has not been synced.</p>
    <ReceiptReportFilters {...{ labels, scope, month, kind, setScope, setMonth, setKind }} allLabel={availableAccounts ? 'All connected mailboxes' : 'All saved mailboxes'} />
    <MailActionButton type="button" data-voice-control-id="mail_saved_receipt_report" disabled={Boolean(visible?.busy) || !rows.length} onClick={() => void runReport()}>
      {visible?.busy ? "Calculating…" : "Show report"}
    </MailActionButton>
    {accounts?.tag === ownerTag && accounts.error ? <p role="alert" className={styles.support}>{accounts.error}</p> : null}
    {visible?.error ? <p role="alert" className={styles.support}>{visible.error}</p> : null}
    {visible?.report ? <SavedReportResult report={visible.report} labels={labels} /> : null}
  </section>;
}

function ReceiptReportFilters({ labels, scope, month, kind, setScope, setMonth, setKind, allLabel }: {
  labels: Record<string, string>; scope: string; month: string; kind: string;
  setScope: (value: string) => void; setMonth: (value: string) => void; setKind: (value: string) => void;
  allLabel: string;
}) {
  return <div className="grid gap-3 sm:grid-cols-3">
    <label className="min-w-0 space-y-1"><span className={styles.support}>Mailboxes</span>
      <Select value={scope} onValueChange={setScope}><SelectTrigger className="w-full min-h-11" aria-label="Report mailboxes"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="all_saved">{allLabel}</SelectItem>
          {Object.entries(labels).map(([binding, label]) => <SelectItem key={binding} value={binding}>{label}</SelectItem>)}
        </SelectContent></Select>
    </label>
    <label className="min-w-0 space-y-1"><span className={styles.support}>Month</span><Input type="month" aria-label="Report month" value={month} onChange={event => setMonth(event.target.value)} className="min-h-11 text-sm" /></label>
    <label className="min-w-0 space-y-1"><span className={styles.support}>Include</span>
      <Select value={kind} onValueChange={setKind}><SelectTrigger className="w-full min-h-11" aria-label="Report type"><SelectValue /></SelectTrigger>
        <SelectContent><SelectItem value="spending">Paid receipts</SelectItem><SelectItem value="recurring">Recurring charges paid</SelectItem></SelectContent>
      </Select>
    </label>
  </div>;
}

function SavedReportResult({ report, labels }: { report: ReceiptAccountReport; labels: Record<string, string> }) {
  return <div role="status" className="space-y-2">
    <p className={styles.support}>{report.accounts.length} saved {report.accounts.length === 1 ? "mailbox" : "mailboxes"} · {report.charges.length} paid {report.recurring_only ? "recurring charges" : "receipts"}</p>
    {report.totals.length ? <ul className="space-y-1">{report.totals.map(total => <li key={total.currency} className="font-medium tabular-nums">{total.currency} {total.paid_amount}</li>)}</ul> : <p>No verified paid charges found in these saved receipts for this month.</p>}
    <p className={`${styles.support} text-muted-foreground`}>Saved receipts only, not total spending. Scan coverage may be incomplete. Refunds are not subtracted.</p>
    {report.unidentified_records || report.conflicting_records_excluded ? <p className={styles.support}>Some records are excluded or may be duplicated. Review the details below.</p> : null}
    {report.recurring_only ? <p className={styles.support}>Charges paid this month, not upcoming bills.</p> : null}
    <details><summary className="min-h-11 cursor-pointer py-3 text-sm">Account coverage and receipts</summary>
      <p className={`${styles.support} text-muted-foreground`}>{report.duplicate_copies_removed} duplicate copies removed · {report.conflicting_records_excluded} conflicting records excluded · {report.undated_records_excluded} records without a usable date</p>
      {report.unidentified_records ? <p className={styles.support}>Some receipts have no verified transaction reference; other duplicate copies may remain.</p> : null}
      {report.recurring_only ? <p className={styles.support}>Includes annual charges paid in this period. Future bills, unpaid invoices and free trials are excluded.</p> : null}
      <ul className={`${styles.support} space-y-2`}>{report.accounts.map(account => <li key={account.binding}>{labels[account.binding]}: {account.coverage.partial || account.coverage.truncated ? "partial scan" : "completed scan"} · saved {new Date(account.freshness).toLocaleString()}{account.coverage.window_from && account.coverage.window_to ? ` · ${account.coverage.window_from}–${account.coverage.window_to}` : " · scan date range not recorded"}</li>)}</ul>
      <ul className={`${styles.support} mt-3 space-y-2`}>{report.charges.slice(0, 100).map(charge => <li key={`${charge.account}:${charge.ref}`} className="flex flex-wrap justify-between gap-x-3"><span>{charge.merchant} · {charge.date} · {labels[charge.account]}</span><span className="tabular-nums">{charge.currency} {charge.amount}</span></li>)}</ul>
      {report.charges.length > 100 ? <p className={styles.support}>Showing the first 100 charges. Totals include every qualifying charge.</p> : null}
    </details>
  </div>;
}
