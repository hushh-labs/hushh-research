'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ShellActionSurface } from '@/components/app-ui/shell-action-surface';
import { isVaultSessionEpochCurrent } from '@/lib/vault/session-epoch';
import type { GoogleConnectorTransitionReview } from '@/lib/one/google-native-connect';
import calendarPresentation from '@/components/calendar/calendar-presentation.module.css';

const LABELS = { gmail: 'Gmail', calendar: 'Calendar', drive: 'Drive', contacts: 'Contacts' } as const;

/** The caller supplies current owner context; no credential enters dialog state. */
export function useGoogleConnectorTransitionReview(ownerId: string | undefined, vaultEpoch: number) {
  const identity = useRef({ ownerId, vaultEpoch });
  useLayoutEffect(() => { identity.current = { ownerId, vaultEpoch }; }, [ownerId, vaultEpoch]);
  type Request = { ownerId: string; vaultEpoch: number; resolve: (approved: boolean) => void };
  const pending = useRef<Request | null>(null);
  const [terms, setTerms] = useState<{ review: GoogleConnectorTransitionReview; presentation?: 'calendar'; request: Request } | null>(null);
  const settle = useCallback((approved: boolean, expected: Request | null) => {
    const request = pending.current;
    if (!request || request !== expected) return;
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
  const confirmTransition = useCallback((review: GoogleConnectorTransitionReview, presentation?: 'calendar'): Promise<boolean> => {
    if (!ownerId || identity.current.ownerId !== ownerId || identity.current.vaultEpoch !== vaultEpoch ||
        !isVaultSessionEpochCurrent(vaultEpoch) || pending.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      const request = { ownerId, vaultEpoch, resolve };
      pending.current = request;
      setTerms({ review, presentation, request });
    });
  }, [ownerId, vaultEpoch]);
  const cancelReview = () => settle(false, terms?.request ?? null);
  const approveTransition = () => settle(true, terms?.request ?? null);
  const transitionDialog = <Dialog open={terms !== null} onOpenChange={(open) => { if (!open) cancelReview(); }}>
    <DialogContent className={terms?.presentation === 'calendar' ? calendarPresentation.portal : undefined} data-calendar-presentation={terms?.presentation === 'calendar' || undefined}>
      <DialogHeader className="pr-8 text-left">
        <DialogTitle>Replace Google access?</DialogTitle>
        <DialogDescription>This replaces all Google grants in the affected Google projects. Existing Google connections, including your private agent, will need sign-in again.</DialogDescription>
      </DialogHeader>
      {terms && <p className="text-sm">{terms.review.services.map((service) => LABELS[service]).join(', ')}</p>}
      <DialogFooter>
        <ShellActionSurface variant="pill" className={terms?.presentation === 'calendar' ? `${calendarPresentation.utility} !border-transparent !bg-transparent !shadow-none` : 'min-h-11'} onClick={cancelReview}>Not now</ShellActionSurface>
        <ShellActionSurface variant="pill" className={terms?.presentation === 'calendar' ? 'min-h-11 !border-transparent !bg-[color:var(--app-accent)] !text-[color:var(--app-accent-fg)] !shadow-none hover:!bg-[color:var(--app-accent-hover)]' : 'min-h-11'} rippleEffect={terms?.presentation === 'calendar' ? 'fill' : 'glass'} onClick={approveTransition}>Replace and sign in</ShellActionSurface>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
  const cancelTransition = useCallback(() => settle(false, pending.current), [settle]);
  return { confirmTransition, transitionDialog, transitionPending: terms !== null, cancelTransition,
    review: terms?.review ?? null, approveTransition, cancelReview };
}
