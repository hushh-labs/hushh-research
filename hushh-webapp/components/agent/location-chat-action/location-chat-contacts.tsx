"use client";

import { useCallback, useId, useLayoutEffect, useRef } from "react";
import { CardTitle } from "@/components/app-ui/typography";
import { SurfaceCard, SurfaceCardContent, SurfaceCardHeader } from "@/components/app-ui/surfaces";
import { ContactDiscoverabilityConsentDialog } from "@/components/connections/contact-discoverability-consent-dialog";
import { ContactSyncResultsSheet } from "@/components/one-location/contact-sync-results-sheet";
import { Button } from "@/components/ui/button";
import { ContactInvitationSessionContext } from "@/lib/contacts/use-contact-invitations";
import { useContactSync } from "@/lib/contacts/use-contact-sync";
import { GoogleContactSyncSessionContext } from "@/lib/contacts/use-google-contact-sync-session";
import { useAuth } from "@/lib/firebase/auth-context";
import { rememberLocationInviteSource } from "@/lib/observability/growth";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";

const LOCATION_INVITE_COPY = {
  title: "Join me on Hushh",
  text: "Join me on Hushh so we can share location.",
  dialogTitle: "Invite to Hushh",
};

type Props = {
  ownerId: string;
  onBack: () => void;
  onChanged?: () => void;
};

export function LocationChatContacts(props: Props) {
  // Open results and invitations belong to this proposal, even if a new card
  // replaces it while Chat stays on the same route.
  return (
    <ContactInvitationSessionContext.Provider value={null}>
      <GoogleContactSyncSessionContext.Provider value={null}>
        <ContactDiscovery {...props} />
      </GoogleContactSyncSessionContext.Provider>
    </ContactInvitationSessionContext.Provider>
  );
}

function ContactDiscovery({ ownerId, onBack, onChanged }: Props) {
  const titleId = useId();
  const auth = useAuth();
  const authUser = auth.userId === ownerId ? auth.user : null;
  const lifetime = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    if (!authUser) controller.abort();
    const unsubscribe = subscribeVaultSessionEpoch(() => controller.abort());
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [authUser, ownerId]);

  const getSessionSignal = useCallback(() => lifetime.current?.signal, []);
  const getIdToken = useCallback(async () => {
    const signal = getSessionSignal();
    if (!signal || signal.aborted || !authUser) return null;
    const token = await authUser.getIdToken();
    return signal.aborted ? null : token;
  }, [authUser, getSessionSignal]);

  const sync = useContactSync({
    userId: authUser ? ownerId : null,
    routeId: "chat",
    accountEmail: authUser?.email,
    accountPhoneNumber: authUser ? auth.phoneNumber ?? authUser.phoneNumber : null,
    resolveVerifiedAccountPhoneNumber: authUser ? auth.resolveVerifiedPhoneNumber : undefined,
    getIdToken: authUser ? getIdToken : null,
    getSessionSignal,
    onConnectionGraphChanged: onChanged,
    onInviteShareStarted: () => rememberLocationInviteSource("contact_sync"),
    referralShare: LOCATION_INVITE_COPY,
  });

  return (
    <SurfaceCard role="region" aria-labelledby={titleId} className="w-full min-w-0">
      <SurfaceCardHeader className="flex items-center justify-between gap-3 space-y-0">
        <CardTitle as="h3" id={titleId}>Find contacts or invite someone</CardTitle>
        <Button size="sm" variant="outline" onClick={onBack}>Done</Button>
      </SurfaceCardHeader>
      <SurfaceCardContent className="space-y-3" aria-busy={sync.syncing || undefined}>
        <p className="text-sm text-muted-foreground">
          Check your contacts for people on Hushh, or share an invitation link.
        </p>
        {sync.signal.error ? <p role="alert" className="text-sm text-destructive">{sync.signal.error}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!authUser || !sync.available || sync.syncing} onClick={() => void sync.sync()}>
            {sync.googleFallback ? "Find Google contacts" : "Find contacts"}
          </Button>
          <Button size="sm" variant="outline" disabled={!authUser || sync.syncing} onClick={() => void sync.invite()}>
            Invite to Hushh
          </Button>
          {sync.signal.status === "denied" ? (
            <Button size="sm" variant="outline" disabled={!authUser || sync.syncing} onClick={() => void sync.openContactSettings()}>
              Open Contacts settings
            </Button>
          ) : null}
        </div>
        {!sync.available ? <p className="text-sm text-muted-foreground">Contact access depends on your device or signed-in Google account.</p> : null}
        <ContactSyncResultsSheet {...sync.resultsSheetProps} />
        <ContactDiscoverabilityConsentDialog {...sync.discoverabilityConsentDialogProps} />
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
