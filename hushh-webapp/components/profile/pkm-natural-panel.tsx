"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  SpinnerGapIcon as Loader2,
  LockIcon as Lock,
  ShieldWarningIcon as ShieldAlert,
} from "@/components/icons";
import { SearchClearButton } from "@/components/app-ui/search-clear-button";

import { PkmMemoryRow } from "@/components/profile/pkm-memory-row";
import { LocationMemoryView } from "@/components/profile/location-memory-view";
import { buildLocationMemoryPresentation, findLocationMemoryFieldForCard, resolveLocationMemoryField } from "@/lib/profile/location-memory-presentation";
import { ROUTES } from "@/lib/navigation/routes";
import { PkmMemoryLevel } from "@/components/profile/pkm-memory-level";
import {
  PkmMemoryDetail,
  type MemorySharingPosture,
  type MemorySharingState,
} from "@/components/profile/pkm-memory-detail";
import { SettingsGroup, SettingsRow, SegmentedTabs } from "@/components/app-ui/settings-ui";
import { PkmExportService } from "@/lib/services/pkm-export-service";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
import { NativeTestBeacon, type NativeTestDataState } from "@/components/app-ui/native-test-beacon";
import { useAuth } from "@/hooks/use-auth";
import { trackEvent } from "@/lib/observability/client";
import { Button } from "@/lib/morphy-ux/morphy";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import {
  buildPkmDomainPresentation,
  isConsumerBrowsablePkmDomain,
} from "@/lib/profile/pkm-profile-presentation";
import {
  addToPKM,
  clearAgentPkmContext,
  describeAgentPkmCardDestination,
  formatAgentPkmCardDestination,
  getIgnoredPkmCards,
  type AgentPkmPreviewCard,
} from "@/lib/agent/agent-pkm-memory";
import {
  isUnresolvedSourceBlock,
  prepareNaturalLanguagePkm,
  type PkmNaturalLanguageSourceCoverage,
} from "@/lib/pkm/pkm-natural-language-ingestion";
import { describePkmCaptureSection, pkmCaptureSectionKey } from "@/lib/pkm/pkm-capture-sections";
import { isDegradedPreviewCard } from "@/lib/profile/pkm-agent-lab-preview";
import { createAgentPkmCaptureGuard, isAgentPkmProcessingReady } from "@/lib/agent/agent-pkm-capture-runtime";
import { useReviewerPkmProof } from "@/lib/testing/use-reviewer-pkm-proof";
import { AgentPkmContextStore } from "@/lib/agent/agent-pkm-context-store";
import {
  DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY,
  loadAgentPkmAutoSavePolicy,
  saveAgentPkmAutoSavePolicy,
  type AgentPkmAutoSavePolicy,
} from "@/lib/agent/agent-pkm-auto-save-policy";
import {
  buildPkmMemorySnapshot,
  deletePkmDomainValue,
  selectRelevantPkmMemoryCards,
  updatePkmDomainValue,
  type PkmMemoryCard,
  type PkmPathSegment,
} from "@/lib/pkm/pkm-memory-cards";
import { pkmMemoryCardBreadcrumb } from "@/lib/pkm/pkm-memory-level";
import {
  buildPkmShareBundles,
  pkmShareBundleState,
} from "@/lib/profile/pkm-memory-tree";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import {
  ConsentCenterService,
  type ConsentCenterEntry,
} from "@/lib/services/consent-center-service";
import {
  PersonalKnowledgeModelService,
  type PkmMutationSharingImpact,
  type PersonalKnowledgeModelMetadata,
} from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { usePkmDomainChangeRevision } from "@/lib/pkm/use-pkm-domain-change-revision";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { useVault } from "@/lib/vault/vault-context";

type DomainDetailState = {
  session?: MemoryReadSession;
  manifest: DomainManifest | null;
  data: Record<string, unknown> | null;
  loading: boolean;
  error: boolean;
};

type MemoryReadSession = symbol;

type MemoryWorkspaceTab = "browse" | "add" | "sharing";
const MEMORY_WORKSPACE_TABS = [
  { value: "browse", label: "Saved" },
  { value: "add", label: "Add" },
  { value: "sharing", label: "Sharing" },
];

const EMPTY_DOMAIN_DETAIL: DomainDetailState = {
  manifest: null,
  data: null,
  loading: false,
  error: false,
};

/** The Recently learned route lists this many; the home shows one row into it. */
const RECENT_MEMORIES_LIMIT = 50;

// Capture operations are intentionally process-local. They retain only an
// owner/operation identity, never source text, keys, or decrypted values. A
// module-level registry prevents a route remount from dispatching the same
// reviewed write twice while the first request is still settling.
const pkmCaptureSaveInFlight = new Map<string, symbol>();
const pkmCaptureReconciliationNeeded = new Set<string>();

function cardScopePath(card: PkmMemoryCard): string {
  return String(card.pathSegments.find((segment) => typeof segment === "string") || "profile");
}

function cardImpactKey(card: PkmMemoryCard): string {
  return `${card.domain}::${cardScopePath(card)}`;
}

/** The reviewed card's destination, then how it is shared. */
function describeUnresolvedCapture(sectionCount: number, hasReadyDetails: boolean): string {
  const sections = `${sectionCount} section${sectionCount === 1 ? "" : "s"} of this note still need${sectionCount === 1 ? "s" : ""} another pass`;
  return hasReadyDetails
    ? `${sections}. You can save the details that are ready now; nothing from ${sectionCount === 1 ? "that section" : "those sections"} will be saved.`
    : `${sections}. Nothing has been saved.`;
}

function CaptureCardDescription({
  card,
  domainTitles,
}: {
  card: AgentPkmPreviewCard;
  domainTitles: ReadonlyMap<string, string>;
}) {
  const destination = describeAgentPkmCardDestination(card, domainTitles);
  const sharing = card.sharing_impact?.active_recipient_count
    ? card.sharing_impact.summary?.trim() || "This may update a detail that is currently shared."
    : "This stays private unless you choose to share it later.";
  return (
    <>
      <span
        className="block font-medium text-foreground"
        data-testid="memory-capture-destination"
        data-destination-kind={destination.kind}
      >
        {formatAgentPkmCardDestination(destination)}
      </span>
      {destination.kind === "not_saved" ? null : <span className="block">{sharing}</span>}
    </>
  );
}

export function PkmNaturalPanel({
  refreshToken = 0,
  view = "home",
  locationMemoryId = null,
}: {
  refreshToken?: number;
  onOpenExplorer?: () => void;
  /** "recent" renders the full Recently learned list on its own route. */
  view?: "home" | "recent" | "location" | "location-detail";
  locationMemoryId?: string | null;
} = {}) {
  const router = useRouter();
  const { user, loading: authLoading, sessionVerificationRequired } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken, tokenExpiresAt } = useVault();
  const locationView = view === "location" || view === "location-detail";
  // Cache tags change with authority, without retaining copies of vault keys.
  const memoryReadSession = useMemo(() => Symbol(
    user?.uid && vaultKey && vaultOwnerToken && isVaultUnlocked ? "authorized-memory-session" : "unavailable-memory-session",
  ), [user?.uid, vaultKey, vaultOwnerToken, isVaultUnlocked]);
  const memoryReadSessionRef = useRef(memoryReadSession);
  memoryReadSessionRef.current = memoryReadSession;
  const locationSnapshot = useRef<{ session: MemoryReadSession; data: Record<string, unknown> } | null>(null);
  useReviewerPkmProof({ userId: user?.uid ?? null, authLoading, sessionVerificationRequired,
    isVaultUnlocked, vaultKey, vaultOwnerToken, tokenExpiresAt });
  const captureReadinessRef = useRef({ authLoading, sessionVerificationRequired, isVaultUnlocked, vaultOwnerToken, tokenExpiresAt });
  captureReadinessRef.current = { authLoading, sessionVerificationRequired, isVaultUnlocked, vaultOwnerToken, tokenExpiresAt };
  const renderedMemoryOwnerId = user?.uid ?? null;
  const memoryOwnerIdRef = useRef<string | null>(renderedMemoryOwnerId);
  memoryOwnerIdRef.current = renderedMemoryOwnerId;
  useEffect(() => {
    memoryOwnerIdRef.current = renderedMemoryOwnerId;
    return () => {
      if (memoryOwnerIdRef.current === renderedMemoryOwnerId) {
        memoryOwnerIdRef.current = null;
      }
    };
  }, [renderedMemoryOwnerId]);
  const trackMemoryOutcome = useCallback((
    ownerId: string,
    action: "export_saved" | "detail_edited" | "detail_deleted" | "auto_save_changed" | "capture_prepared" | "capture_saved",
    result: "success" | "expected_error" | "error",
  ) => {
    if (memoryOwnerIdRef.current !== ownerId) return;
    trackEvent("one_memory_action", { route_id: "pkm", action, result });
  }, []);
  const pkmChangeRevision = usePkmDomainChangeRevision(user?.uid);

  const [metadataState, setMetadataState] = useState<{ session: MemoryReadSession; metadata: PersonalKnowledgeModelMetadata | null } | null>(null);
  const metadata = metadataState?.session === memoryReadSession ? metadataState.metadata : null;
  const setMetadata = useCallback((nextMetadata: PersonalKnowledgeModelMetadata | null) => {
    if (memoryReadSessionRef.current === memoryReadSession) setMetadataState({ session: memoryReadSession, metadata: nextMetadata });
  }, [memoryReadSession]);
  const [activeGrants, setActiveGrants] = useState<ConsentCenterEntry[]>([]);
  const [sharingResolved, setSharingResolved] = useState(false);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [localDomainKey, setSelectedDomainKey] = useState<string | null>(null);
  const selectedDomainKey = locationView ? "location" : localDomainKey;
  const [pathStack, setPathStack] = useState<PkmPathSegment[]>([]);
  const [localSelectedCard, setSelectedCard] = useState<PkmMemoryCard | null>(null);
  const [domainDetail, setDomainDetail] = useState<DomainDetailState>(EMPTY_DOMAIN_DETAIL);
  const canBrowseLocation = metadata?.domains.some((domain) => domain.key === "location" && isConsumerBrowsablePkmDomain(domain)) ?? false;
  const locationPresentation = useMemo(() => buildLocationMemoryPresentation({
    data: canBrowseLocation && domainDetail.session === memoryReadSession ? domainDetail.data : null,
  }), [canBrowseLocation, domainDetail, memoryReadSession]);
  const locationField = view === "location-detail" ? resolveLocationMemoryField(locationPresentation, locationMemoryId) : null;
  const selectedCard = locationView ? locationField?.card ?? null : localSelectedCard;
  const [memoryCardsNonce, setMemoryCardsNonce] = useState(0);
  const [memoryActionState, setMemoryActionState] = useState<{ session: MemoryReadSession; id: string | null } | null>(null);
  const memoryActionId = memoryActionState?.session === memoryReadSession ? memoryActionState.id : null;
  const setMemoryActionId = useCallback((id: string | null) => {
    if (memoryReadSessionRef.current === memoryReadSession) setMemoryActionState({ session: memoryReadSession, id });
  }, [memoryReadSession]);
  const [memoryActionError, setMemoryActionError] = useState<string | null>(null);
  const [sharingImpactState, setSharingImpactState] = useState<{ session: MemoryReadSession; values: Record<string, PkmMutationSharingImpact> }>({ session: memoryReadSession, values: {} });
  const sharingImpacts = sharingImpactState.session === memoryReadSession ? sharingImpactState.values : {};
  const setSharingImpacts = useCallback((update: Record<string, PkmMutationSharingImpact> | ((current: Record<string, PkmMutationSharingImpact>) => Record<string, PkmMutationSharingImpact>)) => {
    if (memoryReadSessionRef.current !== memoryReadSession) return;
    setSharingImpactState((current) => ({ session: memoryReadSession, values: typeof update === "function" ? update(current.session === memoryReadSession ? current.values : {}) : update }));
  }, [memoryReadSession]);
  const [sharingImpactError, setSharingImpactError] = useState<string | null>(null);
  const [sharingImpactRefreshNonce, setSharingImpactRefreshNonce] = useState(0);
  const [autoSavePolicy, setAutoSavePolicy] = useState<AgentPkmAutoSavePolicy>(
    DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY
  );
  const [autoSavePolicyLoading, setAutoSavePolicyLoading] = useState(false);
  const [autoSavePolicySaving, setAutoSavePolicySaving] = useState(false);
  const [autoSavePolicyError, setAutoSavePolicyError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  /**
   * Hand the owner everything One remembers about them, as a file they keep.
   *
   * Only possible while the vault is unlocked: the readable half is decrypted in
   * this browser, because the backend holds ciphertext and no key.
   */
  const handleExportMemory = useCallback(async () => {
    if (!user?.uid || !vaultKey || !vaultOwnerToken) return;
    const operationOwnerId = user.uid;
    setExportBusy(true);
    setExportError(null);
    setExportStatus(null);
    try {
      const result = await PkmExportService.downloadMemoryExport({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
      });
      trackMemoryOutcome(
        operationOwnerId,
        "export_saved",
        result.saved ? "success" : "expected_error",
      );
      // On a phone the file only exists once the share sheet accepts it, so the
      // two outcomes are reported differently rather than both as success.
      setExportStatus(
        result.saved
          ? `Saved ${result.filename}. It holds ${result.domainCount} ${
              result.domainCount === 1 ? "area" : "areas"
            } of what One remembers.`
          : "Nothing was saved. You can try again whenever you like.",
      );
    } catch (error) {
      trackMemoryOutcome(operationOwnerId, "export_saved", "error");
      setExportError(
        error instanceof Error ? error.message : "The file could not be prepared.",
      );
    } finally {
      setExportBusy(false);
    }
  }, [trackMemoryOutcome, user?.uid, vaultKey, vaultOwnerToken]);
  const [autoSavePolicyRetryValue, setAutoSavePolicyRetryValue] = useState<
    boolean | null
  >(null);
  const [workspaceTab, setWorkspaceTab] = useState<MemoryWorkspaceTab>("browse");
  const [captureText, setCaptureText] = useState("");
  const [captureCards, setCaptureCards] = useState<AgentPkmPreviewCard[]>([]);
  const captureHasSharedRecipients = captureCards.some(
    (card) => (card.sharing_impact?.active_recipient_count || 0) > 0,
  );
  const [captureSharingImpactAcknowledged, setCaptureSharingImpactAcknowledged] =
    useState(false);
  // Sections of the prepared note that still need another pass. They never
  // block saving the details that are ready; each one can be retried alone.
  const [captureUnresolvedSections, setCaptureUnresolvedSections] =
    useState<PkmNaturalLanguageSourceCoverage[]>([]);
  // The exact text the unresolved ranges index into. Editing the note retires
  // the review, so this always equals the trimmed note while sections are shown.
  const [captureSourceSnapshot, setCaptureSourceSnapshot] = useState("");
  const [captureRetryingSectionKey, setCaptureRetryingSectionKey] = useState<string | null>(null);
  const captureHasUnresolvedSource = captureUnresolvedSections.length > 0;
  // Only details the save path can accept count as ready to save.
  const captureSaveableCards = captureCards.filter(
    (card) => card.write_mode !== "do_not_save" && !isDegradedPreviewCard(card),
  );
  const captureRevision = useRef(0);
  const captureAuthReady = !authLoading && !sessionVerificationRequired;
  useEffect(() => {
    if (captureAuthReady) return;
    // Keep the owner's draft, but old work must not resume after verification.
    captureRevision.current += 1;
    setCaptureLoading(false);
    // A dispatched save can still succeed. Retire the old review, but hold its
    // operation lock until settlement so recovery cannot submit it twice.
    // Read the owner through the ref kept current above: this effect runs on
    // auth readiness only, never on an owner change, by design.
    const ownerId = memoryOwnerIdRef.current;
    if (ownerId && pkmCaptureSaveInFlight.has(ownerId)) setCaptureCards([]);
  }, [captureAuthReady]);
  const [captureLoading, setCaptureLoading] = useState(false);
  const [captureSaving, setCaptureSaving] = useState(() =>
    Boolean(user?.uid && pkmCaptureSaveInFlight.has(user.uid)),
  );
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  useEffect(() => {
    captureRevision.current += 1;
    setCaptureText("");
    setCaptureCards([]);
    setCaptureUnresolvedSections([]);
    setCaptureRetryingSectionKey(null);
    setCaptureMessage(null);
    setCaptureLoading(false);
    setCaptureSaving(Boolean(user?.uid && pkmCaptureSaveInFlight.has(user.uid)));
    return () => { captureRevision.current += 1; };
  }, [user?.uid, isVaultUnlocked]);

  // A request can be accepted while verification is temporarily unavailable.
  // Its result is deliberately not published through the stale guard; once
  // current authority is restored, force one fresh ciphertext-backed read so
  // the visible Memory projection catches up without reviving the old result.
  useEffect(() => {
    if (!user?.uid || !isVaultUnlocked || !vaultOwnerToken || !isCaptureReady(vaultOwnerToken)) {
      return;
    }
    if (pkmCaptureSaveInFlight.has(user.uid) || !pkmCaptureReconciliationNeeded.has(user.uid)) {
      return;
    }
    pkmCaptureReconciliationNeeded.delete(user.uid);
    setRefreshNonce((value) => value + 1);
  }, [authLoading, isVaultUnlocked, sessionVerificationRequired, tokenExpiresAt, user?.uid, vaultOwnerToken]);
  const [sharingManifests, setSharingManifests] = useState<Record<string, DomainManifest | null>>({});
  const [sharingManifestsLoading, setSharingManifestsLoading] = useState(false);
  const [sharingActionKey, setSharingActionKey] = useState<string | null>(null);
  const [cardManifestState, setCardManifestState] = useState<{ session: MemoryReadSession; manifest: DomainManifest | null } | null>(null);
  const selectedCardManifest = cardManifestState?.session === memoryReadSession ? cardManifestState.manifest : null;
  const setSelectedCardManifest = useCallback((manifest: DomainManifest | null) => {
    if (memoryReadSessionRef.current === memoryReadSession) setCardManifestState({ session: memoryReadSession, manifest });
  }, [memoryReadSession]);
  const [memorySharingActionState, setMemorySharingActionState] = useState<{ session: MemoryReadSession; id: string | null } | null>(null);
  const memorySharingActionId = memorySharingActionState?.session === memoryReadSession ? memorySharingActionState.id : null;
  const setMemorySharingActionId = useCallback((id: string | null) => {
    if (memoryReadSessionRef.current === memoryReadSession) setMemorySharingActionState({ session: memoryReadSession, id });
  }, [memoryReadSession]);
  const [memorySharingError, setMemorySharingError] = useState<string | null>(null);
  const [homeSearchQuery, setHomeSearchQuery] = useState("");
  const [memoryCards, setMemoryCards] = useState<PkmMemoryCard[]>([]);
  const [memoryCardsLoading, setMemoryCardsLoading] = useState(false);
  const [memoryCardsLoadError, setMemoryCardsLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadCategories() {
      if (authLoading) return;
      if (!user || !isVaultUnlocked || !vaultOwnerToken) {
        if (!cancelled) {
          setMetadata(null);
          setActiveGrants([]);
          setSharingResolved(false);
          setBootstrapLoading(false);
          setBootstrapError(false);
        }
        return;
      }

      setBootstrapLoading(true);
      setBootstrapError(false);
      setSharingResolved(false);
      const force =
        refreshNonce > 0 || refreshToken > 0 || pkmChangeRevision > 0;
      const metadataTask = PersonalKnowledgeModelService.getMetadata(
        user.uid,
        force,
        vaultOwnerToken,
      )
        .then((nextMetadata) => {
          if (!cancelled) setMetadata(nextMetadata);
        })
        .catch(() => {
          if (!cancelled) setBootstrapError(true);
        })
        .finally(() => {
          if (!cancelled) setBootstrapLoading(false);
        });
      const sharingTask = user
        .getIdToken()
        .then((idToken) =>
          ConsentCenterService.getCenter({
            idToken,
            userId: user.uid,
            actor: "investor",
            view: "active",
            force,
          }),
        )
        .then((value) => {
          if (cancelled) return;
          setActiveGrants(value.active_grants || []);
          setSharingResolved(true);
        })
        .catch(() => {
          // Domain-level sharing is not shown on the Saved screen anymore; a
          // memory's own sharing state is verified per scope in its detail view.
          if (!cancelled) setSharingResolved(false);
        });
      await Promise.allSettled([metadataTask, sharingTask]);
    }

    void loadCategories();
    return () => {
      cancelled = true;
    };
  }, [
    authLoading,
    setMetadata,
    isVaultUnlocked,
    pkmChangeRevision,
    refreshNonce,
    refreshToken,
    user,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (!user || !isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
      setAutoSavePolicy(DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY);
      setAutoSavePolicyError(null);
      setAutoSavePolicyRetryValue(null);
      setAutoSavePolicyLoading(false);
      return undefined;
    }
    setAutoSavePolicyLoading(true);
    setAutoSavePolicyError(null);
    setAutoSavePolicyRetryValue(null);
    void loadAgentPkmAutoSavePolicy({
      userId: user.uid,
      vaultKey,
      vaultOwnerToken,
    })
      .then((policy) => {
        if (!cancelled) {
          setAutoSavePolicy(policy);
          setAutoSavePolicyError(null);
          setAutoSavePolicyRetryValue(null);
        }
      })
      .catch(() => {
        if (!cancelled) setAutoSavePolicyError("Automatic memory saving couldn’t be loaded.");
      })
      .finally(() => {
        if (!cancelled) setAutoSavePolicyLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isVaultUnlocked, user, vaultKey, vaultOwnerToken]);

  const visibleMetadataDomains = useMemo(
    () => (metadata?.domains || []).filter(isConsumerBrowsablePkmDomain),
    [metadata?.domains]
  );
  // Every known domain, not only the browsable ones, so a proposed save into
  // a domain Memory keeps off its list still names it the way the app does.
  const domainTitles = useMemo(
    () => new Map((metadata?.domains || []).map((domain) => [domain.key, domain.displayName] as const)),
    [metadata?.domains]
  );

  const domainPresentations = useMemo(
    () =>
      visibleMetadataDomains.map((domain) =>
        buildPkmDomainPresentation({
          domain,
          activeGrants,
          sharingResolved,
        })
      ),
    [activeGrants, sharingResolved, visibleMetadataDomains]
  );

  const selectedMetadataDomain = useMemo(
    () => visibleMetadataDomains.find((domain) => domain.key === selectedDomainKey) || null,
    [selectedDomainKey, visibleMetadataDomains]
  );

  // Entering or leaving a category always starts the nested browser at the
  // category root; Back then walks the stack down exactly one segment at a time.
  useEffect(() => {
    setPathStack([]);
  }, [selectedDomainKey]);

  // Only ever browse cards whose domain a consumer is allowed to see. This is a
  // second guard behind buildPkmMemorySnapshot: reserved domains (runtime
  // secrets, KYC) and domains a backend marks not consumer-visible must never
  // reach Recently learned, categories, search, or a detail view.
  const browsableCards = useMemo(() => {
    const allowed = new Set(visibleMetadataDomains.map((domain) => domain.key));
    return memoryCards.filter((card) => allowed.has(card.domain));
  }, [memoryCards, visibleMetadataDomains]);

  const domainMemoryCards = useMemo(
    () =>
      selectedDomainKey
        ? browsableCards.filter((card) => card.domain === selectedDomainKey)
        : [],
    [browsableCards, selectedDomainKey]
  );

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const card of browsableCards) {
      counts.set(card.domain, (counts.get(card.domain) || 0) + 1);
    }
    return counts;
  }, [browsableCards]);

  const categories = useMemo(
    () =>
      domainPresentations
        .map((domain) => ({
          key: domain.key,
          title: domain.title,
          summary: domain.summary,
          count: Math.max(domain.detailCount, categoryCounts.get(domain.key) || 0),
        }))
        .filter((domain) => domain.count > 0),
    [categoryCounts, domainPresentations]
  );

  const nativeDataState: NativeTestDataState =
    authLoading || bootstrapLoading || domainDetail.loading
      ? "loading"
      : bootstrapError || domainDetail.error
        ? "error"
        : !user || !isVaultUnlocked || !vaultOwnerToken || !vaultKey
          ? "unavailable-valid"
          : metadata === null
            ? "loading"
            : view === "location-detail" && !locationField
              ? "unavailable-valid"
              : locationView && locationPresentation.sections.length === 0
                ? "empty-valid"
            : visibleMetadataDomains.length === 0
              ? "empty-valid"
              : "loaded";
  const nativeBeacon = (
    <NativeTestBeacon
      routeId={view === "location-detail" ? ROUTES.PKM_LOCATION_DETAIL : view === "location" ? ROUTES.PKM_LOCATION : view === "recent" ? ROUTES.PKM_RECENT : ROUTES.PKM}
      marker={view === "location-detail" ? "native-route-pkm-location-detail" : view === "location" ? "native-route-pkm-location" : view === "recent" ? "native-route-pkm-recent" : "native-route-pkm"}
      authState={user ? "authenticated" : authLoading ? "pending" : "anonymous"}
      dataState={nativeDataState}
      errorCode={nativeDataState === "error" ? "pkm_memory_unavailable" : null}
    />
  );

  useEffect(() => {
    let cancelled = false;

    async function loadMutationImpacts() {
      if (!user || !vaultOwnerToken || !selectedMetadataDomain || domainMemoryCards.length === 0) {
        if (!cancelled) setSharingImpactError(null);
        return;
      }
      setSharingImpactError(null);
      try {
        const scopeEntries = Array.from(
          new Map(domainMemoryCards.map((card) => [cardImpactKey(card), cardScopePath(card)])).entries()
        );
        const impacts = await Promise.all(
          scopeEntries.map(async ([impactKey, scopePath]) => [
            impactKey,
            await PersonalKnowledgeModelService.getMutationSharingImpact({
              userId: user.uid,
              domain: selectedMetadataDomain.key,
              scopePath,
              vaultOwnerToken,
            }),
          ] as const)
        );
        if (!cancelled) {
          setSharingImpacts((current) => ({ ...current, ...Object.fromEntries(impacts) }));
        }
      } catch {
        if (!cancelled) {
          setSharingImpactError("Current sharing couldn’t be verified. Refresh before changing details.");
        }
      }
    }

    void loadMutationImpacts();
    return () => {
      cancelled = true;
    };
  }, [
    domainMemoryCards,
    setSharingImpacts,
    selectedMetadataDomain,
    sharingImpactRefreshNonce,
    user,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function loadSelectedDomain() {
      if (
        !selectedMetadataDomain ||
        !user ||
        !isVaultUnlocked ||
        !vaultKey ||
        !vaultOwnerToken
      ) {
        if (!cancelled) setDomainDetail(EMPTY_DOMAIN_DETAIL);
        return;
      }

      setDomainDetail({ ...EMPTY_DOMAIN_DETAIL, loading: true });
      try {
        const [manifest, domainData] = await Promise.all([
          PersonalKnowledgeModelService.getDomainManifest(
            user.uid,
            selectedMetadataDomain.key,
            vaultOwnerToken
          ).catch(() => null),
          PersonalKnowledgeModelService.loadDomainData({
            userId: user.uid,
            domain: selectedMetadataDomain.key,
            vaultKey,
            vaultOwnerToken,
          }),
        ]);
        if (cancelled) return;

        setDomainDetail({
          session: memoryReadSession,
          manifest,
          data: domainData,
          loading: false,
          error: false,
        });
      } catch {
        if (!cancelled) {
          setDomainDetail({ ...EMPTY_DOMAIN_DETAIL, session: memoryReadSession, error: true });
        }
      }
    }

    void loadSelectedDomain();
    return () => {
      cancelled = true;
    };
  }, [
    isVaultUnlocked,
    memoryReadSession,
    memoryCardsNonce,
    pkmChangeRevision,
    selectedMetadataDomain,
    user,
    vaultKey,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (workspaceTab !== "sharing" || !user || !vaultOwnerToken || visibleMetadataDomains.length === 0) {
      return undefined;
    }
    setSharingManifestsLoading(true);
    void Promise.all(
      visibleMetadataDomains.map(async (domain) => [
        domain.key,
        await PersonalKnowledgeModelService.getDomainManifest(
          user.uid,
          domain.key,
          vaultOwnerToken
        ).catch(() => null),
      ] as const)
    )
      .then((entries) => {
        if (!cancelled) setSharingManifests(Object.fromEntries(entries));
      })
      .finally(() => {
        if (!cancelled) setSharingManifestsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    pkmChangeRevision,
    user,
    vaultOwnerToken,
    visibleMetadataDomains,
    workspaceTab,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (
      locationView ||
      workspaceTab !== "browse" ||
      !user ||
      !isVaultUnlocked ||
      !vaultKey ||
      !vaultOwnerToken
    ) {
      return undefined;
    }
    setMemoryCardsLoading(true);
    setMemoryCardsLoadError(false);
    const loadedDomains: Record<string, Record<string, unknown>> = {};
    const updateCards = () => {
      locationSnapshot.current = loadedDomains.location ? { session: memoryReadSession, data: loadedDomains.location } : null;
      const snapshot = buildPkmMemorySnapshot({
        metadata,
        fullBlob: loadedDomains,
        maxCards: 400,
        maxCardsPerDomain: 80,
      });
      const sorted = [...snapshot.cards].sort((left, right) => {
        const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
        const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
        return rightTime - leftTime;
      });
      setMemoryCards(sorted);
    };
    void PkmDomainResourceService.getManyStaleFirst({
      userId: user.uid,
      domains: visibleMetadataDomains.map((domain) => domain.key),
      vaultKey,
      vaultOwnerToken,
      forceRefresh: refreshNonce > 0 || memoryCardsNonce > 0 || pkmChangeRevision > 0,
      backgroundRefresh: true,
      onProgress: ({ domain, snapshot }) => {
        if (cancelled || !snapshot?.data) return;
        loadedDomains[domain] = snapshot.data;
        updateCards();
      },
    })
      .then(({ snapshots, failedDomains }) => {
        if (cancelled) return;
        for (const [domain, snapshot] of Object.entries(snapshots)) {
          loadedDomains[domain] = snapshot.data;
        }
        updateCards();
        setMemoryCardsLoadError(failedDomains.length > 0);
      })
      .finally(() => {
        if (!cancelled) setMemoryCardsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    locationView,
    memoryReadSession,
    isVaultUnlocked,
    memoryCardsNonce,
    metadata,
    pkmChangeRevision,
    refreshNonce,
    user,
    vaultKey,
    vaultOwnerToken,
    visibleMetadataDomains,
    workspaceTab,
  ]);

  async function ensureSharingImpact(card: PkmMemoryCard): Promise<PkmMutationSharingImpact | null> {
    const key = cardImpactKey(card);
    const cached = sharingImpacts[key];
    if (cached) return cached;
    if (!user || !vaultOwnerToken) return null;
    try {
      const impact = await PersonalKnowledgeModelService.getMutationSharingImpact({
        userId: user.uid,
        domain: card.domain,
        scopePath: cardScopePath(card),
        vaultOwnerToken,
      });
      if (memoryReadSessionRef.current !== memoryReadSession) return null;
      setSharingImpacts((current) => ({ ...current, [key]: impact }));
      return impact;
    } catch {
      if (memoryReadSessionRef.current !== memoryReadSession) return null;
      setSharingImpactError("Current sharing couldn’t be verified. Refresh before changing details.");
      return null;
    }
  }

  function resetMemoryActionState() {
    setMemoryActionId(null);
  }

  useEffect(() => {
    if (selectedCard) void ensureSharingImpact(selectedCard);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCard?.id, memoryReadSession]);

  // A memory opened straight from search or "Recently learned" has no selected
  // category, so its domain manifest — the source of the per-scope share bundle
  // and the manifest version the backend checks — is loaded here on demand.
  useEffect(() => {
    let cancelled = false;
    if (!selectedCard || !user || !vaultOwnerToken) {
      setSelectedCardManifest(null);
      return undefined;
    }
    void PersonalKnowledgeModelService.getDomainManifest(
      user.uid,
      selectedCard.domain,
      vaultOwnerToken,
    )
      .then((manifest) => {
        if (!cancelled) setSelectedCardManifest(manifest);
      })
      .catch(() => {
        if (!cancelled) setSelectedCardManifest(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pkmChangeRevision, refreshNonce, selectedCard, setSelectedCardManifest, user, vaultOwnerToken]);

  async function persistMemoryCardChange(params: {
    card: PkmMemoryCard;
    action: "edited" | "deleted";
    nextValue?: string;
  }) {
    if (!user || !vaultKey || !vaultOwnerToken) return;
    const operationOwnerId = user.uid;
    const sharingImpact = sharingImpacts[cardImpactKey(params.card)];
    if (!sharingImpact) {
      setMemoryActionError("Current sharing couldn’t be verified. Refresh and try again.");
      return;
    }
    setMemoryActionId(`${params.card.id}:${params.action}`);
    setMemoryActionError(null);
    let persistedDomainData: Record<string, unknown> | null = null;
    try {
      const result = await PkmWriteCoordinator.saveMergedDomain({
        userId: user.uid,
        domain: params.card.domain,
        vaultKey,
        vaultOwnerToken,
        confirmation: {
          confirmedByUser: true,
          surface: "web",
          source: `pkm_memory_${params.action}_button`,
          sharingImpactAcknowledged: sharingImpact.activeRecipientCount > 0,
          sharingImpact,
        },
        build: ({ currentDomainData }) => {
          // Routed links identify the entity, not its old array position.
          // Resolve again against the coordinator's fresh domain before writing.
          const currentField = view === "location-detail" ? resolveLocationMemoryField(
            buildLocationMemoryPresentation({ data: currentDomainData }), locationMemoryId,
          ) : null;
          if (view === "location-detail" && (!currentField || currentField.card.valueFingerprint !== params.card.valueFingerprint)) {
            throw new Error("This detail has changed. Open Location memory again before updating it.");
          }
          const targetCard = currentField?.card ?? params.card;
          persistedDomainData =
            params.action === "edited"
              ? updatePkmDomainValue({
                  domainData: currentDomainData,
                  pathSegments: targetCard.pathSegments,
                  previousValue: params.card.value,
                  nextValue: params.nextValue || "",
                  expectedValueFingerprint: params.card.valueFingerprint,
                })
              : deletePkmDomainValue({
                  domainData: currentDomainData,
                  pathSegments: targetCard.pathSegments,
                  expectedValueFingerprint: params.card.valueFingerprint,
                });
          return {
            domainData: persistedDomainData,
            summary: {
              readable_summary: `${params.card.domainTitle} saved details were ${params.action}.`,
              readable_highlights: [
                params.action === "edited" ? "One saved a correction." : "One removed a detail.",
              ],
              readable_updated_at: new Date().toISOString(),
              readable_source_label: "Memory",
              readable_event_summary:
                params.action === "edited" ? "A saved detail was corrected." : "A saved detail was removed.",
            },
            mergeDecision: { merge_mode: "replace_domain" },
            operation: params.action === "deleted" ? "delete" : "update",
            scopePath: cardScopePath(params.card),
          };
        },
      });
      if (!result.success || !persistedDomainData) {
        throw new Error(result.message || "This saved detail couldn’t be updated.");
      }
      if (memoryReadSessionRef.current !== memoryReadSession) return;
      // The encrypted write is the mutation boundary. Record it before the
      // best-effort metadata refresh so a transient read failure cannot turn
      // one confirmed write into contradictory success + error outcomes.
      trackMemoryOutcome(operationOwnerId, params.action === "edited" ? "detail_edited" : "detail_deleted", "success");
      clearAgentPkmContext(user.uid);
      let metadataRefreshFailed = false;
      try {
        const refreshedMetadata = await PersonalKnowledgeModelService.getMetadata(user.uid, true, vaultOwnerToken);
        if (memoryReadSessionRef.current !== memoryReadSession) return;
        setMetadata(refreshedMetadata);
      } catch {
        if (memoryReadSessionRef.current !== memoryReadSession) return;
        metadataRefreshFailed = true;
        setMemoryActionError(
          "Memory was updated, but the latest summary could not refresh. Refresh the page to see it."
        );
      }
      morphyToast.success(params.action === "edited" ? "Memory updated." : "Memory forgotten.");
      resetMemoryActionState();
      if (!metadataRefreshFailed) setSelectedCard(null);
      if (locationView && !metadataRefreshFailed) router.replace(ROUTES.PKM_LOCATION);
      setMemoryCardsNonce((value) => value + 1);
    } catch (error) {
      if (memoryReadSessionRef.current !== memoryReadSession) return;
      trackMemoryOutcome(operationOwnerId, params.action === "edited" ? "detail_edited" : "detail_deleted", "error");
      setMemoryActionError(
        error instanceof Error ? error.message : "This saved detail couldn’t be updated."
      );
      setMemoryActionId(null);
      setSharingImpactRefreshNonce((value) => value + 1);
    }
  }

  async function updateAutoSavePolicy(enabled: boolean) {
    if (!user || !vaultKey || !vaultOwnerToken) return;
    const operationOwnerId = user.uid;
    setAutoSavePolicySaving(true);
    setAutoSavePolicyError(null);
    setAutoSavePolicyRetryValue(enabled);
    const operation = saveAgentPkmAutoSavePolicy({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
        enabled,
        confirmation: {
          confirmedByUser: true,
          surface: "web",
          source: "pkm_memory_auto_save_toggle",
        },
      });
    try {
      void morphyToast.promise(operation, {
        loading: "Updating automatic memory saving…",
        success: "Automatic memory saving updated.",
        error: "Automatic memory saving couldn’t be updated. Try again.",
      });
      const nextPolicy = await operation;
      trackMemoryOutcome(operationOwnerId, "auto_save_changed", "success");
      setAutoSavePolicy(nextPolicy);
      setAutoSavePolicyError(null);
      setAutoSavePolicyRetryValue(null);
    } catch {
      trackMemoryOutcome(operationOwnerId, "auto_save_changed", "error");
      // ApiService asks VaultLockGuard to re-open the existing vault unlock
      // dialog when a VAULT_OWNER token is rejected. Other failures are not
      // evidence that the vault is locked, so keep the recovery local and
      // retryable instead of sending people to hunt for an unlock screen.
      setAutoSavePolicyError("Automatic memory saving couldn’t be updated. Try again.");
    } finally {
      setAutoSavePolicySaving(false);
    }
  }

  function isCaptureReady(expectedToken: string) {
    return isAgentPkmProcessingReady(captureReadinessRef.current, expectedToken);
  }

  async function previewMemoryCapture() {
    if (!user || !isVaultUnlocked || !vaultOwnerToken || !captureText.trim() || captureSaving) return;
    const operationOwnerId = user.uid;
    const revision = ++captureRevision.current;
    const guard = createAgentPkmCaptureGuard({
      userId: user.uid, signal: new AbortController().signal,
      isEnabled: () => revision === captureRevision.current && isCaptureReady(vaultOwnerToken),
    });
    if (!guard.isCurrent()) return;
    setCaptureCards([]);
    setCaptureSharingImpactAcknowledged(false);
    setCaptureLoading(true);
    setCaptureUnresolvedSections([]);
    setCaptureRetryingSectionKey(null);
    setCaptureMessage(null);
    try {
      const localDuplicate = AgentPkmContextStore.findLocalDuplicate({
        userId: user.uid,
        candidate: captureText.trim(),
      });
      if (localDuplicate?.kind === "exact") {
        trackMemoryOutcome(operationOwnerId, "capture_prepared", "expected_error");
        setCaptureCards([]);
        setCaptureMessage("That exact detail is already saved. Open Browse to correct it instead of creating a duplicate.");
        return;
      }
      const sourceSnapshot = captureText.trim();
      const prepared = await prepareNaturalLanguagePkm({
        userId: user.uid,
        message: sourceSnapshot,
        currentDomains: visibleMetadataDomains.map((domain) => domain.key),
        vaultOwnerToken,
        source: "memory_workspace",
        allowEmpty: true,
        isEffectCurrent: guard.isCurrent,
        findDuplicate: (candidate) => AgentPkmContextStore.findLocalDuplicate({ userId: user.uid, candidate }),
        beforeEffect: guard.assertCurrent,
        onProgress: (progress) => {
          if (guard.isCurrent() && progress.phase !== "prepared") {
            setCaptureMessage(`Preparing section ${Math.min(progress.chunkIndex + 1, progress.chunkCount)} of ${progress.chunkCount}… Nothing has been saved yet.`);
          }
        },
      });
      if (!guard.isCurrent()) return;
      setCaptureCards(prepared.cards);
      setCaptureSharingImpactAcknowledged(false);
      // `preparation_requires_review` stays on every card when any block is
      // unresolved: it forbids *automatic* effects. This is the owner's explicit
      // review, so it gates per section instead of across the whole note.
      const unresolvedSections = prepared.sourceCoverage.filter(isUnresolvedSourceBlock);
      const hasFailedSource = prepared.sourceCoverage.some((block) =>
        block.disposition === "failed" ||
        (Boolean(block.preparationIssue) && block.preparationIssue !== "degraded_preview"));
      const hasUnresolvedSource = unresolvedSections.length > 0;
      trackMemoryOutcome(
        operationOwnerId,
        "capture_prepared",
        hasFailedSource
          ? "error"
          : prepared.cards.length > 0 && !hasUnresolvedSource
            ? "success"
            : "expected_error",
      );
      setCaptureSourceSnapshot(sourceSnapshot);
      setCaptureUnresolvedSections(unresolvedSections);
      setCaptureMessage(
        hasUnresolvedSource
          ? describeUnresolvedCapture(unresolvedSections.length, prepared.cards.length > 0)
          : localDuplicate?.kind === "possible"
          ? "A related saved detail may already exist. Review this suggestion before saving."
          : prepared.cards.length
          ? "Review the proposed details before adding them."
          : "Nothing new needs to be saved from that note."
      );
    } catch {
      if (!guard.isCurrent()) return;
      trackMemoryOutcome(operationOwnerId, "capture_prepared", "error");
      setCaptureMessage("That note couldn’t be prepared. Nothing was saved. Please try again.");
    } finally {
      if (revision === captureRevision.current) setCaptureLoading(false);
    }
  }

  async function retryCaptureSection(block: PkmNaturalLanguageSourceCoverage) {
    const sourceSnapshot = captureSourceSnapshot;
    if (
      !user || !isVaultUnlocked || !vaultOwnerToken || !block.sourceRange ||
      captureLoading || captureSaving || captureRetryingSectionKey !== null ||
      !sourceSnapshot || sourceSnapshot !== captureText.trim()
    ) return;
    const operationOwnerId = user.uid;
    const revision = captureRevision.current;
    const sectionKey = pkmCaptureSectionKey(block);
    const guard = createAgentPkmCaptureGuard({
      userId: user.uid, signal: new AbortController().signal,
      isEnabled: () => revision === captureRevision.current && isCaptureReady(vaultOwnerToken),
    });
    if (!guard.isCurrent()) return;
    setCaptureRetryingSectionKey(sectionKey);
    try {
      const prepared = await prepareNaturalLanguagePkm({
        userId: user.uid,
        message: sourceSnapshot,
        sourceSelection: { range: block.sourceRange, context: block.sourceContext },
        currentDomains: visibleMetadataDomains.map((domain) => domain.key),
        vaultOwnerToken,
        source: "memory_workspace",
        allowEmpty: true,
        isEffectCurrent: guard.isCurrent,
        findDuplicate: (candidate) => AgentPkmContextStore.findLocalDuplicate({ userId: user.uid, candidate }),
        beforeEffect: guard.assertCurrent,
      });
      if (!guard.isCurrent()) return;
      const stillUnresolved = prepared.sourceCoverage.filter(isUnresolvedSourceBlock);
      const remaining = captureUnresolvedSections.length - 1 + stillUnresolved.length;
      setCaptureUnresolvedSections((current) => current.flatMap((entry) =>
        pkmCaptureSectionKey(entry) === sectionKey ? stillUnresolved : [entry]));
      if (prepared.cards.length > 0) {
        setCaptureCards((current) => [...current, ...prepared.cards]);
        if (prepared.cards.some((card) => (card.sharing_impact?.active_recipient_count || 0) > 0)) {
          setCaptureSharingImpactAcknowledged(false);
        }
      }
      trackMemoryOutcome(operationOwnerId, "capture_prepared", stillUnresolved.length === 0 ? "success" : "expected_error");
      setCaptureMessage(
        remaining > 0
          ? describeUnresolvedCapture(remaining, captureCards.length + prepared.cards.length > 0)
          : captureCards.length + prepared.cards.length > 0
            ? "Every section is prepared. Review the proposed details before adding them."
            : "Nothing new needs to be saved from that note."
      );
    } catch {
      if (!guard.isCurrent()) return;
      trackMemoryOutcome(operationOwnerId, "capture_prepared", "error");
      setCaptureMessage("That section couldn’t be prepared. Nothing from it was saved. Please try again.");
    } finally {
      if (memoryOwnerIdRef.current === operationOwnerId) setCaptureRetryingSectionKey(null);
    }
  }

  async function saveMemoryCapture() {
    if (
      !user || !isVaultUnlocked || !vaultKey || !vaultOwnerToken ||
      captureSaveableCards.length === 0 || captureRetryingSectionKey !== null ||
      (captureHasSharedRecipients && !captureSharingImpactAcknowledged) ||
      pkmCaptureSaveInFlight.has(user.uid)
    ) return;
    const operationId = Symbol("memory-save");
    const operationOwnerId = user.uid;
    pkmCaptureSaveInFlight.set(operationOwnerId, operationId);
    const revision = ++captureRevision.current;
    const receiptGuard = createAgentPkmCaptureGuard({
      userId: user.uid, signal: new AbortController().signal,
      isEnabled: () => pkmCaptureSaveInFlight.get(operationOwnerId) === operationId,
    });
    const guard = createAgentPkmCaptureGuard({
      userId: user.uid, signal: new AbortController().signal,
      isEnabled: () => revision === captureRevision.current && isCaptureReady(vaultOwnerToken),
    });
    if (!guard.isCurrent()) {
      if (pkmCaptureSaveInFlight.get(operationOwnerId) === operationId) {
        pkmCaptureSaveInFlight.delete(operationOwnerId);
      }
      return;
    }
    setCaptureSaving(true);
    try {
      const operation = addToPKM({
          userId: user.uid,
          cards: captureSaveableCards,
          sourceMessage: captureText.trim(),
          vaultKey,
          vaultOwnerToken,
          source: "memory_workspace",
          beforeEffect: guard.assertCurrent,
          mayPublish: guard.isCurrent,
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "memory_workspace_add",
            sharingImpactAcknowledged: captureHasSharedRecipients
              ? captureSharingImpactAcknowledged
              : false,
          },
        });
      void morphyToast.promise(operation, {
        loading: "Saving reviewed memory…",
        success: (result) => result.failed > 0
          ? "Some details still need attention. Your note is kept for review."
          : result.saved > 0 ? "Reviewed memory saved." : "No details were saved. Your note is kept for review.",
        error: "Memory couldn’t be saved. Your note is still here; please try again.",
      });
      const result = await operation;
      if (receiptGuard.isCurrent() && memoryOwnerIdRef.current === operationOwnerId) {
        trackMemoryOutcome(
          operationOwnerId,
          "capture_saved",
          result.saved > 0
            ? "success"
            : result.failed > 0
              ? "error"
              : "expected_error",
        );
      }
      if (!guard.isCurrent()) {
        if (receiptGuard.isCurrent() && memoryOwnerIdRef.current === operationOwnerId) {
          if (result.saved > 0) pkmCaptureReconciliationNeeded.add(operationOwnerId);
          // Counts only; do not republish cards or refresh private information
          // while verification is unavailable. The draft stays for review.
          setCaptureCards([]);
          setCaptureUnresolvedSections([]);
          setCaptureMessage(result.saved > 0
            ? `${result.saved} reviewed detail${result.saved === 1 ? "" : "s"} saved. Check Memory before preparing this note again.`
            : "Saving was interrupted. Check Memory before preparing this note again.");
        }
        return;
      }
      clearAgentPkmContext(user.uid);
      const remainingSections = captureUnresolvedSections.length;
      setCaptureMessage(
        result.saved > 0
          ? `${result.saved} reviewed detail${result.saved === 1 ? "" : "s"} saved.${
            remainingSections > 0
              ? ` ${remainingSections} section${remainingSections === 1 ? " still needs" : "s still need"} another pass; nothing from ${remainingSections === 1 ? "it" : "them"} was saved. Your note is kept below.`
              : result.failed > 0 ? " Some details still need attention; your note is kept below." : ""
          }`
          : "Nothing was saved; the proposed detail needs a correction first."
      );
      if (result.saved > 0) {
        if (result.failed > 0 || captureHasUnresolvedSource) {
          const savedIds = new Set(result.results.filter((item) => item.success).map((item) => item.cardId));
          setCaptureCards((current) => current.filter((card) => !savedIds.has(card.card_id)));
        } else {
          setCaptureText("");
          setCaptureCards([]);
          setCaptureSharingImpactAcknowledged(false);
        }
        setRefreshNonce((value) => value + 1);
      }
    } catch {
      if (!guard.isCurrent()) {
        if (receiptGuard.isCurrent() && memoryOwnerIdRef.current === operationOwnerId) {
          setCaptureCards([]);
          setCaptureMessage("Saving was interrupted. Check Memory before preparing this note again.");
        }
        return;
      }
      trackMemoryOutcome(operationOwnerId, "capture_saved", "error");
      setCaptureMessage("Memory couldn’t be saved. Your note is still here; please try again.");
    } finally {
      if (pkmCaptureSaveInFlight.get(operationOwnerId) === operationId) {
        pkmCaptureSaveInFlight.delete(operationOwnerId);
        if (memoryOwnerIdRef.current === operationOwnerId) setCaptureSaving(false);
      }
    }
  }

  async function updateSharingBundles(params: {
    domain: string;
    manifest: DomainManifest;
    scopeHandles: string[];
    enabled: boolean;
  }) {
    if (!user || !vaultOwnerToken || params.scopeHandles.length === 0) return;
    const actionKey = `${params.domain}:${params.scopeHandles.join(",")}`;
    setSharingActionKey(actionKey);
    try {
      const operation = PersonalKnowledgeModelService.updateScopeExposure({
          userId: user.uid,
          domain: params.domain,
          expectedManifestVersion: params.manifest.manifest_version,
          vaultOwnerToken,
          changes: params.scopeHandles.map((scopeHandle) => ({
            scopeHandle,
            visibilityPosture: params.enabled ? "consent_required" : "private",
          })),
        });
      void morphyToast.promise(operation, {
        loading: "Updating sharing choices…",
        success: params.enabled ? "One will ask before sharing this." : "This is private again.",
        error: "Sharing choices changed elsewhere. Refresh and try again.",
      });
      const result = await operation;
      if (result.manifest) {
        setSharingManifests((current) => ({ ...current, [params.domain]: result.manifest }));
      }
      setRefreshNonce((value) => value + 1);
    } catch {
      // The toast is intentionally redacted. Scope exposure never exposes server detail.
    } finally {
      setSharingActionKey(null);
    }
  }

  function memorySharingState(card: PkmMemoryCard): MemorySharingState {
    const impact = sharingImpacts[cardImpactKey(card)];
    if (impact) return impact.activeRecipientCount > 0 ? "shared" : "private";
    if (sharingImpactError) return "unavailable";
    return "loading";
  }

  // The share bundle for this memory's own top-level scope, resolved from the
  // domain manifest. Reuses the same PKM sharing contract the Sharing tab uses.
  function memoryScopeShareBundle(card: PkmMemoryCard) {
    const scopePath = cardScopePath(card);
    return (
      buildPkmShareBundles(selectedCardManifest).find(
        (bundle) => bundle.topLevelScopePath === scopePath,
      ) || null
    );
  }

  function memorySharingPosture(card: PkmMemoryCard): MemorySharingPosture {
    const bundle = memoryScopeShareBundle(card);
    if (!bundle || !bundle.scopeHandle) return null;
    return bundle.enabled ? "consent_required" : "private";
  }

  // In-place per-memory sharing. Stays on the memory screen — no redirect to the
  // Consent Center — and drives the same scope-exposure endpoint as the Sharing
  // tab, so grant revocation on turning a scope private is handled server-side.
  async function updateMemoryScopeSharing(
    card: PkmMemoryCard,
    nextPosture: "private" | "consent_required",
  ) {
    if (!user || !vaultOwnerToken) return;
    const manifest = selectedCardManifest;
    const bundle = memoryScopeShareBundle(card);
    if (!manifest || !bundle?.scopeHandle) {
      setMemorySharingError(
        "Sharing controls for this memory aren’t available right now. Refresh and try again.",
      );
      return;
    }
    setMemorySharingActionId(cardImpactKey(card));
    setMemorySharingError(null);
    try {
      const operation = PersonalKnowledgeModelService.updateScopeExposure({
        userId: user.uid,
        domain: card.domain,
        expectedManifestVersion: manifest.manifest_version,
        vaultOwnerToken,
        changes: [{ scopeHandle: bundle.scopeHandle, visibilityPosture: nextPosture }],
      });
      void morphyToast.promise(operation, {
        loading: "Updating sharing choices…",
        success:
          nextPosture === "consent_required"
            ? "One will ask before sharing this."
            : "This is private again.",
        error: "Sharing choices changed elsewhere. Refresh and try again.",
      });
      const result = await operation;
      if (memoryReadSessionRef.current !== memoryReadSession) return;
      if (result.manifest) setSelectedCardManifest(result.manifest);
      // Turning a scope private revokes matching active grants server-side, so
      // re-verify this memory's recipients instead of trusting a stale "Shared".
      try {
        const impact = await PersonalKnowledgeModelService.getMutationSharingImpact({
          userId: user.uid,
          domain: card.domain,
          scopePath: cardScopePath(card),
          vaultOwnerToken,
        });
        if (memoryReadSessionRef.current !== memoryReadSession) return;
        setSharingImpacts((current) => ({ ...current, [cardImpactKey(card)]: impact }));
      } catch {
        if (memoryReadSessionRef.current !== memoryReadSession) return;
        setSharingImpacts((current) => {
          const next = { ...current };
          delete next[cardImpactKey(card)];
          return next;
        });
        setSharingImpactError(
          "Current sharing couldn’t be verified. Refresh before changing details.",
        );
      }
      setRefreshNonce((value) => value + 1);
    } catch {
      if (memoryReadSessionRef.current !== memoryReadSession) return;
      setMemorySharingError(
        "Sharing choices couldn’t be updated. Refresh and try again.",
      );
    } finally {
      if (memoryReadSessionRef.current === memoryReadSession) setMemorySharingActionId(null);
    }
  }

  const trimmedQuery = homeSearchQuery.trim();
  const searchResults = trimmedQuery
    ? selectRelevantPkmMemoryCards(browsableCards, homeSearchQuery, 24)
    : [];
  const matchedCategories = trimmedQuery
    ? categories.filter((domain) =>
        `${domain.title} ${domain.summary}`.toLowerCase().includes(trimmedQuery.toLowerCase())
      )
    : categories;
  const recentMemories = browsableCards.slice(0, RECENT_MEMORIES_LIMIT);

  function openMemory(card: PkmMemoryCard) {
    if (card.domain === "location") {
      const snapshot = locationSnapshot.current;
      const presentation = buildLocationMemoryPresentation({ data: snapshot?.session === memoryReadSession ? snapshot.data : null });
      const field = findLocationMemoryFieldForCard(presentation, card);
      router.push(field?.selector ? `${ROUTES.PKM_LOCATION_DETAIL}?memory=${field.selector}` : ROUTES.PKM_LOCATION);
      return;
    }
    setSelectedCard(card);
    setMemoryActionError(null);
  }

  function renderCategoryRow(domain: { key: string; title: string; count: number }) {
    return (
      <SettingsRow
        key={domain.key}
        title={domain.title}
        description={`${domain.count} ${domain.count === 1 ? "memory" : "memories"}`}
        onClick={() => domain.key === "location" ? router.push(ROUTES.PKM_LOCATION) : setSelectedDomainKey(domain.key)}
        chevron
        ariaLabel={`Open category: ${domain.title}`}
        testId={`memory-category-${domain.key}`}
      />
    );
  }

  const addMemoryRow = (
    <SettingsRow
      title="Add Memory"
      onClick={() => setWorkspaceTab("add")}
      chevron
      ariaLabel="Add Memory"
      testId="memory-add-row"
    />
  );

  if (authLoading) {
    return (
      <>
        {nativeBeacon}
        <SurfaceInset className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          Opening Memory…
        </SurfaceInset>
      </>
    );
  }

  if (!user || (locationView && sessionVerificationRequired)) {
    return (
      <>{nativeBeacon}<SurfaceInset className="space-y-2 px-4 py-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 font-semibold text-foreground">
          <ShieldAlert className="h-4 w-4" aria-hidden />
          Sign in to open Memory
        </div>
        <p>Your saved details stay connected to your account.</p>
      </SurfaceInset></>
    );
  }

  if (!isVaultUnlocked || !vaultOwnerToken || !vaultKey) {
    return (
      <>{nativeBeacon}<SurfaceInset className="space-y-2 px-4 py-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 font-semibold text-foreground">
          <Lock className="h-4 w-4" aria-hidden />
          Unlock your vault to open Memory
        </div>
        <p>Your saved details are decrypted only for this unlocked session.</p>
      </SurfaceInset></>
    );
  }

  const locationLoading = bootstrapLoading || (!metadata && !bootstrapError) || domainDetail.loading || (Boolean(selectedMetadataDomain) && domainDetail.session !== memoryReadSession);
  if (locationView && (view === "location" || !selectedCard)) {
    const missingDetail = view === "location-detail" && !locationLoading && !bootstrapError && !domainDetail.error;
    return (
      <>
        {nativeBeacon}
        {missingDetail ? (
          <SurfaceInset className="space-y-3 p-4" data-pkm-location-view="true">
            <p>This detail is no longer available.</p>
            <Button variant="muted" size="sm" onClick={() => router.replace(ROUTES.PKM_LOCATION)}>
              Open Location memory
            </Button>
          </SurfaceInset>
        ) : (
          <LocationMemoryView
            presentation={locationPresentation}
            loading={locationLoading}
            error={bootstrapError || domainDetail.error}
            onRetry={() => {
              setRefreshNonce((value) => value + 1);
              setMemoryCardsNonce((value) => value + 1);
            }}
            onOpen={(field) => router.push(`${ROUTES.PKM_LOCATION_DETAIL}?memory=${field.selector}`)}
          />
        )}
      </>
    );
  }

  if (selectedCard) {
    return (
      <>
        {nativeBeacon}
        <PkmMemoryDetail
          key={locationView ? locationMemoryId : selectedCard.id}
          card={selectedCard}
          displayLabel={locationField?.label}
          displayValue={locationField?.value}
          displayContext={locationField?.context}
          hideBack={locationView}
          sharingState={memorySharingState(selectedCard)}
          sharingPosture={memorySharingPosture(selectedCard)}
          sharingBusy={memorySharingActionId === cardImpactKey(selectedCard)}
          sharingError={memorySharingError}
          canMutate={selectedCard.editable && Boolean(sharingImpacts[cardImpactKey(selectedCard)])}
          saving={memoryActionId === `${selectedCard.id}:edited`}
          deleting={memoryActionId === `${selectedCard.id}:deleted`}
          actionError={memoryActionError}
          onBack={() => {
            if (locationView) router.push(ROUTES.PKM_LOCATION);
            setSelectedCard(null);
            setMemoryActionError(null);
            setMemorySharingError(null);
          }}
          onSharingChange={(nextPosture) =>
            void updateMemoryScopeSharing(selectedCard, nextPosture)
          }
          onSharingOpenChange={(open) => {
            if (!open) setMemorySharingError(null);
          }}
          onSave={(nextValue) =>
            void persistMemoryCardChange({ card: selectedCard, action: "edited", nextValue })
          }
          onForget={() => void persistMemoryCardChange({ card: selectedCard, action: "deleted" })}
          onOpenOwner={(routePattern) => router.push(routePattern)}
        />
      </>
    );
  }

  if (selectedMetadataDomain) {
    return (
      <>
        {nativeBeacon}
        <PkmMemoryLevel
          domainKey={selectedMetadataDomain.key}
          domainTitle={selectedMetadataDomain.displayName}
          data={domainDetail.data}
          pathStack={pathStack}
          loading={domainDetail.loading || memoryCardsLoading}
          error={domainDetail.error}
          sharingImpactError={sharingImpactError}
          sourceLabel={selectedMetadataDomain.readableSourceLabel || undefined}
          updatedAt={
            selectedMetadataDomain.readableUpdatedAt ||
            selectedMetadataDomain.lastUpdated ||
            null
          }
          onDrill={(segment) => setPathStack((stack) => [...stack, segment])}
          onBack={() => {
            if (pathStack.length === 0) {
              setSelectedDomainKey(null);
              return;
            }
            setPathStack((stack) => stack.slice(0, -1));
          }}
          onOpenLeaf={openMemory}
        />
      </>
    );
  }

  if (view === "recent") {
    return (
      <>
        {nativeBeacon}
        {recentMemories.length > 0 ? (
          <SettingsGroup separatorInset testId="memory-recent-list">
            {recentMemories.map((card) => (
              <PkmMemoryRow key={card.id} card={card} onOpen={openMemory} />
            ))}
          </SettingsGroup>
        ) : (
          <SurfaceInset className="px-4 py-4 text-sm text-muted-foreground" data-testid="memory-recent-empty">
            Nothing learned yet.
          </SurfaceInset>
        )}
      </>
    );
  }

  return (
    <>
      {nativeBeacon}
      <div className="space-y-4">
        <SegmentedTabs
          tabSetId="memory"
          ariaLabel="Memory"
          value={workspaceTab}
          onValueChange={(value) => setWorkspaceTab(value as MemoryWorkspaceTab)}
          options={MEMORY_WORKSPACE_TABS}
          mobileColumns={3}
          variant="agent-top"
        />
        <SwipeViews
          options={MEMORY_WORKSPACE_TABS}
          tabSetId="memory"
          activeValue={workspaceTab}
          onSelectionChange={(value) => setWorkspaceTab(value as MemoryWorkspaceTab)}
          viewportMinHeight="fill"
          heightMode="active"
        >
          <div className="space-y-5 pb-1 pr-px" data-pkm-saved-panel="true">
          <div className="relative">
            <Input
              type="search"
              value={homeSearchQuery}
              onChange={(event) => setHomeSearchQuery(event.target.value)}
              placeholder="Search Memory"
              aria-label="Search Memory"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="h-11 pr-11"
            />
            <SearchClearButton
              visible={homeSearchQuery.length > 0}
              label="Clear Memory search"
              onClear={() => setHomeSearchQuery("")}
            />
          </div>

          {memoryCardsLoading && memoryCards.length === 0 ? (
            <SurfaceInset className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Opening Memory…
            </SurfaceInset>
          ) : memoryCardsLoadError && memoryCards.length === 0 ? (
            <SurfaceInset className="space-y-3 p-4 text-sm text-muted-foreground">
              <p>Some saved details couldn’t be opened.</p>
              <Button
                size="sm"
                variant="muted"
                onClick={() => setMemoryCardsNonce((current) => current + 1)}
              >
                Try again
              </Button>
            </SurfaceInset>
          ) : trimmedQuery ? (
            searchResults.length === 0 && matchedCategories.length === 0 ? (
              <SurfaceInset className="p-4 text-sm text-muted-foreground" data-pkm-search-empty="true">
                No memories match “{trimmedQuery}”.
              </SurfaceInset>
            ) : (
              <>
                {searchResults.length > 0 ? (
                  <SettingsGroup title="Memories" separatorInset testId="memory-search-results">
                    {searchResults.map((card) => (
                      <PkmMemoryRow
                        key={card.id}
                        card={card}
                        onOpen={openMemory}
                        breadcrumb={pkmMemoryCardBreadcrumb(card)}
                      />
                    ))}
                  </SettingsGroup>
                ) : null}
                {matchedCategories.length > 0 ? (
                  <SettingsGroup title="Categories" separatorInset>
                    {matchedCategories.map(renderCategoryRow)}
                  </SettingsGroup>
                ) : null}
              </>
            )
          ) : (
            <>
              {recentMemories.length > 0 ? (
                <SettingsGroup separatorInset testId="memory-recently-learned">
                  <SettingsRow
                    title="Recently learned"
                    description={`${recentMemories.length} ${recentMemories.length === 1 ? "memory" : "memories"}`}
                    onClick={() => router.push(ROUTES.PKM_RECENT)}
                    chevron
                    ariaLabel="Open recently learned memories"
                    testId="memory-recently-learned-row"
                  />
                </SettingsGroup>
              ) : null}

              {categories.length > 0 ? (
                <SettingsGroup title="Categories" separatorInset testId="memory-categories">
                  {categories.map(renderCategoryRow)}
                  {addMemoryRow}
                </SettingsGroup>
              ) : (
                <>
                  {!bootstrapError && !memoryCardsLoading && !memoryCardsLoadError ? (
                    <p className="px-1 text-sm text-muted-foreground">
                      One hasn’t saved anything yet.
                    </p>
                  ) : null}
                  <SettingsGroup separatorInset>{addMemoryRow}</SettingsGroup>
                </>
              )}

              {bootstrapError ? (
                <div className="flex items-center justify-between gap-3 px-1 text-sm text-muted-foreground">
                  <p>Some saved details couldn’t be loaded.</p>
                  <Button
                    size="sm"
                    variant="muted"
                    onClick={() => setRefreshNonce((current) => current + 1)}
                  >
                    Try again
                  </Button>
                </div>
              ) : null}
              {memoryCardsLoadError ? (
                <div className="flex items-center justify-between gap-3 px-1 text-sm text-muted-foreground">
                  <p>Some saved details couldn’t be refreshed. Your available details are still here.</p>
                  <Button
                    size="sm"
                    variant="muted"
                    onClick={() => setMemoryCardsNonce((current) => current + 1)}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}
            </>
          )}
          </div>
          <div className="space-y-5 pb-1 pr-px">
          <SurfaceInset className="space-y-4 p-4" data-pkm-memory-capture="true">
            <Textarea value={captureText} disabled={captureSaving} onPaste={(event) => {
              const input = event.currentTarget;
              const length = captureText.length - (input.selectionEnd - input.selectionStart) +
                event.clipboardData.getData("text/plain").length;
              if (length > 50000) {
                event.preventDefault();
                setCaptureMessage("That paste is too long. Add smaller sections; your existing note is unchanged.");
              }
            }} onChange={(event) => {
              captureRevision.current += 1;
              setCaptureText(event.target.value);
              setCaptureCards([]);
              setCaptureUnresolvedSections([]);
              setCaptureRetryingSectionKey(null);
              setCaptureMessage(null);
              setCaptureLoading(false);
            }} placeholder="I prefer morning flights whenever possible." aria-label="Memory note" maxLength={50000} />
            <Button className="w-full justify-center" type="button" variant="muted" effect="fade" disabled={captureLoading || captureSaving || !captureText.trim()} onClick={() => void previewMemoryCapture()}>
              {captureLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}Review memory
            </Button>
            {captureMessage ? <p role="status" data-testid="memory-preparation-status" className="text-sm text-muted-foreground">{captureMessage}</p> : null}
            {captureCards.length > 0 ? (
              <SettingsGroup separatorInset>
                {captureCards.map((card) => (
                  <SettingsRow
                    key={card.card_id}
                    // A multi-line detail (a heading with its list) reads as one row.
                    title={card.source_text?.trim().replace(/\s*\n+\s*/g, " · ") || "Proposed saved detail"}
                    description={<CaptureCardDescription card={card} domainTitles={domainTitles} />}
                  />
                ))}
                {getIgnoredPkmCards(captureCards).length > 0 ? <SettingsRow title="Some of this note will not be saved" description="Only appropriate details can be added to Memory." /> : null}
              </SettingsGroup>
            ) : null}
            {captureHasUnresolvedSource ? (
              <SettingsGroup separatorInset testId="memory-unresolved-sections">
                {captureUnresolvedSections.map((block) => {
                  const section = describePkmCaptureSection(captureSourceSnapshot, block);
                  return (
                    <SettingsRow
                      key={section.key}
                      testId="memory-unresolved-section"
                      title={section.label}
                      description={`${section.reason} Nothing from this section has been saved.`}
                      stackTrailingOnMobile
                      trailingInteractive
                      trailing={section.retryable ? (
                        <Button
                          type="button"
                          variant="muted"
                          effect="fade"
                          aria-label={`Retry this section: ${section.label}`}
                          disabled={captureLoading || captureSaving || captureRetryingSectionKey !== null}
                          onClick={() => void retryCaptureSection(block)}
                        >
                          {captureRetryingSectionKey === section.key ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
                          Retry this section
                        </Button>
                      ) : undefined}
                    />
                  );
                })}
              </SettingsGroup>
            ) : null}
            {captureHasSharedRecipients ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2" data-pkm-sharing-impact="true">
                <label
                  htmlFor="memory-sharing-impact-ack"
                  className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-foreground"
                >
                  <Checkbox
                    id="memory-sharing-impact-ack"
                    checked={captureSharingImpactAcknowledged}
                    onCheckedChange={(checked) =>
                      setCaptureSharingImpactAcknowledged(checked === true)
                    }
                    disabled={captureSaving}
                  />
                  <span>
                    I understand that this detail is already shared and will be refreshed for the current recipients.
                  </span>
                </label>
                <p className="pl-7 text-xs leading-5 text-muted-foreground">
                  Review this before saving. It does not change who can access the detail.
                </p>
              </div>
            ) : null}
            {captureCards.length > 0 ? <Button data-testid="memory-save-capture" className="w-full justify-center" type="button" effect="fade" disabled={captureSaving || captureSaveableCards.length === 0 || captureRetryingSectionKey !== null || (captureHasSharedRecipients && !captureSharingImpactAcknowledged)} onClick={() => void saveMemoryCapture()}>{captureSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}Save to Memory</Button> : null}
          </SurfaceInset>

          <SettingsGroup separatorInset testId="memory-auto-save-group">
            <SettingsRow
              testId="memory-auto-save-row"
              title="Let One save useful details"
              description={
                autoSavePolicyError ||
                "One can automatically save clear details you type. Secrets, sensitive details, corrections, and details with active recipient access still ask first."
              }
              tone={autoSavePolicyError ? "destructive" : "default"}
              stackTrailingOnMobile
              trailing={
                <div className="flex min-h-11 w-full items-center justify-end gap-2 sm:w-auto">
                  {autoSavePolicyError && autoSavePolicyRetryValue !== null ? (
                    <Button
                      type="button"
                      variant="none"
                      effect="fade"
                      size="sm"
                      onClick={() => void updateAutoSavePolicy(autoSavePolicyRetryValue)}
                      disabled={autoSavePolicySaving || autoSavePolicyLoading}
                    >
                      Retry
                    </Button>
                  ) : null}
                  <span aria-live="polite" className="text-xs font-medium text-muted-foreground">
                    {autoSavePolicy.enabled ? "On" : "Off"}
                  </span>
                  <Switch
                    checked={autoSavePolicy.enabled}
                    onCheckedChange={(enabled) => void updateAutoSavePolicy(enabled)}
                    disabled={autoSavePolicyLoading || autoSavePolicySaving}
                    aria-label={
                      autoSavePolicy.enabled
                        ? "Turn automatic memory saving off"
                        : "Turn automatic memory saving on"
                    }
                    className="shrink-0"
                  />
                </div>
              }
            />
          </SettingsGroup>
          </div>
          <div className="space-y-4 pb-1 pr-px" data-pkm-memory-sharing="true">
            {sharingManifestsLoading ? (
              <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Checking sharing settings…
              </p>
            ) : null}

            <SettingsGroup separatorInset testId="memory-export-group">
              <SettingsRow
                title={exportBusy ? "Preparing…" : "Download Memory"}
                description={isVaultUnlocked
                  ? "Readable file. Keep it private."
                  : "Unlock to download."}
                onClick={() => void handleExportMemory()}
                disabled={!isVaultUnlocked || exportBusy}
                trailing={exportBusy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : undefined}
                ariaLabel="Download Memory"
                testId="memory-export-button"
              />
            </SettingsGroup>

            {exportStatus ? (
              <p className="px-1 text-sm text-muted-foreground" role="status">
                {exportStatus}
              </p>
            ) : null}
            {exportError ? (
              <p className="px-1 text-sm text-[color:var(--app-destructive)]" role="alert">
                {exportError}
              </p>
            ) : null}

            {!sharingManifestsLoading &&
              visibleMetadataDomains.map((domain) => {
                const manifest = sharingManifests[domain.key] || null;
                const bundles = buildPkmShareBundles(manifest);
                if (!manifest || bundles.length === 0) return null;
                const state = pkmShareBundleState(bundles);
                const allHandles = bundles
                  .map((bundle) => bundle.scopeHandle)
                  .filter((value): value is string => Boolean(value));
                const allBusy = sharingActionKey === `${domain.key}:${allHandles.join(",")}`;
                return (
                  <SettingsGroup
                    key={domain.key}
                    title={domain.displayName}
                    separatorInset
                    testId={`memory-sharing-${domain.key}`}
                    titleAction={
                      bundles.length > 1 && allHandles.length > 0 ? (
                        <button
                          type="button"
                          disabled={allBusy}
                          aria-pressed={state === "checked"}
                          aria-label={`Set every ${domain.displayName} item ${
                            state === "checked" ? "private" : "to ask before sharing"
                          }`}
                          onClick={() =>
                            void updateSharingBundles({
                              domain: domain.key,
                              manifest,
                              scopeHandles: allHandles,
                              enabled: state !== "checked",
                            })
                          }
                          className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                        >
                          {allBusy ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : null}
                          {state === "checked" ? "Make all private" : "Ask for all"}
                        </button>
                      ) : undefined
                    }
                  >
                    {bundles.map((bundle) => {
                      const bundleKey = `${domain.key}:${bundle.scopeHandle || bundle.topLevelScopePath}`;

  return (
                        <SettingsRow
                          key={bundleKey}
                          title={bundle.label}
                          description={bundle.enabled ? "Ask before sharing" : "Private"}
                          trailing={
                            <Switch
                              checked={bundle.enabled}
                              disabled={sharingActionKey === bundleKey || !bundle.scopeHandle}
                              onCheckedChange={(enabled) =>
                                bundle.scopeHandle &&
                                void updateSharingBundles({
                                  domain: domain.key,
                                  manifest,
                                  scopeHandles: [bundle.scopeHandle],
                                  enabled,
                                })
                              }
                              aria-label={`${bundle.enabled ? "Make private" : "Ask before sharing"} ${bundle.label}`}
                            />
                          }
                        />
                      );
                    })}
                  </SettingsGroup>
                );
              })}

            {!sharingManifestsLoading &&
            visibleMetadataDomains.length > 0 &&
            Object.values(sharingManifests).every(
              (manifest) => buildPkmShareBundles(manifest).length === 0,
            ) ? (
              <p className="px-1 text-sm text-muted-foreground">Nothing to share yet.</p>
            ) : null}
          </div>
        </SwipeViews>
      </div>
    </>
  );
}
