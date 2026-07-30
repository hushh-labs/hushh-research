"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, Edit3, Loader2, Lock, ShieldAlert, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { PkmDataManagerPanel } from "@/components/profile/pkm-data-manager";
import { PkmSectionPreview } from "@/components/profile/pkm-section-preview";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
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
import { Switch } from "@/components/ui/switch";
import { SurfaceInset } from "@/components/app-ui/surfaces";
import { NativeTestBeacon, type NativeTestDataState } from "@/components/app-ui/native-test-beacon";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/lib/morphy-ux/morphy";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import {
  buildPkmDomainPresentation,
  buildPkmProfileSummaryPresentation,
  isConsumerVisiblePkmDomain,
} from "@/lib/profile/pkm-profile-presentation";
import {
  buildPkmSectionPreviewPresentation,
  type PkmSectionPreviewPresentation,
} from "@/lib/profile/pkm-section-preview";
import { ROUTES } from "@/lib/navigation/routes";
import { clearAgentPkmContext } from "@/lib/agent/agent-pkm-memory";
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
  ConsentCenterService,
  type ConsentCenterEntry,
} from "@/lib/services/consent-center-service";
import {
  PersonalKnowledgeModelService,
  type PkmMutationSharingImpact,
  type PersonalKnowledgeModelMetadata,
} from "@/lib/services/personal-knowledge-model-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { useVault } from "@/lib/vault/vault-context";

type DomainDetailState = {
  manifest: DomainManifest | null;
  data: Record<string, unknown> | null;
  preview: PkmSectionPreviewPresentation | null;
  loading: boolean;
  error: boolean;
};

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

export function PkmNaturalPanel({
  refreshToken = 0,
}: {
  refreshToken?: number;
  onOpenExplorer?: () => void;
} = {}) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();

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
      const force = refreshNonce > 0 || refreshToken > 0;
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
  }, [authLoading, isVaultUnlocked, refreshNonce, refreshToken, user, vaultOwnerToken]);

  useEffect(() => {
    let cancelled = false;
    if (!user || !isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
      setAutoSavePolicy(DEFAULT_AGENT_PKM_AUTO_SAVE_POLICY);
      setAutoSavePolicyLoading(false);
      return undefined;
    }
    setAutoSavePolicyLoading(true);
    void loadAgentPkmAutoSavePolicy({
      userId: user.uid,
      vaultKey,
      vaultOwnerToken,
    })
      .then((policy) => {
        if (!cancelled) setAutoSavePolicy(policy);
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
    () => (metadata?.domains || []).filter(isConsumerVisiblePkmDomain),
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
  }, [isVaultUnlocked, selectedMetadataDomain, user, vaultKey, vaultOwnerToken]);

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
    try {
      const nextPolicy = await saveAgentPkmAutoSavePolicy({
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
      setAutoSavePolicy(nextPolicy);
    } catch (error) {
      setAutoSavePolicyError(
        error instanceof Error ? error.message : "Automatic memory saving couldn’t be updated."
      );
    } finally {
      setAutoSavePolicySaving(false);
    }
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
          Unlock your vault to open Memory
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

            {domainMemoryCards.length > 0 ? (
              <SurfaceInset className="space-y-3 p-4">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">Correct saved details</p>
                  <p className="text-sm text-muted-foreground">
                    Changes apply only to the selected detail in this encrypted category.
                  </p>
                </div>
                {memoryActionMessage ? (
                  <p className="text-sm text-emerald-700 dark:text-emerald-300">
                    {memoryActionMessage}
                  </p>
                ) : null}
                {memoryActionError ? (
                  <p className="text-sm text-destructive">{memoryActionError}</p>
                ) : null}
                {sharingImpactError ? (
                  <p className="text-sm text-destructive">{sharingImpactError}</p>
                ) : null}
                <div className="divide-y divide-[color:var(--app-card-border-standard)]">
                  {domainMemoryCards.map((card) => {
                    const editing = editingCardId === card.id;
                    const saving = memoryActionId === `${card.id}:edited`;
                    const deleting = memoryActionId === `${card.id}:deleted`;
                    const sharingImpact = sharingImpacts[cardScopePath(card)];
                    return (
                      <div key={card.id} className="space-y-3 py-3 first:pt-0 last:pb-0">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <p className="break-words text-sm font-medium text-foreground">
                              {card.title}
                            </p>
                            <p className="text-xs text-muted-foreground">{card.detail}</p>
                            {sharingImpact?.activeRecipientCount ? (
                              <p className="text-xs text-muted-foreground">
                                {sharingImpact.summary}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex shrink-0 gap-1">
                            {editing ? (
                              <>
                                <Button
                                  type="button"
                                  variant="none"
                                  effect="fade"
                                  disabled={saving || !sharingImpact}
                                  aria-label="Save corrected detail"
                                  onClick={() =>
                                    void persistMemoryCardChange({
                                      card,
                                      action: "edited",
                                      nextValue: editValue,
                                    })
                                  }
                                >
                                  {saving ? (
                                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                                  ) : (
                                    <Check className="h-4 w-4" aria-hidden />
                                  )}
                                </Button>
                                <Button
                                  type="button"
                                  variant="none"
                                  effect="fade"
                                  disabled={saving}
                                  aria-label="Cancel correction"
                                  onClick={resetMemoryActionState}
                                >
                                  <X className="h-4 w-4" aria-hidden />
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button
                                  type="button"
                                  variant="none"
                                  effect="fade"
                                  disabled={sharingImpactLoading || !sharingImpact}
                                  aria-label="Correct saved detail"
                                  onClick={() => {
                                    setEditingCardId(card.id);
                                    setEditValue(card.value);
                                    setMemoryActionError(null);
                                    setMemoryActionMessage(null);
                                  }}
                                >
                                  <Edit3 className="h-4 w-4" aria-hidden />
                                </Button>
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <Button
                                      type="button"
                                      variant="none"
                                      effect="fade"
                                      disabled={deleting || sharingImpactLoading || !sharingImpact}
                                      aria-label="Remove saved detail"
                                    >
                                      {deleting ? (
                                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                                      ) : (
                                        <Trash2 className="h-4 w-4" aria-hidden />
                                      )}
                                    </Button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent size="sm">
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Remove this saved detail?</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        Other details in {card.domainTitle} will stay unchanged.
                                        {sharingImpact ? ` ${sharingImpact.summary}` : ""}
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                                      <AlertDialogAction
                                        variant="destructive"
                                        onClick={() =>
                                          void persistMemoryCardChange({ card, action: "deleted" })
                                        }
                                      >
                                        Remove
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </>
                            )}
                          </div>
                        </div>
                        {editing ? (
                          <Input
                            value={editValue}
                            onChange={(event) => setEditValue(event.target.value)}
                            aria-label="Corrected detail value"
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
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
        <SettingsGroup separatorInset testId="memory-auto-save-group">
          <SettingsRow
            testId="memory-auto-save-row"
            title="Automatically save eligible memories"
            description={
              autoSavePolicyError ||
              "One saves medium- and high-confidence preferences in the background. Shared, corrective, and destructive changes still ask first."
            }
            tone={autoSavePolicyError ? "destructive" : "default"}
            trailing={
              <Switch
                checked={autoSavePolicy.enabled}
                onCheckedChange={(enabled) => void updateAutoSavePolicy(enabled)}
                disabled={autoSavePolicyLoading || autoSavePolicySaving}
                aria-label="Automatically save eligible memories"
                className="shrink-0"
              />
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
      onOpenSharing={() => router.push(ROUTES.CONSENTS)}
      onOpenImport={() => router.push(ROUTES.PROFILE_SECURITY_VAULT)}
      onRefresh={() => setRefreshNonce((value) => value + 1)}
      onOpenDomain={(domain) => setSelectedDomainKey(domain.key)}
        />
      </div>
    </>
  );
}
