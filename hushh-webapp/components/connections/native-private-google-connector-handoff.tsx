'use client';

import { snapshotVaultSessionEpoch, isVaultSessionEpochCurrent } from '@/lib/vault/session-epoch';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { useVault } from '@/lib/vault/vault-context';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ApiService } from '@/lib/services/api-service';
import { ROUTES } from '@/lib/navigation/routes';
import { googleConnectorIntent, GOOGLE_CONNECTOR_HANDOFF_EVENT } from '@/lib/one/google-connector-intent';
import { connectGoogleConnector, connectRefusalMessage } from '@/lib/one/google-native-connect';
import { GoogleConnectorPhoneHandoff } from './google-connector-phone-handoff';
import { phoneHandoff } from '@/lib/one/google-native-connect';
import type { GoogleConnector } from '@/lib/one/connector-credential-seal';
import { useGoogleConnectorTransitionReview } from './google-connector-transition-review';

/** Only an intent arrives. The phone supplies its own auth, unlock and signed pod admission. */
export function NativePrivateGoogleConnectorHandoff() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const { confirmTransition, transitionDialog, transitionPending, cancelTransition } = useGoogleConnectorTransitionReview(user?.uid, snapshotVaultSessionEpoch());
  const [connector, setConnector] = useState<GoogleConnector | null>(null);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const intentEpoch = useRef(0);
  const owner = useRef(user?.uid);
  owner.current = user?.uid;
  useEffect(() => {
    const receive = (event: Event) => {
      const detail: unknown = (event as CustomEvent).detail;
      const next = typeof detail === 'string' ? googleConnectorIntent(detail) : null;
      if (next) { intentEpoch.current += 1; cancelTransition(); setConnector(next); setMessage(''); setPaused(false); setBusy(false); }
    };
    window.addEventListener(GOOGLE_CONNECTOR_HANDOFF_EVENT, receive);
    return () => window.removeEventListener(GOOGLE_CONNECTOR_HANDOFF_EVENT, receive);
  }, [cancelTransition]);
  useEffect(() => { if (user && vaultKey && vaultOwnerToken) setPaused(false); }, [user, vaultKey, vaultOwnerToken]);
  useLayoutEffect(() => { setMessage(''); setBusy(false); }, [user?.uid, vaultKey, vaultOwnerToken]);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let disposed = false;
    let remove: (() => void) | undefined;
    let liveArrival = false;
    const consume = (raw: string) => {
      const next = googleConnectorIntent(raw);
      if (next && !disposed) { intentEpoch.current += 1; cancelTransition(); setConnector(next); setMessage(''); setBusy(false); }
    };
    void import('@capacitor/app').then(async ({ App }) => {
      const listener = await App.addListener('appUrlOpen', (event) => { liveArrival = true; consume(event.url); });
      if (disposed) { void listener.remove(); return; }
      remove = () => { void listener.remove(); };
      const launched = await App.getLaunchUrl();
      if (launched?.url && !liveArrival) consume(launched.url);
    }).catch(() => undefined);
    return () => { disposed = true; remove?.(); };
  }, [cancelTransition]);
  const connect = async () => {
    const uid = user?.uid;
    if (!connector || !uid || !vaultKey || !vaultOwnerToken || busy) return;
    const epoch = snapshotVaultSessionEpoch();
    const intent = intentEpoch.current;
    const current = () => owner.current === uid && intentEpoch.current === intent && isVaultSessionEpochCurrent(epoch);
    setBusy(true); setMessage('');
    try {
      const outcome = await connectGoogleConnector(connector, { isCurrent: current, vaultOwnerCapability: vaultOwnerToken,
        confirmLegacyTransition: confirmTransition });
      if (!current()) return;
      if (!outcome.ok) { setMessage(connectRefusalMessage(outcome.code, connector)); return; }
      const response = await ApiService.ownerPodRequest(`connectors/${connector}`, { method: 'GET' });
      const confirmed = await response.json() as { connectorId?: string; status?: string };
      if (!current()) return;
      setMessage(response.ok && confirmed.connectorId === connector && confirmed.status === 'connected'
        ? outcome.legacyCleanup === 'unconfirmed' ? 'Google connected. The previous connection still needs verification.' : 'Google is connected to your private agent.'
        : 'Your agent could not confirm the connection. Try again.');
    } catch { if (current()) setMessage('Your private agent could not be reached. Try again.'); }
    finally { if (current()) setBusy(false); }
  };
  return <><Dialog open={connector !== null && !paused && !transitionPending} onOpenChange={(open) => { if (!open && !busy) { intentEpoch.current += 1; setConnector(null); setMessage(''); } }}>
    <DialogContent>
      <DialogTitle>Connect {connector === 'gmail' ? 'Gmail' : `Google ${connector ?? ''}`}</DialogTitle>
      <DialogDescription>This phone connects to the private agent of the account signed in here. The scanned link carries only the connector name.</DialogDescription>
      {!Capacitor.isNativePlatform() && connector ? <GoogleConnectorPhoneHandoff handoff={phoneHandoff(connector)} /> : !loading && !user ? <Button onClick={() => { setPaused(true); router.push(ROUTES.LOGIN); }}>Sign in on this phone</Button> :
        !vaultKey || !vaultOwnerToken ? <Button disabled={loading} onClick={() => { setPaused(true); router.push(ROUTES.PROFILE_CONNECTORS); }}>Unlock your vault</Button> :
          <Button disabled={busy} onClick={() => void connect()}>{busy ? 'Connecting…' : 'Continue with Google'}</Button>}
      {message && <p role="status" className="text-sm">{message}</p>}
    </DialogContent>
  </Dialog>{transitionDialog}</>;
}
