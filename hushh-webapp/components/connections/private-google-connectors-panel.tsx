'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SettingsGroup, SettingsRow } from '@/components/app-ui/settings-ui';
import { ConnectorVectorGlyph } from '@/components/agent/connector-brand-mark';
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
import {
  GOOGLE_APPS_CLEARANCE_NOTE,
  isProductionVisitorPostureEnabled,
} from '@/lib/agent/production-visitor-posture';
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from '@/lib/auth/session-owner';
import { calendarPermissionRows } from '@/lib/calendar/calendar-permissions';
import {
  DEFAULT_POD_BACKGROUND_CONFIG,
  readPodBackgroundConfig,
  setConnectorBackgroundPrep,
  type PodBackgroundConfig,
} from '@/lib/services/pod-background-config';

const LABELS: Record<GoogleConnector, string> = { gmail: 'Gmail', calendar: 'Google Calendar', drive: 'Google Drive', contacts: 'Google Contacts' };
type Status = 'connected' | 'needs_reauth' | 'absent' | 'unavailable';

export function usePrivateGoogleConnectorsModel({ open, visitKey }: { open: boolean; visitKey?: string | null }) {
  const { userId } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const vaultEpoch = snapshotVaultSessionEpoch();
  const transition = useGoogleConnectorTransitionReview(userId ?? undefined, vaultEpoch);
  const { confirmTransition, cancelTransition } = transition;
  const auth = snapshotValidatedAuthSessionOwner();
  const authUserId = auth?.userId, authGeneration = auth?.generation;
  const visit = useMemo(() => ({ open, uid: userId, vaultEpoch, visitKey,
    auth: authUserId && authGeneration !== undefined ? { userId: authUserId, generation: authGeneration } : null,
  }), [open, userId, vaultEpoch, authUserId, authGeneration, visitKey]);
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
  const [backgroundConfig, setBackgroundConfig] = useState<PodBackgroundConfig>(DEFAULT_POD_BACKGROUND_CONFIG);
  const [backgroundBusy, setBackgroundBusy] = useState<GoogleConnector | null>(null);
  const enabled = Boolean(open && userId && vaultKey && vaultOwnerToken);
  const activeDetailConnector = GOOGLE_CONNECTORS.find(item => item === visitKey) ?? null;
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
  useLayoutEffect(() => { setStatuses({}); setManaged({}); setReadable({}); setBusy(null); setMessage(''); setHandoff(null); setBackgroundBusy(null); }, [visit]);
  useEffect(() => { if (!open) cancelTransition(); }, [open, cancelTransition]);
  useEffect(() => () => cancelTransition(), [visit, cancelTransition]);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);
  useEffect(() => {
    if (!enabled || !activeDetailConnector || !isCurrent()) return;
    const controller = new AbortController();
    void readPodBackgroundConfig({ signal: controller.signal, isCurrent })
      .then(cfg => { if (cfg && isCurrent()) setBackgroundConfig(cfg); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [enabled, activeDetailConnector, isCurrent]);
  const changeBackgroundPrep = async (connector: GoogleConnector, next: boolean) => {
    if (!enabled || !isCurrent() || backgroundBusy !== null) return;
    const current = isCurrent;
    setBackgroundBusy(connector);
    setMessage('');
    try {
      const updated = await setConnectorBackgroundPrep(connector, next, { isCurrent: current });
      if (current()) setBackgroundConfig(updated);
    } catch {
      if (current()) setMessage('Agent One could not update background settings. Try again.');
    } finally {
      if (current()) setBackgroundBusy(null);
    }
  };
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
    } catch { if (current()) setMessage('Agent One could not be reached. Try again.'); }
    finally { if (pending.current === operation) { pending.current = null; if (current()) setBusy(null); } }
  };
  const entries = GOOGLE_CONNECTORS.map(connector => {
    const status = statuses[connector] === 'connected' ? ((connector === 'gmail' || connector === 'calendar') ? managed[connector] ? 'Connected · changes allowed after your confirmation' : readable[connector] ? 'Connected · reading only' : 'Connected · permissions need verification' : 'Connected to Agent One') :
      statuses[connector] === 'needs_reauth' ? 'Sign in again' : statuses[connector] === 'unavailable' ? 'Your agent could not verify this connection' : statuses[connector] ? 'Not connected' : 'Checking connection…';
    const lockedDown = backgroundConfig.sessionOnlyLockdown;
    const bgEnabled = !lockedDown && backgroundConfig.backgroundPrepEnabled && backgroundConfig.connectors[connector];
    return { connector, label: LABELS[connector], status, purpose: connectorAccessPurpose(connector), connected: statuses[connector] === 'connected',
      permissions: connector === 'calendar' && statuses[connector] === 'connected'
        ? calendarPermissionRows({ read: readable[connector] === true, manage: managed[connector] === true }) : [],
      allowChanges: statuses[connector] === 'connected' && (connector === 'gmail' || connector === 'calendar') && !managed[connector],
      backgroundPrep: {
        enabled: lockedDown ? null : bgEnabled,
        busy: backgroundBusy === connector,
        description: lockedDown
          ? 'Paused while Session-only lockdown is on in Hosting.'
          : bgEnabled
            ? 'On · Quietly prepares drafts and durable takeaways while you are away.'
            : 'Off · Used only when you ask in chat.',
        change: (next: boolean) => { void changeBackgroundPrep(connector, next); },
      } };
  });
  return { open, enabled, entries, busy, message, handoff, refresh, run, transition, isCurrent };
}

export type PrivateGoogleConnectorsModel = ReturnType<typeof usePrivateGoogleConnectorsModel>;

export function PrivateGoogleConnectorsPanel(props: {
  open: boolean; onBack: () => void; onClose?: () => void; surface?: 'drawer' | 'profile';
  showAccessDetails?: boolean; model?: PrivateGoogleConnectorsModel;
  onSelectConnector?: (connector: GoogleConnector) => void;
}) {
  return props.model ? <PrivateGoogleConnectorsView {...props} model={props.model} /> : <OwnedPrivateGoogleConnectorsPanel {...props} />;
}
function OwnedPrivateGoogleConnectorsPanel(props: Parameters<typeof PrivateGoogleConnectorsPanel>[0]) {
  return <PrivateGoogleConnectorsView {...props} model={usePrivateGoogleConnectorsModel(props)} />;
}
function PrivateGoogleConnectorsView({ open, onBack, onClose, surface, showAccessDetails = false, onSelectConnector, model }: Parameters<typeof PrivateGoogleConnectorsPanel>[0] & { model: PrivateGoogleConnectorsModel }) {
  const { enabled, busy, message, handoff, refresh, run, entries, transition: { transitionDialog } } = model;
  if (!open) return null;
  const progressiveDisclosure = Boolean(onSelectConnector);
  return <section className="space-y-3" data-testid="private-google-connectors">
    {surface !== 'profile' && <Button variant="ghost" onClick={onClose ?? onBack}>Back</Button>}
    {surface !== 'profile' ? <p className="text-sm text-muted-foreground">Connect Google directly to Agent One. Your agent asks you to confirm changes.</p> : null}
    {isProductionVisitorPostureEnabled() ? <p role="note" data-testid="connector-google-clearance-note" className="text-xs leading-5 text-muted-foreground">{GOOGLE_APPS_CLEARANCE_NOTE}</p> : null}
    {!enabled && <p role="status" className="px-1 text-xs text-muted-foreground">Sign in and unlock your vault to connect Google.</p>}
    <SettingsGroup title="Google Workspace" separatorInset>
      {entries.map(({ connector, status, connected, allowChanges }) => {
        const rowDescription = showAccessDetails ? (
          <><span>{status}</span><span className="block pt-0.5">{connectorAccessPurpose(connector)}</span></>
        ) : status;
        if (progressiveDisclosure && onSelectConnector) {
          return (
            <SettingsRow
              key={connector}
              testId={`private-connector-row-${connector}`}
              leading={<ConnectorVectorGlyph id={connector} variant="profile" />}
              title={LABELS[connector]}
              description={rowDescription}
              textOverflow={showAccessDetails ? undefined : 'truncate'}
              onClick={() => onSelectConnector(connector)}
              chevron
            />
          );
        }
        return (
          <SettingsRow
            key={connector}
            testId={`private-connector-row-${connector}`}
            leading={<ConnectorVectorGlyph id={connector} variant="profile" />}
            title={LABELS[connector]}
            textOverflow={showAccessDetails ? undefined : 'truncate'}
            description={rowDescription}
            trailing={
              <div className="flex items-center gap-2" onClick={event => event.stopPropagation()}>
                {allowChanges && <Button variant="outline" size="row" data-connector-action="primary" disabled={!enabled || busy !== null} onClick={() => void run(connector, false)}>Allow changes</Button>}
                <Button variant="outline" size="row" data-connector-action={connected ? 'destructive' : 'secondary'} disabled={!enabled || busy !== null}
                  onClick={() => void run(connector, connected)}>
                  {busy === connector ? 'Working…' : connected ? 'Disconnect' : 'Connect'}
                </Button>
              </div>
            }
          />
        );
      })}
    </SettingsGroup>
    {handoff && <GoogleConnectorPhoneHandoff handoff={handoff} />}
    {message && <p role="status" className="px-1 text-xs text-muted-foreground">{message}</p>}
    {handoff && <Button variant="outline" size="compact" onClick={() => void refresh()}>Check connection</Button>}
    {transitionDialog}
  </section>;
}
