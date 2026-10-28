'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { connectorAccessPurpose } from '@/lib/agent/connector-access-copy';
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from '@/lib/auth/session-owner';

const LABELS: Record<GoogleConnector, string> = { gmail: 'Gmail', calendar: 'Google Calendar', drive: 'Google Drive', contacts: 'Google Contacts' };
type Status = 'connected' | 'needs_reauth' | 'absent' | 'unavailable';

export function usePrivateGoogleConnectorsModel({ open, visitKey }: { open: boolean; visitKey?: string | null }) {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const vaultEpoch = snapshotVaultSessionEpoch();
  const transition = useGoogleConnectorTransitionReview(user?.uid, vaultEpoch);
  const { confirmTransition, cancelTransition } = transition;
  const auth = snapshotValidatedAuthSessionOwner();
  const authUserId = auth?.userId, authGeneration = auth?.generation;
  const visit = useMemo(() => ({ open, uid: user?.uid, vaultEpoch, visitKey,
    auth: authUserId && authGeneration !== undefined ? { userId: authUserId, generation: authGeneration } : null,
  }), [open, user?.uid, vaultEpoch, authUserId, authGeneration, visitKey]);
  const live = useRef<typeof visit | null>(null);
  const pending = useRef<object | null>(null);
  const reads = useRef(0);
  useLayoutEffect(() => { live.current = visit; pending.current = null; return () => { if (live.current === visit) live.current = null; }; }, [visit]);
  const isCurrent = useCallback(() => live.current === visit && visit.open && !!visit.auth && isValidatedAuthSessionOwnerCurrent(visit.auth) && isVaultSessionEpochCurrent(visit.vaultEpoch), [visit]);
  const [statuses, setStatuses] = useState<Partial<Record<GoogleConnector, Status>>>({});
  const [readable, setReadable] = useState<Partial<Record<GoogleConnector, boolean>>>({});
  const [managed, setManaged] = useState<Partial<Record<GoogleConnector, boolean>>>({});
  const [busy, setBusy] = useState<GoogleConnector | null>(null);
  const [message, setMessage] = useState('');
  const [handoff, setHandoff] = useState<PhoneHandoff | null>(null);
  const enabled = Boolean(open && user?.uid && vaultKey && vaultOwnerToken);
  const refresh = useCallback(async () => {
    if (!enabled || !isCurrent()) return;
    const sequence = ++reads.current;
    const rows = await Promise.all(GOOGLE_CONNECTORS.map(async (connector) => {
      try {
        const result = await privateGoogleStatus(connector);
        return [connector, result.status, result.capabilities.manage, result.capabilities.read] as const;
      } catch { return [connector, 'unavailable', false, false] as const; }
    }));
    if (isCurrent() && reads.current === sequence) {
      setStatuses(Object.fromEntries(rows.map(([connector, status]) => [connector, status])));
      setManaged(Object.fromEntries(rows.map(([connector, , manage]) => [connector, manage])));
      setReadable(Object.fromEntries(rows.map(([connector, , , read]) => [connector, read])));
    }
  }, [enabled, isCurrent]);
  useLayoutEffect(() => { setStatuses({}); setManaged({}); setReadable({}); setBusy(null); setMessage(''); setHandoff(null); }, [visit]);
  useEffect(() => { if (!open) cancelTransition(); }, [open, cancelTransition]);
  useEffect(() => () => cancelTransition(), [visit, cancelTransition]);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  const run = async (connector: GoogleConnector, disconnect: boolean) => {
    if (!enabled || !isCurrent() || pending.current) return;
    const operation = {}; pending.current = operation;
    const current = isCurrent;
    setBusy(connector); setMessage(''); setHandoff(null);
    try {
      if (disconnect) {
        const response = await ApiService.ownerPodRequest(`connectors/${connector}`, { method: 'DELETE' });
        if (!response.ok) throw new Error('AGENT_UNREACHABLE');
      } else {
        const outcome = await connectGoogleConnector(connector, { vaultOwnerCapability: vaultOwnerToken,
          confirmLegacyTransition: terms => current() ? confirmTransition(terms, connector === 'calendar' ? 'calendar' : undefined) : Promise.resolve(false), isCurrent: current });
        if (!current()) return;
        if (!outcome.ok) {
          if ('handoff' in outcome) setHandoff(outcome.handoff);
          else setMessage(connectRefusalMessage(outcome.code, LABELS[connector]));
          return;
        }
        if (outcome.legacyCleanup === 'unconfirmed') setMessage('Google connected. The previous connection still needs verification.');
      }
      if (current()) await refresh();
    } catch { if (current()) setMessage('Your private agent could not be reached. Try again.'); }
    finally { if (pending.current === operation) { pending.current = null; if (current()) setBusy(null); } }
  };
  const entries = GOOGLE_CONNECTORS.map(connector => {
    const status = statuses[connector] === 'connected' ? ((connector === 'gmail' || connector === 'calendar') ? managed[connector] ? 'Connected · changes allowed after your confirmation' : readable[connector] ? 'Connected · reading only' : 'Connected · permissions need verification' : 'Connected to your private agent') :
      statuses[connector] === 'needs_reauth' ? 'Sign in again' : statuses[connector] === 'unavailable' ? 'Your agent could not verify this connection' : statuses[connector] ? 'Not connected' : 'Checking connection…';
    return { connector, label: LABELS[connector], status, purpose: connectorAccessPurpose(connector), connected: statuses[connector] === 'connected',
      allowChanges: statuses[connector] === 'connected' && (connector === 'gmail' || connector === 'calendar') && !managed[connector] };
  });
  return { open, enabled, entries, busy, message, handoff, refresh, run, transition, isCurrent };
}

export type PrivateGoogleConnectorsModel = ReturnType<typeof usePrivateGoogleConnectorsModel>;

export function PrivateGoogleConnectorsPanel(props: {
  open: boolean; onBack: () => void; onClose?: () => void; surface?: 'drawer' | 'profile';
  showAccessDetails?: boolean; model?: PrivateGoogleConnectorsModel;
}) {
  return props.model ? <PrivateGoogleConnectorsView {...props} model={props.model} /> : <OwnedPrivateGoogleConnectorsPanel {...props} />;
}
function OwnedPrivateGoogleConnectorsPanel(props: Parameters<typeof PrivateGoogleConnectorsPanel>[0]) {
  return <PrivateGoogleConnectorsView {...props} model={usePrivateGoogleConnectorsModel(props)} />;
}
function PrivateGoogleConnectorsView({ open, onBack, onClose, surface, showAccessDetails = false, model }: Parameters<typeof PrivateGoogleConnectorsPanel>[0] & { model: PrivateGoogleConnectorsModel }) {
  const { enabled, busy, message, handoff, refresh, run, entries, transition: { transitionDialog } } = model;
  if (!open) return null;
  return <section className="space-y-4" data-testid="private-google-connectors">
    {surface !== 'profile' && <Button variant="ghost" onClick={onClose ?? onBack}>Back</Button>}
    <p className="text-sm text-muted-foreground">Connect Google directly to your private agent. Gmail includes reading, drafts, sending and mailbox changes; your agent asks you to confirm changes.</p>
    {!enabled && <p role="status" className="text-sm">Sign in and unlock your vault to connect Google.</p>}
    <SettingsGroup>
      {entries.map(({ connector, status, connected, allowChanges }) => {
        return <SettingsRow key={connector} title={LABELS[connector]}
        description={showAccessDetails ? <><span>{status}</span><span className="block pt-1">{connectorAccessPurpose(connector)}</span></> : status}
        trailing={<div className="flex gap-2">
          {allowChanges && <Button variant="outline" disabled={!enabled || busy !== null} onClick={() => void run(connector, false)}>Allow changes</Button>}
          <Button variant="outline" disabled={!enabled || busy !== null}
          onClick={() => void run(connector, connected)}>
          {busy === connector ? 'Working…' : connected ? 'Disconnect' : 'Connect'}
        </Button></div>} />; })}
    </SettingsGroup>
    {handoff && <GoogleConnectorPhoneHandoff handoff={handoff} />}
    {message && <p role="status" className="text-sm">{message}</p>}
    {handoff && <Button variant="outline" onClick={() => void refresh()}>Check connection</Button>}
    {transitionDialog}
  </section>;
}
