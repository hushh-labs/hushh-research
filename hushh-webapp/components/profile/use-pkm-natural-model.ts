"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type NativeTestDataState } from "@/components/app-ui/native-test-beacon";
import {
  type MemorySharingPosture,
  type MemorySharingState,
} from "@/components/profile/pkm-memory-detail";
import { useAuth } from "@/hooks/use-auth";
import {
  createAgentPkmCaptureGuard,
  isAgentPkmProcessingReady,
} from "@/lib/agent/agent-pkm-capture-runtime";
import { AgentPkmContextStore } from "@/lib/agent/agent-pkm-context-store";
import {
  addToPKM,
  clearAgentPkmContext,
  type AgentPkmPreviewCard,
} from "@/lib/agent/agent-pkm-memory";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import { trackEvent } from "@/lib/observability/client";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import { pkmCaptureSectionKey } from "@/lib/pkm/pkm-capture-sections";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import {
  buildPkmMemorySnapshot,
  deletePkmDomainValue,
  selectRelevantPkmMemoryCards,
  updatePkmDomainValue,
  type PkmMemoryCard,
  type PkmPathSegment,
} from "@/lib/pkm/pkm-memory-cards";
import {
  isUnresolvedSourceBlock,
  prepareNaturalLanguagePkm,
  type PkmNaturalLanguageSourceCoverage,
} from "@/lib/pkm/pkm-natural-language-ingestion";
import { usePkmDomainChangeRevision } from "@/lib/pkm/use-pkm-domain-change-revision";
import {
  buildLocationMemoryPresentation,
  findLocationMemoryFieldForCard,
  resolveLocationMemoryField,
} from "@/lib/profile/location-memory-presentation";
import { isDegradedPreviewCard } from "@/lib/profile/pkm-agent-lab-preview";
import { buildPkmShareBundles } from "@/lib/profile/pkm-memory-tree";
import {
  buildPkmDomainPresentation,
  isConsumerBrowsablePkmDomain,
} from "@/lib/profile/pkm-profile-presentation";
import {
  ConsentCenterService,
  type ConsentCenterEntry,
} from "@/lib/services/consent-center-service";
import {
  PersonalKnowledgeModelService,
  type PersonalKnowledgeModelMetadata,
  type PkmMutationSharingImpact,
} from "@/lib/services/personal-knowledge-model-service";
import { PkmExportService } from "@/lib/services/pkm-export-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { useReviewerPkmProof } from "@/lib/testing/use-reviewer-pkm-proof";
import { useVault } from "@/lib/vault/vault-context";

import { useSoulMemoryModel } from "./use-soul-memory-model";
import {
  snapshotVaultSessionEpoch,
  subscribeVaultSessionEpoch,
  isVaultSessionEpochCurrent,
} from "@/lib/vault/session-epoch";
type DomainDetailState = {
  session?: MemoryReadSession;
  manifest: DomainManifest | null;
  data: Record<string, unknown> | null;
  loading: boolean;
  error: boolean;
};

type MemoryReadSession = symbol;

export type MemoryWorkspaceTab = "soul" | "browse" | "add" | "sharing";
export const MEMORY_WORKSPACE_TABS = [
  { value: "browse", label: "Saved" },
  { value: "add", label: "Add" },
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
  return String(
    card.pathSegments.find((segment) => typeof segment === "string") ||
      "profile",
  );
}

export function cardImpactKey(card: PkmMemoryCard): string {
  return `${card.domain}::${cardScopePath(card)}`;
}

/** The reviewed card's destination, then how it is shared. */
function describeUnresolvedCapture(
  sectionCount: number,
  hasReadyDetails: boolean,
): string {
  const sections = `${sectionCount} section${sectionCount === 1 ? "" : "s"} of this note still need${sectionCount === 1 ? "s" : ""} another pass`;
  return hasReadyDetails
    ? `${sections}. You can save the details that are ready now; nothing from ${sectionCount === 1 ? "that section" : "those sections"} will be saved.`
    : `${sections}. Nothing has been saved.`;
}

export type PkmNaturalModelOptions = {
  refreshToken?: number;
  view?: "home" | "recent" | "location" | "location-detail";
  locationMemoryId?: string | null;
};

/** One existing feature owner for web/native presentation; no credential-bearing projection. */
export function usePkmNaturalModel({
  refreshToken = 0,
  view = "home",
  locationMemoryId = null,
}: PkmNaturalModelOptions = {}) {
  const router = useRouter();
  const { user, userId: applicationOwnerId, loading: authLoading, sessionVerificationRequired } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken, tokenExpiresAt } =
    useVault();
  const locationView = view === "location" || view === "location-detail";
  // Cache tags change with authority, without retaining copies of vault keys.
  const memoryReadSession = useMemo(
    () =>
      Symbol(
        applicationOwnerId && vaultKey && vaultOwnerToken && isVaultUnlocked
          ? "authorized-memory-session"
          : "unavailable-memory-session",
      ),
    [applicationOwnerId, vaultKey, vaultOwnerToken, isVaultUnlocked],
  );
  const memoryReadSessionRef = useRef<MemoryReadSession | null>(
    memoryReadSession,
  );
  memoryReadSessionRef.current = memoryReadSession;
  useEffect(() => {
    memoryReadSessionRef.current = memoryReadSession;
    return () => {
      if (memoryReadSessionRef.current === memoryReadSession)
        memoryReadSessionRef.current = null;
    };
  }, [memoryReadSession]);
  // Selection belongs to the unlocked owner, not a renewable token. Mask it
  // during render on replacement; an effect-only reset exposes old plaintext.
  const presentationOwner = useMemo(
    () =>
      Symbol(
        applicationOwnerId && vaultKey && isVaultUnlocked
          ? "unlocked-memory-presentation"
          : "unavailable-memory-presentation",
      ),
    [applicationOwnerId, vaultKey, isVaultUnlocked],
  );
  const presentationOwnerRef = useRef(presentationOwner);
  presentationOwnerRef.current = presentationOwner;
  const emptyNavigation = useMemo(
    () => ({
      owner: presentationOwner,
      domainKey: null as string | null,
      path: [] as PkmPathSegment[],
      card: null as PkmMemoryCard | null,
    }),
    [presentationOwner],
  );
  const [navigationState, setNavigationState] = useState(emptyNavigation);
  const navigation =
    navigationState.owner === presentationOwner
      ? navigationState
      : emptyNavigation;
  const setSelectedDomainKey = useCallback(
    (domainKey: string | null) => {
      if (presentationOwnerRef.current !== presentationOwner) return;
      setNavigationState((value) => ({
        ...(value.owner === presentationOwner ? value : emptyNavigation),
        domainKey,
      }));
    },
    [presentationOwner, emptyNavigation],
  );
  const setSelectedCard = useCallback(
    (card: PkmMemoryCard | null) => {
      if (presentationOwnerRef.current !== presentationOwner) return;
      setNavigationState((value) => ({
        ...(value.owner === presentationOwner ? value : emptyNavigation),
        card,
      }));
    },
    [presentationOwner, emptyNavigation],
  );
  const setPathStack = useCallback(
    (
      update: PkmPathSegment[] | ((path: PkmPathSegment[]) => PkmPathSegment[]),
    ) => {
      if (presentationOwnerRef.current !== presentationOwner) return;
      setNavigationState((value) => {
        const current =
          value.owner === presentationOwner ? value : emptyNavigation;
        return {
          ...current,
          path: typeof update === "function" ? update(current.path) : update,
        };
      });
    },
    [presentationOwner, emptyNavigation],
  );
  const locationSnapshot = useRef<{
    session: MemoryReadSession;
    data: Record<string, unknown>;
  } | null>(null);
  useReviewerPkmProof({
    userId: applicationOwnerId ?? null,
    authLoading,
    sessionVerificationRequired,
    isVaultUnlocked,
    vaultKey,
    vaultOwnerToken,
    tokenExpiresAt,
  });
  const captureReadinessRef = useRef({
    authLoading,
    sessionVerificationRequired,
    isVaultUnlocked,
    vaultOwnerToken,
    tokenExpiresAt,
  });
  captureReadinessRef.current = {
    authLoading,
    sessionVerificationRequired,
    isVaultUnlocked,
    vaultOwnerToken,
    tokenExpiresAt,
  };
  const operationEpoch = snapshotVaultSessionEpoch();
  const operationIsCurrent = () =>
    memoryReadSessionRef.current === memoryReadSession &&
    isVaultSessionEpochCurrent(operationEpoch) &&
    !!vaultOwnerToken &&
    isAgentPkmProcessingReady(captureReadinessRef.current, vaultOwnerToken);
  const assertOperationCurrent = async () => {
    if (!operationIsCurrent())
      throw new DOMException("The Memory request expired.", "AbortError");
  };
  const renderedMemoryOwnerId = applicationOwnerId ?? null;
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
  const trackMemoryOutcome = useCallback(
    (
      ownerId: string,
      action:
        | "export_saved"
        | "detail_edited"
        | "detail_deleted"
        | "auto_save_changed"
        | "capture_prepared"
        | "capture_saved",
      result: "success" | "expected_error" | "error",
    ) => {
      if (memoryOwnerIdRef.current !== ownerId) return;
      trackEvent("one_memory_action", { route_id: "pkm", action, result });
    },
    [],
  );
  const pkmChangeRevision = usePkmDomainChangeRevision(applicationOwnerId);

  const [metadataState, setMetadataState] = useState<{
    session: MemoryReadSession;
    metadata: PersonalKnowledgeModelMetadata | null;
  } | null>(null);
  const metadata =
    metadataState?.session === memoryReadSession
      ? metadataState.metadata
      : null;
  const setMetadata = useCallback(
    (nextMetadata: PersonalKnowledgeModelMetadata | null) => {
      if (memoryReadSessionRef.current === memoryReadSession)
        setMetadataState({
          session: memoryReadSession,
          metadata: nextMetadata,
        });
    },
    [memoryReadSession],
  );
  const [grantState, setGrantState] = useState<{
    session: MemoryReadSession;
    values: ConsentCenterEntry[];
  } | null>(null);
  const activeGrants = useMemo(
    () => (grantState?.session === memoryReadSession ? grantState.values : []),
    [grantState, memoryReadSession],
  );
  const setActiveGrants = useCallback(
    (values: ConsentCenterEntry[]) => {
      if (memoryReadSessionRef.current === memoryReadSession)
        setGrantState({ session: memoryReadSession, values });
    },
    [memoryReadSession],
  );
  const [sharingResolved, setSharingResolved] = useState(false);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const localDomainKey = navigation.domainKey;
  const selectedDomainKey = locationView ? "location" : localDomainKey;
  const pathStack = navigation.path;
  const localSelectedCard = navigation.card;
  const [domainDetail, setDomainDetail] =
    useState<DomainDetailState>(EMPTY_DOMAIN_DETAIL);
  const canBrowseLocation =
    metadata?.domains.some(
      (domain) =>
        domain.key === "location" && isConsumerBrowsablePkmDomain(domain),
    ) ?? false;
  const locationPresentation = useMemo(
    () =>
      buildLocationMemoryPresentation({
        data:
          canBrowseLocation && domainDetail.session === memoryReadSession
            ? domainDetail.data
            : null,
      }),
    [canBrowseLocation, domainDetail, memoryReadSession],
  );
  const locationField =
    view === "location-detail"
      ? resolveLocationMemoryField(locationPresentation, locationMemoryId)
      : null;
  const selectedCard = locationView
    ? (locationField?.card ?? null)
    : localSelectedCard;
  const unwindMemory = useCallback(() => {
    if (localSelectedCard) {
      setSelectedCard(null);
      setMemoryActionError(null);
      setMemorySharingError(null);
      return true;
    }
    if (pathStack.length > 0) {
      setPathStack((stack) => stack.slice(0, -1));
      return true;
    }
    if (localDomainKey) {
      setSelectedDomainKey(null);
      return true;
    }
    return false;
  }, [
    localSelectedCard,
    pathStack.length,
    localDomainKey,
    setSelectedCard,
    setPathStack,
    setSelectedDomainKey,
  ]);
  useBackLayer(
    view === "recent" ? ROUTES.PKM_RECENT : ROUTES.PKM,
    locationView || !isVaultUnlocked || !applicationOwnerId
      ? 0
      : (localDomainKey ? 1 : 0) +
          pathStack.length +
          (localSelectedCard ? 1 : 0),
    unwindMemory,
  );
  const [memoryCardsNonce, setMemoryCardsNonce] = useState(0);
  const [memoryActionState, setMemoryActionState] = useState<{
    session: MemoryReadSession;
    id: string | null;
  } | null>(null);
  const memoryActionId =
    memoryActionState?.session === memoryReadSession
      ? memoryActionState.id
      : null;
  const setMemoryActionId = useCallback(
    (id: string | null) => {
      if (memoryReadSessionRef.current === memoryReadSession)
        setMemoryActionState({ session: memoryReadSession, id });
    },
    [memoryReadSession],
  );
  const [memoryActionError, setMemoryActionError] = useState<string | null>(
    null,
  );
  const [sharingImpactState, setSharingImpactState] = useState<{
    session: MemoryReadSession;
    values: Record<string, PkmMutationSharingImpact>;
  }>({ session: memoryReadSession, values: {} });
  const sharingImpacts =
    sharingImpactState.session === memoryReadSession
      ? sharingImpactState.values
      : {};
  const setSharingImpacts = useCallback(
    (
      update:
        | Record<string, PkmMutationSharingImpact>
        | ((
            current: Record<string, PkmMutationSharingImpact>,
          ) => Record<string, PkmMutationSharingImpact>),
    ) => {
      if (memoryReadSessionRef.current !== memoryReadSession) return;
      setSharingImpactState((current) => ({
        session: memoryReadSession,
        values:
          typeof update === "function"
            ? update(
                current.session === memoryReadSession ? current.values : {},
              )
            : update,
      }));
    },
    [memoryReadSession],
  );
  const [sharingImpactError, setSharingImpactError] = useState<string | null>(
    null,
  );
  const [sharingImpactRefreshNonce, setSharingImpactRefreshNonce] = useState(0);
  const [exportState, setExportState] = useState<{
    session: MemoryReadSession;
    busy: boolean;
    status: string | null;
    error: string | null;
  } | null>(null);
  const currentExport =
    exportState?.session === memoryReadSession ? exportState : null;
  const exportBusy = currentExport?.busy ?? false;
  const exportStatus = currentExport?.status ?? null;
  const exportError = currentExport?.error ?? null;

  /**
   * Hand the owner everything One remembers about them, as a file they keep.
   *
   * Only possible while the vault is unlocked: the readable half is decrypted in
   * this browser, because the backend holds ciphertext and no key.
   */
  const handleExportMemory = useCallback(async () => {
    if (!applicationOwnerId || !vaultKey || !vaultOwnerToken || exportBusy) return;
    const operationOwnerId = applicationOwnerId;
    const isEffectCurrent = () =>
      memoryReadSessionRef.current === memoryReadSession &&
      isAgentPkmProcessingReady(captureReadinessRef.current, vaultOwnerToken);
    if (!isEffectCurrent()) return;
    setExportState({
      session: memoryReadSession,
      busy: true,
      status: null,
      error: null,
    });
    try {
      const result = await PkmExportService.downloadMemoryExport({
        userId: applicationOwnerId,
        vaultKey,
        vaultOwnerToken,
        isEffectCurrent,
      });
      if (!isEffectCurrent()) return;
      trackMemoryOutcome(
        operationOwnerId,
        "export_saved",
        result.saved ? "success" : "expected_error",
      );
      // On a phone the file only exists once the share sheet accepts it, so the
      // two outcomes are reported differently rather than both as success.
      setExportState({
        session: memoryReadSession,
        busy: false,
        error: null,
        status: result.saved
          ? `Saved ${result.filename}. It holds ${result.domainCount} ${
              result.domainCount === 1 ? "area" : "areas"
            } of what One remembers.${result.backupIncluded === false ? " The encrypted backup could not be included." : ""}`
          : "Nothing was saved. You can try again whenever you like.",
      });
    } catch {
      if (!isEffectCurrent()) return;
      trackMemoryOutcome(operationOwnerId, "export_saved", "error");
      setExportState({
        session: memoryReadSession,
        busy: false,
        status: null,
        error: "The file could not be prepared.",
      });
    } finally {
      // Verification uncertainty retires feedback, not the operation's lock.
      // Once it settles, the same mounted session must be able to try again.
      if (memoryReadSessionRef.current === memoryReadSession)
        setExportState((value) =>
          value?.session === memoryReadSession
            ? { ...value, busy: false }
            : value,
        );
    }
  }, [
    exportBusy,
    memoryReadSession,
    trackMemoryOutcome,
    applicationOwnerId,
    vaultKey,
    vaultOwnerToken,
  ]);
  const [workspaceTab, setWorkspaceTab] = useState<MemoryWorkspaceTab>(
    "browse",
  );
  const [captureText, setCaptureText] = useState("");
  const [identifierApproval, setIdentifierApproval] = useState<{ note: string; epoch: number } | null>(null);
  const identifierProcessingApproved = () => captureIsCurrent && identifierApproval?.note === captureText && isVaultSessionEpochCurrent(identifierApproval.epoch);
  useEffect(() => subscribeVaultSessionEpoch(() => setIdentifierApproval(null)), []);

  const [captureOwner, setCaptureOwner] = useState(presentationOwner);
  const captureIsCurrent = captureOwner === presentationOwner;
  const [captureCards, setCaptureCards] = useState<AgentPkmPreviewCard[]>([]);
  const captureHasSharedRecipients = captureCards.some(
    (card) => (card.sharing_impact?.active_recipient_count || 0) > 0,
  );
  const [
    captureSharingImpactAcknowledged,
    setCaptureSharingImpactAcknowledged,
  ] = useState(false);
  // Sections of the prepared note that still need another pass. They never
  // block saving the details that are ready; each one can be retried alone.
  const [captureUnresolvedSections, setCaptureUnresolvedSections] = useState<
    PkmNaturalLanguageSourceCoverage[]
  >([]);
  // The exact text the unresolved ranges index into. Editing the note retires
  // the review, so this always equals the trimmed note while sections are shown.
  const [captureSourceSnapshot, setCaptureSourceSnapshot] = useState("");
  const [captureRetryingSectionKey, setCaptureRetryingSectionKey] = useState<
    string | null
  >(null);
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
    Boolean(applicationOwnerId && pkmCaptureSaveInFlight.has(applicationOwnerId)),
  );
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  useEffect(() => {
    setCaptureOwner(presentationOwner);
    captureRevision.current += 1;
    setCaptureText("");
    setIdentifierApproval(null);
    setCaptureCards([]);
    setCaptureUnresolvedSections([]);
    setCaptureSourceSnapshot("");
    setCaptureSharingImpactAcknowledged(false);
    setCaptureRetryingSectionKey(null);
    setCaptureMessage(null);
    setCaptureLoading(false);
    setCaptureSaving(
      Boolean(applicationOwnerId && pkmCaptureSaveInFlight.has(applicationOwnerId)),
    );
    return () => {
      captureRevision.current += 1;
    };
  }, [applicationOwnerId, isVaultUnlocked, presentationOwner]);

  // A request can be accepted while verification is temporarily unavailable.
  // Its result is deliberately not published through the stale guard; once
  // current authority is restored, force one fresh ciphertext-backed read so
  // the visible Memory projection catches up without reviving the old result.
  useEffect(() => {
    if (
      !applicationOwnerId ||
      !isVaultUnlocked ||
      !vaultOwnerToken ||
      !isCaptureReady(vaultOwnerToken)
    ) {
      return;
    }
    if (
      pkmCaptureSaveInFlight.has(applicationOwnerId) ||
      !pkmCaptureReconciliationNeeded.has(applicationOwnerId)
    ) {
      return;
    }
    pkmCaptureReconciliationNeeded.delete(applicationOwnerId);
    setRefreshNonce((value) => value + 1);
  }, [
    authLoading,
    isVaultUnlocked,
    sessionVerificationRequired,
    tokenExpiresAt,
    applicationOwnerId,
    vaultOwnerToken,
  ]);
  const [sharingManifestState, setSharingManifestState] = useState<{
    session: MemoryReadSession;
    values: Record<string, DomainManifest | null>;
  } | null>(null);
  const sharingManifests = useMemo(
    () =>
      sharingManifestState?.session === memoryReadSession
        ? sharingManifestState.values
        : {},
    [sharingManifestState, memoryReadSession],
  );
  const setSharingManifests = useCallback(
    (
      update:
        | Record<string, DomainManifest | null>
        | ((
            current: Record<string, DomainManifest | null>,
          ) => Record<string, DomainManifest | null>),
    ) => {
      if (memoryReadSessionRef.current !== memoryReadSession) return;
      setSharingManifestState((value) => ({
        session: memoryReadSession,
        values:
          typeof update === "function"
            ? update(value?.session === memoryReadSession ? value.values : {})
            : update,
      }));
    },
    [memoryReadSession],
  );
  const [sharingManifestsLoading, setSharingManifestsLoading] = useState(false);
  const [sharingActionKey, setSharingActionKey] = useState<string | null>(null);
  const [cardManifestState, setCardManifestState] = useState<{
    session: MemoryReadSession;
    manifest: DomainManifest | null;
  } | null>(null);
  const selectedCardManifest =
    cardManifestState?.session === memoryReadSession
      ? cardManifestState.manifest
      : null;
  const setSelectedCardManifest = useCallback(
    (manifest: DomainManifest | null) => {
      if (memoryReadSessionRef.current === memoryReadSession)
        setCardManifestState({ session: memoryReadSession, manifest });
    },
    [memoryReadSession],
  );
  const [memorySharingActionState, setMemorySharingActionState] = useState<{
    session: MemoryReadSession;
    id: string | null;
  } | null>(null);
  const memorySharingActionId =
    memorySharingActionState?.session === memoryReadSession
      ? memorySharingActionState.id
      : null;
  const setMemorySharingActionId = useCallback(
    (id: string | null) => {
      if (memoryReadSessionRef.current === memoryReadSession)
        setMemorySharingActionState({ session: memoryReadSession, id });
    },
    [memoryReadSession],
  );
  const [memorySharingError, setMemorySharingError] = useState<string | null>(
    null,
  );
  const [homeSearchState, setHomeSearchState] = useState<{
    owner: symbol;
    query: string;
  } | null>(null);
  const homeSearchQuery =
    homeSearchState?.owner === presentationOwner ? homeSearchState.query : "";
  const setHomeSearchQuery = (query: string) => {
    if (presentationOwnerRef.current === presentationOwner)
      setHomeSearchState({ owner: presentationOwner, query });
  };
  const [memoryCardsState, setMemoryCardsState] = useState<{
    owner: symbol;
    cards: PkmMemoryCard[];
  } | null>(null);
  const memoryCards = useMemo(
    () =>
      memoryCardsState?.owner === presentationOwner
        ? memoryCardsState.cards
        : [],
    [memoryCardsState, presentationOwner],
  );
  const setMemoryCards = useCallback(
    (cards: PkmMemoryCard[]) => {
      if (presentationOwnerRef.current === presentationOwner)
        setMemoryCardsState({ owner: presentationOwner, cards });
    },
    [presentationOwner],
  );
  const [memoryCardsLoading, setMemoryCardsLoading] = useState(false);
  const [memoryCardsLoadError, setMemoryCardsLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadCategories() {
      if (authLoading) return;
      if (!user || !applicationOwnerId || !isVaultUnlocked || !vaultOwnerToken) {
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
        applicationOwnerId,
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
            userId: applicationOwnerId,
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
    setActiveGrants,
    isVaultUnlocked,
    pkmChangeRevision,
    refreshNonce,
    refreshToken,
    user,
    applicationOwnerId,
    vaultOwnerToken,
  ]);

  const visibleMetadataDomains = useMemo(
    () => (metadata?.domains || []).filter(isConsumerBrowsablePkmDomain),
    [metadata?.domains],
  );
  // Every known domain, not only the browsable ones, so a proposed save into
  // a domain Memory keeps off its list still names it the way the app does.
  const domainTitles = useMemo(
    () =>
      new Map(
        (metadata?.domains || []).map(
          (domain) => [domain.key, domain.displayName] as const,
        ),
      ),
    [metadata?.domains],
  );

  const domainPresentations = useMemo(
    () =>
      visibleMetadataDomains.map((domain) =>
        buildPkmDomainPresentation({
          domain,
          activeGrants,
          sharingResolved,
        }),
      ),
    [activeGrants, sharingResolved, visibleMetadataDomains],
  );

  const selectedMetadataDomain = useMemo(
    () =>
      visibleMetadataDomains.find(
        (domain) => domain.key === selectedDomainKey,
      ) || null,
    [selectedDomainKey, visibleMetadataDomains],
  );

  // Entering or leaving a category always starts the nested browser at the
  // category root; Back then walks the stack down exactly one segment at a time.
  useEffect(() => {
    setPathStack([]);
  }, [selectedDomainKey, setPathStack]);

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
    [browsableCards, selectedDomainKey],
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
          count: Math.max(
            domain.detailCount,
            categoryCounts.get(domain.key) || 0,
          ),
        }))
        .filter((domain) => domain.count > 0),
    [categoryCounts, domainPresentations],
  );

  const nativeDataState: NativeTestDataState =
    authLoading || bootstrapLoading || domainDetail.loading
      ? "loading"
      : bootstrapError || domainDetail.error
        ? "error"
        : !applicationOwnerId || !isVaultUnlocked || !vaultOwnerToken || !vaultKey
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

  useEffect(() => {
    let cancelled = false;

    async function loadMutationImpacts() {
      if (
        !applicationOwnerId ||
        !vaultOwnerToken ||
        !selectedMetadataDomain ||
        domainMemoryCards.length === 0
      ) {
        if (!cancelled) setSharingImpactError(null);
        return;
      }
      setSharingImpactError(null);
      try {
        const scopeEntries = Array.from(
          new Map(
            domainMemoryCards.map((card) => [
              cardImpactKey(card),
              cardScopePath(card),
            ]),
          ).entries(),
        );
        const impacts = await Promise.all(
          scopeEntries.map(
            async ([impactKey, scopePath]) =>
              [
                impactKey,
                await PersonalKnowledgeModelService.getMutationSharingImpact({
                  userId: applicationOwnerId,
                  domain: selectedMetadataDomain.key,
                  scopePath,
                  vaultOwnerToken,
                }),
              ] as const,
          ),
        );
        if (!cancelled) {
          setSharingImpacts((current) => ({
            ...current,
            ...Object.fromEntries(impacts),
          }));
        }
      } catch {
        if (!cancelled) {
          setSharingImpactError(
            "Current sharing couldn’t be verified. Refresh before changing details.",
          );
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
    applicationOwnerId,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    let cancelled = false;

    async function loadSelectedDomain() {
      if (
        !selectedMetadataDomain ||
        !applicationOwnerId ||
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
            applicationOwnerId,
            selectedMetadataDomain.key,
            vaultOwnerToken,
          ).catch(() => null),
          PersonalKnowledgeModelService.loadDomainData({
            userId: applicationOwnerId,
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
          setDomainDetail({
            ...EMPTY_DOMAIN_DETAIL,
            session: memoryReadSession,
            error: true,
          });
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
    applicationOwnerId,
    vaultKey,
    vaultOwnerToken,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (
      (workspaceTab !== "browse" && workspaceTab !== "sharing") ||
      !applicationOwnerId ||
      !vaultOwnerToken ||
      visibleMetadataDomains.length === 0
    ) {
      return undefined;
    }
    setSharingManifestsLoading(true);
    void Promise.all(
      visibleMetadataDomains.map(
        async (domain) =>
          [
            domain.key,
            await PersonalKnowledgeModelService.getDomainManifest(
              applicationOwnerId,
              domain.key,
              vaultOwnerToken,
            ).catch(() => null),
          ] as const,
      ),
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
    refreshNonce,
    pkmChangeRevision,
    setSharingManifests,
    applicationOwnerId,
    vaultOwnerToken,
    visibleMetadataDomains,
    workspaceTab,
  ]);

  useEffect(() => {
    let cancelled = false;
    if (
      locationView ||
      workspaceTab !== "browse" ||
      !applicationOwnerId ||
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
      locationSnapshot.current = loadedDomains.location
        ? { session: memoryReadSession, data: loadedDomains.location }
        : null;
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
      userId: applicationOwnerId,
      domains: visibleMetadataDomains.map((domain) => domain.key),
      vaultKey,
      vaultOwnerToken,
      forceRefresh:
        refreshNonce > 0 || memoryCardsNonce > 0 || pkmChangeRevision > 0,
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
    setMemoryCards,
    memoryCardsNonce,
    metadata,
    pkmChangeRevision,
    refreshNonce,
    applicationOwnerId,
    vaultKey,
    vaultOwnerToken,
    visibleMetadataDomains,
    workspaceTab,
  ]);

  async function ensureSharingImpact(
    card: PkmMemoryCard,
  ): Promise<PkmMutationSharingImpact | null> {
    const key = cardImpactKey(card);
    const cached = sharingImpacts[key];
    if (cached) return cached;
    if (!applicationOwnerId || !vaultOwnerToken) return null;
    try {
      const impact =
        await PersonalKnowledgeModelService.getMutationSharingImpact({
          userId: applicationOwnerId,
          domain: card.domain,
          scopePath: cardScopePath(card),
          vaultOwnerToken,
        });
      if (memoryReadSessionRef.current !== memoryReadSession) return null;
      setSharingImpacts((current) => ({ ...current, [key]: impact }));
      return impact;
    } catch {
      if (memoryReadSessionRef.current !== memoryReadSession) return null;
      setSharingImpactError(
        "Current sharing couldn’t be verified. Refresh before changing details.",
      );
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
    if (!selectedCard || !applicationOwnerId || !vaultOwnerToken) {
      setSelectedCardManifest(null);
      return undefined;
    }
    void PersonalKnowledgeModelService.getDomainManifest(
      applicationOwnerId,
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
  }, [
    pkmChangeRevision,
    refreshNonce,
    selectedCard,
    setSelectedCardManifest,
    applicationOwnerId,
    vaultOwnerToken,
  ]);

  async function persistMemoryCardChange(params: {
    card: PkmMemoryCard;
    action: "edited" | "deleted";
    nextValue?: string;
  }) {
    if (!operationIsCurrent() || !applicationOwnerId || !vaultKey || !vaultOwnerToken) return;
    const operationOwnerId = applicationOwnerId;
    const sharingImpact = sharingImpacts[cardImpactKey(params.card)];
    if (!sharingImpact) {
      setMemoryActionError(
        "Current sharing couldn’t be verified. Refresh and try again.",
      );
      return;
    }
    setMemoryActionId(`${params.card.id}:${params.action}`);
    setMemoryActionError(null);
    let persistedDomainData: Record<string, unknown> | null = null;
    try {
      const result = await PkmWriteCoordinator.saveMergedDomain({
        beforeEffect: assertOperationCurrent,
        userId: applicationOwnerId,
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
          const currentField =
            view === "location-detail"
              ? resolveLocationMemoryField(
                  buildLocationMemoryPresentation({ data: currentDomainData }),
                  locationMemoryId,
                )
              : null;
          if (
            view === "location-detail" &&
            (!currentField ||
              currentField.card.valueFingerprint !==
                params.card.valueFingerprint)
          ) {
            throw new Error(
              "This detail has changed. Open Location memory again before updating it.",
            );
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
                params.action === "edited"
                  ? "One saved a correction."
                  : "One removed a detail.",
              ],
              readable_updated_at: new Date().toISOString(),
              readable_source_label: "Memory",
              readable_event_summary:
                params.action === "edited"
                  ? "A saved detail was corrected."
                  : "A saved detail was removed.",
            },
            mergeDecision: { merge_mode: "replace_domain" },
            operation: params.action === "deleted" ? "delete" : "update",
            scopePath: cardScopePath(params.card),
          };
        },
      });
      if (!result.success || !persistedDomainData) {
        throw new Error(
          result.message || "This saved detail couldn’t be updated.",
        );
      }
      if (!operationIsCurrent()) return;
      // The encrypted write is the mutation boundary. Record it before the
      // best-effort metadata refresh so a transient read failure cannot turn
      // one confirmed write into contradictory success + error outcomes.
      trackMemoryOutcome(
        operationOwnerId,
        params.action === "edited" ? "detail_edited" : "detail_deleted",
        "success",
      );
      clearAgentPkmContext(applicationOwnerId);
      let metadataRefreshFailed = false;
      try {
        const refreshedMetadata =
          await PersonalKnowledgeModelService.getMetadata(
            applicationOwnerId,
            true,
            vaultOwnerToken,
          );
        if (!operationIsCurrent()) return;
        setMetadata(refreshedMetadata);
      } catch {
        if (!operationIsCurrent()) return;
        metadataRefreshFailed = true;
        setMemoryActionError(
          "Memory was updated, but the latest summary could not refresh. Refresh the page to see it.",
        );
      }
      morphyToast.success(
        params.action === "edited" ? "Memory updated." : "Memory forgotten.",
      );
      resetMemoryActionState();
      if (!metadataRefreshFailed) setSelectedCard(null);
      if (locationView && !metadataRefreshFailed)
        router.replace(ROUTES.PKM_LOCATION);
      setMemoryCardsNonce((value) => value + 1);
    } catch (error) {
      if (!operationIsCurrent()) return;
      trackMemoryOutcome(
        operationOwnerId,
        params.action === "edited" ? "detail_edited" : "detail_deleted",
        "error",
      );
      setMemoryActionError(
        error instanceof Error
          ? error.message
          : "This saved detail couldn’t be updated.",
      );
      setMemoryActionId(null);
      setSharingImpactRefreshNonce((value) => value + 1);
    } finally {
      if (memoryReadSessionRef.current === memoryReadSession)
        setMemoryActionId(null);
    }
  }

  function isCaptureReady(expectedToken: string) {
    return isAgentPkmProcessingReady(
      captureReadinessRef.current,
      expectedToken,
    );
  }

  async function previewMemoryCapture() {
    if (
      !applicationOwnerId ||
      !isVaultUnlocked ||
      !vaultOwnerToken ||
      !captureText.trim() ||
      captureSaving
    )
      return;
    const operationOwnerId = applicationOwnerId;
    const revision = ++captureRevision.current;
    const guard = createAgentPkmCaptureGuard({
      userId: applicationOwnerId,
      signal: new AbortController().signal,
      isEnabled: () =>
        revision === captureRevision.current && isCaptureReady(vaultOwnerToken),
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
        userId: applicationOwnerId,
        candidate: captureText.trim(),
      });
      if (localDuplicate?.kind === "exact") {
        trackMemoryOutcome(
          operationOwnerId,
          "capture_prepared",
          "expected_error",
        );
        setCaptureCards([]);
        setCaptureMessage(
          "That exact detail is already saved. Open Browse to correct it instead of creating a duplicate.",
        );
        return;
      }
      const sourceSnapshot = captureText.trim();
      const prepared = await prepareNaturalLanguagePkm({
        userId: applicationOwnerId,
        message: sourceSnapshot,
        currentDomains: visibleMetadataDomains.map((domain) => domain.key),
        vaultOwnerToken,
        source: "memory_workspace",
        allowIdentifierProcessing: identifierProcessingApproved(),
        allowEmpty: true,
        isEffectCurrent: guard.isCurrent,
        findDuplicate: (candidate) =>
          AgentPkmContextStore.findLocalDuplicate({
            userId: applicationOwnerId,
            candidate,
          }),
        beforeEffect: guard.assertCurrent,
        onProgress: (progress) => {
          if (guard.isCurrent() && progress.phase !== "prepared") {
            setCaptureMessage(
              `Preparing section ${Math.min(progress.chunkIndex + 1, progress.chunkCount)} of ${progress.chunkCount}… Nothing has been saved yet.`,
            );
          }
        },
      });
      if (!guard.isCurrent()) return;
      setCaptureCards(prepared.cards);
      setCaptureSharingImpactAcknowledged(false);
      // `preparation_requires_review` stays on every card when any block is
      // unresolved: it forbids *automatic* effects. This is the owner's explicit
      // review, so it gates per section instead of across the whole note.
      const unresolvedSections = prepared.sourceCoverage.filter(
        isUnresolvedSourceBlock,
      );
      const hasFailedSource = prepared.sourceCoverage.some(
        (block) =>
          block.disposition === "failed" ||
          (Boolean(block.preparationIssue) &&
            block.preparationIssue !== "degraded_preview"),
      );
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
          ? describeUnresolvedCapture(
              unresolvedSections.length,
              prepared.cards.length > 0,
            )
          : localDuplicate?.kind === "possible"
            ? "A related saved detail may already exist. Review this suggestion before saving."
            : prepared.cards.length
              ? "Review the proposed details before adding them."
              : "Nothing new needs to be saved from that note.",
      );
    } catch {
      if (!guard.isCurrent()) return;
      trackMemoryOutcome(operationOwnerId, "capture_prepared", "error");
      setCaptureMessage(
        "That note couldn’t be prepared. Nothing was saved. Please try again.",
      );
    } finally {
      if (revision === captureRevision.current) setCaptureLoading(false);
    }
  }

  async function retryCaptureSection(block: PkmNaturalLanguageSourceCoverage) {
    const sourceSnapshot = captureSourceSnapshot;
    if (
      !applicationOwnerId ||
      !isVaultUnlocked ||
      !vaultOwnerToken ||
      !block.sourceRange ||
      captureLoading ||
      captureSaving ||
      captureRetryingSectionKey !== null ||
      !sourceSnapshot ||
      sourceSnapshot !== captureText.trim()
    )
      return;
    const operationOwnerId = applicationOwnerId;
    const revision = captureRevision.current;
    const sectionKey = pkmCaptureSectionKey(block);
    const guard = createAgentPkmCaptureGuard({
      userId: applicationOwnerId,
      signal: new AbortController().signal,
      isEnabled: () =>
        revision === captureRevision.current && isCaptureReady(vaultOwnerToken),
    });
    if (!guard.isCurrent()) return;
    setCaptureRetryingSectionKey(sectionKey);
    try {
      const prepared = await prepareNaturalLanguagePkm({
        userId: applicationOwnerId,
        message: sourceSnapshot,
        sourceSelection: {
          range: block.sourceRange,
          context: block.sourceContext,
        },
        currentDomains: visibleMetadataDomains.map((domain) => domain.key),
        vaultOwnerToken,
        source: "memory_workspace",
        allowIdentifierProcessing: identifierProcessingApproved(),
        allowEmpty: true,
        isEffectCurrent: guard.isCurrent,
        findDuplicate: (candidate) =>
          AgentPkmContextStore.findLocalDuplicate({
            userId: applicationOwnerId,
            candidate,
          }),
        beforeEffect: guard.assertCurrent,
      });
      if (!guard.isCurrent()) return;
      const stillUnresolved = prepared.sourceCoverage.filter(
        isUnresolvedSourceBlock,
      );
      const remaining =
        captureUnresolvedSections.length - 1 + stillUnresolved.length;
      setCaptureUnresolvedSections((current) =>
        current.flatMap((entry) =>
          pkmCaptureSectionKey(entry) === sectionKey
            ? stillUnresolved
            : [entry],
        ),
      );
      if (prepared.cards.length > 0) {
        setCaptureCards((current) => [...current, ...prepared.cards]);
        if (
          prepared.cards.some(
            (card) => (card.sharing_impact?.active_recipient_count || 0) > 0,
          )
        ) {
          setCaptureSharingImpactAcknowledged(false);
        }
      }
      trackMemoryOutcome(
        operationOwnerId,
        "capture_prepared",
        stillUnresolved.length === 0 ? "success" : "expected_error",
      );
      setCaptureMessage(
        remaining > 0
          ? describeUnresolvedCapture(
              remaining,
              captureCards.length + prepared.cards.length > 0,
            )
          : captureCards.length + prepared.cards.length > 0
            ? "Every section is prepared. Review the proposed details before adding them."
            : "Nothing new needs to be saved from that note.",
      );
    } catch {
      if (!guard.isCurrent()) return;
      trackMemoryOutcome(operationOwnerId, "capture_prepared", "error");
      setCaptureMessage(
        "That section couldn’t be prepared. Nothing from it was saved. Please try again.",
      );
    } finally {
      if (memoryOwnerIdRef.current === operationOwnerId)
        setCaptureRetryingSectionKey(null);
    }
  }

  async function saveMemoryCapture() {
    if (
      !applicationOwnerId ||
      !isVaultUnlocked ||
      !vaultKey ||
      !vaultOwnerToken ||
      captureSaveableCards.length === 0 ||
      captureRetryingSectionKey !== null ||
      (captureHasSharedRecipients && !captureSharingImpactAcknowledged) ||
      pkmCaptureSaveInFlight.has(applicationOwnerId)
    )
      return;
    const operationId = Symbol("memory-save");
    const operationOwnerId = applicationOwnerId;
    pkmCaptureSaveInFlight.set(operationOwnerId, operationId);
    const revision = ++captureRevision.current;
    const receiptGuard = createAgentPkmCaptureGuard({
      userId: applicationOwnerId,
      signal: new AbortController().signal,
      isEnabled: () =>
        pkmCaptureSaveInFlight.get(operationOwnerId) === operationId,
    });
    const guard = createAgentPkmCaptureGuard({
      userId: applicationOwnerId,
      signal: new AbortController().signal,
      isEnabled: () =>
        revision === captureRevision.current && isCaptureReady(vaultOwnerToken),
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
        userId: applicationOwnerId,
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
        success: (result) =>
          result.failed > 0
            ? "Some details still need attention. Your note is kept for review."
            : result.saved > 0
              ? "Reviewed memory saved."
              : "No details were saved. Your note is kept for review.",
        error:
          "Memory couldn’t be saved. Your note is still here; please try again.",
      });
      const result = await operation;
      if (
        receiptGuard.isCurrent() &&
        memoryOwnerIdRef.current === operationOwnerId
      ) {
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
        if (
          receiptGuard.isCurrent() &&
          memoryOwnerIdRef.current === operationOwnerId
        ) {
          if (result.saved > 0)
            pkmCaptureReconciliationNeeded.add(operationOwnerId);
          // Counts only; do not republish cards or refresh private information
          // while verification is unavailable. The draft stays for review.
          setCaptureCards([]);
          setCaptureUnresolvedSections([]);
          setCaptureMessage(
            result.saved > 0
              ? `${result.saved} reviewed detail${result.saved === 1 ? "" : "s"} saved. Check Memory before preparing this note again.`
              : "Saving was interrupted. Check Memory before preparing this note again.",
          );
        }
        return;
      }
      clearAgentPkmContext(applicationOwnerId);
      const remainingSections = captureUnresolvedSections.length;
      setCaptureMessage(
        result.saved > 0
          ? `${result.saved} reviewed detail${result.saved === 1 ? "" : "s"} saved.${
              remainingSections > 0
                ? ` ${remainingSections} section${remainingSections === 1 ? " still needs" : "s still need"} another pass; nothing from ${remainingSections === 1 ? "it" : "them"} was saved. Your note is kept below.`
                : result.failed > 0
                  ? " Some details still need attention; your note is kept below."
                  : ""
            }`
          : "Nothing was saved; the proposed detail needs a correction first.",
      );
      if (result.saved > 0) {
        if (result.failed > 0 || captureHasUnresolvedSource) {
          const savedIds = new Set(
            result.results
              .filter((item) => item.success)
              .map((item) => item.cardId),
          );
          setCaptureCards((current) =>
            current.filter((card) => !savedIds.has(card.card_id)),
          );
        } else {
          setCaptureText("");
          setCaptureCards([]);
          setCaptureSharingImpactAcknowledged(false);
        }
        setRefreshNonce((value) => value + 1);
      }
    } catch {
      if (!guard.isCurrent()) {
        if (
          receiptGuard.isCurrent() &&
          memoryOwnerIdRef.current === operationOwnerId
        ) {
          setCaptureCards([]);
          setCaptureMessage(
            "Saving was interrupted. Check Memory before preparing this note again.",
          );
        }
        return;
      }
      trackMemoryOutcome(operationOwnerId, "capture_saved", "error");
      setCaptureMessage(
        "Memory couldn’t be saved. Your note is still here; please try again.",
      );
    } finally {
      if (pkmCaptureSaveInFlight.get(operationOwnerId) === operationId) {
        pkmCaptureSaveInFlight.delete(operationOwnerId);
        if (memoryOwnerIdRef.current === operationOwnerId)
          setCaptureSaving(false);
      }
    }
  }

  async function updateSharingBundles(params: {
    domain: string;
    manifest: DomainManifest;
    scopeHandles: string[];
    enabled: boolean;
  }) {
    if (
      !operationIsCurrent() ||
      !applicationOwnerId ||
      !vaultOwnerToken ||
      params.scopeHandles.length === 0
    )
      return;
    const actionKey = `${params.domain}:${params.scopeHandles.join(",")}`;
    setSharingActionKey(actionKey);
    try {
      const operation = PersonalKnowledgeModelService.updateScopeExposure({
        beforeEffect: assertOperationCurrent,
        mayPublish: operationIsCurrent,
        userId: applicationOwnerId,
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
        isCurrent: operationIsCurrent,
        success: params.enabled
          ? "One will ask before sharing this."
          : "This is private again.",
        error: "Sharing choices changed elsewhere. Refresh and try again.",
      });
      const result = await operation;
      if (!operationIsCurrent()) return;
      if (result.manifest) {
        setSharingManifests((current) => ({
          ...current,
          [params.domain]: result.manifest,
        }));
      }
      setRefreshNonce((value) => value + 1);
    } catch {
      // The toast is intentionally redacted. Scope exposure never exposes server detail.
    } finally {
      if (memoryReadSessionRef.current === memoryReadSession)
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
    if (!operationIsCurrent() || !applicationOwnerId || !vaultOwnerToken) return;
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
        beforeEffect: assertOperationCurrent,
        mayPublish: operationIsCurrent,
        userId: applicationOwnerId,
        domain: card.domain,
        expectedManifestVersion: manifest.manifest_version,
        vaultOwnerToken,
        changes: [
          { scopeHandle: bundle.scopeHandle, visibilityPosture: nextPosture },
        ],
      });
      void morphyToast.promise(operation, {
        loading: "Updating sharing choices…",
        isCurrent: operationIsCurrent,
        success:
          nextPosture === "consent_required"
            ? "One will ask before sharing this."
            : "This is private again.",
        error: "Sharing choices changed elsewhere. Refresh and try again.",
      });
      const result = await operation;
      if (!operationIsCurrent()) return;
      if (result.manifest) setSelectedCardManifest(result.manifest);
      // Turning a scope private revokes matching active grants server-side, so
      // re-verify this memory's recipients instead of trusting a stale "Shared".
      try {
        const impact =
          await PersonalKnowledgeModelService.getMutationSharingImpact({
            userId: applicationOwnerId,
            domain: card.domain,
            scopePath: cardScopePath(card),
            vaultOwnerToken,
          });
        if (!operationIsCurrent()) return;
        setSharingImpacts((current) => ({
          ...current,
          [cardImpactKey(card)]: impact,
        }));
      } catch {
        if (!operationIsCurrent()) return;
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
      if (!operationIsCurrent()) return;
      setMemorySharingError(
        "Sharing choices couldn’t be updated. Refresh and try again.",
      );
    } finally {
      if (memoryReadSessionRef.current === memoryReadSession)
        setMemorySharingActionId(null);
    }
  }

  const trimmedQuery = homeSearchQuery.trim();
  const searchResults = trimmedQuery
    ? selectRelevantPkmMemoryCards(browsableCards, homeSearchQuery, 24)
    : [];
  const matchedCategories = trimmedQuery
    ? categories.filter((domain) =>
        `${domain.title} ${domain.summary}`
          .toLowerCase()
          .includes(trimmedQuery.toLowerCase()),
      )
    : categories;
  const recentMemories = browsableCards.slice(0, RECENT_MEMORIES_LIMIT);

  function openMemory(card: PkmMemoryCard) {
    if (card.domain === "location") {
      const snapshot = locationSnapshot.current;
      const presentation = buildLocationMemoryPresentation({
        data: snapshot?.session === memoryReadSession ? snapshot.data : null,
      });
      const field = findLocationMemoryFieldForCard(presentation, card);
      router.push(
        field?.selector
          ? `${ROUTES.PKM_LOCATION_DETAIL}?memory=${field.selector}`
          : ROUTES.PKM_LOCATION,
      );
      return;
    }
    setSelectedCard(card);
    setMemoryActionError(null);
  }

  const canOpen = Boolean(
    applicationOwnerId && isVaultUnlocked && vaultKey && vaultOwnerToken,
  );
  const signedIn = Boolean(applicationOwnerId);
  const locationLoading =
    bootstrapLoading ||
    (!metadata && !bootstrapError) ||
    domainDetail.loading ||
    (Boolean(selectedMetadataDomain) &&
      domainDetail.session !== memoryReadSession);
  const soul = useSoulMemoryModel({
    userId: applicationOwnerId ?? "",
    vaultKey: vaultKey ?? "",
    vaultOwnerToken: vaultOwnerToken ?? "",
    tokenExpiresAt,
    verified: canOpen && !sessionVerificationRequired,
    active:
      view === "home" &&
      canOpen &&
      !authLoading &&
      !selectedCard &&
      !selectedMetadataDomain &&
      workspaceTab === "browse",
  });
  const changeCaptureText = (text: string) => {
    if (memoryReadSessionRef.current !== memoryReadSession || captureSaving)
      return;
    captureRevision.current += 1;
    setCaptureText(text);
    setIdentifierApproval(null);
    setCaptureCards([]);
    setCaptureUnresolvedSections([]);
    setCaptureRetryingSectionKey(null);
    setCaptureMessage(null);
    setCaptureLoading(false);
  };
  const setIdentifierProcessingApproval = (approved: boolean) => {
    if (memoryReadSessionRef.current !== memoryReadSession || captureLoading || captureSaving) return;
    captureRevision.current += 1;
    setIdentifierApproval(approved ? { note: captureText, epoch: snapshotVaultSessionEpoch() } : null);
    setCaptureCards([]);
    setCaptureUnresolvedSections([]);
    setCaptureRetryingSectionKey(null);
    setCaptureMessage(null);
  };
  return {
    ownerId: applicationOwnerId ?? "",
    identifierProcessingApproved,
    setIdentifierProcessingApproval,
    memoryScopeShareBundle,
    authLoading,
    sessionVerificationRequired,
    isVaultUnlocked,
    locationView,
    setSelectedDomainKey,
    setPathStack,
    metadata,
    bootstrapLoading,
    bootstrapError,
    setRefreshNonce,
    pathStack,
    locationPresentation,
    locationField,
    selectedCard,
    unwindMemory,
    setMemoryCardsNonce,
    memoryActionId,
    memoryActionError,
    sharingImpacts,
    sharingImpactError,
    exportBusy,
    exportStatus,
    exportError,
    handleExportMemory,
    workspaceTab,
    setWorkspaceTab,
    captureText: captureIsCurrent ? captureText : "",
    captureCards: captureIsCurrent ? captureCards : [],
    captureHasSharedRecipients: captureIsCurrent && captureHasSharedRecipients,
    captureSharingImpactAcknowledged:
      captureIsCurrent && captureSharingImpactAcknowledged,
    setCaptureSharingImpactAcknowledged: (value: boolean) => {
      if (presentationOwnerRef.current === presentationOwner)
        setCaptureSharingImpactAcknowledged(value);
    },
    captureUnresolvedSections: captureIsCurrent
      ? captureUnresolvedSections
      : [],
    captureSourceSnapshot: captureIsCurrent ? captureSourceSnapshot : "",
    captureRetryingSectionKey: captureIsCurrent
      ? captureRetryingSectionKey
      : null,
    captureHasUnresolvedSource: captureIsCurrent && captureHasUnresolvedSource,
    captureSaveableCards: captureIsCurrent ? captureSaveableCards : [],
    captureLoading: captureIsCurrent && captureLoading,
    captureSaving: captureIsCurrent && captureSaving,
    captureMessage: captureIsCurrent ? captureMessage : null,
    setCaptureMessage: (value: string | null) => {
      if (presentationOwnerRef.current === presentationOwner)
        setCaptureMessage(value);
    },
    sharingManifests,
    sharingManifestsLoading,
    sharingActionKey,
    memorySharingActionId,
    memorySharingError,
    setMemorySharingError: (_value: null) => {
      if (operationIsCurrent()) setMemorySharingError(null);
    },
    homeSearchQuery,
    setHomeSearchQuery,
    memoryCards,
    memoryCardsLoading,
    memoryCardsLoadError,
    visibleMetadataDomains,
    domainTitles,
    selectedMetadataDomain,
    categories,
    persistMemoryCardChange,
    previewMemoryCapture,
    retryCaptureSection,
    saveMemoryCapture,
    updateSharingBundles,
    memorySharingState,
    memorySharingPosture,
    updateMemoryScopeSharing,
    trimmedQuery,
    searchResults,
    matchedCategories,
    recentMemories,
    openMemory,
    canOpen,
    signedIn,
    locationLoading,
    soul,
    changeCaptureText,
    nativeDataState,
    domainDetail: {
      manifest:
        domainDetail.session === memoryReadSession
          ? domainDetail.manifest
          : null,
      data:
        domainDetail.session === memoryReadSession ? domainDetail.data : null,
      loading: domainDetail.loading,
      error: domainDetail.error,
    },
    navigate: (href: string) => router.push(href),
    replaceRoute: (href: string) => router.replace(href),
  };
}
export type PkmNaturalModel = ReturnType<typeof usePkmNaturalModel>;
