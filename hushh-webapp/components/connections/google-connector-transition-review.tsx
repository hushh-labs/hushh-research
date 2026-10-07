'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ShellActionSurface } from '@/components/app-ui/shell-action-surface';
import { isVaultSessionEpochCurrent } from '@/lib/vault/session-epoch';
import type { GoogleConnectorTransitionReview } from '@/lib/one/google-native-connect';

const LABELS = { gmail: 'Gmail', calendar: 'Calendar', drive: 'Drive', contacts: 'Contacts' } as const;

/** The caller supplies current owner context; no credential enters dialog state. */
export function useGoogleConnectorTransitionReview(ownerId: string | undefined, vaultEpoch: number) {
  const identity = useRef({ ownerId, vaultEpoch });
  useLayoutEffect(() => { identity.current = { ownerId, vaultEpoch }; }, [ownerId, vaultEpoch]);
  const pending = useRef<{ ownerId: string; vaultEpoch: number; resolve: (approved: boolean) => void } | null>(null);
  const [terms, setTerms] = useState<GoogleConnectorTransitionReview | null>(null);
  const settle = useCallback((approved: boolean) => {
    const request = pending.current;
    pending.current = null;
    setTerms(null);
    if (!request) return;
    request.resolve(approved && identity.current.ownerId === request.ownerId &&
      identity.current.vaultEpoch === request.vaultEpoch && isVaultSessionEpochCurrent(request.vaultEpoch));
  }, []);
  useEffect(() => {
    return () => {
      const request = pending.current;
      pending.current = null;
      request?.resolve(false);
    };
  }, [ownerId, vaultEpoch]);
  useEffect(() => { setTerms(null); }, [ownerId, vaultEpoch]);
  const confirmTransition = useCallback((review: GoogleConnectorTransitionReview): Promise<boolean> => {
    if (!ownerId || identity.current.ownerId !== ownerId || identity.current.vaultEpoch !== vaultEpoch ||
        !isVaultSessionEpochCurrent(vaultEpoch) || pending.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      pending.current = { ownerId, vaultEpoch, resolve };
      setTerms(review);
    });
  }, [ownerId, vaultEpoch]);
  const transitionDialog = <Dialog open={terms !== null} onOpenChange={(open) => { if (!open) settle(false); }}>
    <DialogContent>
      <DialogHeader className="pr-8 text-left">
        <DialogTitle>Replace Google access?</DialogTitle>
        <DialogDescription>This replaces all Google grants in the affected Google projects. Existing Google connections, including your private agent, will need sign-in again.</DialogDescription>
      </DialogHeader>
      {terms && <p className="text-sm">{terms.services.map((service) => LABELS[service]).join(', ')}</p>}
      <DialogFooter>
        <ShellActionSurface variant="pill" className="min-h-11" onClick={() => settle(false)}>Not now</ShellActionSurface>
        <ShellActionSurface variant="pill" className="min-h-11" onClick={() => settle(true)}>Replace and sign in</ShellActionSurface>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
  const cancelTransition = useCallback(() => settle(false), [settle]);
  return { confirmTransition, transitionDialog, transitionPending: terms !== null, cancelTransition };
}
