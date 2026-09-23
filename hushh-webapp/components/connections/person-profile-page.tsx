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
import { CheckCircle2, Copy, Grid2x2, List, LockKeyhole, Search, X } from "@/components/icons";
import { toast } from "sonner";

import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";
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
import { InformationRequestReviewFields } from "@/components/consent/information-request-review-fields";
import { DocumentRequestButton } from "@/components/consent/document-request-button";
import { usePersonInformationRequest } from "@/lib/consent/use-person-information-request";
import { projectGrantPayload } from "@/lib/consent/project-grant-payload";
import { isCurrentPersonExport } from "@/lib/consent/person-export-binding";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import { FCM_MESSAGE_EVENT } from "@/lib/notifications";
import {
  SectionCard,
  StatusPill,
} from "@/lib/morphy-ux/ui/surface-primitives";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { ConsentScopeNestedList } from "@/components/consent/consent-scope-nested-list";
import { DecryptedGrantCard } from "@/components/connections/decrypted-grant-card";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { scopeItemsFromRequestable } from "@/lib/consent/consent-scope-items";
import { selectedRequestScopes, toggleRequestScopes } from "@/lib/consent/request-scope-selection";
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
import { shouldSkipReviewerBackgroundWritesForAutomation } from "@/lib/testing/native-test";

type Props = { personRef: string; initialProfile: PublicPersonProfile | null };

const GRANT_DECRYPT_STEP_TIMEOUT_MS = 30_000;

function withGrantDecryptTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
  let timeoutId: number | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), GRANT_DECRYPT_STEP_TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  });
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
      purpose: summary.purpose,
      createdAt: summary.createdAt,
    };
  }) ?? recentHistoryGroups.slice((historyPage - 1) * 8, historyPage * 8).map((group) => ({
    ...group,
    itemCount: group.items.length,
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
  const [decryptedByRequest, setDecryptedByRequest] = useState<Record<string, Record<string, unknown>>>({});
  const [decryptedRevisionByRequest, setDecryptedRevisionByRequest] = useState<Record<string, number | null>>({});
  const [decryptFailedByRequest, setDecryptFailedByRequest] = useState<Record<string, boolean>>({});
  const [decryptingRequestId, setDecryptingRequestId] = useState<string | null>(null);
  const [cancellingBundleId, setCancellingBundleId] = useState<string | null>(null);
  const [sharedSearchQuery, setSharedSearchQuery] = useState("");
  const [sharedActiveDomain, setSharedActiveDomain] = useState("all");
  const [sharedViewMode, setSharedViewMode] = useState<"cards" | "list">("cards");
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

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
    setDecryptedByRequest({});
    setDecryptedRevisionByRequest({});
    setDecryptFailedByRequest({});
    setDecryptingRequestId(null);
  }, [resolvedPersonRef, user?.uid]);

  useEffect(() => {
    if (!user) return;
    const refresh = () => {
      requestGeneration.current += 1;
      setDecryptedByRequest({});
      setDecryptedRevisionByRequest({});
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
    if (isVaultUnlocked) return;
    setDecryptedByRequest({});
    setDecryptedRevisionByRequest({});
    setDecryptFailedByRequest({});
    setDecryptingRequestId(null);
  }, [isVaultUnlocked]);

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
      toast.error("Choose at least one thing before reviewing the request.");
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

  const revealGrant = useCallback(
    async (requestId: string | null) => {
      if (!requestId || !user || !vaultKey || !vaultOwnerToken || !isVaultUnlocked || !viewerProfile) {
        toast.error("Unlock your vault to view this grant.");
        return;
      }
      const grant = viewerProfile.grants.find((item) => item.requestId === requestId);
      const expectedRevision = grant?.exportRevision;
      const history = viewerProfile.requestHistory.find((item) => item.requestId === requestId);
      const bundleId = grant?.bundleId || history?.bundleId;
      if (!grant || !bundleId) {
        toast.error("This shared information is not available right now.");
        return;
      }
      setDecryptingRequestId(requestId);
      setDecryptFailedByRequest((current) => {
        if (!current[requestId]) return current;
        const next = { ...current };
        delete next[requestId];
        return next;
      });
      const generation = requestGeneration.current;
      try {
        const bundle = await withGrantDecryptTimeout(
          PersonProfileService.getInformationRequest({ bundleId, vaultOwnerToken }),
          "The request status took too long to check. Try again.",
        );
        if (generation !== requestGeneration.current) return;
        const item = bundle.items.find((entry) => entry.requestId === requestId);
        if (bundle.bundleId !== bundleId || bundle.personRef !== resolvedPersonRef || item?.status !== "granted") {
          throw new Error("This access is no longer available.");
        }
        if (decryptedByRequest[requestId] && expectedRevision != null
          && decryptedRevisionByRequest[requestId] === expectedRevision) return;
        const connector = await withGrantDecryptTimeout(
          OneKycClientZkService.readStoredConnector({
            userId: user.uid,
            vaultKey,
            vaultOwnerToken,
          }),
          "The receiving device took too long to open. Try again.",
        );
        if (generation !== requestGeneration.current) return;
        if (!connector) throw new Error("The receiving device is unavailable.");
        const exports = await withGrantDecryptTimeout(
          PersonProfileService.getInformationRequestExports({
            bundleId,
            vaultOwnerToken,
          }),
          "The shared information took too long to load. Try opening this again.",
        );
        if (generation !== requestGeneration.current) return;
        const exact = exports.find((item) => item.requestId === requestId);
        if (!exact || !isCurrentPersonExport({ item, scopeRef: exact.scopeRef, exportPackage: exact.encryptedExport, nowMs: Date.now() })) {
          throw new Error("This shared information is not available right now.");
        }
        const packageRevision = typeof exact.encryptedExport.export_revision === "number"
          ? exact.encryptedExport.export_revision
          : null;
        if (expectedRevision != null && expectedRevision !== packageRevision) {
          throw new Error("This shared information changed. Please check again.");
        }
        const payload = await withGrantDecryptTimeout(
          OneKycClientZkService.decryptScopedExport({
            exportPackage: exact.encryptedExport,
            connector,
          }),
          "The shared information took too long to open. Try again.",
        );
        if (generation !== requestGeneration.current) return;
        const latest = await PersonProfileService.getInformationRequest({ bundleId, vaultOwnerToken });
        if (generation !== requestGeneration.current) return;
        if (latest.bundleId !== bundleId || latest.personRef !== resolvedPersonRef
          || !latest.items.some((entry) => entry.requestId === requestId && entry.status === "granted")) {
          throw new Error("This access changed while opening information.");
        }
        if (generation !== requestGeneration.current) return;
        setDecryptedByRequest((current) => ({
          ...current,
          [requestId]: projectGrantPayload(payload, grant?.domain),
        }));
        setDecryptedRevisionByRequest((current) => ({
          ...current,
          [requestId]: packageRevision ?? expectedRevision ?? null,
        }));
      } catch (reason) {
        if (generation === requestGeneration.current) {
          setDecryptFailedByRequest((current) => ({ ...current, [requestId]: true }));
          toast.error(oneLocationErrorMessage(reason, "This shared information could not be opened."));
        }
      } finally {
        // A person/vault change invalidates the result, but it must not leave
        // the old card permanently stuck in its busy state. Only clear the
        // request that still owns the indicator; a newer decrypt remains
        // untouched.
        setDecryptingRequestId((current) => current === requestId ? null : current);
      }
    },
    [
      decryptedByRequest,
      decryptedRevisionByRequest,
      isVaultUnlocked,
      resolvedPersonRef,
      user,
      vaultKey,
      vaultOwnerToken,
      viewerProfile,
    ],
  );

  const allGrants = useMemo(() => viewerProfile?.grants || [], [viewerProfile?.grants]);

  const domainCounts = useMemo(() => {
    const counts: Record<string, number> = { all: allGrants.length };
    for (const grant of allGrants) {
      const d = String(grant.domain || "other").toLowerCase();
      counts[d] = (counts[d] || 0) + 1;
    }
    return counts;
  }, [allGrants]);

  const availableDomains = useMemo(() => {
    const set = new Set<string>();
    for (const grant of allGrants) {
      if (grant.domain) set.add(grant.domain.toLowerCase());
    }
    return Array.from(set).sort();
  }, [allGrants]);

  const filteredGrants = useMemo(() => {
    const q = sharedSearchQuery.trim().toLowerCase();
    return allGrants.filter((grant) => {
      if (sharedActiveDomain !== "all") {
        const d = String(grant.domain || "other").toLowerCase();
        if (d !== sharedActiveDomain) return false;
      }
      if (q) {
        const label = String(grant.label || "").toLowerCase();
        const domain = String(grant.domain || "").toLowerCase();
        const scopeRef = String(grant.scopeRef || "").toLowerCase();
        const decrypted = grant.requestId ? decryptedByRequest[grant.requestId] : null;
        const decryptedText = decrypted ? JSON.stringify(decrypted).toLowerCase() : "";
        return (
          label.includes(q) ||
          domain.includes(q) ||
          scopeRef.includes(q) ||
          decryptedText.includes(q)
        );
      }
      return true;
    });
  }, [allGrants, sharedActiveDomain, sharedSearchQuery, decryptedByRequest]);

  useEffect(() => {
    if (shouldSkipReviewerBackgroundWritesForAutomation()) return;
    if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken || !allGrants.length || !user) return;
    if (decryptingRequestId) return;
    // Prioritize visible / filtered grants first (on-demand viewport scaling)
    const pendingFiltered = filteredGrants.filter(
      (grant) => grant.requestId
        && !decryptedByRequest[grant.requestId]
        && !decryptFailedByRequest[grant.requestId]
        && decryptingRequestId !== grant.requestId,
    );
    if (pendingFiltered.length && pendingFiltered[0]?.requestId) {
      void revealGrant(pendingFiltered[0].requestId);
    }
    // Do not serially decrypt unrelated cards in the background. Each grant
    // stays encrypted until it is the visible filtered result or the user
    // explicitly opens it, so one slow connector cannot block another card.
  }, [
    isVaultUnlocked,
    vaultKey,
    vaultOwnerToken,
    allGrants,
    filteredGrants,
    user,
    decryptFailedByRequest,
    decryptedByRequest,
    decryptedRevisionByRequest,
    decryptingRequestId,
    revealGrant,
  ]);

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
          purpose: "Review a person's relationship, requestable information, grants, and request history.",
          primaryEntity: null,
          spokenSubject: null,
          sections: [
            { id: "shared", title: "Shared with you", summary: `${viewerProfile.grants.length} active grants` },
            { id: "requestable", title: "Available to request", summary: `${viewerProfile.scopeCatalog?.totalCount ?? viewerProfile.requestableScopes.length} things you can ask for` },
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
                {viewerProfile.relationship.status === "connected" ? <DocumentRequestButton personRef={resolvedPersonRef} personName={profile.displayName || "this person"} /> : null}
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
            <section
              id="shared-with-you"
              aria-labelledby="shared-with-you"
              className="space-y-4"
              ref={sharedSectionRef}
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <PageHeader
                  title="Shared with you"
                  description="End-to-end encrypted information shared with your account. Unlock your vault to view it."
                />

                {allGrants.length > 1 ? (
                  <div className="flex items-center gap-1 self-start sm:self-auto rounded-xl bg-muted/60 p-1 border border-border/40 shrink-0">
                    <button
                      type="button"
                      onClick={() => setSharedViewMode("cards")}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-[background-color,color,box-shadow] duration-150",
                        sharedViewMode === "cards"
                          ? "bg-background text-foreground shadow-2xs font-semibold"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                      title="Cards View"
                    >
                      <Grid2x2 className="h-3.5 w-3.5" />
                      <span>Cards</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setSharedViewMode("list")}
                      className={cn(
                        "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-[background-color,color,box-shadow] duration-150",
                        sharedViewMode === "list"
                          ? "bg-background text-foreground shadow-2xs font-semibold"
                          : "text-muted-foreground hover:text-foreground"
                      )}
                      title="Compact List View"
                    >
                      <List className="h-3.5 w-3.5" />
                      <span>List</span>
                    </button>
                  </div>
                ) : null}
              </div>

              {allGrants.length > 0 ? (
                <div className="space-y-3">
                  {/* Spotlight Search Bar */}
                  {allGrants.length > 1 ? (
                    <div className="relative">
                      <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/60" />
                      <input
                        type="text"
                        value={sharedSearchQuery}
                        onChange={(e) => setSharedSearchQuery(e.target.value)}
                        placeholder={`Search ${allGrants.length} shared records, skills, holdings...`}
                        className="w-full rounded-2xl border border-border/60 bg-muted/20 px-9 py-2 text-xs sm:text-sm text-foreground placeholder:text-muted-foreground outline-none transition-[background-color,border-color,box-shadow] duration-150 focus:border-primary/40 focus:bg-background focus:ring-2 focus:ring-primary/10"
                      />
                      {sharedSearchQuery ? (
                        <button
                          type="button"
                          onClick={() => setSharedSearchQuery("")}
                          className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                          title="Clear search"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Faceted Domain Pills Rail */}
                  {availableDomains.length > 1 ? (
                    <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
                      <button
                        type="button"
                        onClick={() => setSharedActiveDomain("all")}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-[background-color,color,box-shadow] duration-150 whitespace-nowrap",
                          sharedActiveDomain === "all"
                            ? "bg-foreground text-background font-semibold shadow-xs"
                            : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
                        )}
                      >
                        All
                        <span className="text-[10px] opacity-70">({allGrants.length})</span>
                      </button>
                      {availableDomains.map((dom) => (
                        <button
                          key={dom}
                          type="button"
                          onClick={() => setSharedActiveDomain(dom)}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium capitalize transition-[background-color,color,box-shadow] duration-150 whitespace-nowrap",
                            sharedActiveDomain === dom
                              ? "bg-foreground text-background font-semibold shadow-xs"
                              : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
                          )}
                        >
                          {dom}
                          <span className="text-[10px] opacity-70">({domainCounts[dom] || 0})</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {filteredGrants.length ? (
                sharedViewMode === "cards" ? (
                  <div className="grid gap-4 w-full">
                    {filteredGrants.map((grant, index) => (
                      <DecryptedGrantCard
                        key={`${grant.scopeRef || grant.requestId}-${index}`}
                        grant={grant}
                        decryptedData={grant.requestId ? decryptedByRequest[grant.requestId] || null : null}
                        isVaultUnlocked={isVaultUnlocked}
                        isDecrypting={grant.requestId ? decryptingRequestId === grant.requestId : false}
                        onUnlockVault={() => setShowUnlockDialog(true)}
                        onRevealManual={grant.requestId ? () => void revealGrant(grant.requestId) : undefined}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <SettingsGroup density="comfortable">
                      {filteredGrants.map((grant, index) => {
                        const isExpanded = expandedRowId === (grant.requestId || grant.scopeRef);
                        const decrypted = grant.requestId ? decryptedByRequest[grant.requestId] : null;
                        return (
                          <div key={`${grant.scopeRef || grant.requestId}-${index}`}>
                            <SettingsRow
                              title={grant.label}
                              description={grant.domain || "Shared record"}
                              trailing={
                                <div className="flex items-center gap-2">
                                  <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                    Active
                                  </span>
                                </div>
                              }
                              onClick={() =>
                                setExpandedRowId(isExpanded ? null : grant.requestId || grant.scopeRef || null)
                              }
                            />
                            {isExpanded ? (
                              <div className="border-t border-border/40 bg-muted/20 p-4">
                                <DecryptedGrantCard
                                  grant={grant}
                                  decryptedData={decrypted}
                                  isVaultUnlocked={isVaultUnlocked}
                                  isDecrypting={grant.requestId ? decryptingRequestId === grant.requestId : false}
                                  onUnlockVault={() => setShowUnlockDialog(true)}
                                  onRevealManual={grant.requestId ? () => void revealGrant(grant.requestId) : undefined}
                                />
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </SettingsGroup>
                  </div>
                )
              ) : allGrants.length > 0 ? (
                <SectionCard className="py-6 text-center">
                  <p className="text-sm font-medium text-muted-foreground">
                    No shared records match &ldquo;{sharedSearchQuery}&rdquo;
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setSharedSearchQuery("");
                      setSharedActiveDomain("all");
                    }}
                    className="mt-2 text-xs font-semibold text-primary hover:underline"
                  >
                    Reset filters
                  </button>
                </SectionCard>
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
                rootLabel="All"
                emptyText="This person has nothing available to ask for."
                testIdPrefix="person-profile-scope"
                selection={{
                  selectedIds: selectedScopeRefs,
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
              {allScopes.length ? (
                <div className="flex justify-end pt-1">
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
            </section>

            <section aria-labelledby="request-history" className="space-y-3">
              <PageHeader
                title="Request history"
                description="Requests you sent to this person and their current status."
              />
              {currentHistory?.failed ? (
                <p role="status" className="text-sm text-muted-foreground">Older requests could not be loaded. Showing recent activity only.</p>
              ) : null}
              {historyGroups.length ? (
                <SectionCard>
                  <div className="divide-y divide-border/60">
                    {visibleHistoryGroups.map(({ bundleId, first, items, itemCount, purpose: requestPurpose, createdAt }) => {
                      const details = bundleDetails[bundleId];
                      const statusItems = details?.items ?? (items.length === itemCount ? items : []);
                      const statuses = new Set(statusItems.map((item) => item.status));
                      const grantedCount = statusItems.filter((item) => item.status === "granted").length;
                      const statusLabel = !statusItems.length ? "Check status"
                        : statuses.size === 1 ? statusItems[0]!.status : `${grantedCount} of ${itemCount} granted`;
                      return (
                        <div key={bundleId} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-semibold">{itemCount === 1 && first ? first.label : `Request for ${itemCount} information items`}</p>
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
                                aria-label={`Details for ${itemCount === 1 && first ? first.label : `${itemCount} information items`}`}
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
                              {details.items.map((entry) => `${entry.label} (${entry.status})`).join(", ")}
                              {" · "}
                              {requestDurationLabel(Math.round(details.durationSeconds / 3600))}
                              {details.cancelled ? " · cancelled" : ""}
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
                <SectionCard>
                  <p className="text-sm text-muted-foreground">No information requests yet.</p>
                </SectionCard>
              )}
            </section>
          </>
        ) : viewerUnavailable && user ? (
          <SectionCard className="py-8 text-center">
            <div role="alert" className="flex flex-col items-center justify-center space-y-2">
              <p className="text-sm font-semibold text-foreground">
                We couldn&rsquo;t load your connection with {profile.displayName} right now.
              </p>
              <p className="text-xs text-muted-foreground max-w-sm">
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
