"use client";

import { useCallback, useEffect, useMemo, useState, useRef } from "react";

import {
  isPeopleGraphChange,
  VoiceRefreshDeduper,
} from "@/lib/one-voice/people-voice-refresh";
import type { ToolResultPublic } from "@/lib/one-voice/protocol";
import { useVoiceToolEffects } from "@/lib/one-voice/session-store";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Capacitor } from "@capacitor/core";
import { CheckCircle2, LockKeyhole, MoreHorizontal, FileText, Share2, Settings, ChevronRight, MapPin, CreditCard, UserRound, ShoppingBag, FolderSimpleIcon } from "@/components/icons";
import { toast } from "sonner";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import styles from "./person-profile-page.module.css";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InformationRequestReviewFields } from "@/components/consent/information-request-review-fields";
import { DocumentRequestButton } from "@/components/consent/document-request-button";
import { usePersonInformationRequest } from "@/lib/consent/use-person-information-request";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { FCM_MESSAGE_EVENT } from "@/lib/notifications";
import {
  SectionCard,
  StatusPill,
} from "@/lib/morphy-ux/ui/surface-primitives";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { ConsentScopeNestedList } from "@/components/consent/consent-scope-nested-list";
import { SharedWithYouCard } from "@/components/agent/consent/shared-with-you-card";
import { humanSharedLabel, type SharedWithMeCardItem } from "@/lib/agent/agui-structured-experiences";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { scopeItemsFromRequestable } from "@/lib/consent/consent-scope-items";
import { selectedRequestScopes, toggleRequestScopes } from "@/lib/consent/request-scope-selection";
import { joinInformationLabels } from "@/lib/consent/consent-owner-copy";
import {
  PersonProfileService,
  mergePersonScopePage,
  type PublicPersonProfile,
  type ViewerPersonProfile,
  type InformationRequestBundle,
  type PersonInformationRequestHistory,
  type PersonRequestHistoryPage,
} from "@/lib/services/person-profile-service";
import {
  resolvePersonRefFromProfilePathname,
  ROUTES,
} from "@/lib/navigation/routes";
import {
  DEFAULT_REQUEST_DURATION_HOURS,
  requestDurationLabel,
} from "@/lib/agent/action-directive-summary";
import { useLocalOnboardingActionHandler } from "@/lib/agent/local-onboarding-actions";
import { oneLocationErrorMessage } from "@/lib/one-location/error-message";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { VOICE_CONFIRM_DATA_KEY } from "@/lib/voice/voice-action-card";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";

type Props = { personRef: string; initialProfile: PublicPersonProfile | null };

function renderCategoryIcon(domain: string) {
  const presentation = {
    location: { Icon: MapPin, tone: "blue" },
    financial: { Icon: CreditCard, tone: "green" },
    identity: { Icon: UserRound, tone: "purple" },
    shopping: { Icon: ShoppingBag, tone: "orange" },
  }[domain.toLowerCase()] ?? { Icon: FolderSimpleIcon, tone: "blue" };
  const { Icon, tone } = presentation;
  return <Icon className={styles.categoryIcon} data-tone={tone} color="currentColor" weight="regular" aria-hidden="true" />;
}

/**
 * Where a request stands, in the requester's words. Localhost run 4 (S3)
 * showed the raw "granted" state as a pill and "Tax Record Domain" as a title.
 */
const HISTORY_STATUS: Record<string, string> = {
  pending: "Waiting",
  granted: "Shared",
  denied: "Declined",
  revoked: "Stopped",
  expired: "Expired",
  cancelled: "Withdrawn",
};

function historyStatusLabel(status: string): string {
  return HISTORY_STATUS[status] ?? "Check status";
}

function historyItemLabel(label: string | null | undefined): string {
  return humanSharedLabel(label) ?? "Shared information";
}

/**
 * A request's title: what it asked for when known, otherwise how many items.
 * `itemLabels` is the server's own list of the request's items (deduplicated),
 * so an older request on a later page still reads "Tax record and Portfolio"
 * rather than "2 items" (run 4, S3/U3).
 */
function historyTitle(
  labels: Array<string | null | undefined>,
  itemCount: number,
  itemLabels: readonly string[] = [],
): string {
  if (labels.length === itemCount && itemCount > 0) return joinInformationLabels(labels.map(historyItemLabel), 2);
  const named = itemLabels.filter((label) => typeof label === "string" && label.trim());
  if (named.length) return joinInformationLabels(named.map(historyItemLabel), 2);
  return `${itemCount} ${itemCount === 1 ? "item" : "items"}`;
}

export function PersonProfilePage({ personRef, initialProfile }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading: authLoading } = useAuth();
  const { vaultOwnerToken, isVaultUnlocked } = useVault();
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
  const [viewerLoadError, setViewerLoadError] = useState<{
    personRef: string; viewerUid: string;
  } | null>(null);
  const viewerUnavailable = viewerLoadError?.personRef === resolvedPersonRef
    && viewerLoadError.viewerUid === user?.uid;
  const [viewerProfileState, setViewerProfileState] = useState<{
    personRef: string;
    viewerUid: string | null;
    profile: ViewerPersonProfile | null;
  }>({ personRef: resolvedPersonRef, viewerUid: user?.uid ?? null, profile: null });
  const viewerProfile =
    viewerProfileState.personRef === resolvedPersonRef && viewerProfileState.viewerUid === user?.uid
      ? viewerProfileState.profile
      : null;
  const recentHistoryGroups = useMemo(() => {
    const groups = new Map<string, { first: PersonInformationRequestHistory; items: PersonInformationRequestHistory[] }>();
    for (const item of viewerProfile?.requestHistory ?? []) {
      const key = item.bundleId || item.requestId;
      const group = groups.get(key);
      if (group) group.items.push(item);
      else groups.set(key, { first: item, items: [item] });
    }
    return [...groups.entries()].map(([bundleId, group]) => ({ bundleId, ...group }));
  }, [viewerProfile?.requestHistory]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyCursors, setHistoryCursors] = useState<Array<string | null>>([null]);
  const [historyState, setHistoryState] = useState<{
    personRef: string; viewerUid: string; page: number; result: PersonRequestHistoryPage | null; failed: boolean;
  } | null>(null);
  const currentHistory = historyState?.personRef === resolvedPersonRef
    && historyState.viewerUid === user?.uid && historyState.page === historyPage ? historyState : null;
  const historyGroups = currentHistory?.result?.bundles.map((summary) => {
    const recent = recentHistoryGroups.find((group) => group.bundleId === summary.bundleId);
    return {
      bundleId: summary.bundleId,
      first: recent?.first ?? null,
      items: recent?.items ?? [],
      itemCount: summary.itemCount,
      itemLabels: Array.isArray(summary.itemLabels) ? summary.itemLabels : [],
      purpose: summary.purpose,
      createdAt: summary.createdAt,
    };
  }) ?? recentHistoryGroups.slice((historyPage - 1) * 8, historyPage * 8).map((group) => ({
    ...group,
    itemCount: group.items.length,
    itemLabels: [] as string[],
    purpose: group.first.purpose,
    createdAt: group.first.createdAt,
  }));
  const visibleHistoryGroups = historyGroups;
  const visibleHistoryPage = historyPage;
  const historyPageCount = Math.max(1, Math.ceil(recentHistoryGroups.length / 8));
  const [selectedScopeRefs, setSelectedScopeRefs] = useState<Set<string>>(new Set());
  const [reviewOpen, setReviewOpen] = useState(false);
  const [purpose, setPurpose] = useState("");
  const [durationHours, setDurationHours] = useState<number>(DEFAULT_REQUEST_DURATION_HOURS);
  const [bundleDetailsState, setBundleDetailsState] = useState<{
    personRef: string;
    viewerUid: string | null;
    details: Record<string, InformationRequestBundle>;
  }>({ personRef: resolvedPersonRef, viewerUid: user?.uid ?? null, details: {} });
  const bundleDetails = bundleDetailsState.personRef === resolvedPersonRef
    && bundleDetailsState.viewerUid === user?.uid ? bundleDetailsState.details : {};
  const [loadingBundleId, setLoadingBundleId] = useState<string | null>(null);
  const searchParams = useSearchParams();
  // /connect and the agent's discovery card land here with ?request=1: bring
  // the requestable catalog into view instead of the identity header.
  const requestIntent = searchParams?.get("request") === "1";
  const sharedIntent = searchParams?.get("section") === "shared";
  const availableSectionRef = useRef<HTMLElement | null>(null);
  const sharedSectionRef = useRef<HTMLElement | null>(null);
  const [showUnlockDialog, setShowUnlockDialog] = useState(false);
  const request = usePersonInformationRequest(resolvedPersonRef);
  const requesting = request.pending;
  const requestGeneration = useRef(0);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState(false);
  const catalogInFlight = useRef(false);
  useEffect(() => {
    requestGeneration.current += 1;
    catalogInFlight.current = false;
    setCatalogLoading(false);
    setCatalogError(false);
    return () => {
      requestGeneration.current += 1;
    };
  }, [resolvedPersonRef, user?.uid, isVaultUnlocked]);
  const [relationshipBusy, setRelationshipBusy] = useState(false);
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

  const [viewerReloadToken, setViewerReloadToken] = useState(0);
  useEffect(() => {
    if (authLoading || !user) return;
    let active = true;
    const cursor = historyCursors[historyPage - 1];
    if (historyPage > 1 && !cursor) return;
    setHistoryState({ personRef: resolvedPersonRef, viewerUid: user.uid, page: historyPage, result: null, failed: false });
    void user.getIdToken()
      .then((idToken) => PersonProfileService.getRequestHistory({
        personRef: resolvedPersonRef, idToken, cursor: cursor || undefined, limit: 8,
      }))
      .then((result) => {
        if (active) setHistoryState({ personRef: resolvedPersonRef, viewerUid: user.uid, page: historyPage, result, failed: false });
      })
      .catch(() => {
        if (active) setHistoryState({ personRef: resolvedPersonRef, viewerUid: user.uid, page: historyPage, result: null, failed: true });
      });
    return () => { active = false; };
  }, [authLoading, resolvedPersonRef, user, historyPage, historyCursors, viewerReloadToken]);
  useEffect(() => {
    if (authLoading || !user) return;
    requestGeneration.current += 1;
    catalogInFlight.current = false;
    setCatalogLoading(false);
    setCatalogError(false);
    setSelectedScopeRefs(new Set());
    setReviewOpen(false);
    let active = true;
    setViewerLoadError(null);
    void user
      .getIdToken()
      .then((token) => PersonProfileService.getViewer(resolvedPersonRef, token, { page: 1 }))
      .then((value) => {
        if (active) {
          setViewerProfileState({
            personRef: resolvedPersonRef,
            viewerUid: user.uid,
            profile: value,
          });
        }
      })
      .catch(() => {
        if (active) {
          setViewerLoadError({ personRef: resolvedPersonRef, viewerUid: user.uid });
          // Do not present an older eligibility catalog as current authority.
          setViewerProfileState({ personRef: resolvedPersonRef, viewerUid: user.uid, profile: null });
          setReviewOpen(false);
        }
      });
    return () => {
      active = false;
    };
  }, [authLoading, resolvedPersonRef, user, viewerReloadToken]);

  // One Voice changed a relationship: re-read this profile's relationship
  // state from the server rather than trusting the spoken outcome. The two
  // frames the relay sends for one confirmed action collapse to one reload.
  const voiceRefreshDedupe = useRef(new VoiceRefreshDeduper());
  const reloadAfterVoice = useCallback(
    (tool: string | null, result: ToolResultPublic | null) => {
      if (!isPeopleGraphChange(tool, result)) return;
      if (!voiceRefreshDedupe.current.shouldRefresh(result)) return;
      setViewerReloadToken((token) => token + 1);
    },
    [],
  );
  useVoiceToolEffects({
    onToolResult: (tool, result) => reloadAfterVoice(tool, result),
    onPendingResolved: (_id, status, result) => {
      if (status !== "executed") return;
      reloadAfterVoice(null, result);
    },
  });

  useEffect(() => {
    setSelectedScopeRefs(new Set());
    setReviewOpen(false);
    setPurpose("");
    setDurationHours(DEFAULT_REQUEST_DURATION_HOURS);
    setBundleDetailsState({ personRef: resolvedPersonRef, viewerUid: user?.uid ?? null, details: {} });
    setHistoryPage(1);
    setHistoryCursors([null]);
    setHistoryState(null);
  }, [resolvedPersonRef, user?.uid]);

  useEffect(() => {
    if (!user) return;
    const refresh = () => {
      requestGeneration.current += 1;
      setViewerProfileState((current) => current.personRef === resolvedPersonRef && current.viewerUid === user.uid
        ? { ...current, profile: null } : current);
      setViewerReloadToken((value) => value + 1);
    };
    const onPush = (event: Event) => {
      const detail = (event as CustomEvent<{ data?: { type?: string } }>).detail;
      if (["consent_resolved", "shared_information_updated"].includes(String(detail?.data?.type || ""))) refresh();
    };
    window.addEventListener(CONSENT_STATE_CHANGED_EVENT, refresh);
    window.addEventListener(FCM_MESSAGE_EVENT, onPush);
    return () => {
      window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, refresh);
      window.removeEventListener(FCM_MESSAGE_EVENT, onPush);
    };
  }, [resolvedPersonRef, user]);

  useEffect(() => {
    if (!requestIntent || !viewerProfile) return;
    const node = availableSectionRef.current;
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [requestIntent, viewerProfile]);

  useEffect(() => {
    if (!sharedIntent || !viewerProfile) return;
    const node = sharedSectionRef.current;
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    if (!isVaultUnlocked) {
      setShowUnlockDialog(true);
    }
  }, [sharedIntent, viewerProfile, isVaultUnlocked]);

  const allScopes = useMemo(() => viewerProfile?.requestableScopes || [], [viewerProfile]);

  async function loadMoreScopes() {
    const catalog = viewerProfile?.scopeCatalog;
    if (!user || !viewerProfile || !catalog?.nextPage || catalogInFlight.current) return;
    const generation = requestGeneration.current;
    const current = viewerProfile;
    catalogInFlight.current = true;
    setCatalogLoading(true);
    setCatalogError(false);
    try {
      const token = await user.getIdToken();
      const next = await PersonProfileService.getViewer(resolvedPersonRef, token, {
        page: catalog.nextPage, revision: catalog.catalogRevision,
      });
      if (generation !== requestGeneration.current) return;
      const merged = mergePersonScopePage(current, next);
      if (next.scopeCatalog?.paginationReset || next.scopeCatalog?.catalogRevision !== catalog.catalogRevision) {
        setSelectedScopeRefs(new Set());
        setReviewOpen(false);
      }
      setViewerProfileState({ personRef: resolvedPersonRef, viewerUid: user.uid, profile: merged });
    } catch {
      if (generation === requestGeneration.current) setCatalogError(true);
    } finally {
      if (generation === requestGeneration.current) {
        catalogInFlight.current = false;
        setCatalogLoading(false);
      }
    }
  }

  const grantedScopeRefs = useMemo(
    () =>
      new Set(
        (viewerProfile?.grants || [])
          .map((grant) => grant.scopeRef)
          .filter((ref): ref is string => Boolean(ref)),
      ),
    [viewerProfile?.grants],
  );

  /**
   * The catalogue in the one shape every scope surface reads.
   *
   * The adapter already existed and already took this exact payload type --
   * `scopeItemsFromRequestable` imports `RequestablePersonScope` from this
   * page's own service. Search, grouping and the threshold moved with it, which
   * is why the local copies of all three are gone.
   */
  const scopeItems = useMemo(
    () =>
      scopeItemsFromRequestable(allScopes).map((item) =>
        grantedScopeRefs.has(item.id) ? { ...item, disabled: true } : item,
      ),
    [allScopes, grantedScopeRefs],
  );

  const selectedScopes = useMemo(
    () =>
      selectedRequestScopes(allScopes, selectedScopeRefs).filter(
        (scope) => !grantedScopeRefs.has(scope.scopeRef),
      ),
    [allScopes, selectedScopeRefs, grantedScopeRefs],
  );

  const openRequestReview = () => {
    if (!selectedScopes.length) {
      toast.error("Choose at least one item before reviewing the request.");
      return false;
    }
    if (!isVaultUnlocked) {
      toast.error("Unlock your vault before requesting information.");
      return false;
    }
    if (!request.available) {
      toast.error("Your vault is still getting ready. Try again in a moment.");
      return false;
    }
    setReviewOpen(true);
    return true;
  };

  const submitRequest = async () => {
    const sent = await request.submit({ scopeRefs: selectedScopes.map(scope => scope.scopeRef), purpose, durationHours });
    if (sent) {
      setReviewOpen(false);
      setSelectedScopeRefs(new Set());
      setPurpose("");
      toast.success("Request sent for review");
      // Refresh failure must not misreport a successful write or invite a duplicate.
      setHistoryPage(1);
      setHistoryCursors([null]);
      setViewerReloadToken((value) => value + 1);
    }
  };

  const loadBundleDetails = async (bundleId: string) => {
    if (!vaultOwnerToken || bundleDetails[bundleId] || loadingBundleId) return;
    setLoadingBundleId(bundleId);
    try {
      const bundle = await PersonProfileService.getInformationRequest({ bundleId, vaultOwnerToken });
      if (bundle.personRef !== resolvedPersonRef || bundle.bundleId !== bundleId) {
        throw new Error("Request details did not match this person.");
      }
      setBundleDetailsState((current) => ({
        personRef: resolvedPersonRef,
        viewerUid: user?.uid ?? null,
        details: {
          ...(current.personRef === resolvedPersonRef && current.viewerUid === user?.uid ? current.details : {}),
          [bundleId]: bundle,
        },
      }));
    } catch (reason) {
      toast.error(oneLocationErrorMessage(reason, "Request details are unavailable right now."));
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
      if (action === "remove") {
        CacheSyncService.onConnectionGraphMutated(user.uid);
      } else {
        CacheSyncService.onConnectionCapabilityMutated(user.uid);
      }
      setViewerProfileState((current) =>
        current.personRef === resolvedPersonRef && current.viewerUid === user.uid && current.profile
          ? {
              personRef: resolvedPersonRef,
              viewerUid: user.uid,
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
      toast.error(oneLocationErrorMessage(reason, "Connection could not be updated. Try again."));
      return false;
    } finally {
      setRelationshipBusy(false);
    }
  };

  const allGrants = useMemo(() => viewerProfile?.grants || [], [viewerProfile?.grants]);

  // The same secure card as chat and Profile (CONTRACT-2 decision 2). Each
  // grant opens on this device from the bundle it, or its request history,
  // is bound to; the card owns opening, locking and ended access.
  const sharedCardItems = useMemo<SharedWithMeCardItem[]>(() => allGrants.map((grant, index) => {
    const history = viewerProfile?.requestHistory.find((item) => item.requestId === grant.requestId);
    const declared = String(history?.sensitivity ?? "").toLowerCase();
    const iso = (ms: number | null | undefined) =>
      typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
    return {
      key: grant.requestId || grant.scopeRef || `shared-${index}`,
      grantRef: grant.requestId,
      bundleId: grant.bundleId || history?.bundleId || null,
      requestId: grant.requestId,
      label: humanSharedLabel(grant.label) ?? "Shared information",
      sensitivity: declared === "standard" ? "standard" : declared ? "sensitive" : null,
      domain: grant.domain,
      fieldOutline: [],
      sharedAt: iso(grant.issuedAt),
      accessEndsAt: iso(grant.expiresAt),
      purpose: history?.purpose?.trim() || null,
      status: "granted",
    };
  }), [allGrants, viewerProfile?.requestHistory]);

  const cancelInformationRequest = async (bundleId: string) => {
    if (!user || !vaultOwnerToken) {
      toast.error("Unlock your vault to cancel this request.");
      return;
    }
    setCancellingBundleId(bundleId);
    try {
      await PersonProfileService.cancelInformationRequest({ bundleId, vaultOwnerToken });
      CacheSyncService.onConsentMutated(user.uid);
      setBundleDetailsState((current) => ({ ...current, details: Object.fromEntries(
        Object.entries(current.details).filter(([id]) => id !== bundleId),
      ) }));
      setViewerReloadToken((value) => value + 1);
      toast.success("Information request cancelled");
    } catch (reason) {
      toast.error(oneLocationErrorMessage(reason, "The request could not be cancelled. Try again."));
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
  useLocalOnboardingActionHandler("people.profile.remove_connection", async (_slots, context) => {
    const displayName = profile?.displayName || "this person";
    if (!context?.directiveId && !context?.humanConfirmationToken) {
      return {
        status: "blocked" as const,
        summary: `Removing your connection with ${displayName} needs a confirmation.`,
        data: {
          [VOICE_CONFIRM_DATA_KEY]: {
            actionId: "people.profile.remove_connection",
            slots: {},
            prompt: `Remove your connection with ${displayName}?`,
            subject: { name: displayName, detail: null },
            consequence:
              "Ends the connection with this person. Existing consent remains governed separately.",
            confirmLabel: "Remove",
          },
        },
      };
    }
    return {
      status: (await updateRelationship("remove")) ? "succeeded" : "failed",
      summary: "Connection removal finished.",
    };
  }, { enabled: viewerProfile?.relationship.status === "connected" });
  useLocalOnboardingActionHandler("people.profile.review_information_request", async () => {
    return openRequestReview()
      ? { status: "succeeded", summary: "Information request review opened." }
      : { status: "blocked", summary: "The request review is not ready yet." };
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
        purpose: "Review what you chose before asking for it.",
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
          purpose: "Review a person's relationship, requestable information, shared access, and request history.",
          primaryEntity: null,
          spokenSubject: null,
          sections: [
            { id: "shared", title: "Shared with you", summary: `${viewerProfile.grants.length} active` },
            { id: "requestable", title: "Available to request", summary: `${viewerProfile.scopeCatalog?.totalCount ?? viewerProfile.requestableScopes.length} items you can ask for` },
            { id: "history", title: "Request history", summary: `${historyGroups.length} ${historyGroups.length === 1 ? "request" : "requests"}` },
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
      <div className={styles.page} data-native-route="native-route-person-profile">
        <SectionCard className={styles.hero}>
          {viewerProfile?.relationship.status === "connected" ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="none" effect="fade" className={styles.overflow} aria-label="Profile options">
                  <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" disabled={relationshipBusy} onSelect={() => void updateRelationship("remove")} data-voice-control-id="person-profile-remove-connection">
                  Remove connection
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <ConnectionPersonAvatar
            photoUrl={profile.photoUrl}
            label={profile.displayName}
            verified={Boolean(profile.verifiedRole)}
            size="profile"
            className={styles.avatar}
          />
          <h1 className={styles.name}>
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
              <StatusPill tone={viewerProfile.relationship.status === "connected" ? "ready" : "neutral"}>
                {viewerProfile.relationship.status === "connected" ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : null}
                {viewerProfile.relationship.status === "connected"
                  ? "Connected"
                  : viewerProfile.relationship.status.startsWith("pending")
                    ? "Request pending"
                    : "Not connected"}
              </StatusPill>
            </div>
          ) : null}
          <div className={styles.actions} aria-label="Relationship actions">
            {viewerProfile ? (
              <Button type="button" variant="blue-gradient" effect="fill" className={styles.request} onClick={() => availableSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                <FileText className="h-5 w-5" aria-hidden="true" />
                Request
              </Button>
            ) : null}
            <Button
              type="button"
              variant="none"
              effect="fade"
              className={styles.share}
              aria-label="Share profile"
              onClick={() => {
                void navigator.clipboard.writeText(window.location.href);
                toast.success("Profile link copied");
              }}
            >
              <span className="inline-flex items-center gap-2">
                <Share2 className="h-5 w-5" aria-hidden="true" />
                <span>Share</span>
              </span>
            </Button>
            {viewerProfile ? (
              <>
                <Button type="button" variant="none" effect="fade" className={styles.manage} data-voice-control-id="person-profile-manage-consent" onClick={() => router.push(ROUTES.CONSENTS)}>
                  <Settings className="h-5 w-5" aria-hidden="true" />
                  Manage access
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
                {viewerProfile.relationship.status === "none" ? (
                  <Button
                    type="button"
                    variant="blue-gradient"
                    effect="fill"
                    disabled={relationshipBusy}
                    onClick={() => void updateRelationship("connect")}
                    data-voice-control-id="person-profile-connect"
                    className={styles.relationship}
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
                    className={styles.relationship}
                  >
                    Cancel request
                  </Button>
                ) : null}
                {viewerProfile.relationship.status === "connected" ? <DocumentRequestButton personRef={resolvedPersonRef} personName={profile.displayName || "this person"} /> : null}
              </>
            ) : null}

          </div>
        </SectionCard>

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
            <section
              id="shared-with-you"
              aria-labelledby="shared-with-you-heading"
              className="space-y-4"
              ref={sharedSectionRef}
            >
              <h2 id="shared-with-you-heading" className={styles.heading}>Shared with you</h2>
              <p className="sr-only">End-to-end encrypted information shared with your account, opened on this device only.</p>

              {sharedCardItems.length ? (
                <SharedWithYouCard
                  person={{
                    personRef: viewerProfile.personRef,
                    displayName: viewerProfile.displayName,
                    photoUrl: viewerProfile.photoUrl,
                  }}
                  items={sharedCardItems}
                  variant="profile"
                />
              ) : (
                <SectionCard className={styles.empty}>
                  <div className="flex flex-col items-center justify-center space-y-2">
                    <div className={styles.emptyIcon}>
                      <LockKeyhole className="h-5 w-5" />
                    </div>
                    <p className="text-sm font-semibold text-foreground">
                      Nothing shared yet
                    </p>
                    <p className="sr-only">
                      Information this person shares with you appears here.
                    </p>
                  </div>
                </SectionCard>
              )}
            </section>

            <section
              aria-labelledby="available-to-request"
              className={`space-y-3 ${styles.available}`}
              ref={availableSectionRef}
              data-testid="person-profile-available"
            >
              <h2 id="available-to-request" className={styles.heading}>Available to request</h2>
              {/*
                One nested list, the same one the Memory route uses.

                This section used to hand-roll its own search, its own domain
                chips, its own grouping map and its own row, which meant a
                person met a flat two-level list here and an unbounded drill-in
                on their own Memory -- the same information, two products. The
                catalogue is a set of `attr.<domain>.<path...>` references, so
                it already knew how to nest; the page just threw the path away.
              */}
              <ConsentScopeNestedList
                items={scopeItems}
                renderDomainLeading={renderCategoryIcon}
                searchPlaceholder="Search categories"
                showDomainFilter
                categorySelectionInDetail
                rootLabel="All"
                emptyText="This person has nothing available to ask for."
                testIdPrefix="person-profile-scope"
                selection={{
                  selectedIds: selectedScopeRefs,
                  grantedIds: grantedScopeRefs,
                  onToggleMany: (ids, select) =>
                    setSelectedScopeRefs((current) => toggleRequestScopes(
                      allScopes, current, ids.filter((id) => !grantedScopeRefs.has(id)), select,
                    )),
                }}
              />
              {viewerProfile.scopeCatalog?.hasMore ? (
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <p className="text-muted-foreground">{allScopes.length} of {viewerProfile.scopeCatalog.totalCount} loaded. Search checks loaded information.</p>
                  <Button type="button" variant="none" effect="fade" disabled={catalogLoading}
                    onClick={() => void loadMoreScopes()}>
                    {catalogLoading ? "Loading more…" : catalogError ? "Try loading more again" : "Load more information"}
                  </Button>
                </div>
              ) : null}
            </section>

            <section aria-labelledby="request-history" className="space-y-3">
              <h2 id="request-history" className={styles.heading}>Request history</h2>
              {currentHistory?.failed ? (
                <p role="status" className="text-sm text-muted-foreground">Older requests could not be loaded. Showing recent activity only.</p>
              ) : null}
              {historyGroups.length ? (
                <SectionCard>
                  <div className="divide-y divide-border/60">
                    {visibleHistoryGroups.map(({ bundleId, first, items, itemCount, itemLabels, purpose: requestPurpose, createdAt }) => {
                      const details = bundleDetails[bundleId];
                      const statusItems = details?.items ?? (items.length === itemCount ? items : []);
                      const statuses = new Set(statusItems.map((item) => item.status));
                      const grantedCount = statusItems.filter((item) => item.status === "granted").length;
                      const statusLabel = !statusItems.length ? "Check status"
                        : statuses.size === 1 ? historyStatusLabel(statusItems[0]!.status) : `${grantedCount} of ${itemCount} shared`;
                      const title = historyTitle(
                        statusItems.length ? statusItems.map((item) => item.label) : first ? [first.label] : [],
                        itemCount,
                        itemLabels,
                      );
                      return (
                        <div key={bundleId} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold">{title}</p>
                            <p className="mt-1 text-sm text-muted-foreground">{requestPurpose}</p>
                            {createdAt ? (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(createdAt))}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 flex-wrap items-center gap-2">
                            <StatusPill tone={statusItems.length === itemCount && grantedCount === itemCount ? "ready" : "neutral"}>
                              {statusLabel}
                            </StatusPill>
                            {!details ? (
                              <Button
                                type="button"
                                variant="none"
                                effect="fade"
                                disabled={loadingBundleId === bundleId}
                                onClick={() => void loadBundleDetails(bundleId)}
                                aria-label={`Details for ${title}`}
                              >
                                {loadingBundleId === bundleId ? "Loading…" : "Details"}
                              </Button>
                            ) : null}
                            {statusItems.some((item) => item.status === "pending") ? (
                              <Button
                                type="button"
                                variant="none"
                                effect="fade"
                                disabled={cancellingBundleId === bundleId}
                                onClick={() => void cancelInformationRequest(bundleId)}
                              >
                                {cancellingBundleId === bundleId ? "Withdrawing…" : "Withdraw pending"}
                              </Button>
                            ) : null}
                          </div>
                          {details ? (
                            <p className="max-h-40 w-full overflow-y-auto text-xs text-muted-foreground" data-testid="person-profile-bundle-details">
                              {details.items.map((entry) => `${historyItemLabel(entry.label)} (${historyStatusLabel(entry.status).toLowerCase()})`).join(", ")}
                              {" · "}
                              {requestDurationLabel(Math.round(details.durationSeconds / 3600))}
                              {details.cancelled ? " · withdrawn" : ""}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                  {currentHistory?.result?.nextCursor || historyPage > 1 || (!currentHistory?.result && recentHistoryGroups.length > 8) ? (
                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/60 pt-3 text-sm">
                      <Button type="button" variant="none" effect="fade" disabled={visibleHistoryPage <= 1} onClick={() => setHistoryPage((page) => Math.max(1, page - 1))}>Previous</Button>
                      <span className="text-muted-foreground">{currentHistory?.result ? `Page ${visibleHistoryPage}` : `${visibleHistoryPage} of ${historyPageCount}`}</span>
                      <Button type="button" variant="none" effect="fade" disabled={currentHistory?.result ? !currentHistory.result.nextCursor : visibleHistoryPage >= historyPageCount} onClick={() => {
                        if (currentHistory?.result?.nextCursor) setHistoryCursors((cursors) => [...cursors.slice(0, historyPage), currentHistory.result!.nextCursor]);
                        setHistoryPage((page) => page + 1);
                      }}>Next</Button>
                    </div>
                  ) : null}
                </SectionCard>
              ) : (
                <SectionCard className={styles.empty}>
                  <div className={styles.emptyIcon}><FileText className="h-5 w-5" aria-hidden="true" /></div>
                  <p className="text-sm font-semibold text-muted-foreground">No requests yet</p>
                </SectionCard>
              )}
            </section>
            {allScopes.length ? (
              <div className={styles.review}>
                <Button
                  type="button"
                  variant="blue-gradient"
                  effect="fill"
                  disabled={!selectedScopes.length}
                  onClick={openRequestReview}
                  data-voice-control-id="person-profile-review-information"
                >
                  Review request{selectedScopes.length ? ` (${selectedScopes.length})` : ""}
                </Button>
              </div>
            ) : null}
          </>
        ) : viewerUnavailable && user ? (
          <SectionCard className="py-8 text-center">
            <div role="alert" className="flex flex-col items-center justify-center space-y-2">
              <p className="text-sm font-semibold text-foreground">
                We couldn&rsquo;t load your connection with {profile.displayName} right now.
              </p>
              <p className="sr-only">
                Your connection status, what you can request, and anything shared with you will appear here once this loads.
              </p>
              <Button
                type="button"
                variant="none"
                effect="fade"
                onClick={() => setViewerReloadToken((token) => token + 1)}
              >
                Try again
              </Button>
            </div>
          </SectionCard>
        ) : null}
      </div>
      <Dialog modal open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent
          className="w-[calc(100%-2rem)] max-w-[30rem] max-h-[min(32rem,calc(100dvh-2rem-var(--app-safe-area-top-effective,0px)-env(safe-area-inset-bottom,0px)))] gap-3 overflow-hidden p-4 sm:max-w-[30rem]"
        >
          <DialogHeader className="shrink-0 pr-8 text-left">
            <DialogTitle>Request information from {profile.displayName}</DialogTitle>
            <DialogDescription>
              They will see exactly what you asked for, why, and for how long.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
            <InformationRequestReviewFields scopes={selectedScopes} purpose={purpose} durationHours={durationHours}
              onPurposeChange={setPurpose} onDurationChange={setDurationHours} disabled={requesting} />
            {request.error ? <p role="alert" className="text-sm text-destructive">{request.error}</p> : null}
          </div>
          <DialogFooter className="shrink-0 flex-row items-center justify-end border-t border-border/60 pt-3">
            <Button type="button" variant="none" effect="fade" data-voice-control-id="person-profile-request-cancel" onClick={() => setReviewOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="blue-gradient"
              effect="fill"
              disabled={requesting || purpose.trim().length < 8 || !selectedScopes.length || selectedScopes.length > 50 || !request.available}
              onClick={() => void submitRequest()}
              data-voice-control-id="person-profile-request-confirm"
            >
              {requesting ? "Sending…" : "Send request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {user ? (
        <VaultUnlockDialog
          user={user}
          open={showUnlockDialog}
          onOpenChange={setShowUnlockDialog}
          onSuccess={() => setShowUnlockDialog(false)}
          title="Unlock your vault"
          description="Unlock your private agent to reveal information shared with you."
        />
      ) : null}
    </AppPageShell>
  );
}
