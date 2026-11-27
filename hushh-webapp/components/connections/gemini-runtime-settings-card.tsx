"use client";

import { RadioGroup as RadioPrimitive } from "radix-ui";
import { useCallback, useEffect, useLayoutEffect, useMemo } from "react";
import { useOwnerPresentationState } from "@/hooks/use-owner-presentation-state";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { usePathname, useRouter } from "next/navigation";

import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { CloudAiChoice } from "./cloud-ai-choice";
import { GeminiKeyChoice, type CredentialValidationState } from "./gemini-key-choice";
import { GeminiLogo } from "@/components/brand/gemini-logo";
import { RuntimeProviderMark } from "@/components/brand/runtime-provider-mark";
import {
  CaretDownIcon,
  SpinnerGapIcon as Loader2,
  TrashIcon as Trash2,
} from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { HelperText } from "@/components/app-ui/typography";
import { cn } from "@/lib/utils";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { BringYourOwnAiProviders } from "@/components/connections/byo-ai-providers";
import { RUNTIME_PROVIDER_CATALOG } from "@/lib/connections/runtime-provider-catalog";
import { notifyGeminiRuntimeConfigurationChanged } from "@/lib/connections/gemini-runtime-configuration";
import { ApiService } from "@/lib/services/api-service";
import {
  activateAgentAiSelection,
  aiSelectionRefusalMessage,
  clearAgentAiSelectionFor,
  clearAgentAiSelectionProvider,
  deactivateAgentAiSelection,
  readAgentAiSelection,
  sendAiSelectionToAgent,
  shareGeminiSelectionWithAgent,
  verifyAgentCloudAi,
} from "@/lib/one/ai-selection-agent";
import { isPooledSandboxSwitchAvailable } from "@/lib/one/owner-cloud";
import { useAiPlacement } from "@/lib/connections/use-ai-placement";
import {
  activateSavedAiConfiguration,
  deactivateCustomAiSelection,
  defaultAiConfigurationLabel,
  deleteSavedAiConfiguration,
  loadSavedAiConfigurations,
  saveAiConfiguration,
  type SavedAiConfiguration,
  type SupportedByokProvider,
} from "@/lib/one/ai-selection-vault";
import {
  GEMINI_RUNTIME_CREDENTIAL_REF,
  GEMINI_RUNTIME_TRANSPORT_REF,
  GEMINI_VERTEX_LOCATION_REF,
  GEMINI_VERTEX_PROJECT_REF,
  PersonalKnowledgeModelService,
  RUNTIME_CREDENTIAL_MODE_REF,
  type GeminiRuntimeTransport,
  type RuntimeCredentialMode,
} from "@/lib/services/personal-knowledge-model-service";
import type { OneRuntimeSetupChoice } from "@/lib/services/pre-vault-user-state-service";
import {
  PreVaultSensitiveDraftService,
  type PreVaultAiDraftState,
} from "@/lib/services/pre-vault-sensitive-draft-service";
import detailStyles from "@/components/profile/profile-preference-details.module.css";

const OPENAI_MARK = RUNTIME_PROVIDER_CATALOG.find(
  (entry) => entry.id === "openai",
)!;

export type GeminiRuntimeSettingsCardProps = {
  userId?: string | null;
  vaultKey?: string | null;
  vaultOwnerToken?: string | null;
  /** Live token getter; expiry can precede the next React render. */
  getCurrentVaultOwnerToken?: () => string | null;
  needsVaultCreation: boolean;
  needsUnlock: boolean;
  onRequestVaultUnlock: () => void;
  onRequestVaultCreation: () => void;
  requiresExplicitSelection?: boolean;
  initiallyConfigured?: boolean;
  initialSetupChoice?: OneRuntimeSetupChoice | null;
  onCanContinueChange?: (ready: boolean) => void;
  onSelectionReadyChange?: (
    choice: OneRuntimeSetupChoice,
  ) => void | Promise<void>;
  /** Keeps a sensitive onboarding credential process-memory-only until Finish setup. */
  onPreVaultDraftStaged?: (draft: {
    transport: GeminiRuntimeTransport;
    credential: string;
    vertexProject: string | null;
    vertexLocation: string | null;
  }) => void;
  onPreVaultDraftCleared?: () => void;
  onPreVaultAiConfigsChange?: (state: PreVaultAiDraftState) => void;
};

const CREDENTIAL_VALIDATION_TTL_MS = 60_000;
const EMPTY_PENDING_AI_PROVIDERS: Record<string, boolean> = Object.freeze({});
const EMPTY_SAVED_CONFIGS: SavedAiConfiguration[] = [];
const IDLE_VALIDATION: CredentialValidationState = { status: "idle" };

type OpenAiNotice = { tone: "error" | "status"; text: string } | null;

class RuntimeSettingsVisit {
  live = false; read = 0; draftEdited = false; validationGeneration = 0;
  readonly credential = { current: 0 };
  readonly selection = { current: 0 };
  readonly pending = { current: false };
  readonly validating = { current: false };
  credentialCurrent() { return this.current() && snapshotValidatedAuthSessionOwner()?.generation === this.authGeneration; }
  savedConfiguration: { transport: GeminiRuntimeTransport; project: string; location: string } = { transport: "developer_api", project: "", location: "global" };
  constructor(readonly owner: string | null | undefined, readonly enabled: boolean, readonly epoch: number, readonly authGeneration: number | undefined, ..._credentials: unknown[]) {}
  start() { this.live = this.enabled; }
  retire() { this.live = false; this.read += 1; }
  current() { return this.live && !!this.owner && this.epoch === snapshotVaultSessionEpoch() && snapshotValidatedAuthSessionOwner()?.userId === this.owner; }
}

function assertRuntimeSecretStored(result: { success: boolean; conflict?: boolean }) {
  if (!result.success) {
    throw new Error(result.conflict ? "PKM_CONFLICT" : "PKM_WRITE_FAILED");
  }
}

function toPlaintextSelection(config: SavedAiConfiguration) {
  return {
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    transport: config.provider === "gemini" ? (config.transport ?? "developer_api") : null,
    vertexProject:
      config.provider === "gemini" && config.transport === "vertex_api_key"
        ? config.vertexProject
        : null,
    vertexLocation:
      config.provider === "gemini" && config.transport === "vertex_api_key"
        ? config.vertexLocation
        : null,
  } as const;
}

function readStagedAiDrafts(userId: string | null | undefined): PreVaultAiDraftState | null {
  if (!userId) return null;
  if (typeof PreVaultSensitiveDraftService?.getStagedAiConfigurations !== "function") {
    return null;
  }
  return PreVaultSensitiveDraftService.getStagedAiConfigurations(userId);
}

export function useGeminiRuntimeSettingsModel({
  userId,
  vaultKey,
  vaultOwnerToken,
  getCurrentVaultOwnerToken,
  needsVaultCreation,
  needsUnlock,
  onRequestVaultUnlock,
  onRequestVaultCreation,
  requiresExplicitSelection = false,
  initiallyConfigured = true,
  initialSetupChoice = null,
  onSelectionReadyChange,
  onCanContinueChange,
  onPreVaultDraftStaged,
  onPreVaultDraftCleared,
  onPreVaultAiConfigsChange,
  enabled = true,
}: GeminiRuntimeSettingsCardProps & { enabled?: boolean }) {
  const epoch = snapshotVaultSessionEpoch();
  const authGeneration = snapshotValidatedAuthSessionOwner()?.generation;
  const visit = useMemo(() => new RuntimeSettingsVisit(userId, enabled, epoch, authGeneration, vaultKey, vaultOwnerToken), [userId, vaultKey, vaultOwnerToken, enabled, epoch, authGeneration]);
  useLayoutEffect(() => { visit.start(); return () => visit.retire(); }, [visit]);
  const current = useCallback(() => visit.current(), [visit]);
  const captureOwnerGuard = useCallback(() => {
    const owner = snapshotValidatedAuthSessionOwner();
    return () => current() && !!owner && owner.userId === userId && isValidatedAuthSessionOwnerCurrent(owner);
  }, [current, userId]);
  const router = useRouter();
  const pathname = usePathname();
  const [cloudAiVerified, setCloudAiVerified] = useOwnerPresentationState(visit, false);
  const [cloudAiModel, setCloudAiModel] = useOwnerPresentationState<string | null>(visit, null);
  const { placement, refreshPlacement } = useAiPlacement(captureOwnerGuard, setCloudAiVerified);
  const privateCloud = placement === "gcp" || placement === "azure";
  const defaultLabel = privateCloud ? "Use existing cloud" : "";
  const selectionRevisionRef = visit.selection;
  const selectionPendingRef = visit.pending;
  const validationPendingRef = visit.validating;
  useEffect(() => {
    if (!privateCloud) return;
    let alive = true;
    const ownerIsCurrent = captureOwnerGuard();
    const selectionRevision = selectionRevisionRef.current;
    const currentRead = () => alive && ownerIsCurrent()
      && selectionRevisionRef.current === selectionRevision
      && !selectionPendingRef.current && !validationPendingRef.current;
    if (currentRead()) setCloudAiModel(null);
    void readAgentAiSelection(currentRead).then((selection) => {
      if (!currentRead()) return;
      const effective = selection?.effectiveConnection;
      if (effective?.source !== "cloud_default" || effective.state !== "configured") {
        setCloudAiModel(null); setCloudAiVerified(false); return;
      }
      setCloudAiModel(effective.model);
      setCloudAiVerified(effective.verification === "previously_verified");
    }).catch(() => {
      if (currentRead()) { setCloudAiModel(null); setCloudAiVerified(false); }
    });
    return () => { alive = false; };
  }, [privateCloud, placement, captureOwnerGuard, setCloudAiModel, setCloudAiVerified, selectionRevisionRef, selectionPendingRef, validationPendingRef]);
  const [showAiAlternatives, setShowAiAlternatives] = useOwnerPresentationState(visit, false);
  const [pendingAiProviders, setPendingAiProviders] = useOwnerPresentationState<Record<string, boolean>>(visit, EMPTY_PENDING_AI_PROVIDERS);
  const externalAiPending = Object.values(pendingAiProviders).some(Boolean);
  const onProviderPendingChange = useCallback((pending: boolean, provider: string) => {
    if (current()) setPendingAiProviders(value => value[provider] === pending ? value : ({ ...value, [provider]: pending }));
  }, [current, setPendingAiProviders]);
  const [hasSavedProviderKey, setHasSavedProviderKey] = useOwnerPresentationState(visit, false);
  const [otherProvider, setOtherProvider] = useOwnerPresentationState<string | null>(visit, null);
  const [agentOutcome, setAgentOutcome] = useOwnerPresentationState(visit, "");
  const [cloudAiFailure, setCloudAiFailure] = useOwnerPresentationState<string | null>(visit, null);

  const [savedConfigurations, setSavedConfigurations] =
    useOwnerPresentationState<SavedAiConfiguration[]>(visit, EMPTY_SAVED_CONFIGS);
  const [activeConfigId, setActiveConfigId] =
    useOwnerPresentationState<string | null>(visit, null);
  const [addingProvider, setAddingProvider] =
    useOwnerPresentationState<SupportedByokProvider | null>(visit, null);
  const [draftLabel, setDraftLabel] = useOwnerPresentationState(visit, "");
  const [openaiDraftKey, setOpenaiDraftKey] = useOwnerPresentationState(visit, "");
  const [openaiNotice, setOpenaiNotice] = useOwnerPresentationState<OpenAiNotice>(visit, null);
  const [openaiChecking, setOpenaiChecking] = useOwnerPresentationState(visit, false);

  const [mode, setMode] = useOwnerPresentationState<RuntimeCredentialMode>(visit, "hushh_managed_vertex");
  const [hasSavedKey, setHasSavedKey] = useOwnerPresentationState<boolean | null>(visit, null);
  const [draftKey, setDraftKey] = useOwnerPresentationState(visit, "");
  const [transport, setTransport] = useOwnerPresentationState<GeminiRuntimeTransport>(visit, "developer_api");
  const [vertexProject, setVertexProject] = useOwnerPresentationState(visit, "");
  const [vertexLocation, setVertexLocation] = useOwnerPresentationState(visit, "global");
  const [isSaving, setIsSaving] = useOwnerPresentationState(visit, false);
  const [isRemoving, setIsRemoving] = useOwnerPresentationState(visit, false);
  const [credentialValidation, setCredentialValidation] =
    useOwnerPresentationState<CredentialValidationState>(visit, IDLE_VALIDATION);
  const credentialRevisionRef = visit.credential;
  const [loadFailed, setLoadFailed] = useOwnerPresentationState(visit, false);
  const initialCanContinue =
    !requiresExplicitSelection ||
    initiallyConfigured ||
    (!privateCloud && initialSetupChoice !== "byok_pending_vault");
  const [hasExplicitSelection, setHasExplicitSelection] = useOwnerPresentationState(visit, initialCanContinue);
  const [selectedOption, setSelectedOption] = useOwnerPresentationState<string>(
    visit,
    initiallyConfigured ? (initialSetupChoice === "byok_pending_vault" ? "byok" : "hushh_managed_vertex") : "",
  );
  const vaultReady = Boolean(userId && vaultKey && vaultOwnerToken);
  const activeConfig = useMemo(
    () => (activeConfigId ? savedConfigurations.find((entry) => entry.id === activeConfigId) ?? null : null),
    [activeConfigId, savedConfigurations],
  );
  const savedByokReady =
    requiresExplicitSelection &&
    initialSetupChoice === "byok_pending_vault" &&
    mode === "byok" &&
    (Boolean(activeConfig) || (otherProvider ? hasSavedProviderKey : hasSavedKey === true));
  const builtInSandboxReady =
    requiresExplicitSelection &&
    !privateCloud &&
    placement !== "loading" &&
    placement !== "pending" &&
    placement !== "unknown" &&
    initialSetupChoice !== "byok_pending_vault" &&
    addingProvider === null;
  const configuredChoiceReady = initiallyConfigured || savedByokReady || builtInSandboxReady;

  const syncPreVaultDraft = useCallback(
    (nextConfigs: SavedAiConfiguration[], nextActiveId: string | null) => {
      if (!requiresExplicitSelection || !userId) return;
      const state: PreVaultAiDraftState = {
        configurations: nextConfigs,
        activeConfigId: nextActiveId,
      };
      if (typeof PreVaultSensitiveDraftService?.stageAiConfigurations === "function") {
        PreVaultSensitiveDraftService.stageAiConfigurations(userId, state);
      }
      onPreVaultAiConfigsChange?.(state);
      const active = nextActiveId ? nextConfigs.find((entry) => entry.id === nextActiveId) ?? null : null;
      if (active?.provider === "gemini") {
        onPreVaultDraftStaged?.({
          transport: active.transport === "vertex_api_key" ? "vertex_api_key" : "developer_api",
          credential: active.apiKey,
          vertexProject: active.vertexProject,
          vertexLocation: active.vertexLocation,
        });
      } else if (!nextActiveId) {
        onPreVaultDraftCleared?.();
      }
    },
    [onPreVaultAiConfigsChange, onPreVaultDraftCleared, onPreVaultDraftStaged, requiresExplicitSelection, userId],
  );

  const invalidateCredentialValidation = useCallback(() => {
    if (!current()) return;
    credentialRevisionRef.current += 1;
    visit.validationGeneration += 1; visit.validating.current = false;
    setCredentialValidation(IDLE_VALIDATION);
    if (requiresExplicitSelection && addingProvider === "gemini") setHasExplicitSelection(false);
  }, [addingProvider, current, visit, credentialRevisionRef, setCredentialValidation, setHasExplicitSelection, requiresExplicitSelection]);

  useEffect(() => {
    if (current()) {
      const editingDraft = requiresExplicitSelection && addingProvider !== null;
      onCanContinueChange?.(hasExplicitSelection && !editingDraft && !isSaving && !isRemoving && !openaiChecking);
    }
  }, [addingProvider, current, hasExplicitSelection, isSaving, isRemoving, openaiChecking, onCanContinueChange, requiresExplicitSelection]);

  useEffect(() => {
    if (addingProvider !== null && requiresExplicitSelection) {
      setHasExplicitSelection(false);
      return;
    }
    setHasExplicitSelection(
      !requiresExplicitSelection || configuredChoiceReady,
    );
  }, [addingProvider, configuredChoiceReady, requiresExplicitSelection, setHasExplicitSelection]);

  useEffect(() => {
    if (!requiresExplicitSelection) return;
    setSelectedOption(configuredChoiceReady ? (initialSetupChoice === "byok_pending_vault" ? "byok" : "hushh_managed_vertex") : "");
    setMode(
      initialSetupChoice === "byok_pending_vault"
        ? "byok"
        : "hushh_managed_vertex",
    );
  }, [initialSetupChoice, configuredChoiceReady, requiresExplicitSelection, setSelectedOption, setMode]);

  const refresh = useCallback(async () => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return;
    const request = ++visit.read;
    setLoadFailed(false);
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      const staged = requiresExplicitSelection ? readStagedAiDrafts(userId) : null;
      if (staged) {
        setSavedConfigurations(staged.configurations);
        setActiveConfigId(staged.activeConfigId);
        const active = staged.activeConfigId
          ? staged.configurations.find((entry) => entry.id === staged.activeConfigId) ?? null
          : null;
        setMode(active ? "byok" : "hushh_managed_vertex");
        setSelectedOption(active ? "byok" : "hushh_managed_vertex");
        setOtherProvider(active?.provider === "openai" ? "openai" : null);
        setHasSavedKey(staged.configurations.some((entry) => entry.provider === "gemini"));
        setHasSavedProviderKey(staged.configurations.some((entry) => entry.provider === "openai"));
      } else {
        if (!requiresExplicitSelection) setMode("hushh_managed_vertex");
        setSavedConfigurations(EMPTY_SAVED_CONFIGS);
        setActiveConfigId(null);
        setHasSavedKey(null);
      }
      return;
    }
    const selectionRevision = selectionRevisionRef.current;
    const credentialRevision = credentialRevisionRef.current;
    try {
      const loaded = await loadSavedAiConfigurations({ userId, vaultKey, vaultOwnerToken });
      if (!ownerIsCurrent() || visit.read !== request || selectionRevisionRef.current !== selectionRevision ||
          credentialRevisionRef.current !== credentialRevision || selectionPendingRef.current || validationPendingRef.current) return;
      const active = loaded.activeConfigId
        ? loaded.configurations.find((entry) => entry.id === loaded.activeConfigId) ?? null
        : null;
      const geminiConfig =
        (active?.provider === "gemini" ? active : null) ??
        loaded.configurations.find((entry) => entry.provider === "gemini") ??
        null;
      const hasGemini = loaded.configurations.some((entry) => entry.provider === "gemini");
      const hasOpenAi = loaded.configurations.some((entry) => entry.provider === "openai");
      setSavedConfigurations(loaded.configurations);
      setActiveConfigId(loaded.activeConfigId);
      setMode(loaded.mode);
      setHasSavedProviderKey(hasOpenAi);
      setOtherProvider(loaded.mode === "byok" && active?.provider === "openai" ? "openai" : null);
      if (requiresExplicitSelection) {
        setSelectedOption(loaded.mode === "byok" && active ? "byok" : !privateCloud ? "hushh_managed_vertex" : "");
        if (loaded.mode === "byok" && !active) setHasExplicitSelection(false);
      }
      setHasSavedKey(hasGemini);
      visit.savedConfiguration = {
        transport: geminiConfig?.transport === "vertex_api_key" ? "vertex_api_key" : "developer_api",
        project: geminiConfig?.vertexProject || "",
        location: geminiConfig?.vertexLocation || "global",
      };
      if (!visit.draftEdited) {
        credentialRevisionRef.current += 1;
        setCredentialValidation(IDLE_VALIDATION);
        setTransport(visit.savedConfiguration.transport);
        setVertexProject(visit.savedConfiguration.project);
        setVertexLocation(visit.savedConfiguration.location);
      }
    } catch {
      if (!ownerIsCurrent() || visit.read !== request || selectionRevisionRef.current !== selectionRevision ||
          credentialRevisionRef.current !== credentialRevision || selectionPendingRef.current || validationPendingRef.current) return;
      setLoadFailed(true);
      if (requiresExplicitSelection) {
        setHasExplicitSelection(false);
        if (initialSetupChoice === "byok_pending_vault") {
          setAddingProvider("gemini");
          setMode("byok");
          setSelectedOption("byok");
        }
      } else {
        setMode("hushh_managed_vertex");
      }
      setHasSavedKey(null);
      setHasSavedProviderKey(false);
      if (!visit.draftEdited) { setTransport("developer_api"); setVertexProject(""); setVertexLocation("global"); }
    }
  }, [
    captureOwnerGuard,
    initialSetupChoice,
    privateCloud,
    setActiveConfigId,
    setAddingProvider,
    setHasSavedProviderKey,
    setOtherProvider,
    setSavedConfigurations,
    visit,
    credentialRevisionRef,
    selectionRevisionRef,
    selectionPendingRef,
    validationPendingRef,
    setCredentialValidation,
    setLoadFailed,
    setMode,
    setHasSavedKey,
    setTransport,
    setVertexProject,
    setVertexLocation,
    setSelectedOption,
    setHasExplicitSelection,
    userId,
    vaultKey,
    vaultOwnerToken,
    vaultReady,
    requiresExplicitSelection,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const requestVault = () => {
    if (!current()) return;
    if (needsVaultCreation) onRequestVaultCreation();
    else onRequestVaultUnlock();
  };

  const persistMode = async (nextMode: RuntimeCredentialMode) => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent() || !vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      throw new Error("VAULT_NOT_READY");
    }
    const result = await PersonalKnowledgeModelService.storeRuntimeSecret({
      userId,
      vaultKey,
      vaultOwnerToken,
      credentialRef: RUNTIME_CREDENTIAL_MODE_REF,
      secret: nextMode,
      confirmation: {
        confirmedByUser: true,
        surface: "web",
        source: "profile_gemini_runtime_mode",
      },
    });
    if (!ownerIsCurrent()) throw new Error("RUNTIME_VISIT_RETIRED");
    assertRuntimeSecretStored(result);
  };

  const deactivateCustomAi = async (): Promise<boolean> => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return false;
    if (selectionPendingRef.current || validationPendingRef.current || externalAiPending || openaiChecking) {
      return false;
    }
    const authorityIsCurrent = () => requiresExplicitSelection || !getCurrentVaultOwnerToken ||
      Boolean(vaultOwnerToken && getCurrentVaultOwnerToken() === vaultOwnerToken);
    const selectionIsCurrent = () => ownerIsCurrent() && authorityIsCurrent();
    if (!requiresExplicitSelection && (!vaultReady || !authorityIsCurrent())) {
      if (needsVaultCreation || needsUnlock) requestVault();
      else toast.error("Your vault is reconnecting. Try again.");
      return false;
    }
    if (!requiresExplicitSelection && (hasSavedKey === null || loadFailed)) return false;

    selectionPendingRef.current = true;
    selectionRevisionRef.current += 1;
    setIsSaving(true);
    try {
      const shouldClearPod = Boolean(activeConfigId || mode === "byok");
      if (shouldClearPod) {
        const cleared = await deactivateAgentAiSelection(selectionIsCurrent);
        if (!selectionIsCurrent()) return false;
        if (cleared === "failed" && !(requiresExplicitSelection && !privateCloud && !vaultReady)) {
          toast.error("Agent One could not be reached. Try again.");
          return false;
        }
      }
      if (typeof ApiService.selectManagedGeminiRuntime === "function") {
        try {
          const managed = await ApiService.selectManagedGeminiRuntime(selectionIsCurrent);
          if (!selectionIsCurrent()) return false;
          if (!managed) throw new Error("MANAGED_RUNTIME_NOT_READY");
        } catch (error) {
          if (!selectionIsCurrent()) return false;
          if (!(requiresExplicitSelection && !vaultReady && isPooledSandboxSwitchAvailable())) {
            throw error;
          }
        }
      }
      if (vaultReady && userId && vaultKey && vaultOwnerToken) {
        await deactivateCustomAiSelection({ userId, vaultKey, vaultOwnerToken }, selectionIsCurrent);
        if (!selectionIsCurrent()) return false;
      } else if (requiresExplicitSelection) {
        syncPreVaultDraft(savedConfigurations, null);
        await onSelectionReadyChange?.("hushh_managed_vertex");
        if (!selectionIsCurrent()) return false;
      }
      setActiveConfigId(null);
      setMode("hushh_managed_vertex");
      setSelectedOption("hushh_managed_vertex");
      setOtherProvider(null);
      setAddingProvider(null);
      setHasExplicitSelection(true);
      notifyGeminiRuntimeConfigurationChanged();
      toast.success("Using built-in sandbox AI. Your saved keys are kept.");
      return true;
    } catch (error) {
      if (!selectionIsCurrent()) return false;
      toast.error(
        error instanceof Error && error.message === "MANAGED_RUNTIME_NOT_READY"
          ? "The hushh runtime isn’t responding right now. Try again in a moment."
          : "Could not switch back to built-in sandbox AI. Try again.",
      );
      return false;
    } finally {
      selectionPendingRef.current = false;
      setIsSaving(false);
    }
  };

  const selectManaged = async (): Promise<boolean> => {
    if (!privateCloud) {
      return deactivateCustomAi();
    }
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return false;
    if (selectionPendingRef.current || validationPendingRef.current || externalAiPending || openaiChecking) return false;
    const authorityIsCurrent = () => requiresExplicitSelection || !getCurrentVaultOwnerToken ||
      Boolean(vaultOwnerToken && getCurrentVaultOwnerToken() === vaultOwnerToken);
    const selectionIsCurrent = () => ownerIsCurrent() && authorityIsCurrent();
    if (!requiresExplicitSelection && (!vaultReady || !authorityIsCurrent())) {
      if (needsVaultCreation || needsUnlock) requestVault();
      else toast.error("Your vault is reconnecting. Try again.");
      return false;
    }
    if (!requiresExplicitSelection && (hasSavedKey === null || loadFailed)) return false;
    setAgentOutcome("");
    selectionPendingRef.current = true;
    selectionRevisionRef.current += 1;
    const previousMode = mode;
    const previousSelection = hasExplicitSelection;
    const previousOption = selectedOption;
    setSelectedOption("hushh_managed_vertex");
    setIsSaving(true);
    if (requiresExplicitSelection) setHasExplicitSelection(false);
    try {
      const outcome = await verifyAgentCloudAi(selectionIsCurrent);
      if (!selectionIsCurrent()) return false;
      if (!outcome.ok) {
        setCloudAiFailure(outcome.code);
        throw new Error(outcome.code);
      }
      setCloudAiFailure(null);
      setCloudAiModel(outcome.model);
      setCloudAiVerified(true);
      setShowAiAlternatives(false);
      setAddingProvider(null);
      if (requiresExplicitSelection) {
        await onSelectionReadyChange?.("hushh_managed_vertex");
        if (!selectionIsCurrent()) return false;
        syncPreVaultDraft(savedConfigurations, null);
      } else if (vaultReady && userId && vaultKey && vaultOwnerToken) {
        await deactivateCustomAiSelection({ userId, vaultKey, vaultOwnerToken }, selectionIsCurrent);
      } else {
        await persistMode("hushh_managed_vertex");
      }
      if (!selectionIsCurrent()) return false;
      setActiveConfigId(null);
      setMode("hushh_managed_vertex");
      setOtherProvider(null);
      setHasExplicitSelection(true);
      notifyGeminiRuntimeConfigurationChanged();
      setAgentOutcome("Agent One is already set up.");
      toast.success("Using your cloud’s AI.");
      return true;
    } catch (error) {
      if (!selectionIsCurrent()) return false;
      setMode(previousMode);
      setHasExplicitSelection(previousSelection);
      setSelectedOption(previousOption);
      if (error instanceof Error && error.message === "CLOUD_PROJECT_GONE") {
        toast.error(
          "We can’t find your cloud project. Reconnect your cloud to continue.",
        );
        router.push(ROUTES.ONE_SETUP_CLOUD);
        return false;
      }
      if (error instanceof Error && error.message === "CLOUD_GRANT_REVOKED") {
        toast.error("Re-authorize Hushh’s access to your project to continue.");
        router.push(ROUTES.ONE_SETUP_CLOUD);
        return false;
      }
      const cloudRefusal = error instanceof Error
        ? aiSelectionRefusalMessage(error.message, placement === "azure" ? "Azure AI" : "Vertex AI")
        : null;
      toast.error(
        error instanceof Error && ["QUOTA_EXCEEDED", "MODEL_UNAVAILABLE", "KEY_REFUSED", "AI_DEFAULT_UNAVAILABLE"].includes(error.message)
          ? "Your cloud AI is unavailable. Check model access or connect your own key below."
          : cloudRefusal
          ? cloudRefusal
          : error instanceof Error && error.message === "AGENT_UNREACHABLE"
          ? "Agent One could not be reached. Try again."
          : error instanceof Error && error.message === "PKM_CONFLICT"
            ? "This setting changed on another device. Refresh and try again."
            : requiresExplicitSelection
              ? "We couldn’t save this setup choice. Try again."
              : "Open your private vault again, then try this setting.",
      );
      return false;
    } finally {
      selectionPendingRef.current = false;
      setIsSaving(false);
    }
  };

  const startAddingProvider = (
    provider: SupportedByokProvider,
    options: { toggle?: boolean } = {},
  ) => {
    if (!privateCloud && placement !== "shared") return;
    if (!current() || selectionPendingRef.current || validationPendingRef.current || openaiChecking) return;
    if (!requiresExplicitSelection && vaultReady && (hasSavedKey === null || loadFailed)) return;
    if (!requiresExplicitSelection && !vaultReady) {
      requestVault();
      return;
    }
    selectionRevisionRef.current += 1;
    setAddingProvider((prev) =>
      options.toggle !== false && prev === provider ? null : provider,
    );
    if (!requiresExplicitSelection && provider === "gemini") {
      setMode("byok");
    }
    if (requiresExplicitSelection) {
      setSelectedOption("byok");
      setMode("byok");
    }
    setDraftLabel("");
    setOpenaiNotice(null);
    if (provider === "gemini") {
      setDraftKey("");
      invalidateCredentialValidation();
    } else {
      setOpenaiDraftKey("");
    }
  };

  const cancelAddingProvider = () => {
    if (!current()) return;
    setAddingProvider(null);
    setMode(activeConfigId ? "byok" : "hushh_managed_vertex");
    setSelectedOption(activeConfigId ? "byok" : (!privateCloud ? "hushh_managed_vertex" : ""));
    setDraftLabel("");
    setDraftKey("");
    setOpenaiDraftKey("");
    setOpenaiNotice(null);
    invalidateCredentialValidation();
  };

  const selectByok = async () => {
    startAddingProvider("gemini");
  };

  const activateConfiguration = async (configId: string): Promise<boolean> => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent() || selectionPendingRef.current || validationPendingRef.current || openaiChecking) {
      return false;
    }
    const target = savedConfigurations.find((entry) => entry.id === configId);
    if (!target) return false;
    const authorityIsCurrent = () => requiresExplicitSelection || !getCurrentVaultOwnerToken ||
      Boolean(vaultOwnerToken && getCurrentVaultOwnerToken() === vaultOwnerToken);
    const selectionIsCurrent = () => ownerIsCurrent() && authorityIsCurrent();

    selectionPendingRef.current = true;
    selectionRevisionRef.current += 1;
    setIsSaving(true);
    try {
      const plaintext = toPlaintextSelection(target);
      const providerName = target.provider === "openai" ? "OpenAI" : "Gemini";
      const sameProviderCount = savedConfigurations.filter(
        (entry) => entry.provider === target.provider,
      ).length;
      const syncPodSelection = () =>
        sameProviderCount > 1
          ? sendAiSelectionToAgent(plaintext, selectionIsCurrent)
          : activateAgentAiSelection({ configId, selection: plaintext }, selectionIsCurrent);

      if (privateCloud) {
        const outcome = await syncPodSelection();
        if (!selectionIsCurrent()) return false;
        if (!outcome.ok) {
          toast.error(
            aiSelectionRefusalMessage(outcome.code, providerName) ??
              `Agent One could not activate ${target.label}.`,
          );
          return false;
        }
        setCloudAiVerified(false);
      } else {
        if (target.provider === "gemini") {
          await ApiService.validateGeminiRuntimeCredential({
            credential: target.apiKey,
            transport: target.transport === "vertex_api_key" ? "vertex_api_key" : "developer_api",
            vertexProject: target.transport === "vertex_api_key" ? target.vertexProject : null,
            vertexLocation: target.transport === "vertex_api_key" ? target.vertexLocation : null,
          });
        }
        const status = await ApiService.getPersonalAgentStatus().catch(() => null);
        if (!selectionIsCurrent()) return false;
        const isAce = status?.hostingMode === "hussh_pods" && status.deploymentTarget === "ace";
        if (isAce && status.state === "active") {
          const outcome = await syncPodSelection();
          if (!selectionIsCurrent()) return false;
          if (!outcome.ok) {
            if (outcome.code !== "AGENT_UNREACHABLE" && outcome.code !== "PROVIDER_UNSUPPORTED") {
              toast.error(
                aiSelectionRefusalMessage(outcome.code, providerName) ??
                  `Agent One could not activate ${target.label}.`,
              );
              return false;
            }
            if (target.provider === "openai") {
              await ApiService.validateOpenAiRuntimeCredential({ credential: target.apiKey });
            }
          }
        } else if (target.provider === "openai") {
          await ApiService.validateOpenAiRuntimeCredential({ credential: target.apiKey });
        }
      }

      if (vaultReady && userId && vaultKey && vaultOwnerToken) {
        await activateSavedAiConfiguration({ userId, vaultKey, vaultOwnerToken }, configId, selectionIsCurrent);
        if (!selectionIsCurrent()) return false;
      } else if (requiresExplicitSelection) {
        syncPreVaultDraft(savedConfigurations, configId);
        await onSelectionReadyChange?.("byok_pending_vault");
        if (!selectionIsCurrent()) return false;
      } else {
        requestVault();
        return false;
      }

      setActiveConfigId(configId);
      setMode("byok");
      setSelectedOption("byok");
      setOtherProvider(target.provider === "openai" ? "openai" : null);
      setAddingProvider(null);
      setHasExplicitSelection(true);
      notifyGeminiRuntimeConfigurationChanged();
      toast.success(`Using ${target.label}.`);
      return true;
    } catch (error) {
      if (!selectionIsCurrent()) return false;
      toast.error(error instanceof Error && error.message ? error.message : `Could not switch to ${target.label}.`);
      return false;
    } finally {
      selectionPendingRef.current = false;
      setIsSaving(false);
    }
  };

  const deleteConfiguration = async (configId: string): Promise<boolean> => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent() || selectionPendingRef.current || validationPendingRef.current || openaiChecking) {
      return false;
    }
    const target = savedConfigurations.find((entry) => entry.id === configId);
    if (!target) return false;
    const authorityIsCurrent = () => requiresExplicitSelection || !getCurrentVaultOwnerToken ||
      Boolean(vaultOwnerToken && getCurrentVaultOwnerToken() === vaultOwnerToken);
    const mutationIsCurrent = () => ownerIsCurrent() && authorityIsCurrent();
    if (!requiresExplicitSelection && (!vaultReady || !userId || !vaultKey || !vaultOwnerToken || !authorityIsCurrent())) {
      if (needsVaultCreation || needsUnlock) requestVault();
      else toast.error("Your vault is reconnecting. Try again.");
      return false;
    }

    selectionPendingRef.current = true;
    selectionRevisionRef.current += 1;
    setIsRemoving(true);
    try {
      const isTargetActive = activeConfigId === configId;
      if (isTargetActive) {
        const cleared = await clearAgentAiSelectionProvider(target.provider, mutationIsCurrent).catch(() => "failed" as const);
        if (!mutationIsCurrent()) return false;
        if (cleared === "failed") {
          const legacyCleared = await clearAgentAiSelectionFor(target.provider, false, mutationIsCurrent);
          if (!mutationIsCurrent()) return false;
          if (legacyCleared === "failed" && !(requiresExplicitSelection && !privateCloud && !vaultReady)) {
            toast.error("Agent One could not be reached. Try again.");
            return false;
          }
        }
      } else if (activeConfig?.provider !== target.provider) {
        // Clear any saved pod slot for a non-active provider so a deleted key cannot be reactivated later.
        await clearAgentAiSelectionProvider(target.provider, mutationIsCurrent, {
          clearInactiveSlot: true,
        }).catch(() => "not_needed" as const);
        if (!mutationIsCurrent()) return false;
      }

      let nextConfigs: SavedAiConfiguration[];
      if (vaultReady && userId && vaultKey && vaultOwnerToken) {
        const res = await deleteSavedAiConfiguration({ userId, vaultKey, vaultOwnerToken }, configId, mutationIsCurrent);
        if (!mutationIsCurrent()) return false;
        nextConfigs = res.configurations;
      } else {
        nextConfigs = savedConfigurations.filter((entry) => entry.id !== configId);
        syncPreVaultDraft(nextConfigs, isTargetActive ? null : activeConfigId);
      }

      setSavedConfigurations(nextConfigs);
      setHasSavedKey(nextConfigs.some((entry) => entry.provider === "gemini"));
      setHasSavedProviderKey(nextConfigs.some((entry) => entry.provider === "openai"));
      if (isTargetActive) {
        setActiveConfigId(null);
        setMode("hushh_managed_vertex");
        setSelectedOption("hushh_managed_vertex");
        setOtherProvider(null);
        if (requiresExplicitSelection && !privateCloud) {
          await onSelectionReadyChange?.("hushh_managed_vertex");
          setHasExplicitSelection(true);
        }
      }
      notifyGeminiRuntimeConfigurationChanged();
      toast.success(`${target.label} removed.`);
      return true;
    } catch {
      if (!mutationIsCurrent()) return false;
      toast.error(`${target.label} could not be removed.`);
      return false;
    } finally {
      selectionPendingRef.current = false;
      setIsRemoving(false);
    }
  };

  const validateByok = async (): Promise<boolean> => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!visit.credentialCurrent() || !ownerIsCurrent() || selectionPendingRef.current || validationPendingRef.current) return false;
    if (!privateCloud && placement !== "shared") {
      setCredentialValidation({ status: "error", message: "Confirm your hosting before choosing AI." });
      return false;
    }
    if (privateCloud) return saveByok();
    const credential = draftKey.trim();
    if (!credential) {
      setCredentialValidation({ status: "error", message: "Enter your Gemini API key." });
      return false;
    }
    if (transport === "vertex_api_key" && (!vertexProject.trim() || !vertexLocation.trim())) {
      setCredentialValidation({ status: "error", message: "Enter the Google Cloud project ID and Vertex location." });
      return false;
    }
    if (!requiresExplicitSelection && (!vaultReady || !userId || !vaultKey || !vaultOwnerToken)) {
      requestVault();
      return false;
    }
    const revision = credentialRevisionRef.current;
    const validationRun = ++visit.validationGeneration;
    selectionRevisionRef.current += 1;
    validationPendingRef.current = true;
    setCredentialValidation({ status: "checking" });
    try {
      await ApiService.validateGeminiRuntimeCredential({
        credential,
        transport,
        vertexProject: transport === "vertex_api_key" ? vertexProject.trim() : null,
        vertexLocation: transport === "vertex_api_key" ? vertexLocation.trim() : null,
      });
      if (!ownerIsCurrent() || credentialRevisionRef.current !== revision) return false;
      setCredentialValidation({ status: "ready", revision, validatedAt: Date.now() });
      return true;
    } catch (error) {
      if (!ownerIsCurrent() || credentialRevisionRef.current !== revision) return false;
      const message =
        error instanceof Error
          ? error.message
          : "Gemini could not be reached to validate this key.";
      setCredentialValidation({ status: "error", message });
      return false;
    } finally {
      if (visit.validationGeneration === validationRun) validationPendingRef.current = false;
    }
  };

  const saveByok = async (): Promise<boolean> => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!visit.credentialCurrent() || !ownerIsCurrent() || selectionPendingRef.current || validationPendingRef.current) return false;
    if (!privateCloud && placement !== "shared") return false;
    const credential = draftKey.trim();
    if (!credential || (transport === "vertex_api_key" && (!vertexProject.trim() || !vertexLocation.trim()))) {
      setCredentialValidation({ status: "error", message: "Enter a Gemini key and any required Vertex project and location." });
      return false;
    }
    if (privateCloud && !vaultReady) { requestVault(); return false; }
    const validationIsFresh =
      credentialValidation.status === "ready" &&
      credentialValidation.revision === credentialRevisionRef.current &&
      Date.now() - credentialValidation.validatedAt <= CREDENTIAL_VALIDATION_TTL_MS;
    if (!privateCloud && !validationIsFresh) {
      setCredentialValidation({ status: "error", message: "Validate this Gemini key before confirming it." });
      return false;
    }
    const label = draftLabel.trim() || defaultAiConfigurationLabel("gemini", transport);

    if (requiresExplicitSelection && !vaultReady && userId) {
      if (!onPreVaultDraftStaged && !onPreVaultAiConfigsChange && typeof PreVaultSensitiveDraftService?.stageAiConfigurations !== "function") {
        toast.error("Gemini access could not be staged. Try again.");
        return false;
      }
      setIsSaving(true);
      selectionPendingRef.current = true;
      selectionRevisionRef.current += 1;
      try {
        const now = Date.now();
        const newConfig: SavedAiConfiguration = {
          id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `cfg_${now}`,
          provider: "gemini",
          label,
          apiKey: credential,
          model: null,
          transport,
          vertexProject: transport === "vertex_api_key" ? vertexProject.trim() || null : null,
          vertexLocation: transport === "vertex_api_key" ? vertexLocation.trim() || null : null,
          createdAtMs: now,
          updatedAtMs: now,
        };
        const nextConfigs = [...savedConfigurations, newConfig].slice(-10);
        syncPreVaultDraft(nextConfigs, newConfig.id);
        await onSelectionReadyChange?.("byok_pending_vault");
        if (!ownerIsCurrent()) return false;
        setSavedConfigurations(nextConfigs);
        setActiveConfigId(newConfig.id);
        setHasSavedKey(true);
        setDraftKey("");
        setDraftLabel("");
        setAddingProvider(null);
        invalidateCredentialValidation();
        setMode("byok");
        setSelectedOption("byok");
        setOtherProvider(null);
        setHasExplicitSelection(true);
        toast.success("Gemini access is ready to protect when you finish setup.");
        return true;
      } catch {
        if (!ownerIsCurrent()) return false;
        onPreVaultDraftCleared?.();
        toast.error("Gemini access could not be staged. Try again.");
        return false;
      } finally {
        selectionPendingRef.current = false;
        setIsSaving(false);
      }
    }
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      requestVault();
      return false;
    }
    setIsSaving(true);
    selectionPendingRef.current = true;
    selectionRevisionRef.current += 1;
    let agentAccepted = false;
    try {
      if (privateCloud) {
        const outcome = await sendAiSelectionToAgent({
          provider: "gemini",
          model: null,
          apiKey: credential,
          transport,
          vertexProject: transport === "vertex_api_key" ? vertexProject.trim() : null,
          vertexLocation: transport === "vertex_api_key" ? vertexLocation.trim() : null,
        });
        if (!ownerIsCurrent()) return false;
        if (!outcome.ok) {
          setCredentialValidation({ status: "error", message: aiSelectionRefusalMessage(outcome.code, "Gemini") ?? "Agent One could not check this connection." });
          return false;
        }
        agentAccepted = true;
        setCloudAiVerified(false);
      }
      const savedResult = await saveAiConfiguration(
        { userId, vaultKey, vaultOwnerToken },
        {
          provider: "gemini",
          label,
          apiKey: credential,
          model: null,
          transport,
          vertexProject: transport === "vertex_api_key" ? vertexProject.trim() : null,
          vertexLocation: transport === "vertex_api_key" ? vertexLocation.trim() : null,
        },
        { activate: true, isCurrent: ownerIsCurrent },
      );
      if (!ownerIsCurrent()) return false;
      const agentRefusal = privateCloud
        ? null
        : await shareGeminiSelectionWithAgent({
            userId,
            vaultKey,
            vaultOwnerToken,
            credential,
            transport,
            vertexProject: vertexProject.trim() || null,
            vertexLocation: vertexLocation.trim() || null,
          });
      if (!ownerIsCurrent()) return false;
      if (agentRefusal) {
        toast.error(`${agentRefusal} Your Gemini configuration is saved in your encrypted vault.`);
      } else {
        setOtherProvider(null);
      }
      setSavedConfigurations(savedResult.configurations);
      setActiveConfigId(savedResult.saved.id);
      setDraftKey("");
      setDraftLabel("");
      setAddingProvider(null);
      invalidateCredentialValidation();
      setMode("byok");
      setSelectedOption("byok");
      setHasSavedKey(true);
      if (requiresExplicitSelection) {
        await onSelectionReadyChange?.("byok_pending_vault");
        if (!ownerIsCurrent()) return false;
      }
      setHasExplicitSelection(true);
      visit.draftEdited = false;
      visit.savedConfiguration = {
        transport,
        project: transport === "vertex_api_key" ? vertexProject.trim() : "",
        location: transport === "vertex_api_key" ? vertexLocation.trim() : "global",
      };
      notifyGeminiRuntimeConfigurationChanged();
      if (!agentRefusal) {
        toast.success("Your Gemini configuration is saved in your encrypted vault.");
      }
      return true;
    } catch {
      if (!ownerIsCurrent()) return false;
      toast.error(agentAccepted ? "Your agent accepted the key, but its vault backup could not be saved. Retry saving." : "Gemini key could not be saved.");
      return false;
    } finally {
      selectionPendingRef.current = false;
      setIsSaving(false);
    }
  };

  const saveOpenAiConfiguration = async (): Promise<boolean> => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!visit.credentialCurrent() || !ownerIsCurrent() || selectionPendingRef.current || validationPendingRef.current || openaiChecking) {
      return false;
    }
    if (!privateCloud && placement !== "shared") {
      setOpenaiNotice({ tone: "error", text: "Confirm your hosting before choosing AI." });
      return false;
    }
    const apiKey = openaiDraftKey.trim();
    if (!apiKey) {
      setOpenaiNotice({ tone: "error", text: "Enter your OpenAI API key." });
      return false;
    }
    if (!requiresExplicitSelection && (!vaultReady || !userId || !vaultKey || !vaultOwnerToken)) {
      requestVault();
      return false;
    }

    const label = draftLabel.trim() || "OpenAI";
    setOpenaiChecking(true);
    setOpenaiNotice(null);
    selectionPendingRef.current = true;
    selectionRevisionRef.current += 1;
    let agentAccepted = false;
    try {
      let validatedModel: string | null = null;
      const extractValidatedModel = (checked: unknown): string | null =>
        checked && typeof checked === "object" && "model" in checked && typeof (checked as { model?: unknown }).model === "string"
          ? (checked as { model: string }).model
          : null;
      const validateOpenAiControlPlane = async (): Promise<boolean> => {
        try {
          const checked = await ApiService.validateOpenAiRuntimeCredential({ credential: apiKey });
          if (!ownerIsCurrent()) return false;
          validatedModel = extractValidatedModel(checked);
          return true;
        } catch (err) {
          if (!ownerIsCurrent()) return false;
          if (err instanceof Error && err.message === "OPENAI_VALIDATE_ROUTE_UNAVAILABLE") {
            setOpenaiNotice({
              tone: "error",
              text: "Your sandbox is still starting up. Try checking your OpenAI key again in a moment.",
            });
            return false;
          }
          setOpenaiNotice({
            tone: "error",
            text: err instanceof Error && err.message ? err.message : "OpenAI could not validate this key.",
          });
          return false;
        }
      };

      if (!privateCloud && requiresExplicitSelection && !vaultReady) {
        let controlPlaneAvailable = true;
        try {
          const checked = await ApiService.validateOpenAiRuntimeCredential({ credential: apiKey });
          if (!ownerIsCurrent()) return false;
          validatedModel = extractValidatedModel(checked);
        } catch (err) {
          if (!ownerIsCurrent()) return false;
          if (err instanceof Error && err.message === "OPENAI_VALIDATE_ROUTE_UNAVAILABLE") {
            controlPlaneAvailable = false;
          } else {
            setOpenaiNotice({
              tone: "error",
              text: err instanceof Error && err.message ? err.message : "OpenAI could not validate this key.",
            });
            return false;
          }
        }
        if (!controlPlaneAvailable) {
          const outcome = await sendAiSelectionToAgent(
            {
              provider: "openai",
              model: null,
              apiKey,
              transport: null,
              vertexProject: null,
              vertexLocation: null,
            },
            ownerIsCurrent,
          );
          if (!ownerIsCurrent()) return false;
          if (!outcome.ok) {
            setOpenaiNotice({
              tone: "error",
              text: aiSelectionRefusalMessage(outcome.code, "OpenAI") ?? "OpenAI could not be set up. Try again.",
            });
            return false;
          }
          validatedModel = outcome.model;
          agentAccepted = true;
        }
      } else {
        const outcome = await sendAiSelectionToAgent(
          {
            provider: "openai",
            model: null,
            apiKey,
            transport: null,
            vertexProject: null,
            vertexLocation: null,
          },
          ownerIsCurrent,
        );
        if (!ownerIsCurrent()) return false;
        validatedModel = outcome.ok ? outcome.model : null;

        if (!outcome.ok) {
          if (!privateCloud && (outcome.code === "AGENT_UNREACHABLE" || outcome.code === "PROVIDER_UNSUPPORTED")) {
            if (!(await validateOpenAiControlPlane())) return false;
          } else {
            setOpenaiNotice({
              tone: "error",
              text: aiSelectionRefusalMessage(outcome.code, "OpenAI") ?? "OpenAI could not be set up. Try again.",
            });
            return false;
          }
        } else {
          agentAccepted = true;
          setCloudAiVerified(false);
          setCloudAiFailure(null);
        }
      }

      if (requiresExplicitSelection && !vaultReady && userId) {
        const now = Date.now();
        const newConfig: SavedAiConfiguration = {
          id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `cfg_${now}`,
          provider: "openai",
          label,
          apiKey,
          model: validatedModel,
          transport: null,
          vertexProject: null,
          vertexLocation: null,
          createdAtMs: now,
          updatedAtMs: now,
        };
        const nextConfigs = [...savedConfigurations, newConfig].slice(-10);
        syncPreVaultDraft(nextConfigs, newConfig.id);
        await onSelectionReadyChange?.("byok_pending_vault");
        if (!ownerIsCurrent()) return false;
        setSavedConfigurations(nextConfigs);
        setActiveConfigId(newConfig.id);
        setHasSavedProviderKey(true);
        setOpenaiDraftKey("");
        setDraftLabel("");
        setAddingProvider(null);
        setMode("byok");
        setSelectedOption("byok");
        setOtherProvider("openai");
        setHasExplicitSelection(true);
        notifyGeminiRuntimeConfigurationChanged();
        toast.success("OpenAI access is ready to protect when you finish setup.");
        return true;
      }

      if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
        requestVault();
        return false;
      }

      const savedResult = await saveAiConfiguration(
        { userId, vaultKey, vaultOwnerToken },
        {
          provider: "openai",
          label,
          apiKey,
          model: validatedModel,
          transport: null,
          vertexProject: null,
          vertexLocation: null,
        },
        { activate: true, isCurrent: ownerIsCurrent },
      );
      if (!ownerIsCurrent()) return false;
      setSavedConfigurations(savedResult.configurations);
      setActiveConfigId(savedResult.saved.id);
      setHasSavedProviderKey(true);
      setOpenaiDraftKey("");
      setDraftLabel("");
      setAddingProvider(null);
      setMode("byok");
      setSelectedOption("byok");
      setOtherProvider("openai");
      if (requiresExplicitSelection) {
        await onSelectionReadyChange?.("byok_pending_vault");
        if (!ownerIsCurrent()) return false;
      }
      setHasExplicitSelection(true);
      notifyGeminiRuntimeConfigurationChanged();
      toast.success(`Using ${savedResult.saved.label} on your agent.`);
      return true;
    } catch {
      if (!ownerIsCurrent()) return false;
      setOpenaiNotice({
        tone: "error",
        text: agentAccepted
          ? "Your agent accepted the key, but its vault backup could not be saved. Retry saving."
          : "OpenAI key could not be saved.",
      });
      return false;
    } finally {
      selectionPendingRef.current = false;
      setOpenaiChecking(false);
    }
  };

  const removeByok = async (): Promise<boolean> => {
    const activeGemini =
      (activeConfig?.provider === "gemini" ? activeConfig : null) ??
      savedConfigurations.find((entry) => entry.provider === "gemini") ??
      null;
    if (activeGemini) {
      return deleteConfiguration(activeGemini.id);
    }
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent() || selectionPendingRef.current || validationPendingRef.current) return false;
    const authorityIsCurrent = () => Boolean(vaultOwnerToken &&
      (!getCurrentVaultOwnerToken || getCurrentVaultOwnerToken() === vaultOwnerToken));
    const mutationIsCurrent = () => ownerIsCurrent() && authorityIsCurrent();
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken || !authorityIsCurrent()) {
      if (needsVaultCreation || needsUnlock) requestVault();
      else toast.error("Your vault is reconnecting. Try again.");
      return false;
    }
    selectionPendingRef.current = true;
    selectionRevisionRef.current += 1;
    setIsRemoving(true);
    try {
      if ((await clearAgentAiSelectionFor("gemini", false, mutationIsCurrent)) === "failed") throw new Error("AGENT_UNREACHABLE");
      if (!mutationIsCurrent()) return false;
      for (const credentialRef of [
        GEMINI_RUNTIME_CREDENTIAL_REF,
        GEMINI_RUNTIME_TRANSPORT_REF,
        GEMINI_VERTEX_PROJECT_REF,
        GEMINI_VERTEX_LOCATION_REF,
      ]) {
        const res = await PersonalKnowledgeModelService.removeRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef,
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "profile_gemini_api_key_remove",
          },
        });
        if (!mutationIsCurrent()) return false;
        assertRuntimeSecretStored(res);
      }
      await persistMode("hushh_managed_vertex");
      if (!mutationIsCurrent()) return false;
      selectionRevisionRef.current += 1;
      setActiveConfigId(null);
      setMode("hushh_managed_vertex");
      setSelectedOption("hushh_managed_vertex");
      setHasSavedKey(false);
      visit.savedConfiguration = { transport: "developer_api", project: "", location: "global" };
      notifyGeminiRuntimeConfigurationChanged();
      toast.success("Your saved Gemini key was removed.");
      return true;
    } catch {
      if (!mutationIsCurrent()) return false;
      toast.error("Your Gemini key could not be removed.");
      return false;
    } finally {
      selectionPendingRef.current = false;
      setIsRemoving(false);
    }
  };

  const compactDefault = privateCloud && cloudAiVerified && !showAiAlternatives;
  useBackLayer(pathname, showAiAlternatives ? 1 : 0, () => {
    if (isSaving || isRemoving || externalAiPending || openaiChecking) return true;
    setShowAiAlternatives(false);
    if (cloudAiVerified) {
      setMode("hushh_managed_vertex");
      setSelectedOption("hushh_managed_vertex");
      setAddingProvider(null);
      setDraftKey("");
      invalidateCredentialValidation();
      setHasExplicitSelection(true);
    }
    return true;
  });
  const editable = () => visit.credentialCurrent() && !selectionPendingRef.current;
  return {
    userId,
    vaultKey,
    vaultOwnerToken,
    placement,
    refreshPlacement,
    privateCloud,
    defaultLabel,
    cloudAiVerified,
    cloudAiModel,
    cloudAiFailure,
    showAiAlternatives,
    setShowAiAlternatives,
    setCloudAiVerified,
    setCloudAiFailure,
    onProviderPendingChange,
    otherProvider,
    agentOutcome,
    compactDefault,
    managedChoiceDisabled:
      isSaving ||
      isRemoving ||
      externalAiPending ||
      openaiChecking ||
      (!privateCloud && placement !== "shared") ||
      (!requiresExplicitSelection && vaultReady && (hasSavedKey === null || loadFailed)),
    onRequestVaultUnlock,
    onRequestVaultCreation,
    providerChanged: async () => {
      const ownerIsCurrent = captureOwnerGuard(); if (!ownerIsCurrent()) return;
      setShowAiAlternatives(false);
      if (requiresExplicitSelection) await onSelectionReadyChange?.("byok_pending_vault");
      if (!ownerIsCurrent()) return;
      setHasExplicitSelection(true); setMode("byok"); setSelectedOption("byok"); await refresh();
    },
    savedConfigurations,
    activeConfigId,
    activeConfig,
    addingProvider,
    startAddingProvider,
    cancelAddingProvider,
    draftLabel,
    setDraftLabel: (value: string) => { if (editable()) setDraftLabel(value); },
    openaiDraftKey,
    setOpenaiDraftKey: (value: string) => { if (editable()) { setOpenaiDraftKey(value); setOpenaiNotice(null); } },
    openaiNotice,
    openaiChecking,
    saveOpenAiConfiguration,
    activateConfiguration,
    deleteConfiguration,
    deactivateCustomAi,
    mode,
    hasSavedKey,
    draftKey,
    transport,
    vertexProject,
    vertexLocation,
    isSaving,
    isRemoving,
    credentialValidation,
    loadFailed,
    hasExplicitSelection,
    selectedOption,
    setDraftKey: (value: string) => { if (editable()) { visit.draftEdited = true; setDraftKey(value); invalidateCredentialValidation(); } },
    setTransport: (value: GeminiRuntimeTransport) => { if (editable()) { visit.draftEdited = true; setTransport(value); invalidateCredentialValidation(); } },
    setVertexProject: (value: string) => { if (editable()) { visit.draftEdited = true; setVertexProject(value); invalidateCredentialValidation(); } },
    setVertexLocation: (value: string) => { if (editable()) { visit.draftEdited = true; setVertexLocation(value); invalidateCredentialValidation(); } },
    invalidateCredentialValidation,
    selectManaged,
    selectByok,
    validateByok,
    saveByok,
    removeByok,
    refresh,
    needsVaultCreation,
    needsUnlock,
    requiresExplicitSelection,
    current,
    inputRevision: () => credentialRevisionRef.current,
    cancelEdit: () => {
      if (!editable()) return;
      setDraftKey("");
      setDraftLabel("");
      setOpenaiDraftKey("");
      setOpenaiNotice(null);
      setAddingProvider(null);
      setTransport(visit.savedConfiguration.transport);
      setVertexProject(visit.savedConfiguration.project);
      setVertexLocation(visit.savedConfiguration.location);
      visit.draftEdited = false;
      invalidateCredentialValidation();
    },
    reconcileFinalDraft: (draft: { credential: string; transport: GeminiRuntimeTransport; project: string; location: string }, expectedRevision: number) => {
      if (!editable() || validationPendingRef.current || credentialRevisionRef.current !== expectedRevision) return false;
      if (draft.credential === draftKey && draft.transport === transport && draft.project === vertexProject && draft.location === vertexLocation) return true;
      visit.draftEdited = true; setDraftKey(draft.credential); setTransport(draft.transport); setVertexProject(draft.project); setVertexLocation(draft.location);
      invalidateCredentialValidation(); return true;
    },
    operationPending: () => selectionPendingRef.current || validationPendingRef.current || openaiChecking,
    mutationPending: () => selectionPendingRef.current,
  };
}

export type GeminiRuntimeSettingsModel = ReturnType<typeof useGeminiRuntimeSettingsModel>;

export function GeminiRuntimeSettingsCard(props: GeminiRuntimeSettingsCardProps) {
  const model = useGeminiRuntimeSettingsModel(props);
  return <GeminiRuntimeSettingsView model={model} />;
}

/** Both renderers receive this controller; neither creates another key store. */
export function GeminiRuntimeSettingsView({ model }: { model: GeminiRuntimeSettingsModel }) {
  const {
    userId,
    vaultKey,
    vaultOwnerToken,
    mode,
    hasSavedKey,
    draftKey,
    draftLabel,
    transport,
    vertexProject,
    vertexLocation,
    isSaving,
    isRemoving,
    credentialValidation,
    hasExplicitSelection,
    selectedOption,
    setDraftKey,
    setDraftLabel,
    setTransport,
    setVertexProject,
    setVertexLocation,
    invalidateCredentialValidation,
    selectManaged,
    startAddingProvider,
    cancelAddingProvider,
    savedConfigurations,
    activeConfigId,
    activeConfig,
    addingProvider,
    openaiDraftKey,
    setOpenaiDraftKey,
    openaiNotice,
    openaiChecking,
    saveOpenAiConfiguration,
    activateConfiguration,
    deleteConfiguration,
    deactivateCustomAi,
    needsVaultCreation,
    needsUnlock,
    requiresExplicitSelection,
    placement,
    privateCloud,
    defaultLabel,
    otherProvider,
    cloudAiVerified,
    cloudAiFailure,
    agentOutcome,
    compactDefault,
    managedChoiceDisabled,
    setShowAiAlternatives,
    setCloudAiVerified,
    setCloudAiFailure,
    onProviderPendingChange,
    onRequestVaultUnlock,
    onRequestVaultCreation,
  } = model;

  const saveByok = async () => { await model.saveByok(); };
  const validateByok = async () => { await model.validateByok(); };
  const settingsReadPending = !requiresExplicitSelection && Boolean(vaultKey && vaultOwnerToken) && (hasSavedKey === null || model.loadFailed);
  const byokExpanded = addingProvider === "gemini";
  const openaiExpanded = addingProvider === "openai";
  const useRadioItems = privateCloud && requiresExplicitSelection;

  const groupDescription = privateCloud
    ? (requiresExplicitSelection ? undefined : "Available now")
    : activeConfig
      ? `Using ${activeConfig.label}. Turn off custom AI anytime to return to built-in sandbox AI.`
      : "Built-in sandbox AI is active automatically. Add Gemini or OpenAI below to switch.";

  const geminiKeyChoice = (
    <GeminiKeyChoice
      expanded={byokExpanded}
      disabled={settingsReadPending}
      isSaving={isSaving}
      isRemoving={isRemoving}
      privateCloud={privateCloud}
      placement={placement}
      requiresExplicitSelection={requiresExplicitSelection}
      useRadioItem={useRadioItems}
      selectedOption={selectedOption}
      hasActiveGemini={activeConfig?.provider === "gemini"}
      hasSavedKey={Boolean(hasSavedKey)}
      needsVaultCreation={needsVaultCreation}
      needsUnlock={needsUnlock}
      draftLabel={draftLabel}
      transport={transport}
      vertexProject={vertexProject}
      vertexLocation={vertexLocation}
      draftKey={draftKey}
      credentialValidation={credentialValidation}
      onToggleExpand={() => startAddingProvider("gemini")}
      onCancel={addingProvider === "gemini" ? cancelAddingProvider : undefined}
      setDraftLabel={setDraftLabel}
      setTransport={setTransport}
      setVertexProject={setVertexProject}
      setVertexLocation={setVertexLocation}
      setDraftKey={setDraftKey}
      invalidateCredentialValidation={invalidateCredentialValidation}
      saveByok={saveByok}
      validateByok={validateByok}
    />
  );

  const openaiKeyChoice = (
    <>
      <SettingsRow
        asChild
        leading={<RuntimeProviderMark provider={OPENAI_MARK} className="!h-8 !w-8" />}
        title="OpenAI"
        disabled={
          settingsReadPending || isSaving || isRemoving || openaiChecking || (!privateCloud && placement !== "shared")
        }
        description={
          savedConfigurations.some((entry) => entry.provider === "openai")
            ? "Add another OpenAI configuration."
            : "Use your own key."
        }
        trailing={
          <span className="inline-flex items-center gap-2">
            {activeConfig?.provider === "openai" ? <Badge variant="secondary">Active</Badge> : null}
            <CaretDownIcon
              aria-hidden
              className={cn(
                "h-4 w-4 transition-transform",
                openaiExpanded ? "rotate-180" : "",
              )}
            />
          </span>
        }
        testId="profile-openai-key-row"
      >
        <button
          type="button"
          disabled={
            settingsReadPending || isSaving || isRemoving || openaiChecking || (!privateCloud && placement !== "shared")
          }
          onClick={() => startAddingProvider("openai")}
          aria-expanded={openaiExpanded}
        />
      </SettingsRow>
      {openaiExpanded ? (
        <div className="space-y-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
          <Input
            type="text"
            autoComplete="off"
            value={draftLabel}
            onChange={(event) => setDraftLabel(event.target.value)}
            placeholder="Configuration name (optional, e.g. Work OpenAI)"
            disabled={isSaving || isRemoving || openaiChecking}
            aria-label="OpenAI configuration name"
          />
          <Input
            type="password"
            autoComplete="off"
            value={openaiDraftKey}
            onChange={(event) => setOpenaiDraftKey(event.target.value)}
            placeholder="Paste an OpenAI API key"
            disabled={isSaving || isRemoving || openaiChecking}
            aria-label="OpenAI API key"
            aria-invalid={openaiNotice?.tone === "error"}
          />
          <HelperText
            as="div"
            className="min-h-5"
            role={openaiNotice?.tone === "error" ? "alert" : "status"}
            aria-live="polite"
          >
            {openaiChecking ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                Checking this key with OpenAI…
              </span>
            ) : openaiNotice ? (
              <span className={openaiNotice.tone === "error" ? "text-destructive" : undefined}>
                {openaiNotice.text}
              </span>
            ) : (
              "Agent One verifies this key with OpenAI before saving it."
            )}
          </HelperText>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant={requiresExplicitSelection ? "blue" : "blue-gradient"}
              onClick={() => void saveOpenAiConfiguration()}
              disabled={isSaving || isRemoving || openaiChecking}
            >
              {openaiChecking ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
              ) : null}
              Check and use
            </Button>
            <Button
              type="button"
              variant="none"
              effect="fade"
              onClick={cancelAddingProvider}
              disabled={isSaving || isRemoving || openaiChecking}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );

  const savedConfigRows = !settingsReadPending && !compactDefault && savedConfigurations.length > 0 ? (
    <>
      {savedConfigurations.map((config) => {
        const isActive = config.id === activeConfigId;
        const configDetail =
          config.provider === "gemini"
            ? config.transport === "vertex_api_key"
              ? "Gemini · Google Cloud Vertex"
              : "Gemini · Google AI Studio"
            : "OpenAI";
        return (
          <SettingsRow
            key={config.id}
            leading={
              config.provider === "gemini" ? (
                <GeminiLogo className="h-8 w-8" />
              ) : (
                <RuntimeProviderMark provider={OPENAI_MARK} className="!h-8 !w-8" />
              )
            }
            title={config.label}
            description={configDetail}
            trailing={
              <span className="inline-flex items-center gap-2">
                {isActive ? (
                  <Badge variant="secondary">Active</Badge>
                ) : (
                  <Button
                    type="button"
                    variant="muted"
                    size="sm"
                    disabled={isSaving || isRemoving || openaiChecking}
                    onClick={() => void activateConfiguration(config.id)}
                  >
                    Switch
                  </Button>
                )}
                <Button
                  type="button"
                  variant="none"
                  size="sm"
                  aria-label={`Remove ${config.label}`}
                  disabled={isSaving || isRemoving || openaiChecking}
                  onClick={() => void deleteConfiguration(config.id)}
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </Button>
              </span>
            }
            testId={`saved-ai-config-${config.id}`}
          />
        );
      })}
    </>
  ) : null;

  const builtInTurnOffRow = !privateCloud && !settingsReadPending && (activeConfig || mode === "byok") ? (
    <SettingsRow
      title="Use built-in sandbox AI"
      description="Turn off custom AI without removing your saved keys."
      trailing={
        <Button
          type="button"
          variant="muted"
          size="sm"
          disabled={isSaving || isRemoving || openaiChecking}
          onClick={() => void deactivateCustomAi()}
          data-testid="turn-off-custom-ai"
        >
          Turn off
        </Button>
      }
      testId="profile-builtin-sandbox-ai"
    />
  ) : null;

  const unavailableProviderGroups = !compactDefault && !settingsReadPending && !requiresExplicitSelection ? (
    <BringYourOwnAiProviders
      ungrouped
      showConfigurable={false}
      excludeComingSoonIds={["openai"]}
      onAccepted={() => { if (model.current()) { setCloudAiVerified(false); setCloudAiFailure(null); } }}
      onPendingChange={onProviderPendingChange}
      showUnavailable={!requiresExplicitSelection}
      userId={userId}
      vaultKey={vaultKey}
      vaultOwnerToken={vaultOwnerToken}
      needsVaultCreation={needsVaultCreation}
      needsUnlock={needsUnlock}
      onRequestVaultUnlock={onRequestVaultUnlock}
      onRequestVaultCreation={onRequestVaultCreation}
      onChanged={model.providerChanged}
    />
  ) : null;

  const innerContent = (
    <div>
      <SettingsGroup
        title="Bring your own AI"
        titleAction={
          compactDefault ? (
            <Button
              type="button"
              variant="link"
              onClick={() => setShowAiAlternatives(true)}
            >
              Change AI
            </Button>
          ) : undefined
        }
        description={groupDescription}
        testId="profile-gemini-runtime"
        separatorInset
      >
        {privateCloud ? (
          <CloudAiChoice
            placement={placement}
            title={defaultLabel}
            disabled={managedChoiceDisabled}
            requiresExplicitSelection={requiresExplicitSelection}
            selectedOption={selectedOption}
            mode={mode}
            hasExplicitSelection={hasExplicitSelection && (requiresExplicitSelection || (hasSavedKey !== null && !model.loadFailed))}
            otherProvider={Boolean(otherProvider)}
            cloudAiVerified={cloudAiVerified}
            modelLabel={model.cloudAiModel}
            onSelect={() => {
              if (!requiresExplicitSelection ||
                (selectedOption === "hushh_managed_vertex" &&
                  (!hasExplicitSelection || (privateCloud && !cloudAiVerified))))
                void selectManaged();
            }}
          />
        ) : null}

        {builtInTurnOffRow}
        {savedConfigRows}
        {!compactDefault && !settingsReadPending ? geminiKeyChoice : null}
        {!compactDefault && !settingsReadPending ? openaiKeyChoice : null}
      </SettingsGroup>
      {unavailableProviderGroups}
      {placement === "azure" && cloudAiFailure && ["QUOTA_EXCEEDED", "MODEL_UNAVAILABLE", "KEY_REFUSED", "AI_DEFAULT_UNAVAILABLE"].includes(cloudAiFailure) ? (
        <p role="status" className="px-[var(--settings-row-px)] text-sm text-muted-foreground">
          Azure AI needs model access. Use a key below, or{" "}
          <a href="https://portal.azure.com/#view/Microsoft_Azure_Billing/SubscriptionsBlade"
            target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center underline underline-offset-4">manage your subscription</a>
          {" "}and check this connection again. Upgrading alone does not guarantee quota.
        </p>
      ) : null}
    </div>
  );

  return (
    <div
      className={cn(
        requiresExplicitSelection ? "space-y-3" : "contents",
        detailStyles.geminiRoot,
      )}
    >
      {agentOutcome ? (
        <p
          role="status"
          className="text-sm text-muted-foreground whitespace-pre-wrap break-words"
        >
          {agentOutcome}
        </p>
      ) : null}
      {!requiresExplicitSelection && model.loadFailed ? (
        <p role="status" className="px-[var(--settings-row-px)] text-sm text-muted-foreground">
          Couldn’t load AI settings. <Button type="button" variant="link" onClick={() => void model.refresh()}>Retry</Button>
        </p>
      ) : null}
      {settingsReadPending && !model.loadFailed ? <p role="status" className="px-[var(--settings-row-px)] text-sm text-muted-foreground">Loading AI settings…</p> : null}
      {placement === "pending" || placement === "unknown" ? (
        <div role="status" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{placement === "pending" ? "Your agent is still getting ready." : "We couldn't verify your hosting connection."}</span>
          <Button type="button" variant="link" onClick={model.refreshPlacement}>Check connection</Button>
        </div>
      ) : null}
      {useRadioItems ? (
        <RadioPrimitive.Root
          asChild
          value={otherProvider ?? selectedOption}
          onValueChange={(value) => {
            if (value === "byok") startAddingProvider("gemini", { toggle: false });
            else void selectManaged();
          }}
          role="radiogroup"
          aria-label="Choose your AI"
          disabled={isSaving || isRemoving || openaiChecking}
        >
          {innerContent}
        </RadioPrimitive.Root>
      ) : (
        innerContent
      )}
    </div>
  );
}
