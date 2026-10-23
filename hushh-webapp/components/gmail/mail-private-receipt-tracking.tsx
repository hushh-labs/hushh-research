"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { receiptStoreGuard, type ReceiptStoreSession } from '@/lib/mail/receipt-store';
import { snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from '@/lib/vault/session-epoch';
import { syncPrivateMailReceipts, type MailboxSyncResult } from '@/lib/services/private-mail-receipts';
import type { PrivateMailAccount } from '@/lib/services/private-google-connections';
import { MailActionButton } from './mail-action-button';
import { MailSavedReceiptReport } from './mail-saved-receipt-report';
import styles from './mail-workspace.module.css';
import { subscribeDurableOwnerReset } from '@/lib/services/secure-durable-resource-service';

export function MailPrivateReceiptTracking({ session, accounts, enabled }: { session: ReceiptStoreSession; accounts: PrivateMailAccount[]; enabled: boolean }) {
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const [selection, setSelection] = useState('all');
  const [run, setRun] = useState<{ tag: string; busy: boolean; results: MailboxSyncResult[] }>();
  const [revision, setRevision] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const tag = JSON.stringify([session.userId, epoch, accounts.map(a => [a.accountId, a.credentialId, a.status])]);
  const current = receiptStoreGuard(session);
  const selectedAccounts = selection === 'all' ? accounts : accounts.filter(a => a.accountId === selection);
  const visible = current() && run?.tag === tag ? run : undefined;
  useEffect(() => {
    setRun(previous => previous?.busy ? { ...previous, busy: false } : previous);
    setSelection(previous => previous === 'all' || accounts.some(a => a.accountId === previous) ? previous : 'all');
    return () => { controller.current?.abort(); controller.current = null; };
  }, [tag, enabled, accounts]);
  useEffect(() => subscribeDurableOwnerReset(owner => {
    if (owner !== session.userId) return;
    controller.current?.abort(); controller.current = null; setRun(undefined); setRevision(value => value + 1);
  }), [session.userId]);
  async function sync() {
    if (controller.current || !current() || !enabled) return;
    const abort = new AbortController(); controller.current = abort;
    const selected = selectedAccounts;
    const results: MailboxSyncResult[] = [];
    setRun({ tag, busy: true, results });
    try {
      await syncPrivateMailReceipts(session, selected, abort.signal, result => {
        if (!current() || abort.signal.aborted) return;
        results.push(result); setRun({ tag, busy: true, results: [...results] }); setRevision(value => value + 1);
      });
    } catch {
      if (current() && !abort.signal.aborted) {
        for (const account of selected) if (!results.some(result => result.accountId === account.accountId))
          results.push({ accountId: account.accountId, status: 'failed', count: 0 });
      }
    } finally {
      if (current() && !abort.signal.aborted) setRun({ tag, busy: false, results });
      if (controller.current === abort) controller.current = null;
    }
  }
  if (!enabled || !accounts.length) return null;
  return <div className="space-y-3 border-t border-[color:var(--app-separator)] py-3" data-voice-control-id="mail_sync_selected_accounts">
    <h3 className={styles.sectionTitle}>Track receipts</h3>
    <p className={styles.support}>Sync a mailbox or all connected mailboxes, then compare spending below. Scans cover up to the last year. Other mail requests use your default mailbox.</p>
    <Select value={selection} onValueChange={setSelection} disabled={visible?.busy}><SelectTrigger aria-label="Sync mailboxes" className="min-h-11"><SelectValue /></SelectTrigger><SelectContent>
      <SelectItem value="all">All connected mailboxes</SelectItem>
      {accounts.map((account, index) => <SelectItem key={account.accountId} value={account.accountId}>{account.email || `Google mailbox ${index + 1}`}</SelectItem>)}
    </SelectContent></Select>
    <MailActionButton disabled={visible?.busy || !selectedAccounts.some(a => a.receiptSyncAvailable === true)} onClick={() => void sync()}>{visible?.busy ? 'Syncing receipts…' : 'Sync receipts'}</MailActionButton>
    {visible?.busy ? <MailActionButton onClick={() => { controller.current?.abort(); controller.current = null; setRun(previous => previous ? { ...previous, busy: false } : previous); }}>Cancel sync</MailActionButton> : null}
    {accounts.some(a => a.receiptSyncAvailable !== true) ? <p className={styles.support}>Update your private agent to enable receipt sync.</p> : null}
    {visible?.results.map(result => <p key={result.accountId} role="status" className={styles.support}>
      {accounts.find(a => a.accountId === result.accountId)?.email || 'Mailbox'}: {result.status === 'saved' ? `${result.count} ${result.count === 1 ? 'receipt' : 'receipts'} saved${result.partial ? ' · scan incomplete' : ''}` : result.status === 'empty' ? 'No receipts returned; previous saved receipts kept.' : 'Sync failed; previous saved receipts kept. Reconnect if needed.'}
    </p>)}
    <MailSavedReceiptReport session={session} activeAccount={null} receiptRevision={`${tag}:${revision}`} availableAccounts={accounts} enabled={enabled} />
  </div>;
}
