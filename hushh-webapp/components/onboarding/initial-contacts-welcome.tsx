"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { User } from "firebase/auth";
import { toast } from "sonner";
import { AppPageShell, AppPageHeaderRegion, AppPageContentRegion } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { ContactInvitationSheet } from "@/components/connections/contact-invitation-sheet";
import { CircleInvitePeopleSheet } from "@/components/one-location/redesign/circles/circle-grow-actions";
import { createConnectCircleActions } from "@/components/connect/circles/connect-circle-actions";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { useInitialContacts } from "./initial-contacts-bridge";
import { InitialContactsOnboardingService as InitialContacts } from "@/lib/services/initial-contacts-onboarding-service";
import { useContactInvitationSession } from "@/lib/contacts/use-contact-invitations";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationCircleOverview, OneLocationCircleMember } from "@/lib/one-location/types";
import { ReferralService } from "@/lib/services/referral-service";
import { buildInviteToOneShare } from "@/lib/connect/invite-to-one";
import { shareLink } from "@/lib/share/share-link";
import { ROUTES, initialContactsWelcomeDestination } from "@/lib/navigation/routes";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { snapshotValidatedAuthSessionOwner, isValidatedAuthSessionOwnerCurrent } from "@/lib/auth/session-owner";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import type { InvitationShare } from "@/lib/services/contact-invitations-service";

export function InitialContactsWelcome() {
  const { user } = useAuth();
  const { vaultOwnerToken } = useVault();
  return <VaultLockGuard>{user && vaultOwnerToken
    ? <WelcomeForOwner key={user.uid} user={user} vaultOwnerToken={vaultOwnerToken} />
    : <HushhLoader variant="page" />}</VaultLockGuard>;
}

function WelcomeForOwner({ user, vaultOwnerToken }: { user: User; vaultOwnerToken: string }) {
  const router = useRouter();
  const query = useSearchParams();
  useInitialContacts();
  const snapshot = InitialContacts.snapshotForOwner(user.uid);
  const authOwner = useMemo(() => {
    const owner = snapshotValidatedAuthSessionOwner();
    return owner?.userId === user.uid ? owner : null;
  }, [user]);
  const currentOwner = useCallback(() => Boolean(authOwner && authOwner.userId === user.uid
    && isValidatedAuthSessionOwnerCurrent(authOwner)), [authOwner, user.uid]);
  const [overview, setOverview] = useState<OneLocationCircleOverview | null>(null);
  const [members, setMembers] = useState<OneLocationCircleMember[]>([]);
  const [preview, setPreview] = useState<OneLocationCircleMember[]>([]);
  const [memberPage, setMemberPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<OneLocationCircleMember | null>(null);
  const [picker, setPicker] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [personalInvite, setPersonalInvite] = useState<InvitationShare | null>(null);
  const invitations = useContactInvitationSession(user.uid, snapshot.attemptId ?? "initial-welcome");
  const { beginSync: beginInvitationSync, clear: clearInvitations } = invitations;
  const actions = useMemo(() => createConnectCircleActions({ vaultOwnerToken }), [vaultOwnerToken]);
  const queueEntryWelcome = useOneConversationSession((state) => state.queueEntryWelcome);
  const destination = useMemo(() => initialContactsWelcomeDestination(query.get("return_to")), [query]);
  const circleId = snapshot.ownerId === user.uid ? snapshot.circle?.circleId : null;

  useEffect(() => {
    void InitialContacts.prepareCircle(vaultOwnerToken);
  }, [vaultOwnerToken, router, destination]);

  useEffect(() => {
    let active = true;
    if (!circleId) return;
    void actions.loadCircleOverview(circleId).then((circle) => {
      if (active && currentOwner()) setOverview(circle);
    }).catch(() => { if (active && currentOwner()) setOverview(null); });
    return () => { active = false; };
  }, [actions, circleId, snapshot.membersAdded, refresh, currentOwner]);

  useEffect(() => {
    let active = true;
    if (!circleId || snapshot.people.length) return;
    void actions.loadCircleMembersPage(circleId, { page: 1, limit: 4 }).then((page) => {
      if (active && currentOwner()) setPreview(page.items.filter((member) => member.userId !== user.uid).slice(0, 3));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [actions, circleId, snapshot.people.length, currentOwner, user.uid]);

  useEffect(() => {
    let active = true;
    void user.getIdToken().then((idToken) => {
      if (!currentOwner()) throw new Error("session_changed");
      return ReferralService.getSummary({ idToken });
    })
      .then((summary) => {
        if (active && currentOwner()) setPersonalInvite({ title: "Join me on One", text: "Join me on One, your private agent.",
          dialogTitle: "Invite to One", url: summary.link });
      }).catch(() => { if (active && currentOwner()) setPersonalInvite(buildInviteToOneShare()); });
    return () => { active = false; };
  }, [user, currentOwner]);

  useEffect(() => {
    const receive = beginInvitationSync();
    receive?.(snapshot.ownerId === user.uid ? snapshot.candidates : []);
  }, [snapshot.candidates, snapshot.ownerId, user.uid, beginInvitationSync]);

  const continueToOne = useCallback(async () => {
    const owner = snapshotValidatedAuthSessionOwner();
    if (continuing || !owner || owner.userId !== user.uid) return;
    setContinuing(true);
    clearInvitations();
    try { await InitialContacts.acknowledge(user); }
    catch { toast.message("You can continue. We’ll confirm your welcome next time."); }
    // Acknowledgment clears the initial session. Validate the AuthProvider
    // owner separately before routing an asynchronous completed action.
    if (!isValidatedAuthSessionOwnerCurrent(owner)) return;
    queueEntryWelcome(user.uid);
    router.replace(destination);
  }, [continuing, destination, clearInvitations, queueEntryWelcome, router, user]);

  useBackLayer(ROUTES.ONE_WELCOME, 1, () => { void continueToOne(); return true; });
  useBackLayer(ROUTES.ONE_WELCOME, 2, () => {
    if (inviteOpen) { setInviteOpen(false); return true; }
    if (rosterOpen) { setRosterOpen(false); return true; }
    return false;
  });
  useBackLayer(ROUTES.ONE_WELCOME, 3, () => {
    if (picker) { if (!busy) setPicker(null); return true; }
    if (invitations.active) {
      if (invitations.draft.busy) return true;
      if (invitations.draft.step !== "select") invitations.draft.setStep("select");
      else invitations.clear();
      return true;
    }
    return false;
  });
  useBackLayer(ROUTES.ONE_WELCOME, 4, () => {
    if (!removeTarget) return false;
    if (!busy) setRemoveTarget(null);
    return true;
  });

  async function confirmRemoval() {
    if (!removeTarget || !circleId || busy || !currentOwner()) return;
    const targetId = removeTarget.userId;
    setBusy(true);
    const removal = actions.removeMember(circleId, targetId);
    morphyToast.promise(removal, {
      loading: "Removing from this circle…", success: "Removed from this circle.",
      error: "Could not remove this person. Try again.", variant: "destructive",
    });
    try {
      await removal;
      if (!currentOwner()) return;
      setMembers((current) => current.filter((entry) => entry.userId !== targetId));
      setRemoveTarget(null);
      setRefresh((value) => value + 1);
    } catch {
      // Keep the confirmation available for retry; the branded toast owns feedback.
    } finally { if (currentOwner()) setBusy(false); }
  }

  async function loadMembers(page: number) {
    if (!circleId || busy || !currentOwner()) return;
    setBusy(true);
    try {
      const result = await actions.loadCircleMembersPage(circleId, { page, limit: 50 });
      if (!currentOwner()) return;
      setMembers((current) => page === 1 ? result.items : [...current, ...result.items]);
      setMemberPage(page); setHasMore(result.hasMore);
    } catch { if (currentOwner()) toast.error("Could not load your circle. Try again."); }
    finally { setBusy(false); }
  }

  async function chooseTrusted() {
    if (busy || !currentOwner()) return;
    setBusy(true);
    const opening = OneLocationService.ensureTrustedSystemCircle({ vaultOwnerToken, summaryOnly: true });
    morphyToast.promise(opening, {
      loading: "Opening Trusted…", success: "Choose your trusted people.",
      error: "Could not open Trusted. Try again.",
    });
    try {
      const circle = await opening;
      if (!currentOwner()) return;
      setPicker({ id: circle.id, name: circle.name });
    } catch {
      // The branded toast owns feedback; Continue remains available.
    } finally { if (currentOwner()) setBusy(false); }
  }

  const checking = ["reading", "waiting_for_phone", "matching"].includes(snapshot.status);
  const connected = (snapshot.result?.autoConnectedCount ?? 0) + (snapshot.result?.alreadyConnectedCount ?? 0);
  const peers = overview ? Math.max(0, overview.memberCount - 1) : null;
  const full = Boolean(overview && overview.memberCount >= (overview.memberLimit ?? 100));
  const greeting = user.displayName?.trim().split(/\s+/)[0];
  const summary = checking ? "We’re checking your contacts. You can continue whenever you’re ready."
    : connected ? `${connected} ${connected === 1 ? "person you know is" : "people you know are"} already here.`
    : peers ? `${peers} ${peers === 1 ? "person you know is" : "people you know are"} already here.`
    : "Your space is ready. Bring your people with you whenever you like.";
  const people = snapshot.people.length ? snapshot.people : preview;

  return <AppPageShell as="main" width="reading" fitContent
    nativeTest={{ routeId: ROUTES.ONE_WELCOME, marker: "native-route-one-welcome", authState: "authenticated", dataState: "loaded" }}>
    <AppPageHeaderRegion><PageHeader title={greeting ? `Welcome to One, ${greeting}` : "Welcome to One"}
      description={summary} accent="neutral" /></AppPageHeaderRegion>
    <AppPageContentRegion className="space-y-4">
      {people.length ? <SettingsGroup title="People you know" density="compact" separatorInset headingClassName="mt-0"
        titleAction={<Button variant="ghost" className="min-h-11" aria-label="See your Contacts" disabled={!circleId} onClick={() => { setRosterOpen(true); void loadMembers(1); }}>See all</Button>}>
        {people.map((person) => <SettingsRow key={person.userId} density="comfortable"
          leading={<ConnectionPersonAvatar photoUrl={person.photoUrl} label={person.displayName ?? "One member"} size="comfortable" verified={person.isRia === true} />}
          title={<span dir="auto">{person.displayName ?? "One member"}</span>}
          description="Already on One" />)}
      </SettingsGroup> : null}
      <SettingsGroup separatorInset>
        <SettingsRow title={overview?.name ?? "Contacts"} description={peers === null ? "Your shared circle is being prepared." : "Members can see the shared roster."}
          trailing="Manage" chevron disabled={!circleId} onClick={() => { setRosterOpen(true); void loadMembers(1); }} />
        <SettingsRow title="Trusted" description="Choose your closest people when you’re ready."
          trailing="Choose" chevron disabled={busy} onClick={() => void chooseTrusted()} />
        <SettingsRow title="Invite someone" description="Missing someone? Bring them along."
          trailing="Invite" chevron onClick={() => setInviteOpen(true)} />
      </SettingsGroup>
      {snapshot.overflow > 0 ? <p className="text-sm text-muted-foreground">{snapshot.overflow} more people are connected. Contacts holds 99 people plus you.</p> : null}
      {snapshot.error ? <p role="status" className="text-sm text-muted-foreground">{snapshot.error}</p> : null}
      {snapshot.circleError ? <div className="space-y-2"><p role="status" className="text-sm text-muted-foreground">{snapshot.circleError}</p>
        <Button variant="ghost" className="min-h-11" onClick={() => void InitialContacts.prepareCircle(vaultOwnerToken)}>Retry circle setup</Button></div> : null}
      {(!["ready", "reading", "matching"].includes(snapshot.status) || snapshot.result?.partial) && snapshot.source !== "none" ?
        <Button variant="ghost" className="min-h-11" onClick={() => InitialContacts.startSource()}>
          {snapshot.source === "device" ? "Find people from my phone" : "Find people with Google Contacts"}
        </Button> : null}
      <Button className="min-h-11 w-full" disabled={continuing} onClick={() => void continueToOne()}>
        {continuing ? "Opening One…" : "Continue to One"}
      </Button>
    </AppPageContentRegion>

    <Sheet open={rosterOpen} onOpenChange={setRosterOpen}><SheetContent side="bottom" contentDragDismiss={false} className="flex max-h-[85dvh] flex-col">
      <SheetHeader><SheetTitle>{overview?.name ?? "Contacts"}</SheetTitle>
        <SheetDescription>Members can see the shared roster. Adding someone does not turn on private information sharing.</SheetDescription></SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto"><SettingsGroup separatorInset>
        {members.map((member) => <SettingsRow key={member.userId} density="compact"
          leading={<ConnectionPersonAvatar photoUrl={member.photoUrl} label={member.displayName ?? "One member"} size="compact" verified={member.isRia === true} />}
          title={<span dir="auto">{member.displayName ?? "One member"}</span>}
          trailing={member.userId === user.uid ? "You" : overview?.viewerCapabilities?.canManageCircle ?
            <Button variant="ghost" disabled={busy} className="min-h-11" onClick={() => {
              if (!currentOwner()) return;
              setRemoveTarget(member);
            }}>Remove</Button> : undefined} trailingInteractive />)}
      </SettingsGroup></div>
      {hasMore ? <Button variant="ghost" disabled={busy} onClick={() => void loadMembers(memberPage + 1)}>Load more</Button> : null}
      {overview?.viewerCapabilities?.canInviteMembers ? <Button variant="outline" disabled={full}
        onClick={() => setPicker({ id: circleId!, name: overview.name })}>Add people</Button> : null}

    <AlertDialog open={Boolean(removeTarget)} onOpenChange={(open) => { if (!open && !busy) setRemoveTarget(null); }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader><AlertDialogTitle>Remove from {overview?.name ?? "Contacts"}?</AlertDialogTitle>
          <AlertDialogDescription>{removeTarget?.displayName ?? "This person"} will leave this shared circle.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep person</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={(event) => { event.preventDefault(); void confirmRemoval(); }}>
            {busy ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </SheetContent></Sheet>

    <Sheet open={inviteOpen} onOpenChange={setInviteOpen}><SheetContent side="bottom">
      <SheetHeader><SheetTitle>Bring your people</SheetTitle><SheetDescription>Choose whether to invite someone to One or into your shared circle.</SheetDescription></SheetHeader>
      <div className="space-y-4">
        <div><p className="font-normal">Join Contacts</p>
          {snapshot.circle?.code ? <p className="font-mono tracking-wider" dir="ltr">{snapshot.circle.code}</p> : <p className="text-sm text-muted-foreground">Your circle code is being prepared.</p>}
          <div className="flex gap-2">
            <Button variant="outline" disabled={!snapshot.circle?.code || full} onClick={() => { if (currentOwner()) void actions.copyCode(snapshot.circle!.code); }}>Copy code</Button>
            <Button variant="outline" disabled={!overview || !snapshot.circle?.code || full} onClick={() => {
              if (!currentOwner()) return;
              void actions.shareCode(overview!, snapshot.circle!.code).catch(() => toast.error("Could not open sharing. Copy the code instead."));
            }}>Share circle link</Button>
          </div>
          {full ? <p className="text-sm text-muted-foreground">This circle is full. You can still invite someone to One.</p> : null}
        </div>
        <Button variant="outline" disabled={!personalInvite} onClick={() => {
          if (!currentOwner()) return;
          void shareLink(personalInvite!).catch(() => toast.error("Could not open sharing. Try again."));
        }}>Invite to One</Button>
        {invitations.enabled && invitations.candidates.length > 0 ? <Button variant="outline" disabled={!personalInvite}
          onClick={() => { void invitations.open(async () => personalInvite); }}>Invite contacts</Button> : null}
      </div>
    </SheetContent></Sheet>

    {picker ? <CircleInvitePeopleSheet open onOpenChange={(open) => { if (!open) setPicker(null); }}
      circleId={picker.id} circleName={picker.name} busy={busy}
      onLoadEligibleConnections={actions.loadEligibleConnections} onLoadEligibleConnectionsPage={actions.loadEligibleConnectionsPage}
      onInviteConnections={async (id, ids) => { if (!currentOwner()) throw new Error("session_changed"); await actions.inviteConnections(id, ids); if (currentOwner()) setRefresh((value) => value + 1); }}
      onCancelMemberInvite={actions.cancelMemberInvite} onInvited={() => setPicker(null)} /> : null}
    <ContactInvitationSheet controller={invitations} onFinish={invitations.clear} />
  </AppPageShell>;
}
