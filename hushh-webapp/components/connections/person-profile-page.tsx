"use client";

import { useEffect, useMemo, useState, useRef } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Capacitor } from "@capacitor/core";
import { CheckCircle2, Copy, Eye, EyeOff, LockKeyhole } from "lucide-react";
import { toast } from "sonner";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  SectionCard,
  StatusPill,
} from "@/lib/morphy-ux/ui/surface-primitives";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import {
  PersonProfileService,
  type PublicPersonProfile,
  type ViewerPersonProfile,
  type InformationRequestBundle,
} from "@/lib/services/person-profile-service";
import {
  resolvePersonRefFromProfilePathname,
  ROUTES,
} from "@/lib/navigation/routes";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";

type Props = { personRef: string; initialProfile: PublicPersonProfile | null };

function scopeTitle(scope: ViewerPersonProfile["requestableScopes"][number]) {
  return scope.label || scope.domain || "Information";
}

/** Bound to the backend's real range (1 hour to 30 days, whole hours). */
const REQUEST_DURATION_OPTIONS = [
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
] as const;
const DEFAULT_REQUEST_DURATION_HOURS = 168;
/** Search and domain chips appear once the catalog is long enough to need them. */
const SCOPE_SEARCH_THRESHOLD = 6;

function requestDurationLabel(hours: number): string {
  return REQUEST_DURATION_OPTIONS.find((option) => option.hours === hours)?.label ?? `${hours} hours`;
}

function scopeMatchesQuery(
  scope: ViewerPersonProfile["requestableScopes"][number],
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [scope.label, scope.description, scope.domain]
    .some((value) => String(value || "").toLowerCase().includes(needle));
}

function domainChipClass(active: boolean): string {
  return active
    ? "rounded-full border border-[var(--app-accent)] bg-[var(--app-accent)]/10 px-3 py-1 text-xs font-medium capitalize"
    : "rounded-full border border-border px-3 py-1 text-xs font-medium capitalize text-muted-foreground";
}

export function PersonProfilePage({ personRef, initialProfile }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const { vaultKey, vaultOwnerToken, isVaultUnlocked } = useVault();
  const resolvedPersonRef = useMemo(() => {
    const isNativeIOS =
      Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
    if (!isNativeIOS) return personRef;
    return resolvePersonRefFromProfilePathname(pathname) || personRef;
  }, [pathname, personRef]);
  const [profileState, setProfileState] = useState<{
    personRef: string;
    profile: PublicPersonProfile | null;
  }>({ personRef: resolvedPersonRef, profile: initialProfile });
  const profile =
    profileState.personRef === resolvedPersonRef ? profileState.profile : null;
  const [publicProfileUnavailable, setPublicProfileUnavailable] = useState(false);
  const [viewerProfileState, setViewerProfileState] = useState<{
    personRef: string;
    profile: ViewerPersonProfile | null;
  }>({ personRef: resolvedPersonRef, profile: null });
  const viewerProfile =
    viewerProfileState.personRef === resolvedPersonRef
      ? viewerProfileState.profile
      : null;
  const [selectedScopeRefs, setSelectedScopeRefs] = useState<Set<string>>(new Set());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [durationHours, setDurationHours] = useState<number>(DEFAULT_REQUEST_DURATION_HOURS);
  const [scopeQuery, setScopeQuery] = useState("");
  const [scopeDomain, setScopeDomain] = useState<string | null>(null);
  const [bundleDetails, setBundleDetails] = useState<Record<string, InformationRequestBundle>>({});
  const [loadingBundleId, setLoadingBundleId] = useState<string | null>(null);
  const searchParams = useSearchParams();
  // /connect and the agent's discovery card land here with ?request=1: bring
  // the requestable catalog into view instead of the identity header.
  const requestIntent = searchParams?.get("request") === "1";
  const availableSectionRef = useRef<HTMLElement | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [relationshipBusy, setRelationshipBusy] = useState(false);
  const [decryptedByRequest, setDecryptedByRequest] = useState<Record<string, Record<string, unknown>>>({});
  const [revealedRequests, setRevealedRequests] = useState<Set<string>>(new Set());
  const [decryptingRequestId, setDecryptingRequestId] = useState<string | null>(null);
  const [cancellingBundleId, setCancellingBundleId] = useState<string | null>(null);

  useEffect(() => {
    if (profile) return;
    let active = true;
    setPublicProfileUnavailable(false);
    void PersonProfileService.getPublic(resolvedPersonRef)
      .then((value) => {
        if (active) {
          setProfileState({ personRef: resolvedPersonRef, profile: value });
        }
      })
      .catch(() => {
        if (active) setPublicProfileUnavailable(true);
      });
    return () => {
      active = false;
    };
  }, [resolvedPersonRef, profile]);

  useEffect(() => {
    if (authLoading || !user) return;
    let active = true;
    void user
      .getIdToken()
      .then((token) => PersonProfileService.getViewer(resolvedPersonRef, token))
      .then((value) => {
        if (active) {
          setViewerProfileState({
            personRef: resolvedPersonRef,
            profile: value,
          });
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [authLoading, resolvedPersonRef, user]);

  useEffect(() => {
    setSelectedScopeRefs(new Set());
    setReviewOpen(false);
    setPurpose("");
    setDurationHours(DEFAULT_REQUEST_DURATION_HOURS);
    setScopeQuery("");
    setScopeDomain(null);
    setBundleDetails({});
    setDecryptedByRequest({});
    setRevealedRequests(new Set());
  }, [resolvedPersonRef]);

  useEffect(() => {
    if (isVaultUnlocked) return;
    setDecryptedByRequest({});
    setRevealedRequests(new Set());
  }, [isVaultUnlocked]);

  useEffect(() => {
    if (!requestIntent || !viewerProfile) return;
    const node = availableSectionRef.current;
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [requestIntent, viewerProfile]);

  const allScopes = useMemo(() => viewerProfile?.requestableScopes || [], [viewerProfile]);
  const scopeDomains = useMemo(
    () => [...new Set(allScopes.map((scope) => scope.domain || "Other"))],
    [allScopes],
  );
  const filteredScopes = useMemo(
    () =>
      allScopes.filter(
        (scope) =>
          (!scopeDomain || (scope.domain || "Other") === scopeDomain) &&
          scopeMatchesQuery(scope, scopeQuery),
      ),
    [allScopes, scopeDomain, scopeQuery],
  );
  const scopeToolsVisible = allScopes.length > SCOPE_SEARCH_THRESHOLD;
  const groupedScopes = useMemo(() => {
    const groups = new Map<string, ViewerPersonProfile["requestableScopes"]>();
    for (const scope of filteredScopes) {
      const domain = scope.domain || "Other";
      groups.set(domain, [...(groups.get(domain) || []), scope]);
    }
    return [...groups.entries()];
  }, [filteredScopes]);

  const selectedScopes = useMemo(
    () => (viewerProfile?.requestableScopes || []).filter((scope) => selectedScopeRefs.has(scope.scopeRef)),
    [selectedScopeRefs, viewerProfile],
  );

  const submitRequest = async () => {
    if (!user || !vaultKey || !vaultOwnerToken || !isVaultUnlocked) {
      toast.error("Unlock your vault before requesting information.");
      return;
    }
    if (!selectedScopes.length || purpose.trim().length < 8) return;
    setRequesting(true);
    try {
      const connector = await OneKycClientZkService.ensureConnector({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
      });
      await PersonProfileService.createInformationRequest({
        personRef: resolvedPersonRef,
        scopeRefs: selectedScopes.map((scope) => scope.scopeRef),
        purpose: purpose.trim(),
        durationSeconds: durationHours * 3600,
        connectorKeyId: connector.connector_key_id,
        idempotencyKey: crypto.randomUUID(),
        vaultOwnerToken,
      });
      setReviewOpen(false);
      setSelectedScopeRefs(new Set());
      setPurpose("");
      const idToken = await user.getIdToken();
      setViewerProfileState({
        personRef: resolvedPersonRef,
        profile: await PersonProfileService.getViewer(resolvedPersonRef, idToken),
      });
      toast.success("Request sent for review");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Request could not be sent.");
    } finally {
      setRequesting(false);
    }
  };

  const loadBundleDetails = async (bundleId: string) => {
    if (!vaultOwnerToken || bundleDetails[bundleId] || loadingBundleId) return;
    setLoadingBundleId(bundleId);
    try {
      const bundle = await PersonProfileService.getInformationRequest({ bundleId, vaultOwnerToken });
      setBundleDetails((current) => ({ ...current, [bundleId]: bundle }));
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Request details are unavailable.");
    } finally {
      setLoadingBundleId(null);
    }
  };

  const updateRelationship = async (action: "connect" | "cancel" | "remove"): Promise<boolean> => {
    if (!user || !viewerProfile) return false;
    setRelationshipBusy(true);
    try {
      const idToken = await user.getIdToken();
      const relationship =
        action === "connect"
          ? await PersonProfileService.connect(resolvedPersonRef, idToken)
          : action === "cancel"
            ? await PersonProfileService.cancelConnectionRequest(
                resolvedPersonRef,
                idToken,
              )
            : await PersonProfileService.removeConnection(
                resolvedPersonRef,
                idToken,
              );
      setViewerProfileState((current) =>
        current.personRef === resolvedPersonRef && current.profile
          ? {
              personRef: resolvedPersonRef,
              profile: { ...current.profile, relationship },
            }
          : current,
      );
      toast.success(
        action === "connect"
          ? "Connection request sent"
          : action === "cancel"
            ? "Connection request cancelled"
            : "Connection removed",
      );
      return true;
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Relationship could not be updated.");
      return false;
    } finally {
      setRelationshipBusy(false);
    }
  };

  const revealGrant = async (requestId: string | null) => {
    if (!requestId || !user || !vaultKey || !vaultOwnerToken || !isVaultUnlocked || !viewerProfile) {
      toast.error("Unlock your vault to view this grant.");
      return;
    }
    if (decryptedByRequest[requestId]) {
      setRevealedRequests((current) => {
        const next = new Set(current);
        if (next.has(requestId)) next.delete(requestId);
        else next.add(requestId);
        return next;
      });
      return;
    }
    const history = viewerProfile.requestHistory.find((item) => item.requestId === requestId);
    if (!history) {
      toast.error("The encrypted export is not available for this grant.");
      return;
    }
    setDecryptingRequestId(requestId);
    try {
      const connector = await OneKycClientZkService.ensureConnector({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
      });
      const exports = await PersonProfileService.getInformationRequestExports({
        bundleId: history.bundleId,
        vaultOwnerToken,
      });
      const exact = exports.find((item) => item.requestId === requestId);
      if (!exact) throw new Error("The active grant has no current encrypted export.");
      const payload = await OneKycClientZkService.decryptScopedExport({
        exportPackage: exact.encryptedExport,
        connector,
      });
      setDecryptedByRequest((current) => ({ ...current, [requestId]: payload }));
      setRevealedRequests((current) => new Set(current).add(requestId));
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The encrypted export could not be opened.");
    } finally {
      setDecryptingRequestId(null);
    }
  };

  const cancelInformationRequest = async (bundleId: string) => {
    if (!user || !vaultOwnerToken) {
      toast.error("Unlock your vault to cancel this request.");
      return;
    }
    setCancellingBundleId(bundleId);
    try {
      await PersonProfileService.cancelInformationRequest({ bundleId, vaultOwnerToken });
      const idToken = await user.getIdToken();
      setViewerProfileState({
        personRef: resolvedPersonRef,
        profile: await PersonProfileService.getViewer(resolvedPersonRef, idToken),
      });
      toast.success("Information request cancelled");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "The information request could not be cancelled.");
    } finally {
      setCancellingBundleId(null);
    }
  };

  useLocalOnboardingActionHandler("people.profile.connect", async () => ({
    status: (await updateRelationship("connect")) ? "succeeded" : "failed",
    summary: "Connection request processing finished.",
  }), { enabled: viewerProfile?.relationship.status === "none" });
  useLocalOnboardingActionHandler("people.profile.cancel_connection_request", async () => ({
    status: (await updateRelationship("cancel")) ? "succeeded" : "failed",
    summary: "Connection request cancellation finished.",
  }), { enabled: viewerProfile?.relationship.status === "pending_outgoing" });
  useLocalOnboardingActionHandler("people.profile.remove_connection", async () => ({
    status: (await updateRelationship("remove")) ? "succeeded" : "failed",
    summary: "Connection removal finished.",
  }), { enabled: viewerProfile?.relationship.status === "connected" });
  useLocalOnboardingActionHandler("people.profile.review_information_request", async () => {
    if (!selectedScopeRefs.size) {
      return { status: "blocked", summary: "Select at least one field before reviewing the request." };
    }
    if (!isVaultUnlocked) {
      return { status: "blocked", summary: "Unlock the vault before reviewing an information request." };
    }
    setReviewOpen(true);
    return { status: "succeeded", summary: "Information request review opened." };
  }, { enabled: Boolean(viewerProfile) });
  useLocalOnboardingActionHandler("people.profile.manage_consent", async () => {
    router.push(ROUTES.CONSENTS);
    return { status: "started", summary: "Opening the Consent Center." };
  }, { enabled: Boolean(viewerProfile) });

  const surfaceActions = useMemo(() => {
    if (!viewerProfile) return [];
    const actions = [
      {
        id: "manage-consent",
        label: "Manage consent",
        actionId: "people.profile.manage_consent",
        purpose: "Review access independently from the social connection.",
      },
      {
        id: "review-information-request",
        label: "Review information request",
        actionId: "people.profile.review_information_request",
        purpose: "Review selected fields before sending a consent request.",
      },
    ];
    if (viewerProfile.relationship.status === "none") {
      actions.push({ id: "connect", label: "Connect", actionId: "people.profile.connect", purpose: "Send a separate social connection request." });
    } else if (viewerProfile.relationship.status === "pending_outgoing") {
      actions.push({ id: "cancel-connection", label: "Cancel request", actionId: "people.profile.cancel_connection_request", purpose: "Withdraw the pending social connection request." });
    } else if (viewerProfile.relationship.status === "connected") {
      actions.push({ id: "remove-connection", label: "Remove connection", actionId: "people.profile.remove_connection", purpose: "End the social connection without silently changing consent." });
    }
    return actions;
  }, [viewerProfile]);

  usePublishVoiceSurfaceMetadata(
    viewerProfile
      ? {
          screenId: "one_person_profile",
          title: "Person profile",
          purpose: "Review a person's relationship, requestable information, grants, and request history.",
          primaryEntity: null,
          spokenSubject: null,
          sections: [
            { id: "shared", title: "Shared with you", summary: `${viewerProfile.grants.length} active grants` },
            { id: "requestable", title: "Available to request", summary: `${viewerProfile.requestableScopes.length} requestable fields` },
            { id: "history", title: "Request history", summary: `${viewerProfile.requestHistory.length} request records` },
          ],
          actions: surfaceActions,
          availableActions: surfaceActions.flatMap((action) => action.actionId ? [action.actionId] : []),
          screenMetadata: {
            profile_reference_present: true,
            relationship_state: viewerProfile.relationship.status,
            selected_scope_count: selectedScopeRefs.size,
          },
        }
      : null,
    { role: "route", routeKey: "/people/[personRef]" },
  );

  usePublishVoiceSurfaceMetadata(
    reviewOpen
      ? {
          screenId: "one_person_profile",
          title: "Review information request",
          interactionLayer: {
            schemaVersion: "voice_interaction_layer.v1",
            id: "person_information_request_review",
            kind: "information_request_review",
            modality: "modal",
            lifecycle: "open",
            dismissible: true,
            dismissActionId: null,
            visibleActionIds: [],
            visibleControlIds: ["person-profile-request-confirm", "person-profile-request-cancel"],
            options: [],
            returnFocusControlId: "person-profile-review-information",
            blocksUnderlyingActions: true,
            agentContinuity: "suppressed",
          },
        }
      : null,
    { role: "interaction_layer", routeKey: "/people/[personRef]" },
  );

  if (!profile) {
    return (
      <AppPageShell width="agent" fitContent>
        <div
          className="flex min-h-[50vh] items-center justify-center"
          data-native-route="native-route-person-profile"
        >
          <p className="text-sm text-muted-foreground" role={publicProfileUnavailable ? "alert" : undefined}>
            {publicProfileUnavailable ? "This profile is unavailable." : "Loading profile…"}
          </p>
        </div>
      </AppPageShell>
    );
  }

  return (
    <AppPageShell width="agent" fitContent>
      <div className="space-y-8 sm:space-y-10 pb-28 sm:pb-36" data-native-route="native-route-person-profile">
        <section className="flex flex-col items-center text-center py-2">
          <ConnectionPersonAvatar
            photoUrl={profile.photoUrl}
            label={profile.displayName}
            verified={Boolean(profile.verifiedRole)}
            size="profile"
          />
          <h1 className="mt-3.5 text-3xl font-semibold tracking-tight">
            {profile.displayName}
          </h1>
          {profile.verifiedRole ? (
            <p className="mt-1.5 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-[var(--app-accent)] shrink-0" />
              <span>{profile.verifiedRole}</span>
            </p>
          ) : null}
          {viewerProfile ? (
            <div className="mt-2.5 flex justify-center">
              <StatusPill tone="neutral">
                {viewerProfile.relationship.status === "connected"
                  ? "Connected"
                  : viewerProfile.relationship.status.startsWith("pending")
                    ? "Request pending"
                    : "Not connected"}
              </StatusPill>
            </div>
          ) : null}
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5" aria-label="Relationship actions">
            {viewerProfile ? (
              <>
                {viewerProfile.relationship.status === "none" ? (
                  <Button
                    type="button"
                    variant="blue-gradient"
                    effect="fill"
                    disabled={relationshipBusy}
                    onClick={() => void updateRelationship("connect")}
                    data-voice-control-id="person-profile-connect"
                  >
                    Connect
                  </Button>
                ) : null}
                {viewerProfile.relationship.status === "pending_outgoing" ? (
                  <Button
                    type="button"
                    variant="none"
                    effect="fade"
                    disabled={relationshipBusy}
                    onClick={() => void updateRelationship("cancel")}
                    data-voice-control-id="person-profile-cancel-connection"
                  >
                    Cancel request
                  </Button>
                ) : null}
                {viewerProfile.relationship.status === "connected" ? (
                  <Button
                    type="button"
                    variant="none"
                    effect="fade"
                    disabled={relationshipBusy}
                    onClick={() => void updateRelationship("remove")}
                    data-voice-control-id="person-profile-remove-connection"
                  >
                    Remove connection
                  </Button>
                ) : null}
                <Button type="button" variant="none" effect="fade" data-voice-control-id="person-profile-manage-consent" onClick={() => router.push(ROUTES.CONSENTS)}>
                  Manage access
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              variant="none"
              effect="fade"
              onClick={() => {
                void navigator.clipboard.writeText(window.location.href);
                toast.success("Profile link copied");
              }}
            >
              <span className="inline-flex items-center gap-2">
                <Copy className="h-4 w-4" />
                <span>Share profile</span>
              </span>
            </Button>
          </div>
        </section>

        {!user && !authLoading ? (
          <SectionCard>
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="font-semibold">Connect through Hussh</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Sign in to see requestable information and consented access.
                </p>
              </div>
              <Button asChild variant="blue-gradient" effect="fill">
                <Link href="/login">Sign in</Link>
              </Button>
            </div>
          </SectionCard>
        ) : null}

        {viewerProfile ? (
          <>
            <section aria-labelledby="shared-with-you" className="space-y-3">
              <PageHeader
                title="Shared with you"
                description="Information this person has granted to your account. Values stay encrypted until you unlock your vault."
              />
              {viewerProfile.grants.length ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {viewerProfile.grants.map((grant, index) => (
                    <SectionCard key={`${grant.scopeRef || grant.requestId}-${index}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-semibold">{grant.label}</h3>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {grant.domain || "Consented information"}
                          </p>
                        </div>
                        <LockKeyhole className="h-4 w-4 text-muted-foreground" />
                      </div>
                      {grant.requestId && revealedRequests.has(grant.requestId) && decryptedByRequest[grant.requestId] ? (
                        <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-3 text-xs">
                          {JSON.stringify(decryptedByRequest[grant.requestId], null, 2)}
                        </pre>
                      ) : (
                        <p className="mt-3 text-sm text-muted-foreground">
                          {isVaultUnlocked ? "Value hidden until you reveal it." : "Unlock to view."}
                        </p>
                      )}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="none"
                          effect="fade"
                          disabled={decryptingRequestId === grant.requestId}
                          onClick={() => void revealGrant(grant.requestId)}
                        >
                          {grant.requestId && revealedRequests.has(grant.requestId) ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          {decryptingRequestId === grant.requestId
                            ? "Opening…"
                            : grant.requestId && revealedRequests.has(grant.requestId)
                              ? "Hide"
                              : "Reveal"}
                        </Button>
                        {grant.requestId && revealedRequests.has(grant.requestId) && decryptedByRequest[grant.requestId] ? (
                          <Button
                            type="button"
                            variant="none"
                            effect="fade"
                            onClick={() => {
                              void navigator.clipboard.writeText(JSON.stringify(decryptedByRequest[grant.requestId!]));
                              toast.success("Consented information copied");
                            }}
                          >
                            <Copy className="h-4 w-4" />
                            Copy
                          </Button>
                        ) : null}
                      </div>
                    </SectionCard>
                  ))}
                </div>
              ) : (
                <SectionCard className="py-8 text-center">
                  <div className="flex flex-col items-center justify-center space-y-2">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <LockKeyhole className="h-5 w-5" />
                    </div>
                    <p className="text-sm font-semibold text-foreground">
                      No information shared yet
                    </p>
                    <p className="text-xs text-muted-foreground max-w-sm">
                      Information granted by this person will appear here once shared. Values remain end-to-end encrypted until unlocked.
                    </p>
                  </div>
                </SectionCard>
              )}
            </section>

            <section
              aria-labelledby="available-to-request"
              className="space-y-3"
              ref={availableSectionRef}
              data-testid="person-profile-available"
            >
              <PageHeader
                title="Available to request"
                description="Choose only what is needed. The person reviews every request before access is granted."
              />
              {scopeToolsVisible ? (
                <div className="space-y-3">
                  <Input
                    value={scopeQuery}
                    onChange={(event) => setScopeQuery(event.target.value)}
                    placeholder="Search fields"
                    aria-label="Search fields"
                    data-testid="person-profile-scope-search"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by domain">
                      <button
                        type="button"
                        aria-pressed={!scopeDomain}
                        className={domainChipClass(!scopeDomain)}
                        onClick={() => setScopeDomain(null)}
                      >
                        All
                      </button>
                      {scopeDomains.map((domain) => (
                        <button
                          key={domain}
                          type="button"
                          aria-pressed={scopeDomain === domain}
                          className={domainChipClass(scopeDomain === domain)}
                          onClick={() => setScopeDomain((current) => (current === domain ? null : domain))}
                          data-testid={`person-profile-domain-chip-${domain}`}
                        >
                          {domain.replaceAll("_", " ")}
                        </button>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground font-medium" data-testid="person-profile-scope-count">
                      {filteredScopes.length} of {allScopes.length} fields
                    </p>
                  </div>
                </div>
              ) : null}
              {groupedScopes.length ? (
                <div className="space-y-4">
                  {groupedScopes.map(([domain, scopes]) => (
                    <SectionCard key={domain}>
                      <h3 className="font-semibold capitalize">{domain.replaceAll("_", " ")}</h3>
                      <div className="mt-3 divide-y divide-border/60">
                        {scopes.map((scope) => (
                          <button
                            type="button"
                            key={scope.scopeRef}
                            className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-xl px-3.5 py-3.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
                            aria-pressed={selectedScopeRefs.has(scope.scopeRef)}
                            onClick={() => setSelectedScopeRefs((current) => {
                              const next = new Set(current);
                              if (next.has(scope.scopeRef)) next.delete(scope.scopeRef);
                              else next.add(scope.scopeRef);
                              return next;
                            })}
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-semibold">{scopeTitle(scope)}</p>
                              {scope.description ? (
                                <p className="mt-1 text-sm text-muted-foreground">{scope.description}</p>
                              ) : null}
                            </div>
                            <StatusPill
                              tone={selectedScopeRefs.has(scope.scopeRef) ? "ready" : "neutral"}
                              className="shrink-0 justify-self-end"
                            >
                              {selectedScopeRefs.has(scope.scopeRef) ? "Selected" : "Ask first"}
                            </StatusPill>
                          </button>
                        ))}
                      </div>
                    </SectionCard>
                  ))}
                </div>
              ) : allScopes.length ? (
                <SectionCard>
                  <p className="text-sm text-muted-foreground" data-testid="person-profile-scope-no-match">
                    No fields match.{" "}
                    <button
                      type="button"
                      className="font-medium text-foreground underline underline-offset-4"
                      onClick={() => {
                        setScopeQuery("");
                        setScopeDomain(null);
                      }}
                    >
                      Clear
                    </button>
                  </p>
                </SectionCard>
              ) : (
                <SectionCard>
                  <p className="text-sm text-muted-foreground">
                    This person has no information available to request.
                  </p>
                </SectionCard>
              )}
              {allScopes.length ? (
                <div className="flex justify-end pt-1">
                  <Button
                    type="button"
                    variant="blue-gradient"
                    effect="fill"
                    disabled={!selectedScopeRefs.size}
                    onClick={() => {
                      if (!isVaultUnlocked) {
                        toast.error("Unlock your vault before requesting information.");
                        return;
                      }
                      setReviewOpen(true);
                    }}
                    data-voice-control-id="person-profile-review-information"
                  >
                    Review request{selectedScopeRefs.size ? ` (${selectedScopeRefs.size})` : ""}
                  </Button>
                </div>
              ) : null}
            </section>

            <section aria-labelledby="request-history" className="space-y-3">
              <PageHeader
                title="Request history"
                description="A viewer-relative record of requests to this person and their current consent state."
              />
              {viewerProfile.requestHistory.length ? (
                <SectionCard>
                  <div className="divide-y divide-border/60">
                    {viewerProfile.requestHistory.map((item) => (
                      <div key={item.requestId} className="flex flex-wrap items-start justify-between gap-4 py-3 first:pt-0 last:pb-0">
                        <div>
                          <p className="text-sm font-semibold">{item.label}</p>
                          <p className="mt-1 text-sm text-muted-foreground">{item.purpose}</p>
                          {item.createdAt ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.createdAt))}
                            </p>
                          ) : null}
                        </div>
                        <StatusPill tone={item.status === "granted" ? "ready" : "neutral"}>
                          {item.status}
                        </StatusPill>
                        {bundleDetails[item.bundleId] ? (
                          <p className="basis-full text-xs text-muted-foreground" data-testid="person-profile-bundle-details">
                            {bundleDetails[item.bundleId]!.items.map((entry) => entry.label).join(", ")}
                            {" · "}
                            {requestDurationLabel(Math.round(bundleDetails[item.bundleId]!.durationSeconds / 3600))}
                            {bundleDetails[item.bundleId]!.cancelled ? " · cancelled" : ""}
                          </p>
                        ) : (
                          <Button
                            type="button"
                            variant="none"
                            effect="fade"
                            disabled={loadingBundleId === item.bundleId}
                            onClick={() => void loadBundleDetails(item.bundleId)}
                            aria-label={`Details for ${item.label}`}
                          >
                            {loadingBundleId === item.bundleId ? "Loading…" : "Details"}
                          </Button>
                        )}
                        {item.status === "pending" ? (
                          <Button
                            type="button"
                            variant="none"
                            effect="fade"
                            disabled={cancellingBundleId === item.bundleId}
                            onClick={() => void cancelInformationRequest(item.bundleId)}
                          >
                            {cancellingBundleId === item.bundleId ? "Cancelling…" : "Cancel"}
                          </Button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </SectionCard>
              ) : (
                <SectionCard>
                  <p className="text-sm text-muted-foreground">No information requests yet.</p>
                </SectionCard>
              )}
            </section>
          </>
        ) : null}
      </div>
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Request information from {profile.displayName}</DialogTitle>
            <DialogDescription>
              They will see the exact fields, purpose, sensitivity, and the {requestDurationLabel(durationHours)} access duration before deciding.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <SectionCard title="Fields">
              <div className="space-y-2">
                {selectedScopes.map((scope) => (
                  <div key={scope.scopeRef} className="flex items-center justify-between gap-3 text-sm">
                    <span>{scopeTitle(scope)}</span>
                    <StatusPill tone="neutral">{scope.sensitivity || "Standard"}</StatusPill>
                  </div>
                ))}
              </div>
            </SectionCard>
            <label className="block space-y-2 text-sm font-medium">
              Access duration
              <select
                className="block h-9 w-full rounded-md border border-input bg-background px-3 text-sm font-normal"
                value={durationHours}
                onChange={(event) => setDurationHours(Number(event.target.value))}
                data-testid="person-profile-duration-select"
              >
                {REQUEST_DURATION_OPTIONS.map((option) => (
                  <option key={option.hours} value={option.hours}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-2 text-sm font-medium">
              Purpose
              <Textarea
                value={purpose}
                onChange={(event) => setPurpose(event.target.value)}
                maxLength={500}
                placeholder="Explain why these fields are needed and how they will be used."
              />
            </label>
          </div>
          <DialogFooter>
            <Button type="button" variant="none" effect="fade" data-voice-control-id="person-profile-request-cancel" onClick={() => setReviewOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="blue-gradient"
              effect="fill"
              disabled={requesting || purpose.trim().length < 8}
              onClick={() => void submitRequest()}
              data-voice-control-id="person-profile-request-confirm"
            >
              {requesting ? "Sending…" : "Send request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppPageShell>
  );
}
