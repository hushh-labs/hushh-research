"use client";

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Capacitor } from '@capacitor/core';
import { toast } from 'sonner';
import { AuthService } from '@/lib/services/auth-service';
import { ownerContentIsPrivate } from '@/lib/services/private-agent-specialist-chat';
import { privateMailAccounts, disconnectPrivateMailAccount, type PrivateMailAccount } from '@/lib/services/private-google-connections';
import { connectGoogleConnector, connectRefusalMessage, type GoogleConnectorTransitionReview } from '@/lib/one/google-native-connect';
import { requestGoogleConnectorPhoneHandoff } from '@/lib/one/google-connector-intent';
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from '@/lib/vault/session-epoch';
import type { ReceiptStoreSession } from '@/lib/mail/receipt-store';
import { MailActionButton } from './mail-action-button';
import styles from './mail-workspace.module.css';

type Props = {
  session: ReceiptStoreSession; enabled: boolean; fallback: ReactNode;
  confirmTransition: (terms: GoogleConnectorTransitionReview) => Promise<boolean>;
  onChanged: () => void;
};
type Inventory = { scope: string; accounts: PrivateMailAccount[]; error?: string; private: boolean };

export function MailGoogleAccounts({ session, enabled, fallback, confirmTransition, onChanged }: Props) {
  const epoch = snapshotVaultSessionEpoch();
  const scope = `${session.userId}:${epoch}`;
  const [inventory, setInventory] = useState<Inventory>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setBusy(false); }, [scope]);
  const current = () => mounted.current && AuthService.getCurrentUser()?.uid === session.userId && isVaultSessionEpochCurrent(epoch);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const valid = () => !disposed && AuthService.getCurrentUser()?.uid === session.userId && isVaultSessionEpochCurrent(epoch);
    void ownerContentIsPrivate().then(async (privateAgent) => {
      if (!valid()) return;
      if (!privateAgent) { setInventory({ scope, private: false, accounts: [] }); return; }
      try {
        const accounts = await privateMailAccounts();
        if (valid()) setInventory({ scope, private: true, accounts });
      } catch {
        if (valid()) setInventory({ scope, private: true, accounts: [], error: 'Your private agent could not load mailboxes. Refresh or update your agent.' });
      }
    }).catch(() => { if (valid()) setInventory({ scope, private: true, accounts: [], error: 'Could not confirm your private agent connection.' }); });
    return () => { disposed = true; };
  }, [enabled, epoch, revision, scope, session.userId]);
  async function connect(account?: PrivateMailAccount) {
    if (busy || !current()) return;
    if (account && !Capacitor.isNativePlatform()) { toast.info('Open Mail on your phone to reconnect this mailbox.'); return; }
    setBusy(true);
    try {
      const outcome = await connectGoogleConnector('gmail', {
        vaultOwnerCapability: session.vaultOwnerToken, confirmLegacyTransition: confirmTransition, isCurrent: current,
        mailAccount: account ? { mode: 'reconnect', accountId: account.accountId, credentialId: account.credentialId } : { mode: 'add' },
      });
      if (!current()) return;
      if (!outcome.ok) {
        if (outcome.code === 'PHONE_HANDOFF_REQUIRED') requestGoogleConnectorPhoneHandoff('gmail', true);
        else toast.error(connectRefusalMessage(outcome.code, 'Mail'));
      } else {
        if (outcome.legacyCleanup === 'unconfirmed') toast.info('Mailbox connected. The previous Google connection still needs verification.');
        setRevision(value => value + 1); onChanged();
      }
    } catch { if (current()) toast.error('Could not connect this mailbox. Try again.'); }
    finally { if (current()) setBusy(false); }
  }
  async function disconnect(account: PrivateMailAccount) {
    if (busy || !current()) return;
    setBusy(true);
    try {
      const result = await disconnectPrivateMailAccount(account.accountId, account.credentialId);
      if (!current()) return;
      if (result.disconnected) {
        toast.success('Mailbox disconnected.');
        if (result.providerRevoked === false) toast.info('One stopped using this mailbox. Google could not confirm removal of access; review it in your Google account.');
      } else toast.info('This mailbox changed while disconnecting. Review its current connection.');
      setRevision(value => value + 1); onChanged();
    } catch { if (current()) toast.error('Could not confirm the disconnect. Refresh Mail before trying again.'); }
    finally { if (current()) setBusy(false); }
  }
  const visible = inventory?.scope === scope ? inventory : undefined;
  if (!visible) return null;
  if (!visible.private) return fallback;
  return <section className="space-y-3 py-3" aria-label="Connected mailboxes" data-voice-control-id="mail_google_accounts">
    <h2 className={styles.sectionTitle}>Your mailboxes</h2>
    <p className={styles.support}>Connect Gmail or Google Workspace, including your Hussh work email. Mail requests currently use the default mailbox.</p>
    {visible.error ? <p role="alert" className={styles.support}>{visible.error}</p> : visible.accounts.length === 0 ? <p className={styles.support}>No mailboxes connected.</p> : null}
    {visible.accounts.map((account, index) => <div key={account.accountId} className="flex flex-wrap items-center justify-between gap-2 border-b border-[color:var(--app-separator)] py-2 last:border-0">
      <div className="min-w-0"><p className="break-all text-sm">{account.email || `Google mailbox ${index + 1}`}</p><p className={styles.support}>{account.status === 'connected' ? 'Connected' : 'Reconnect needed'}{account.isDefault ? ' · Default mailbox' : ''}</p></div>
      <div className="flex gap-2"><MailActionButton disabled={busy} onClick={() => void connect(account)} className="min-h-11 px-2 text-sm text-[color:var(--app-accent)]">Reconnect</MailActionButton>
        <MailActionButton disabled={busy} onClick={() => void disconnect(account)} className="min-h-11 px-2 text-sm">Disconnect</MailActionButton></div>
    </div>)}
    <div className="flex flex-wrap gap-2"><MailActionButton disabled={busy || !!visible.error || visible.accounts.length >= 20} onClick={() => void connect()} className="min-h-11 px-3 text-sm text-[color:var(--app-accent)]">Add Google account</MailActionButton>
      <MailActionButton disabled={busy} onClick={() => setRevision(value => value + 1)} className="min-h-11 px-3 text-sm">Refresh</MailActionButton></div>
  </section>;
}
