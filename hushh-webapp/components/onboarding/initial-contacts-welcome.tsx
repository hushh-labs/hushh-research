"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { User } from "firebase/auth";
import { toast } from "sonner";
import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { VaultLockGuard } from "@/components/vault/vault-lock-guard";
import { ContactInvitationSheet } from "@/components/connections/contact-invitation-sheet";
import { CircleInvitePeopleSheet } from "@/components/one-location/redesign/circles/circle-grow-actions";
import { CircleOnboarding } from "./circles-v11/CircleOnboarding";
import type { OnboardingPerson, ViewName } from "./circles-v11/types";
import { createConnectCircleActions } from "@/components/connect/circles/connect-circle-actions";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { useInitialContacts } from "./initial-contacts-bridge";
import { InitialContactsOnboardingService as InitialContacts } from "@/lib/services/initial-contacts-onboarding-service";
import { useContactInvitationSession } from "@/lib/contacts/use-contact-invitations";
import { OneLocationService } from "@/lib/one-location/service";
import type { OneLocationCircleOverview, OneLocationCircleMember, OneLocationCircleSummary } from "@/lib/one-location/types";
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
  const { user, userId } = useAuth();
  const { vaultOwnerToken } = useVault();
  return <VaultLockGuard>{user && userId && vaultOwnerToken
    ? <WelcomeForOwner key={userId} userId={userId} user={user} vaultOwnerToken={vaultOwnerToken} />
    : <HushhLoader variant="page" />}</VaultLockGuard>;
}

function WelcomeForOwner({ user, userId, vaultOwnerToken }: { user: User; userId: string; vaultOwnerToken: string }) {
  const router = useRouter();
  const query = useSearchParams();
  useInitialContacts();
  const snapshot = InitialContacts.snapshotForOwner(userId);
  const authOwner = useMemo(() => {
    const owner = snapshotValidatedAuthSessionOwner();
    return owner?.userId === userId ? owner : null;
  }, [userId]);
  const currentOwner = useCallback(() => Boolean(authOwner && authOwner.userId === userId
    && isValidatedAuthSessionOwnerCurrent(authOwner)), [authOwner, userId]);
  const [overview, setOverview] = useState<OneLocationCircleOverview | null>(null);
  const [members, setMembers] = useState<OneLocationCircleMember[]>([]);
  const [preview, setPreview] = useState<OneLocationCircleMember[]>([]);
  const [memberPage, setMemberPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [membersLoading, setMembersLoading] = useState(false);
  const [trustedCircle, setTrustedCircle] = useState<OneLocationCircleSummary | null>(null);
  const [trustedMembers, setTrustedMembers] = useState<OneLocationCircleMember[]>([]);
  const [trustedPage, setTrustedPage] = useState(0);
  const [trustedHasMore, setTrustedHasMore] = useState(false);
  const [trustedLoading, setTrustedLoading] = useState(false);
  const [view, setView] = useState<ViewName>("home");
  const [removeTarget, setRemoveTarget] = useState<OneLocationCircleMember | null>(null);
  const [picker, setPicker] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [personalInvite, setPersonalInvite] = useState<InvitationShare | null>(null);
  const invitations = useContactInvitationSession(userId, snapshot.attemptId ?? "initial-welcome");
  const { beginSync: beginInvitationSync, clear: clearInvitations } = invitations;
  const actions = useMemo(() => createConnectCircleActions({ vaultOwnerToken }), [vaultOwnerToken]);
  const queueEntryWelcome = useOneConversationSession((state) => state.queueEntryWelcome);
  const destination = useMemo(() => initialContactsWelcomeDestination(query.get("return_to")), [query]);
  const circleId = snapshot.ownerId === userId ? snapshot.circle?.circleId : null;

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
      if (active && currentOwner()) setPreview(page.items.filter((member) => member.userId !== userId).slice(0, 3));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [actions, circleId, snapshot.people.length, currentOwner, userId]);

  useEffect(() => {
    let active = true;
    void user.getIdToken().then((idToken) => {
      if (!currentOwner()) throw new Error("session_changed");
      return ReferralService.getSummary({ idToken });
    })
      .then((summary) => {
        if (active && currentOwner()) setPersonalInvite({ title: "Join me on One", text: "Join me on One, Agent One.",
          dialogTitle: "Invite to One", url: summary.link });
      }).catch(() => { if (active && currentOwner()) setPersonalInvite(buildInviteToOneShare()); });
    return () => { active = false; };
  }, [user, currentOwner]);

  useEffect(() => {
    const receive = beginInvitationSync();
    receive?.(snapshot.ownerId === userId ? snapshot.candidates : []);
  }, [snapshot.candidates, snapshot.ownerId, userId, beginInvitationSync]);

  const continueToOne = useCallback(async () => {
    const owner = snapshotValidatedAuthSessionOwner();
    if (continuing || !owner || owner.userId !== userId) return;
    setContinuing(true);
    clearInvitations();
    try { await InitialContacts.acknowledge(user); }
    catch { toast.message("You can continue. We’ll confirm your welcome next time."); }
    // Acknowledgment clears the initial session. Validate the AuthProvider
    // owner separately before routing an asynchronous completed action.
    if (!isValidatedAuthSessionOwnerCurrent(owner)) return;
    queueEntryWelcome(userId);
    router.replace(destination);
  }, [continuing, destination, clearInvitations, queueEntryWelcome, router, user, userId]);

  useBackLayer(ROUTES.ONE_WELCOME, 1, () => { void continueToOne(); return true; });
  useBackLayer(ROUTES.ONE_WELCOME, 2, () => {
    if (view !== "home") { setView("home"); return true; }
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
    if (!circleId || busy || membersLoading || !currentOwner()) return;
    setMembersLoading(true);
    try {
      const result = await actions.loadCircleMembersPage(circleId, { page, limit: 50 });
      if (!currentOwner()) return;
      setMembers((current) => page === 1 ? result.items : [...current, ...result.items]);
      setMemberPage(page); setHasMore(result.hasMore);
    } catch { if (currentOwner()) toast.error("Could not load your circle. Try again."); }
    finally { if (currentOwner()) setMembersLoading(false); }
  }

  async function loadTrustedMembers(page: number) {
    if (trustedLoading || !currentOwner()) return;
    setTrustedLoading(true);
    try {
      const circle = trustedCircle ?? (await OneLocationService.listCircles(vaultOwnerToken))
        .find((item) => item.systemKind === "trusted") ?? null;
      if (!currentOwner()) return;
      if (!circle) {
        setTrustedMembers([]); setTrustedHasMore(false); return;
      }
      setTrustedCircle(circle);
      const result = await OneLocationService.listCircleMembersPage({
        vaultOwnerToken, circleId: circle.id, page, limit: 50,
      });
      if (!currentOwner()) return;
      setTrustedMembers((current) => page === 1 ? result.items : [...current, ...result.items]);
      setTrustedPage(page); setTrustedHasMore(result.hasMore);
    } catch { if (currentOwner()) toast.error("Could not load Trusted. Try again."); }
    finally { if (currentOwner()) setTrustedLoading(false); }
  }

  function changeView(next: ViewName) {
    if (next === view) return;
    setView(next);
    if (next === "contacts") void loadMembers(1);
    if (next === "trusted") void loadTrustedMembers(1);
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
      setTrustedCircle(circle);
      setPicker({ id: circle.id, name: circle.name });
    } catch {
      // The branded toast owns feedback; Continue remains available.
    } finally { if (currentOwner()) setBusy(false); }
  }

  const checking = ["reading", "waiting_for_phone", "matching"].includes(snapshot.status);
  const connected = (snapshot.result?.autoConnectedCount ?? 0) + (snapshot.result?.alreadyConnectedCount ?? 0);
  const peers = overview ? Math.max(0, overview.memberCount - 1) : null;
  const full = Boolean(overview && overview.memberCount >= (overview.memberLimit ?? 100));
  const circleCode = overview?.activeInviteCode?.code ?? snapshot.circle?.code;
  const people = (snapshot.people.length ? snapshot.people : preview).map((person): OnboardingPerson => ({
    userId: person.userId,
    displayName: person.displayName ?? "One member",
    photoUrl: person.photoUrl,
    isRia: person.isRia,
  }));
  const roster = members.map((person): OnboardingPerson => ({
    userId: person.userId,
    displayName: person.displayName ?? "One member",
    photoUrl: person.photoUrl,
    isRia: person.isRia,
    isSelf: person.userId === userId,
  }));
  const trustedRoster = trustedMembers.filter((person) => person.userId !== userId).map((person): OnboardingPerson => ({
    userId: person.userId,
    displayName: person.displayName ?? "One member",
    photoUrl: person.photoUrl,
    isRia: person.isRia,
  }));
  const canFindContacts = (!['ready', 'reading', 'matching'].includes(snapshot.status) || snapshot.result?.partial)
    && snapshot.source !== 'none';

  return <FullscreenFlowShell as="main" width="expanded" className="oc-host">
    <NativeTestBeacon routeId={ROUTES.ONE_WELCOME} marker="native-route-one-welcome"
      authState="authenticated" dataState="loaded" />
    <CircleOnboarding
      displayName={user.displayName}
      members={people}
      rosterMembers={roster}
      trustedMembers={trustedRoster}
      circleName={overview?.name ?? snapshot.circle?.circleName ?? 'Contacts'}
      circleReady={Boolean(circleId)}
      circleCode={circleCode}
      circleFull={full}
      canManageCircle={Boolean(overview?.viewerCapabilities?.canManageCircle)}
      canInviteMembers={Boolean(overview?.viewerCapabilities?.canInviteMembers)}
      canInviteContacts={Boolean(invitations.enabled && invitations.candidates.length && personalInvite)}
      canFindContacts={Boolean(canFindContacts)}
      source={snapshot.source}
      matching={checking}
      matchCount={connected || peers}
      inviteReady={Boolean(personalInvite)}
      busy={continuing}
      membersLoading={membersLoading}
      trustedLoading={trustedLoading}
      hasMoreMembers={hasMore}
      hasMoreTrustedMembers={trustedHasMore}
      statusMessage={snapshot.error}
      circleError={snapshot.circleError}
      overflowCount={snapshot.overflow}
      view={view}
      onViewChange={changeView}
      nestedDialogOpen={Boolean(picker || removeTarget || invitations.active)}
      onContinue={continueToOne}
      onOpenTrusted={chooseTrusted}
      onChooseContacts={() => {
        if (!currentOwner() || !circleId || !overview?.viewerCapabilities?.canInviteMembers || full) return;
        setPicker({ id: circleId, name: overview.name });
      }}
      onInviteContacts={() => invitations.open(async () => personalInvite)}
      onFindContacts={() => { if (currentOwner() && canFindContacts) InitialContacts.startSource(); }}
      onRetryCircle={() => InitialContacts.prepareCircle(vaultOwnerToken)}
      onInviteToOne={() => {
        if (!currentOwner() || !personalInvite) return;
        return shareLink(personalInvite).catch(() => toast.error('Could not open sharing. Try again.'));
      }}
      onCopyCircleCode={() => {
        if (!currentOwner() || !circleCode) return;
        return actions.copyCode(circleCode);
      }}
      onShareCircle={overview ? () => {
        if (!currentOwner() || !circleCode) return;
        return actions.shareCode(overview, circleCode)
          .catch(() => toast.error('Could not open sharing. Copy the code instead.'));
      } : undefined}
      onRequestRemoveMember={(person) => {
        if (!currentOwner()) return;
        setRemoveTarget(members.find((member) => member.userId === person.userId) ?? null);
      }}
      onLoadMoreMembers={() => loadMembers(memberPage + 1)}
      onLoadMoreTrustedMembers={() => loadTrustedMembers(trustedPage + 1)}
    />

    <AlertDialog open={Boolean(removeTarget)} onOpenChange={(open) => { if (!open && !busy) setRemoveTarget(null); }}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader><AlertDialogTitle>Remove from {overview?.name ?? 'Contacts'}?</AlertDialogTitle>
          <AlertDialogDescription>{removeTarget?.displayName ?? 'This person'} will leave this shared circle.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep person</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={(event) => { event.preventDefault(); void confirmRemoval(); }}>
            {busy ? 'Removing…' : 'Remove'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {picker ? <CircleInvitePeopleSheet open onOpenChange={(open) => { if (!open) setPicker(null); }}
      circleId={picker.id} circleName={picker.name} busy={busy}
      onLoadEligibleConnections={actions.loadEligibleConnections} onLoadEligibleConnectionsPage={actions.loadEligibleConnectionsPage}
      onInviteConnections={async (id, ids) => {
        if (!currentOwner()) throw new Error('session_changed');
        await actions.inviteConnections(id, ids);
        if (currentOwner()) setRefresh((value) => value + 1);
      }}
      onCancelMemberInvite={actions.cancelMemberInvite} onInvited={() => {
        setPicker(null);
        if (view === 'trusted') void loadTrustedMembers(1);
        if (view === 'contacts') void loadMembers(1);
      }} /> : null}
    <ContactInvitationSheet controller={invitations} onFinish={invitations.clear} />
  </FullscreenFlowShell>;
}
