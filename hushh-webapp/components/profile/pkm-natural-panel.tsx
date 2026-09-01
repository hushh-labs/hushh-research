"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Lock, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";

import { PkmMemoryRow } from "@/components/profile/pkm-memory-row";
import { PkmMemoryLevel } from "@/components/profile/pkm-memory-level";
import {
  PkmMemoryDetail,
  type MemorySharingState,
} from "@/components/profile/pkm-memory-detail";
import { SettingsGroup, SettingsRow, SegmentedTabs } from "@/components/app-ui/settings-ui";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { SwipeViews } from "@/lib/morphy-ux/ui/swipe-views";
import { NativeTestBeacon, type NativeTestDataState } from "@/components/app-ui/native-test-beacon";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/morphy";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import {
  buildPkmDomainPresentation,
  isConsumerBrowsablePkmDomain,
} from "@/lib/profile/pkm-profile-presentation";
import { ROUTES } from "@/lib/navigation/routes";
import {
  addToPKM,
  clearAgentPkmContext,
  getIgnoredPkmCards,
  previewAgentPkmMemory,
  type AgentPkmPreviewCard,
} from "@/lib/agent/agent-pkm-memory";
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
import { useVault } from "@/lib/vault/vault-context";

type DomainDetailState = {
  manifest: DomainManifest | null;
  data: Record<string, unknown> | null;
  loading: boolean;
  error: boolean;
};

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

function cardScopePath(card: PkmMemoryCard): string {
  return String(card.pathSegments.find((segment) => typeof segment === "string") || "profile");
}

function cardImpactKey(card: PkmMemoryCard): string {
  return `${card.domain}::${cardScopePath(card)}`;
}

export function PkmNaturalPanel({
  refreshToken = 0,
}: {
  refreshToken?: number;
  onOpenExplorer?: () => void;
} = {}) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const pkmChangeRevision = usePkmDomainChangeRevision(user?.uid);

  const [metadata, setMetadata] = useState<PersonalKnowledgeModelMetadata | null>(null);
  const [activeGrants, setActiveGrants] = useState<ConsentCenterEntry[]>([]);
  const [sharingResolved, setSharingResolved] = useState(false);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [selectedDomainKey, setSelectedDomainKey] = useState<string | null>(null);
  const [pathStack, setPathStack] = useState<PkmPathSegment[]>([]);
  const [selectedCard, setSelectedCard] = useState<PkmMemoryCard | null>(null);
  const [domainDetail, setDomainDetail] = useState<DomainDetailState>(EMPTY_DOMAIN_DETAIL);
  const [memoryCardsNonce, setMemoryCardsNonce] = useState(0);
  const [memoryActionId, setMemoryActionId] = useState<string | null>(null);
  const [memoryActionError, setMemoryActionError] = useState<string | null>(null);
  const [sharingImpacts, setSharingImpacts] = useState<Record<string, PkmMutationSharingImpact>>({});
  const [sharingImpactError, setSharingImpactError] = useState<string | null>(null);
  const [sharingImpactRefreshNonce, setSharingImpactRefreshNonce] = useState(0);
  const [autoSavePolicy, setAutoSavePolicy] = useState<AgentPkmAutoSavePolicy>(
    DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY
  );
  const [autoSavePolicyLoading, setAutoSavePolicyLoading] = useState(false);
  const [autoSavePolicySaving, setAutoSavePolicySaving] = useState(false);
  const [autoSavePolicyError, setAutoSavePolicyError] = useState<string | null>(null);
  const [autoSavePolicyRetryValue, setAutoSavePolicyRetryValue] = useState<
    boolean | null
  >(null);
  const [workspaceTab, setWorkspaceTab] = useState<MemoryWorkspaceTab>("browse");
  const [captureText, setCaptureText] = useState("");
  const [captureCards, setCaptureCards] = useState<AgentPkmPreviewCard[]>([]);
  const [captureLoading, setCaptureLoading] = useState(false);
  const [captureSaving, setCaptureSaving] = useState(false);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);
  const [sharingManifests, setSharingManifests] = useState<Record<string, DomainManifest | null>>({});
  const [sharingManifestsLoading, setSharingManifestsLoading] = useState(false);
  const [sharingActionKey, setSharingActionKey] = useState<string | null>(null);
  const [homeSearchQuery, setHomeSearchQuery] = useState("");
  const [memoryCards, setMemoryCards] = useState<PkmMemoryCard[]>([]);
  const [memoryCardsLoading, setMemoryCardsLoading] = useState(false);

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
            : visibleMetadataDomains.length === 0
              ? "empty-valid"
              : "loaded";
  const nativeBeacon = (
    <NativeTestBeacon
      routeId="/one/pkm"
      marker="native-route-pkm"
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
          manifest,
          data: domainData,
          loading: false,
          error: false,
        });
      } catch {
        if (!cancelled) {
          setDomainDetail({ ...EMPTY_DOMAIN_DETAIL, error: true });
        }
      }
    }

    void loadSelectedDomain();
    return () => {
      cancelled = true;
    };
  }, [
    isVaultUnlocked,
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
      workspaceTab !== "browse" ||
      !user ||
      !isVaultUnlocked ||
      !vaultKey ||
      !vaultOwnerToken
    ) {
      return undefined;
    }
    setMemoryCardsLoading(true);
    void PersonalKnowledgeModelService.loadFullBlob({
      userId: user.uid,
      vaultKey,
      vaultOwnerToken,
    })
      .then((fullBlob) => {
        if (cancelled) return;
        const snapshot = buildPkmMemorySnapshot({
          metadata,
          fullBlob,
          maxCards: 400,
          maxCardsPerDomain: 80,
        });
        const sorted = [...snapshot.cards].sort((left, right) => {
          const leftTime = left.updatedAt ? Date.parse(left.updatedAt) : 0;
          const rightTime = right.updatedAt ? Date.parse(right.updatedAt) : 0;
          return rightTime - leftTime;
        });
        setMemoryCards(sorted);
      })
      .catch(() => {
        if (!cancelled) setMemoryCards([]);
      })
      .finally(() => {
        if (!cancelled) setMemoryCardsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    isVaultUnlocked,
    memoryCardsNonce,
    metadata,
    pkmChangeRevision,
    refreshNonce,
    user,
    vaultKey,
    vaultOwnerToken,
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
      setSharingImpacts((current) => ({ ...current, [key]: impact }));
      return impact;
    } catch {
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
  }, [selectedCard?.id]);

  async function persistMemoryCardChange(params: {
    card: PkmMemoryCard;
    action: "edited" | "deleted";
    nextValue?: string;
  }) {
    if (!user || !vaultKey || !vaultOwnerToken) return;
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
          persistedDomainData =
            params.action === "edited"
              ? updatePkmDomainValue({
                  domainData: currentDomainData,
                  pathSegments: params.card.pathSegments,
                  previousValue: params.card.value,
                  nextValue: params.nextValue || "",
                  expectedValueFingerprint: params.card.valueFingerprint,
                })
              : deletePkmDomainValue({
                  domainData: currentDomainData,
                  pathSegments: params.card.pathSegments,
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
      clearAgentPkmContext(user.uid);
      setMetadata(
        await PersonalKnowledgeModelService.getMetadata(user.uid, true, vaultOwnerToken)
      );
      morphyToast.success(params.action === "edited" ? "Memory updated." : "Memory forgotten.");
      resetMemoryActionState();
      setSelectedCard(null);
      setMemoryCardsNonce((value) => value + 1);
    } catch (error) {
      setMemoryActionError(
        error instanceof Error ? error.message : "This saved detail couldn’t be updated."
      );
      setMemoryActionId(null);
      setSharingImpactRefreshNonce((value) => value + 1);
    }
  }

  async function updateAutoSavePolicy(enabled: boolean) {
    if (!user || !vaultKey || !vaultOwnerToken) return;
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
      setAutoSavePolicy(nextPolicy);
      setAutoSavePolicyError(null);
      setAutoSavePolicyRetryValue(null);
    } catch {
      // ApiService asks VaultLockGuard to re-open the existing vault unlock
      // dialog when a VAULT_OWNER token is rejected. Other failures are not
      // evidence that the vault is locked, so keep the recovery local and
      // retryable instead of sending people to hunt for an unlock screen.
      setAutoSavePolicyError("Automatic memory saving couldn’t be updated. Try again.");
    } finally {
      setAutoSavePolicySaving(false);
    }
  }

  async function previewMemoryCapture() {
    if (!user || !vaultOwnerToken || !captureText.trim()) return;
    setCaptureLoading(true);
    setCaptureMessage(null);
    try {
      const localDuplicate = AgentPkmContextStore.findLocalDuplicate({
        userId: user.uid,
        candidate: captureText.trim(),
      });
      if (localDuplicate?.kind === "exact") {
        setCaptureCards([]);
        setCaptureMessage("That exact detail is already saved. Open Browse to correct it instead of creating a duplicate.");
        return;
      }
      const preview = await previewAgentPkmMemory({
        userId: user.uid,
        message: captureText.trim(),
        currentDomains: visibleMetadataDomains.map((domain) => domain.key),
        vaultOwnerToken,
      });
      setCaptureCards(preview.cards);
      setCaptureMessage(
        localDuplicate?.kind === "possible"
          ? "A related saved detail may already exist. Review this suggestion before saving."
          : preview.cards.length
          ? "Review the proposed saved detail before adding it."
          : "Nothing new needs to be saved from that note."
      );
    } catch {
      setCaptureMessage("That note couldn’t be prepared. Unlock your vault again and retry.");
    } finally {
      setCaptureLoading(false);
    }
  }

  async function saveMemoryCapture() {
    if (!user || !vaultKey || !vaultOwnerToken || captureCards.length === 0) return;
    setCaptureSaving(true);
    try {
      const operation = addToPKM({
          userId: user.uid,
          cards: captureCards,
          sourceMessage: captureText.trim(),
          vaultKey,
          vaultOwnerToken,
          source: "memory_workspace",
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "memory_workspace_add",
          },
        });
      void morphyToast.promise(operation, {
        loading: "Saving reviewed memory…",
        success: "Reviewed memory saved.",
        error: "Memory couldn’t be saved. Unlock your vault again and retry.",
      });
      const result = await operation;
      clearAgentPkmContext(user.uid);
      setCaptureMessage(
        result.saved > 0
          ? `${result.saved} reviewed detail${result.saved === 1 ? "" : "s"} saved.`
          : "Nothing was saved; the proposed detail needs a correction first."
      );
      if (result.saved > 0) {
        setCaptureText("");
        setCaptureCards([]);
        setRefreshNonce((value) => value + 1);
      }
    } catch {
      setCaptureMessage("Memory couldn’t be saved. Unlock your vault again and retry.");
    } finally {
      setCaptureSaving(false);
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

  const trimmedQuery = homeSearchQuery.trim();
  const searchResults = trimmedQuery
    ? selectRelevantPkmMemoryCards(browsableCards, homeSearchQuery, 24)
    : [];
  const matchedCategories = trimmedQuery
    ? categories.filter((domain) =>
        `${domain.title} ${domain.summary}`.toLowerCase().includes(trimmedQuery.toLowerCase())
      )
    : categories;
  const recentMemories = browsableCards.slice(0, 6);

  function openMemory(card: PkmMemoryCard) {
    setSelectedCard(card);
    setMemoryActionError(null);
  }

  function renderCategoryRow(domain: { key: string; title: string; count: number }) {
    return (
      <SettingsRow
        key={domain.key}
        title={domain.title}
        description={`${domain.count} ${domain.count === 1 ? "memory" : "memories"}`}
        onClick={() => setSelectedDomainKey(domain.key)}
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

  if (!user) {
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

  if (selectedCard) {
    return (
      <>
        {nativeBeacon}
        <PkmMemoryDetail
          card={selectedCard}
          sharingState={memorySharingState(selectedCard)}
          canMutate={Boolean(sharingImpacts[cardImpactKey(selectedCard)])}
          saving={memoryActionId === `${selectedCard.id}:edited`}
          deleting={memoryActionId === `${selectedCard.id}:deleted`}
          actionError={memoryActionError}
          onBack={() => {
            setSelectedCard(null);
            setMemoryActionError(null);
          }}
          onOpenSharing={() => router.push(ROUTES.CONSENTS)}
          onSave={(nextValue) =>
            void persistMemoryCardChange({ card: selectedCard, action: "edited", nextValue })
          }
          onForget={() => void persistMemoryCardChange({ card: selectedCard, action: "deleted" })}
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

  return (
    <>
      {nativeBeacon}
      <div className="space-y-4">
        <SegmentedTabs
          value={workspaceTab}
          onValueChange={(value) => setWorkspaceTab(value as MemoryWorkspaceTab)}
          options={MEMORY_WORKSPACE_TABS}
          mobileColumns={3}
        />
        <SwipeViews
          options={MEMORY_WORKSPACE_TABS}
          tabSetId="memory"
          activeValue={workspaceTab}
          onSelectionChange={(value) => setWorkspaceTab(value as MemoryWorkspaceTab)}
          viewportMinHeight="0px"
          heightMode="active"
        >
          <div className="space-y-5 pb-1 pr-px" data-pkm-saved-panel="true">
          <Input
            type="search"
            value={homeSearchQuery}
            onChange={(event) => setHomeSearchQuery(event.target.value)}
            placeholder="Search Memory"
            aria-label="Search Memory"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="h-11"
          />

          {memoryCardsLoading && memoryCards.length === 0 ? (
            <SurfaceInset className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Opening Memory…
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
                <SettingsGroup title="Recently learned" separatorInset testId="memory-recently-learned">
                  {recentMemories.map((card) => (
                    <PkmMemoryRow key={card.id} card={card} onOpen={openMemory} />
                  ))}
                </SettingsGroup>
              ) : null}

              {categories.length > 0 ? (
                <SettingsGroup title="Categories" separatorInset testId="memory-categories">
                  {categories.map(renderCategoryRow)}
                  {addMemoryRow}
                </SettingsGroup>
              ) : (
                <>
                  {!memoryCardsLoading ? (
                    <p className="px-1 text-sm text-muted-foreground">
                      One hasn’t saved anything yet.
                    </p>
                  ) : null}
                  <SettingsGroup separatorInset>{addMemoryRow}</SettingsGroup>
                </>
              )}

              {bootstrapError ? (
                <p className="px-1 text-sm text-muted-foreground">
                  Some memories couldn’t be loaded. Pull to refresh.
                </p>
              ) : null}
            </>
          )}
          </div>
          <div className="space-y-5 pb-1 pr-px">
          <SurfaceInset className="space-y-4 p-4" data-pkm-memory-capture="true">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">Teach One something</p>
              <p className="text-sm text-muted-foreground">Tell One something you’d like it to remember.</p>
            </div>
            <Textarea value={captureText} onChange={(event) => setCaptureText(event.target.value)} placeholder="I prefer morning flights whenever possible." aria-label="Memory note" maxLength={4000} />
            <Button className="w-full justify-center" type="button" variant="muted" effect="fade" disabled={captureLoading || !captureText.trim()} onClick={() => void previewMemoryCapture()}>
              {captureLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}Review memory
            </Button>
            {captureMessage ? <p className="text-sm text-muted-foreground">{captureMessage}</p> : null}
            {captureCards.length > 0 ? (
              <SettingsGroup separatorInset>
                {captureCards.map((card) => (
                  <SettingsRow
                    key={card.card_id}
                    title="Proposed saved detail"
                    description={card.sharing_impact?.active_recipient_count ? "This may update a detail that is currently shared." : "This stays private unless you choose to share it later."}
                  />
                ))}
                {getIgnoredPkmCards(captureCards).length > 0 ? <SettingsRow title="Some of this note will not be saved" description="Only appropriate details can be added to Memory." /> : null}
              </SettingsGroup>
            ) : null}
            {captureCards.length > 0 ? <Button className="w-full justify-center" type="button" effect="fade" disabled={captureSaving} onClick={() => void saveMemoryCapture()}>{captureSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}Save to Memory</Button> : null}
          </SurfaceInset>

          <SettingsGroup separatorInset testId="memory-auto-save-group">
            <SettingsRow
              testId="memory-auto-save-row"
              title="Let One remember useful preferences"
              description={
                autoSavePolicyError ||
                "One can save simple preferences automatically. Sensitive details will still ask first."
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
            <div className="space-y-1 px-1">
              <p className="text-sm font-semibold text-foreground">Memory sharing</p>
              <p className="text-sm text-muted-foreground">
                Choose what One can share when someone asks for access.
              </p>
            </div>

            {sharingManifestsLoading ? (
              <p className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Checking sharing settings…
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
