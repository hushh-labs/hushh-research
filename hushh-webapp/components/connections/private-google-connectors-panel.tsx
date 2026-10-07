'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SettingsGroup, SettingsRow } from '@/components/app-ui/settings-ui';
import { useAuth } from '@/hooks/use-auth';
import { useVault } from '@/lib/vault/vault-context';
import { ApiService } from '@/lib/services/api-service';
import { privateGoogleStatus } from '@/lib/services/private-google-connections';
import { GOOGLE_CONNECTORS, type GoogleConnector } from '@/lib/one/connector-credential-seal';
import { connectGoogleConnector, connectRefusalMessage, type PhoneHandoff } from '@/lib/one/google-native-connect';
import { GoogleConnectorPhoneHandoff } from './google-connector-phone-handoff';
import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from '@/lib/vault/session-epoch';
import { useGoogleConnectorTransitionReview } from './google-connector-transition-review';

const LABELS: Record<GoogleConnector, string> = { gmail: 'Gmail', calendar: 'Google Calendar', drive: 'Google Drive', contacts: 'Google Contacts' };
type Status = 'connected' | 'needs_reauth' | 'absent' | 'unavailable';

export function PrivateGoogleConnectorsPanel({ open, onBack, onClose, surface }: {
  open: boolean; onBack: () => void; onClose?: () => void; surface?: 'drawer' | 'profile';
}) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const vaultEpoch = snapshotVaultSessionEpoch();
  const { confirmTransition, transitionDialog, cancelTransition } = useGoogleConnectorTransitionReview(user?.uid, vaultEpoch);
  const owner = useRef(user?.uid);
  owner.current = user?.uid;
  const visible = useRef(open);
  useLayoutEffect(() => { visible.current = open; return () => { visible.current = false; }; }, [open]);
  const [statuses, setStatuses] = useState<Partial<Record<GoogleConnector, Status>>>({});
  const [readable, setReadable] = useState<Partial<Record<GoogleConnector, boolean>>>({});
  const [managed, setManaged] = useState<Partial<Record<GoogleConnector, boolean>>>({});
  const [busy, setBusy] = useState<GoogleConnector | null>(null);
  const [message, setMessage] = useState('');
  const [handoff, setHandoff] = useState<PhoneHandoff | null>(null);
  const enabled = Boolean(user?.uid && vaultKey && vaultOwnerToken);
  const refresh = useCallback(async () => {
    const uid = user?.uid;
    if (!enabled || !uid) return;
    const epoch = snapshotVaultSessionEpoch();
    const rows = await Promise.all(GOOGLE_CONNECTORS.map(async (connector) => {
      try {
        const result = await privateGoogleStatus(connector);
        return [connector, result.status, result.capabilities.manage, result.capabilities.read] as const;
      } catch { return [connector, 'unavailable', false, false] as const; }
    }));
    if (owner.current === uid && isVaultSessionEpochCurrent(epoch)) {
      setStatuses(Object.fromEntries(rows.map(([connector, status]) => [connector, status])));
      setManaged(Object.fromEntries(rows.map(([connector, , manage]) => [connector, manage])));
      setReadable(Object.fromEntries(rows.map(([connector, , , read]) => [connector, read])));
    }
  }, [enabled, user?.uid]);
  useLayoutEffect(() => { setStatuses({}); setManaged({}); setReadable({}); setBusy(null); setMessage(''); setHandoff(null); }, [user?.uid, vaultEpoch]);
  useEffect(() => { if (!open) cancelTransition(); }, [open, cancelTransition]);
  useEffect(() => { if (open) void refresh(); }, [open, refresh, vaultEpoch]);
  const run = async (connector: GoogleConnector, disconnect: boolean) => {
    const uid = user?.uid;
    if (!enabled || !uid || busy) return;
    const epoch = snapshotVaultSessionEpoch();
    const current = () => visible.current && owner.current === uid && isVaultSessionEpochCurrent(epoch);
    setBusy(connector); setMessage(''); setHandoff(null);
    try {
      if (disconnect) {
        const response = await ApiService.ownerPodRequest(`connectors/${connector}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('AGENT_UNREACHABLE');
      } else {
        const outcome = await connectGoogleConnector(connector, { vaultOwnerCapability: vaultOwnerToken,
          confirmLegacyTransition: confirmTransition, isCurrent: current });
        if (!current()) return;
        if (!outcome.ok) {
          if ('handoff' in outcome) setHandoff(outcome.handoff);
          else setMessage(connectRefusalMessage(outcome.code, LABELS[connector]));
          return;
        }
        if (outcome.legacyCleanup === 'unconfirmed') setMessage('Google connected. The previous connection still needs verification.');
      }
      // A mutation receipt is not status proof. Read back from the authenticated pod.
      if (!current()) return;
      await refresh();
    } catch { if (current()) setMessage('Your private agent could not be reached. Try again.'); }
    finally { if (current()) setBusy(null); }
  };
  if (!open) return null;
  return <section className="space-y-4" data-testid="private-google-connectors">
    {surface !== 'profile' && <Button variant="ghost" onClick={onClose ?? onBack}>Back</Button>}
    <p className="text-sm text-muted-foreground">Connect Google directly to your private agent. Gmail includes reading, drafts, sending and mailbox changes; your agent asks you to confirm changes.</p>
    {!enabled && <p role="status" className="text-sm">Sign in and unlock your vault to connect Google.</p>}
    <SettingsGroup>
      {GOOGLE_CONNECTORS.map((connector) => <SettingsRow key={connector} title={LABELS[connector]}
        description={statuses[connector] === 'connected' ? ((connector === 'gmail' || connector === 'calendar') ? managed[connector] ? 'Connected · changes allowed after your confirmation' : readable[connector] ? 'Connected · reading only' : 'Connected · permissions need verification' : 'Connected to your private agent') :
          statuses[connector] === 'needs_reauth' ? 'Sign in again' : statuses[connector] === 'unavailable' ? 'Your agent could not verify this connection' : 'Not connected'}
        trailing={<div className="flex gap-2">
          {statuses[connector] === 'connected' && (connector === 'gmail' || connector === 'calendar') && !managed[connector] && <Button variant="outline" disabled={!enabled || busy !== null} onClick={() => void run(connector, false)}>Allow changes</Button>}
          <Button variant="outline" disabled={!enabled || busy !== null}
          onClick={() => void run(connector, statuses[connector] === 'connected')}>
          {busy === connector ? 'Working…' : statuses[connector] === 'connected' ? 'Disconnect' : 'Connect'}
        </Button></div>} />)}
    </SettingsGroup>
    {handoff && <GoogleConnectorPhoneHandoff handoff={handoff} />}
    {message && <p role="status" className="text-sm">{message}</p>}
    {handoff && <Button variant="outline" onClick={() => void refresh()}>Check connection</Button>}
    {transitionDialog}
  </section>;
}
