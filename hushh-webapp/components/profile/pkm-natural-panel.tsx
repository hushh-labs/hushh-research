"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronLeft, Edit3, Loader2, Lock, Minus, ShieldAlert, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { PkmDataManagerPanel } from "@/components/profile/pkm-data-manager";
import { PkmSectionPreview } from "@/components/profile/pkm-section-preview";
import { SettingsGroup, SettingsRow, SettingsSegmentedTabs } from "@/components/app-ui/settings-ui";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
  buildPkmProfileSummaryPresentation,
  isConsumerBrowsablePkmDomain,
} from "@/lib/profile/pkm-profile-presentation";
import {
  buildPkmSectionPreviewPresentation,
  type PkmSectionPreviewPresentation,
} from "@/lib/profile/pkm-section-preview";
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
  updatePkmDomainValue,
  type PkmMemoryCard,
} from "@/lib/pkm/pkm-memory-cards";
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
  preview: PkmSectionPreviewPresentation | null;
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
  preview: null,
  loading: false,
  error: false,
};

function cardScopePath(card: PkmMemoryCard): string {
  return String(card.pathSegments.find((segment) => typeof segment === "string") || "profile");
}

function formatSharingImpactDisclosure(impact: PkmMutationSharingImpact): string {
  const labels = impact.recipientLabels.map((label) => label.trim()).filter(Boolean);
  const recipient =
    labels.length === 1
      ? labels[0]
      : `${impact.activeRecipientCount} recipient${
          impact.activeRecipientCount === 1 ? "" : "s"
        }`;
  return `This update is shared with ${recipient}.`;
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
  const [sharingError, setSharingError] = useState<string | null>(null);
  const [bootstrapLoading, setBootstrapLoading] = useState(true);
  const [bootstrapError, setBootstrapError] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [selectedDomainKey, setSelectedDomainKey] = useState<string | null>(null);
  const [domainDetail, setDomainDetail] = useState<DomainDetailState>(EMPTY_DOMAIN_DETAIL);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [memoryActionId, setMemoryActionId] = useState<string | null>(null);
  const [memoryActionMessage, setMemoryActionMessage] = useState<string | null>(null);
  const [memoryActionError, setMemoryActionError] = useState<string | null>(null);
  const [sharingImpacts, setSharingImpacts] = useState<Record<string, PkmMutationSharingImpact>>({});
  const [sharingImpactLoading, setSharingImpactLoading] = useState(false);
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

  useEffect(() => {
    let cancelled = false;

    async function loadCategories() {
      if (authLoading) return;
      if (!user || !isVaultUnlocked || !vaultOwnerToken) {
        if (!cancelled) {
          setMetadata(null);
          setActiveGrants([]);
          setSharingResolved(false);
          setSharingError(null);
          setBootstrapLoading(false);
          setBootstrapError(false);
        }
        return;
      }

      setBootstrapLoading(true);
      setBootstrapError(false);
      setSharingResolved(false);
      setSharingError(null);
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
          if (cancelled) return;
          setSharingError("Sharing access couldn’t be verified. Refresh to try again.");
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

  const selectedDomain = useMemo(() => {
    if (!selectedMetadataDomain) return null;
    return buildPkmDomainPresentation({
      domain: selectedMetadataDomain,
      activeGrants,
      sharingResolved,
      manifest: domainDetail.manifest,
    });
  }, [activeGrants, domainDetail.manifest, selectedMetadataDomain, sharingResolved]);

  const summary = useMemo(
    () =>
      buildPkmProfileSummaryPresentation({
        metadata,
        domains: domainPresentations,
        activeGrants,
        metadataResolved: metadata !== null,
        sharingResolved,
      }),
    [activeGrants, domainPresentations, metadata, sharingResolved]
  );

  const domainMemoryCards = useMemo(() => {
    if (!selectedMetadataDomain || !domainDetail.data) return [];
    return buildPkmMemorySnapshot({
      metadata,
      fullBlob: { [selectedMetadataDomain.key]: domainDetail.data },
      maxCards: 64,
      maxCardsPerDomain: 64,
    }).cards;
  }, [domainDetail.data, metadata, selectedMetadataDomain]);

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
        if (!cancelled) {
          setSharingImpacts({});
          setSharingImpactLoading(false);
          setSharingImpactError(null);
        }
        return;
      }
      setSharingImpactLoading(true);
      setSharingImpactError(null);
      try {
        const scopes = Array.from(new Set(domainMemoryCards.map(cardScopePath)));
        const impacts = await Promise.all(
          scopes.map(async (scopePath) => [
            scopePath,
            await PersonalKnowledgeModelService.getMutationSharingImpact({
              userId: user.uid,
              domain: selectedMetadataDomain.key,
              scopePath,
              vaultOwnerToken,
            }),
          ] as const)
        );
        if (!cancelled) setSharingImpacts(Object.fromEntries(impacts));
      } catch {
        if (!cancelled) {
          setSharingImpacts({});
          setSharingImpactError("Current sharing couldn’t be verified. Refresh before changing details.");
        }
      } finally {
        if (!cancelled) setSharingImpactLoading(false);
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
          preview: buildPkmSectionPreviewPresentation({
            domain: selectedMetadataDomain.key,
            domainTitle: selectedMetadataDomain.displayName,
            permissionLabel: selectedMetadataDomain.displayName,
            permissionDescription: `Saved details in ${selectedMetadataDomain.displayName}.`,
            topLevelScopePath: "",
            value: domainData,
          }),
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

  function resetMemoryActionState() {
    setEditingCardId(null);
    setEditValue("");
    setMemoryActionId(null);
  }

  function rebuildDomainDetail(
    domainData: Record<string, unknown>,
    manifest = domainDetail.manifest
  ): DomainDetailState {
    if (!selectedMetadataDomain) return EMPTY_DOMAIN_DETAIL;
    return {
      manifest,
      data: domainData,
      preview: buildPkmSectionPreviewPresentation({
        domain: selectedMetadataDomain.key,
        domainTitle: selectedMetadataDomain.displayName,
        permissionLabel: selectedMetadataDomain.displayName,
        permissionDescription: `Saved details in ${selectedMetadataDomain.displayName}.`,
        topLevelScopePath: "",
        value: domainData,
      }),
      loading: false,
      error: false,
    };
  }

  async function persistMemoryCardChange(params: {
    card: PkmMemoryCard;
    action: "edited" | "deleted";
    nextValue?: string;
  }) {
    if (!user || !vaultKey || !vaultOwnerToken) return;
    const sharingImpact = sharingImpacts[cardScopePath(params.card)];
    if (!sharingImpact) {
      setMemoryActionError("Current sharing couldn’t be verified. Refresh and try again.");
      return;
    }
    setMemoryActionId(`${params.card.id}:${params.action}`);
    setMemoryActionError(null);
    setMemoryActionMessage(null);
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
      const nextDomainData =
        (result.fullBlob[params.card.domain] as Record<string, unknown> | undefined) ||
        persistedDomainData;
      setDomainDetail(rebuildDomainDetail(nextDomainData));
      clearAgentPkmContext(user.uid);
      setMetadata(
        await PersonalKnowledgeModelService.getMetadata(user.uid, true, vaultOwnerToken)
      );
      setMemoryActionMessage(
        params.action === "edited" ? "Saved detail corrected." : "Saved detail removed."
      );
      resetMemoryActionState();
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
      setCaptureMessage("That note couldn’t be prepared. Unlock again and retry.");
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
        error: "Memory couldn’t be saved. Unlock again and retry.",
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
      setCaptureMessage("Memory couldn’t be saved. Unlock again and retry.");
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
        success: params.enabled ? "These bundles can now be requested with your approval." : "These bundles are private.",
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

  function renderMemoryCard(card: PkmMemoryCard) {
    const editing = editingCardId === card.id;
    const saving = memoryActionId === `${card.id}:edited`;
    const deleting = memoryActionId === `${card.id}:deleted`;
    const sharingImpact = sharingImpacts[cardScopePath(card)];
    return (
      <div className="space-y-2 py-3 pl-6 first:pt-1 last:pb-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="break-words text-sm font-medium text-foreground">{card.title}</p>
            <p className="text-xs text-muted-foreground">{card.detail}</p>
            {sharingImpact?.activeRecipientCount ? (
              <p className="text-xs text-muted-foreground">{formatSharingImpactDisclosure(sharingImpact)}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-1">
            {editing ? (
              <>
                <Button type="button" variant="none" effect="fade" disabled={saving || !sharingImpact} aria-label="Save corrected detail" onClick={() => void persistMemoryCardChange({ card, action: "edited", nextValue: editValue })}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Check className="h-4 w-4" aria-hidden />}
                </Button>
                <Button type="button" variant="none" effect="fade" disabled={saving} aria-label="Cancel correction" onClick={resetMemoryActionState}>
                  <X className="h-4 w-4" aria-hidden />
                </Button>
              </>
            ) : (
              <>
                <Button type="button" variant="none" effect="fade" disabled={sharingImpactLoading || !sharingImpact} aria-label="Correct saved detail" onClick={() => { setEditingCardId(card.id); setEditValue(card.value); setMemoryActionError(null); setMemoryActionMessage(null); }}>
                  <Edit3 className="h-4 w-4" aria-hidden />
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button type="button" variant="none" effect="fade" disabled={deleting || sharingImpactLoading || !sharingImpact} aria-label="Remove saved detail">
                      {deleting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="h-4 w-4" aria-hidden />}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove this saved detail?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Other details in {card.domainTitle} will stay unchanged.
                        {sharingImpact?.activeRecipientCount ? ` ${formatSharingImpactDisclosure(sharingImpact)}` : ""}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction variant="destructive" onClick={() => void persistMemoryCardChange({ card, action: "deleted" })}>Remove</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            )}
          </div>
        </div>
        {editing ? <Input value={editValue} onChange={(event) => setEditValue(event.target.value)} aria-label="Corrected detail value" /> : null}
      </div>
    );
  }

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
          Unlock to open Memory
        </div>
        <p>Your saved details are decrypted only for this unlocked session.</p>
      </SurfaceInset></>
    );
  }

  if (selectedDomain && selectedMetadataDomain) {
    return (
      <>{nativeBeacon}<div className="space-y-4" data-pkm-detail-panel="true">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button
            type="button"
            variant="none"
            effect="fade"
            onClick={() => setSelectedDomainKey(null)}
          >
            <ChevronLeft className="mr-2 h-4 w-4" aria-hidden />
            All categories
          </Button>
          <Button
            type="button"
            variant="none"
            effect="fade"
            onClick={() => router.push(ROUTES.CONSENTS)}
          >
            Manage sharing
          </Button>
        </div>

        <SurfaceInset className="space-y-3 p-4">
          <div className="space-y-1">
            <p className="text-sm font-semibold tracking-tight text-foreground">
              {selectedDomain.title}
            </p>
            <p className="text-sm leading-6 text-muted-foreground">{selectedDomain.summary}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {selectedDomain.detailCount > 0 ? (
              <Badge variant="secondary">
                {selectedDomain.detailCount} saved item
                {selectedDomain.detailCount === 1 ? "" : "s"}
              </Badge>
            ) : null}
            {selectedDomain.sourceLabels.map((sourceLabel) => (
              <Badge key={sourceLabel} variant="secondary">
                {sourceLabel}
              </Badge>
            ))}
            <Badge variant="secondary">{selectedDomain.accessSummary}</Badge>
          </div>
        </SurfaceInset>

        {domainDetail.loading ? (
          <SurfaceInset className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Decrypting this category…
          </SurfaceInset>
        ) : domainDetail.error ? (
          <SurfaceInset className="space-y-1 p-4 text-sm text-muted-foreground">
            <p className="font-semibold text-foreground">This category couldn’t be opened</p>
            <p>Return to all categories and try again.</p>
          </SurfaceInset>
        ) : domainDetail.preview ? (
          <div className="space-y-4">
            <PkmSectionPreview presentation={domainDetail.preview} />

            {memoryActionMessage ? <p className="text-sm text-emerald-700 dark:text-emerald-300">{memoryActionMessage}</p> : null}
            {memoryActionError ? <p className="text-sm text-destructive">{memoryActionError}</p> : null}
            {sharingImpactError ? <p className="text-sm text-destructive">{sharingImpactError}</p> : null}
            {domainMemoryCards.length > 0 ? (
              <SurfaceInset className="p-4">
                <details className="group">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0 space-y-0.5">
                      <span className="block text-sm font-semibold text-foreground">Review individual fields</span>
                      <span className="block text-sm text-muted-foreground">
                        {domainMemoryCards.length} saved detail{domainMemoryCards.length === 1 ? "" : "s"}
                      </span>
                    </span>
                    <ChevronDown
                      className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
                      aria-hidden
                    />
                  </summary>
                  <div className="mt-3 border-t border-[color:var(--app-card-border-standard)] pt-2">
                    <p className="px-6 py-2 text-xs leading-5 text-muted-foreground">
                      Open a detail only when you need to correct or remove it.
                    </p>
                    <div className="divide-y divide-[color:var(--app-card-border-standard)]">
                      {domainMemoryCards.map((card) => <div key={card.id}>{renderMemoryCard(card)}</div>)}
                    </div>
                  </div>
                </details>
              </SurfaceInset>
            ) : null}
          </div>
        ) : null}
      </div></>
    );
  }

  return (
    <>
      {nativeBeacon}
      <div className="space-y-4">
        <SettingsSegmentedTabs
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
        >
          <div className="space-y-4 pb-1 pr-px">
        <SettingsGroup separatorInset testId="memory-auto-save-group">
          <SettingsRow
            testId="memory-auto-save-row"
            title="Save automatically"
            description={
              autoSavePolicyError ||
              "Private preferences only. Everything else asks first."
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
          <PkmDataManagerPanel
            signedIn
            loading={bootstrapLoading}
            metadataReady={metadata !== null}
            metadataError={bootstrapError ? "Saved details couldn’t be loaded. Try again." : null}
            sharingReady={sharingResolved}
            sharingError={sharingError}
            needsVaultCreation={false}
            needsUnlock={false}
            summary={summary}
            domains={domainPresentations}
            loadingManifestsByDomain={{}}
            manifestErrorsByDomain={{}}
            onOpenSharing={() => setWorkspaceTab("sharing")}
            onOpenImport={() => router.push(ROUTES.PROFILE_SECURITY_VAULT)}
            onRefresh={() => setRefreshNonce((value) => value + 1)}
            onOpenDomain={(domain) => setSelectedDomainKey(domain.key)}
          />
          </div>
          <div className="pb-1 pr-px">
          <SurfaceInset className="space-y-4 p-4" data-pkm-memory-capture="true">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">Add a detail</p>
              <p className="text-sm text-muted-foreground">Write it naturally. Review it before it is saved.</p>
            </div>
            <Textarea value={captureText} onChange={(event) => setCaptureText(event.target.value)} placeholder="I prefer morning flights whenever possible." aria-label="Memory note" maxLength={4000} />
            <Button className="w-full justify-center" type="button" variant="muted" effect="fade" disabled={captureLoading || !captureText.trim()} onClick={() => void previewMemoryCapture()}>
              {captureLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}Review note
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
            {captureCards.length > 0 ? <Button className="w-full justify-center" type="button" effect="fade" disabled={captureSaving} onClick={() => void saveMemoryCapture()}>{captureSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}Save reviewed detail</Button> : null}
          </SurfaceInset>
          </div>
          <div className="pb-1 pr-px">
          <SurfaceInset className="space-y-4 p-4" data-pkm-memory-sharing="true">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">Sharing preferences</p>
              <p className="text-sm text-muted-foreground">These are the existing top-level bundles that can be requested with your approval. Folders inside a bundle inherit this setting.</p>
            </div>
            {sharingManifestsLoading ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />Checking saved bundles…</p> : null}
            {!sharingManifestsLoading && visibleMetadataDomains.map((domain) => {
              const manifest = sharingManifests[domain.key] || null;
              const bundles = buildPkmShareBundles(manifest);
              if (!manifest || bundles.length === 0) return null;
              const state = pkmShareBundleState(bundles);
              const allHandles = bundles.map((bundle) => bundle.scopeHandle).filter((value): value is string => Boolean(value));
              const busy = sharingActionKey === `${domain.key}:${allHandles.join(",")}`;
              return (
                <div key={domain.key} className="space-y-2 rounded-xl border border-[color:var(--app-card-border-standard)] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div><p className="text-sm font-medium text-foreground">{domain.displayName}</p><p className="text-xs text-muted-foreground">{state === "indeterminate" ? "Some bundles can be requested" : state === "checked" ? "All available bundles can be requested" : "All available bundles are private"}</p></div>
                    <button type="button" role="checkbox" aria-checked={state === "indeterminate" ? "mixed" : state === "checked"} aria-label={`Set all ${domain.displayName} bundles ${state === "checked" ? "private" : "to ask first"}`} disabled={busy || allHandles.length === 0} onClick={() => void updateSharingBundles({ domain: domain.key, manifest, scopeHandles: allHandles, enabled: state !== "checked" })} className="flex h-8 w-8 items-center justify-center rounded-full border border-[color:var(--app-card-border-standard)] bg-muted text-foreground disabled:opacity-50">
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : state === "checked" ? <Check className="h-4 w-4" aria-hidden /> : state === "indeterminate" ? <Minus className="h-4 w-4" aria-hidden /> : null}
                    </button>
                  </div>
                  <div className="divide-y divide-[color:var(--app-card-border-standard)]">
                    {bundles.map((bundle) => {
                      const bundleKey = `${domain.key}:${bundle.scopeHandle || bundle.topLevelScopePath}`;
                      return <SettingsRow key={bundleKey} title={bundle.label} description="Ask first before sharing this bundle." trailing={<Switch checked={bundle.enabled} disabled={sharingActionKey === bundleKey || !bundle.scopeHandle} onCheckedChange={(enabled) => bundle.scopeHandle && void updateSharingBundles({ domain: domain.key, manifest, scopeHandles: [bundle.scopeHandle], enabled })} aria-label={`${bundle.enabled ? "Make private" : "Allow requests for"} ${bundle.label}`} />} />;
                    })}
                  </div>
                </div>
              );
            })}
            {!sharingManifestsLoading && visibleMetadataDomains.length > 0 && Object.values(sharingManifests).every((manifest) => buildPkmShareBundles(manifest).length === 0) ? <p className="text-sm text-muted-foreground">There are no saved bundles available for sharing yet.</p> : null}
          </SurfaceInset>
          </div>
        </SwipeViews>
      </div>
    </>
  );
}
