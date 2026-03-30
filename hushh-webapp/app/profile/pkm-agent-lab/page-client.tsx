"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Code2,
  Loader2,
  Lock,
  ShieldAlert,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";

import { SurfaceInset } from "@/components/app-ui/surfaces";
import { PkmExplorerPanel } from "@/components/profile/pkm-explorer-panel";
import { PkmNaturalPanel } from "@/components/profile/pkm-natural-panel";
import { PkmSettingsShell } from "@/components/profile/pkm-settings-shell";
import { PkmUpgradeStatusCard } from "@/components/profile/pkm-upgrade-status-card";
import {
  SettingsDetailPanel,
  SettingsGroup,
  SettingsRow,
} from "@/components/profile/settings-ui";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { resolveAppEnvironment } from "@/lib/app-env";
import { ApiService } from "@/lib/services/api-service";
import { buildReadablePkmMetadata } from "@/lib/personal-knowledge-model/natural-language";
import type { DomainManifest } from "@/lib/personal-knowledge-model/manifest";
import {
  getDeveloperAccess,
  type DeveloperPortalAccess,
} from "@/lib/services/developer-portal-service";
import {
  PersonalKnowledgeModelService,
  type PersonalKnowledgeModelMetadata,
} from "@/lib/services/personal-knowledge-model-service";
import { PkmUpgradeOrchestrator } from "@/lib/services/pkm-upgrade-orchestrator";
import {
  PkmUpgradeService,
  type PkmUpgradeStatus,
} from "@/lib/services/pkm-upgrade-service";
import { PkmWriteCoordinator } from "@/lib/services/pkm-write-coordinator";
import { Button } from "@/lib/morphy-ux/morphy";
import { useVault } from "@/lib/vault/vault-context";

type AgentLabDomainChoice = {
  domain_key: string;
  display_name: string;
  description: string;
  recommended: boolean;
};

type AgentLabIntentFrame = {
  save_class?: string;
  intent_class?: string;
  mutation_intent?: string;
  requires_confirmation?: boolean;
  confirmation_reason?: string;
  candidate_domain_choices?: AgentLabDomainChoice[];
};

type AgentLabPreviewCard = {
  card_id: string;
  source_text: string;
  save_class?: string;
  intent_class?: string;
  mutation_intent?: string;
  merge_mode?: string;
  target_domain?: string;
  primary_json_path?: string | null;
  target_entity_scope?: string | null;
  target_entity_id?: string | null;
  write_mode?: string;
  requires_confirmation?: boolean;
  confirmation_reason?: string;
  candidate_domain_choices?: AgentLabDomainChoice[];
  validation_hints?: string[];
  intent_frame?: AgentLabIntentFrame;
  merge_decision?: Record<string, unknown>;
  candidate_payload?: Record<string, unknown>;
  structure_decision?: Record<string, unknown>;
  manifest_draft?: DomainManifest | null;
};

type AgentLabResponse = {
  agent_id: string;
  agent_name: string;
  model: string;
  used_fallback: boolean;
  routing_decision?: string;
  error?: string | null;
  intent_frame?: AgentLabIntentFrame;
  merge_decision?: Record<string, unknown>;
  candidate_payload: Record<string, unknown>;
  structure_decision: Record<string, unknown>;
  write_mode?: string;
  primary_json_path?: string | null;
  target_entity_scope?: string | null;
  validation_hints?: string[];
  manifest_draft?: DomainManifest | null;
  preview_cards?: AgentLabPreviewCard[];
  preview_summary?: Record<string, unknown>;
  performance?: Record<string, unknown>;
};

type PermissionSection = {
  scopeHandle: string;
  topLevelScopePath: string;
  label: string;
  description: string;
  exposureEnabled: boolean;
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizePath(path: string | null | undefined): string {
  return String(path || "")
    .split(".")
    .map((part) =>
      String(part)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/^_+|_+$/g, "")
    )
    .filter(Boolean)
    .join(".");
}

function titleize(value: string | null | undefined): string {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function getScopeSections(manifest: DomainManifest | null | undefined): PermissionSection[] {
  const registry = Array.isArray(manifest?.scope_registry) ? manifest.scope_registry : [];
  return registry
    .map((entry) => {
      let summaryProjection: Record<string, unknown> = {};
      if (entry.summary_projection && typeof entry.summary_projection === "object") {
        summaryProjection = entry.summary_projection as Record<string, unknown>;
      } else if (typeof entry.summary_projection === "string") {
        try {
          const parsed = JSON.parse(entry.summary_projection);
          summaryProjection =
            parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : {};
        } catch {
          summaryProjection = {};
        }
      }
      const topLevelScopePath = normalizePath(
        typeof summaryProjection.top_level_scope_path === "string"
          ? summaryProjection.top_level_scope_path
          : ""
      );
      if (!entry.scope_handle || !topLevelScopePath) {
        return null;
      }
      const summaryText =
        typeof summaryProjection.readable_summary === "string"
          ? summaryProjection.readable_summary.trim()
          : "";
      const readableEvent =
        typeof summaryProjection.readable_event_summary === "string"
          ? summaryProjection.readable_event_summary.trim()
          : "";
      return {
        scopeHandle: entry.scope_handle,
        topLevelScopePath,
        label: String(entry.scope_label || titleize(topLevelScopePath)),
        description:
          summaryText ||
          readableEvent ||
          `Controls whether Kai can expose ${titleize(topLevelScopePath)} through PKM permissions.`,
        exposureEnabled: entry.exposure_enabled !== false,
      };
    })
    .filter((entry): entry is PermissionSection => entry !== null)
    .sort((left, right) => left.label.localeCompare(right.label));
}

function buildPreviewCards(
  response: AgentLabResponse | null,
  message: string
): AgentLabPreviewCard[] {
  if (Array.isArray(response?.preview_cards) && response.preview_cards.length > 0) {
    return response.preview_cards;
  }
  if (!response) return [];
  return [
    {
      card_id: "preview_1",
      source_text: message,
      save_class: response.intent_frame?.save_class,
      intent_class: response.intent_frame?.intent_class,
      mutation_intent: response.intent_frame?.mutation_intent,
      merge_mode:
        typeof response.merge_decision?.merge_mode === "string"
          ? response.merge_decision.merge_mode
          : undefined,
      target_domain:
        typeof response.manifest_draft?.domain === "string"
          ? response.manifest_draft.domain
          : typeof response.structure_decision?.target_domain === "string"
            ? response.structure_decision.target_domain
            : undefined,
      primary_json_path: response.primary_json_path,
      target_entity_scope: response.target_entity_scope,
      target_entity_id:
        typeof response.merge_decision?.target_entity_id === "string"
          ? response.merge_decision.target_entity_id
          : undefined,
      write_mode: response.write_mode,
      requires_confirmation: response.intent_frame?.requires_confirmation,
      confirmation_reason: response.intent_frame?.confirmation_reason,
      candidate_domain_choices: response.intent_frame?.candidate_domain_choices,
      validation_hints: response.validation_hints,
      intent_frame: response.intent_frame,
      merge_decision: response.merge_decision,
      candidate_payload: response.candidate_payload,
      structure_decision: response.structure_decision,
      manifest_draft: response.manifest_draft,
    },
  ];
}

export default function PkmAgentLabPageClient() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const { isVaultUnlocked, vaultKey, vaultOwnerToken } = useVault();
  const environment = resolveAppEnvironment();
  const nonProdLabel = environment === "uat" ? "UAT" : "development";

  const [access, setAccess] = useState<DeveloperPortalAccess | null>(null);
  const [accessLoading, setAccessLoading] = useState(true);
  const [metadata, setMetadata] = useState<PersonalKnowledgeModelMetadata | null>(null);
  const [manifests, setManifests] = useState<Record<string, DomainManifest | null>>({});
  const [bootstrapLoading, setBootstrapLoading] = useState(false);
  const [upgradeStatus, setUpgradeStatus] = useState<PkmUpgradeStatus | null>(null);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const [naturalRefreshToken, setNaturalRefreshToken] = useState(0);
  const [showVaultUnlock, setShowVaultUnlock] = useState(false);
  const [message, setMessage] = useState(
    "Remember that I prefer short city breaks and weekly meal prep."
  );
  const [response, setResponse] = useState<AgentLabResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedDomainKey, setSelectedDomainKey] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const loadBootstrap = useCallback(
    async (force = false) => {
      if (loading) return;
      if (!user) {
        setAccess(null);
        setAccessLoading(false);
        setMetadata(null);
        setManifests({});
        return;
      }

      setAccessLoading(true);
      setBootstrapLoading(true);
      try {
        const idToken = await user.getIdToken();
        const nextAccess = await getDeveloperAccess(idToken, { userId: user.uid });
        let nextMetadata: PersonalKnowledgeModelMetadata | null = null;
        let nextManifests: Record<string, DomainManifest | null> = {};
        if (isVaultUnlocked && vaultOwnerToken) {
          nextMetadata = await PersonalKnowledgeModelService.getMetadata(
            user.uid,
            force,
            vaultOwnerToken
          ).catch(() => null);
          if (nextMetadata) {
            const manifestPairs = await Promise.all(
              nextMetadata.domains.map(async (domain) => [
                domain.key,
                await PersonalKnowledgeModelService.getDomainManifest(
                  user.uid,
                  domain.key,
                  vaultOwnerToken
                ).catch(() => null),
              ])
            );
            nextManifests = Object.fromEntries(manifestPairs);
          }
        }
        setAccess(nextAccess);
        setMetadata(nextMetadata);
        setManifests(nextManifests);
        setSelectedDomainKey((current) => {
          if (current && nextMetadata?.domains.some((domain) => domain.key === current)) {
            return current;
          }
          return nextMetadata?.domains[0]?.key || null;
        });
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Failed to load PKM Agent Lab."
        );
      } finally {
        setAccessLoading(false);
        setBootstrapLoading(false);
      }
    },
    [isVaultUnlocked, loading, user, vaultOwnerToken]
  );

  useEffect(() => {
    void loadBootstrap(naturalRefreshToken > 0);
  }, [loadBootstrap, naturalRefreshToken]);

  useEffect(() => {
    let cancelled = false;

    async function loadUpgradeStatus() {
      if (!user || !vaultOwnerToken) {
        if (!cancelled) {
          setUpgradeStatus(null);
          setUpgradeLoading(false);
        }
        return;
      }

      setUpgradeLoading(true);
      try {
        const nextStatus = await PkmUpgradeService.getStatus({
          userId: user.uid,
          vaultOwnerToken,
          force: naturalRefreshToken > 0,
        });
        if (!cancelled) {
          setUpgradeStatus(nextStatus);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(
            nextError instanceof Error
              ? nextError.message
              : "Failed to load PKM upgrade status."
          );
        }
      } finally {
        if (!cancelled) {
          setUpgradeLoading(false);
        }
      }
    }

    void loadUpgradeStatus();
    return () => {
      cancelled = true;
    };
  }, [naturalRefreshToken, user, vaultOwnerToken]);

  const previewCards = useMemo(
    () => buildPreviewCards(response, message),
    [message, response]
  );

  const domains = useMemo(() => metadata?.domains || [], [metadata?.domains]);
  const totalSections = useMemo(
    () =>
      Object.values(manifests).reduce(
        (sum, manifest) => sum + getScopeSections(manifest).length,
        0
      ),
    [manifests]
  );
  const enabledSections = useMemo(
    () =>
      Object.values(manifests).reduce(
        (sum, manifest) =>
          sum + getScopeSections(manifest).filter((section) => section.exposureEnabled).length,
        0
      ),
    [manifests]
  );
  const upgradableDomains = upgradeStatus?.upgradableDomains.filter((domain) => domain.needsUpgrade) || [];
  const selectedDomain = domains.find((domain) => domain.key === selectedDomainKey) || null;
  const selectedManifest = selectedDomainKey ? manifests[selectedDomainKey] || null : null;
  const selectedSections = useMemo(
    () => getScopeSections(selectedManifest),
    [selectedManifest]
  );
  const selectedDomainNeedsUpgrade = Boolean(
    selectedDomain && upgradableDomains.some((domain) => domain.domain === selectedDomain.key)
  );

  const openDomain = useCallback((domainKey: string) => {
    setSelectedDomainKey(domainKey);
    setDetailOpen(true);
  }, []);

  const handleResumeUpgrade = useCallback(async () => {
    if (!user) return;
    if (!isVaultUnlocked || !vaultKey || !vaultOwnerToken) {
      setShowVaultUnlock(true);
      return;
    }

    try {
      setUpgradeBusy(true);
      await PkmUpgradeOrchestrator.ensureRunning({
        userId: user.uid,
        vaultKey,
        vaultOwnerToken,
        initiatedBy: "pkm_lab",
      });
      setNaturalRefreshToken((value) => value + 1);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Failed to resume PKM upgrade."
      );
    } finally {
      setUpgradeBusy(false);
    }
  }, [isVaultUnlocked, user, vaultKey, vaultOwnerToken]);

  const handlePreview = useCallback(async () => {
    if (!user || !vaultOwnerToken) {
      setError("Unlock your vault before previewing PKM changes.");
      return;
    }

    setSubmitting(true);
    setError(null);
    setSaveMessage(null);
    try {
      const result = await ApiService.apiFetch("/api/pkm/agent-lab/structure", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${vaultOwnerToken}`,
        },
        body: JSON.stringify({
          user_id: user.uid,
          message,
          current_domains: domains.map((domain) => domain.key),
        }),
      });

      if (!result.ok) {
        const detail = await result.text();
        throw new Error(detail || `Agent lab request failed with ${result.status}`);
      }

      setResponse((await result.json()) as AgentLabResponse);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Failed to preview PKM capture."
      );
    } finally {
      setSubmitting(false);
    }
  }, [domains, message, user, vaultOwnerToken]);

  const persistPreview = useCallback(async () => {
    if (!user || !vaultKey || !vaultOwnerToken) {
      setError("Unlock your vault before saving to PKM.");
      return;
    }

    const saveableCards = previewCards.filter((card) => card.write_mode === "can_save");
    if (saveableCards.length === 0) {
      setError("This preview does not contain any saveable PKM changes.");
      return;
    }

    try {
      setSaving(true);
      setError(null);
      setSaveMessage(null);

      for (const card of saveableCards) {
        const candidatePayload =
          card.candidate_payload && typeof card.candidate_payload === "object"
            ? card.candidate_payload
            : null;
        const structureDecision = toRecord(card.structure_decision);
        const manifestDraft =
          card.manifest_draft && typeof card.manifest_draft === "object"
            ? card.manifest_draft
            : null;
        const targetDomain =
          (typeof manifestDraft?.domain === "string" && manifestDraft.domain) ||
          (typeof structureDecision.target_domain === "string" &&
            structureDecision.target_domain) ||
          "";
        if (!candidatePayload || !targetDomain) {
          throw new Error("One preview card did not produce a valid PKM payload.");
        }

        const summaryProjection =
          structureDecision.summary_projection &&
          typeof structureDecision.summary_projection === "object"
            ? (structureDecision.summary_projection as Record<string, unknown>)
            : {};
        const readableMetadata = buildReadablePkmMetadata({
          domainKey: targetDomain,
          domainDisplayName: titleize(targetDomain),
          sourceText: String(card.source_text || message),
          mergeMode:
            typeof card.merge_mode === "string"
              ? card.merge_mode
              : typeof card.merge_decision?.merge_mode === "string"
                ? String(card.merge_decision.merge_mode)
                : null,
          intentClass:
            typeof card.intent_class === "string"
              ? card.intent_class
              : typeof card.intent_frame?.intent_class === "string"
                ? card.intent_frame.intent_class
                : null,
          manifest: manifestDraft,
          structureDecision,
          primaryJsonPath:
            typeof card.primary_json_path === "string" ? card.primary_json_path : null,
          targetEntityScope:
            typeof card.target_entity_scope === "string" ? card.target_entity_scope : null,
        });
        const nextSummaryProjection = {
          ...summaryProjection,
          ...readableMetadata,
        };
        const nextStructureDecision = {
          ...structureDecision,
          summary_projection: nextSummaryProjection,
        };
        const nextManifest =
          manifestDraft && typeof manifestDraft === "object"
            ? ({
                ...manifestDraft,
                summary_projection: {
                  ...(manifestDraft.summary_projection || {}),
                  ...readableMetadata,
                },
              } as DomainManifest)
            : null;

        const result = await PkmWriteCoordinator.savePreparedDomain({
          userId: user.uid,
          domain: targetDomain,
          vaultKey,
          vaultOwnerToken,
          build: async () => ({
            domainData: candidatePayload,
            summary: {
              ...nextSummaryProjection,
              message_excerpt: String(card.source_text || message).slice(0, 160),
              source: "pkm_agent_lab",
              card_id: card.card_id,
            },
            mergeDecision: card.merge_decision,
            structureDecision: nextStructureDecision,
            manifest: nextManifest || undefined,
          }),
        });

        if (!result.success) {
          throw new Error(result.message || "Failed to save PKM preview.");
        }
      }

      await loadBootstrap(true);
      setNaturalRefreshToken((value) => value + 1);
      setSaveMessage(
        saveableCards.length === 1
          ? "Saved 1 PKM capture. The encrypted revision and permission metadata are now live."
          : `Saved ${saveableCards.length} PKM captures. The encrypted revisions and permission metadata are now live.`
      );
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "Failed to save PKM preview."
      );
    } finally {
      setSaving(false);
    }
  }, [loadBootstrap, message, previewCards, user, vaultKey, vaultOwnerToken]);

  const applyScopeExposureChange = useCallback(
    async (
      domainKey: string,
      changes: Array<{
        scopeHandle?: string;
        topLevelScopePath?: string;
        exposureEnabled: boolean;
      }>
    ) => {
      if (!user || !vaultOwnerToken) {
        setShowVaultUnlock(true);
        return;
      }
      const manifest = manifests[domainKey];
      if (!manifest) {
        setError("This PKM domain is not ready for permissions yet.");
        return;
      }

      try {
        setTogglingKey(
          `${domainKey}:${changes.map((change) => change.scopeHandle || change.topLevelScopePath).join(",")}`
        );
        setError(null);
        const result = await PersonalKnowledgeModelService.updateScopeExposure({
          userId: user.uid,
          domain: domainKey,
          expectedManifestVersion: manifest.manifest_version,
          revokeMatchingActiveGrants: true,
          changes: changes.map((change) => ({
            scopeHandle: change.scopeHandle,
            topLevelScopePath: change.topLevelScopePath,
            exposureEnabled: change.exposureEnabled,
          })),
          vaultOwnerToken,
        });
        setManifests((current) => ({
          ...current,
          [domainKey]: result.manifest,
        }));
        await loadBootstrap(true);
        setNaturalRefreshToken((value) => value + 1);
        setSaveMessage(
          result.revokedGrantCount > 0
            ? `Updated permissions and revoked ${result.revokedGrantCount} overlapping active grant${result.revokedGrantCount === 1 ? "" : "s"}.`
            : "Updated PKM permissions."
        );
      } catch (nextError) {
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Failed to update PKM permissions."
        );
      } finally {
        setTogglingKey(null);
      }
    },
    [loadBootstrap, manifests, user, vaultOwnerToken]
  );

  const developerReady = Boolean(access?.access_enabled);
  const canUseTooling = Boolean(user && developerReady && isVaultUnlocked && vaultOwnerToken);

  return (
    <>
      <PkmSettingsShell
        title="PKM Permissions Viewer"
        description="A calm, settings-style view of what Kai knows, which top-level PKM sections can be exposed, and the latest AI capture previews before they are encrypted and saved."
      >
        <SurfaceInset className="space-y-4 px-4 py-4">
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 dark:text-amber-100">
            <p className="font-medium">Development / UAT only</p>
            <p className="mt-1 text-amber-900/80 dark:text-amber-100/80">
              PKM Agent Lab is visible only in {nonProdLabel}. It remains blocked in production.
            </p>
          </div>

          <PkmUpgradeStatusCard
            status={upgradeStatus}
            loading={upgradeLoading}
            onResume={handleResumeUpgrade}
            resumeBusy={upgradeBusy}
            onUnlock={() => setShowVaultUnlock(true)}
            vaultUnlocked={isVaultUnlocked}
          />

          <SettingsGroup
            eyebrow="Summary"
            title="What Kai knows right now"
            description="This viewer keeps the default language simple: domains first, then the top-level sections inside each domain, with raw structure details pushed into Advanced."
          >
            <SettingsRow
              title="Domains captured"
              description="Each domain is encrypted in PKM and becomes readable only after vault unlock."
              trailing={<Badge variant="secondary">{domains.length}</Badge>}
            />
            <SettingsRow
              title="Permission-ready sections"
              description="Top-level PKM sections that can be exposed or hidden through consent scopes."
              trailing={<Badge variant="secondary">{enabledSections} / {totalSections}</Badge>}
            />
            <SettingsRow
              title="Upgrade status"
              description="Older manifests are shown read-only until the resumable PKM upgrade brings them onto the current permissions contract."
              trailing={
                <Badge variant={upgradableDomains.length > 0 ? "outline" : "secondary"}>
                  {upgradableDomains.length > 0 ? `${upgradableDomains.length} pending` : "Current"}
                </Badge>
              }
            />
          </SettingsGroup>

          <SettingsGroup
            eyebrow="Permissions"
            title="Domain controls"
            description="Open any domain to toggle the top-level sections Kai may expose through PKM permissions. Turning a section off also revokes overlapping active grants."
          >
            {accessLoading || bootstrapLoading ? (
              <SettingsRow
                title="Loading private model"
                description="Checking developer access, PKM metadata, and current manifests."
                leading={<Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
              />
            ) : !user ? (
              <SettingsRow
                title="Sign in required"
                description="This route inspects your live PKM, so it only becomes available after sign in."
                leading={<ShieldAlert className="h-4 w-4 text-amber-500" />}
              />
            ) : !developerReady ? (
              <SettingsRow
                title="Developer access required"
                description="PKM Agent Lab stays non-production and developer-gated during this phase."
                leading={<Code2 className="h-4 w-4 text-amber-500" />}
                trailing={
                  <Button variant="none" effect="fade" onClick={() => router.push("/developers")}>
                    Open Developers
                  </Button>
                }
              />
            ) : !isVaultUnlocked ? (
              <SettingsRow
                title="Unlock your vault"
                description="Permissions only become readable after local unlock because decrypted PKM stays memory-only."
                leading={<Lock className="h-4 w-4 text-amber-500" />}
                trailing={
                  <Button variant="none" effect="fade" onClick={() => setShowVaultUnlock(true)}>
                    Unlock
                  </Button>
                }
              />
            ) : domains.length === 0 ? (
              <SettingsRow
                title="No PKM domains yet"
                description="Save your first capture below and the permission viewer will populate automatically."
              />
            ) : (
              domains.map((domain) => {
                const manifest = manifests[domain.key] || null;
                const sections = getScopeSections(manifest);
                const enabledCount = sections.filter((section) => section.exposureEnabled).length;
                const allEnabled = sections.length > 0 && enabledCount === sections.length;
                const upgradeBlocked = upgradableDomains.some(
                  (entry) => entry.domain === domain.key
                );
                return (
                  <SettingsRow
                    key={domain.key}
                    title={domain.displayName}
                    description={
                      domain.readableSummary ||
                      `${domain.attributeCount} saved signals. ${sections.length || 0} permission-ready sections.`
                    }
                    onClick={() => openDomain(domain.key)}
                    chevron
                    trailing={
                      <div
                        className="flex items-center gap-2"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Badge variant="outline" className="rounded-full">
                          {sections.length === 0 ? "Read only" : `${enabledCount}/${sections.length}`}
                        </Badge>
                        <Switch
                          checked={sections.length > 0 ? allEnabled : false}
                          disabled={
                            sections.length === 0 ||
                            upgradeBlocked ||
                            togglingKey !== null ||
                            !vaultOwnerToken
                          }
                          onCheckedChange={(checked) =>
                            void applyScopeExposureChange(
                              domain.key,
                              sections.map((section) => ({
                                scopeHandle: section.scopeHandle,
                                topLevelScopePath: section.topLevelScopePath,
                                exposureEnabled: checked,
                              }))
                            )
                          }
                          aria-label={`Toggle all ${domain.displayName} permissions`}
                        />
                      </div>
                    }
                  />
                );
              })
            )}
          </SettingsGroup>

          <SettingsGroup
            eyebrow="Recent Captures"
            title="Latest AI capture preview"
            description="Each preview stays plain-language first: what Kai heard, where it plans to save it, and whether the capture is ready to persist."
          >
            {previewCards.length === 0 ? (
              <SettingsRow
                title="No pending preview"
                description="Describe one new preference or memory below. Kai will draft the PKM capture before anything is encrypted or saved."
                leading={<Sparkles className="h-4 w-4 text-sky-500" />}
              />
            ) : (
              previewCards.map((card) => (
                <SettingsRow
                  key={card.card_id}
                  title={`${titleize(card.target_domain || "general")} capture`}
                  description={`${String(card.source_text || "").slice(0, 180)}${String(card.source_text || "").length > 180 ? "..." : ""}`}
                  trailing={
                    <Badge variant="secondary">
                      {card.write_mode === "can_save"
                        ? "Ready"
                        : card.write_mode === "confirm_first"
                          ? "Review"
                          : "Blocked"}
                    </Badge>
                  }
                />
              ))
            )}
          </SettingsGroup>

          <SettingsGroup
            eyebrow="Advanced"
            title="Capture tool and technical details"
            description="The capture composer, raw response envelope, readable PKM view, and explorer stay here so the default page can remain simple."
          >
            <div className="px-3 py-3 sm:px-4 sm:py-4">
              <Accordion type="multiple" className="w-full">
                <AccordionItem value="capture">
                  <AccordionTrigger>Capture composer</AccordionTrigger>
                  <AccordionContent className="space-y-4">
                    <Textarea
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      rows={5}
                      placeholder="Tell Kai one new memory, preference, or intent."
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="none"
                        effect="fade"
                        disabled={!canUseTooling || submitting}
                        onClick={() => void handlePreview()}
                      >
                        {submitting ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Sparkles className="mr-2 h-4 w-4" />
                        )}
                        Generate preview
                      </Button>
                      <Button
                        variant="none"
                        effect="fade"
                        disabled={!canUseTooling || saving || previewCards.every((card) => card.write_mode !== "can_save")}
                        onClick={() => void persistPreview()}
                      >
                        {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                        Save encrypted capture
                      </Button>
                    </div>
                    <SettingsGroup embedded title="Save protocol" description="PKM writes now use a version-aware save path that upgrades stale manifests first, retries bounded conflicts, and keeps encrypted history plus read-model projections in sync.">
                      <SettingsRow
                        title="Decision history retention"
                        description="Kai keeps the newest 3 saved debate versions per ticker and emits a full replacement decision projection on every history mutation."
                      />
                    </SettingsGroup>
                    {response ? (
                      <SettingsGroup embedded title="Raw response" description="Technical payload for debugging; not the primary UX.">
                        <div className="px-3 py-3 sm:px-4 sm:py-4">
                          <pre className="max-h-[420px] overflow-auto rounded-2xl border bg-muted/35 p-3 text-xs leading-5">
                            {JSON.stringify(response, null, 2)}
                          </pre>
                        </div>
                      </SettingsGroup>
                    ) : null}
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="natural">
                  <AccordionTrigger>Readable PKM view</AccordionTrigger>
                  <AccordionContent>
                    <PkmNaturalPanel
                      refreshToken={naturalRefreshToken}
                      onOpenExplorer={() => undefined}
                    />
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem value="explorer">
                  <AccordionTrigger>Explorer</AccordionTrigger>
                  <AccordionContent>
                    <PkmExplorerPanel />
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          </SettingsGroup>

          {saveMessage ? (
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-100">
              {saveMessage}
            </div>
          ) : null}
          {error ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </SurfaceInset>
      </PkmSettingsShell>

      <SettingsDetailPanel
        open={detailOpen}
        onOpenChange={setDetailOpen}
        title={selectedDomain?.displayName || "PKM domain"}
        description="Permissions are controlled at the top-level section layer. Disabling a section also revokes overlapping active grants."
      >
        {!selectedDomain ? (
          <SettingsGroup embedded>
            <SettingsRow
              title="Nothing selected yet"
              description="Choose a PKM domain from the main list to inspect its sections."
            />
          </SettingsGroup>
        ) : (
          <div className="space-y-4">
            <SettingsGroup
              embedded
              eyebrow="Domain"
              title={selectedDomain.displayName}
              description={selectedDomain.readableSummary || "No readable summary yet."}
            >
              <SettingsRow
                title="Last updated"
                description={formatTimestamp(selectedDomain.lastUpdated)}
              />
              <SettingsRow
                title="Manifest revision"
                description={selectedManifest ? `v${selectedManifest.manifest_version}` : "Unavailable"}
              />
              <SettingsRow
                title="Retention note"
                description="Kai keeps the newest 3 debate-history versions per ticker in encrypted financial PKM."
              />
            </SettingsGroup>

            {selectedDomainNeedsUpgrade ? (
              <SettingsGroup
                embedded
                eyebrow="Upgrade required"
                title="This domain is read-only until the PKM upgrade completes"
                description="The current manifest is not on the latest permissions contract yet, so section toggles stay disabled until the resumable upgrade finishes."
              >
                <SettingsRow
                  title="Resume upgrade"
                  description="Unlock and resume the PKM upgrade to enable section-level toggles."
                  trailing={
                    <Button variant="none" effect="fade" onClick={() => void handleResumeUpgrade()}>
                      Resume
                    </Button>
                  }
                />
              </SettingsGroup>
            ) : null}

            <SettingsGroup
              embedded
              eyebrow="Sections"
              title="Permission controls"
              description="Apple-style simple: one master switch for the whole domain, then one switch per top-level section."
            >
              <SettingsRow
                title="Allow this entire domain"
                description="Turning this off disables every section below and revokes overlapping active grants."
                trailing={
                  <Switch
                    checked={
                      selectedSections.length > 0 &&
                      selectedSections.every((section) => section.exposureEnabled)
                    }
                    disabled={
                      selectedSections.length === 0 ||
                      selectedDomainNeedsUpgrade ||
                      togglingKey !== null
                    }
                    onCheckedChange={(checked) =>
                      void applyScopeExposureChange(
                        selectedDomain.key,
                        selectedSections.map((section) => ({
                          scopeHandle: section.scopeHandle,
                          topLevelScopePath: section.topLevelScopePath,
                          exposureEnabled: checked,
                        }))
                      )
                    }
                  />
                }
              />
              {selectedSections.length === 0 ? (
                <SettingsRow
                  title="No permission-ready sections yet"
                  description="This domain has not been upgraded into the simplified permissions model."
                />
              ) : (
                selectedSections.map((section) => (
                  <SettingsRow
                    key={section.scopeHandle}
                    title={section.label}
                    description={section.description}
                    trailing={
                      <Switch
                        checked={section.exposureEnabled}
                        disabled={selectedDomainNeedsUpgrade || togglingKey !== null}
                        onCheckedChange={(checked) =>
                          void applyScopeExposureChange(selectedDomain.key, [
                            {
                              scopeHandle: section.scopeHandle,
                              topLevelScopePath: section.topLevelScopePath,
                              exposureEnabled: checked,
                            },
                          ])
                        }
                      />
                    }
                  />
                ))
              )}
            </SettingsGroup>

            <SettingsGroup
              embedded
              eyebrow="Advanced"
              title="Technical diagnostics"
              description="Manifest paths and raw explorer details stay secondary, but they remain available for debugging."
            >
              <SettingsRow
                title="Open explorer"
                description="Use the advanced explorer accordion on the main page to inspect raw manifests, ciphertext shape, and decrypted domain data."
                leading={<SlidersHorizontal className="h-4 w-4 text-muted-foreground" />}
              />
            </SettingsGroup>
          </div>
        )}
      </SettingsDetailPanel>

      {user ? (
        <VaultUnlockDialog
          user={user}
          open={showVaultUnlock}
          onOpenChange={setShowVaultUnlock}
          onSuccess={() => {
            setShowVaultUnlock(false);
            setNaturalRefreshToken((value) => value + 1);
          }}
          title="Unlock your vault"
          description="Unlock locally to read or save encrypted PKM data."
          enableGeneratedDefault
        />
      ) : null}
    </>
  );
}
