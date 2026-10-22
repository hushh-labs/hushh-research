"use client";

import { RadioGroup as RadioPrimitive } from "radix-ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, type CSSProperties } from "react";
import { useOwnerPresentationState } from "@/hooks/use-owner-presentation-state";
import { snapshotVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { CheckCircleIcon as CheckCircle2, SpinnerGapIcon as Loader2, TrashIcon as Trash2 } from "@/components/icons";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import {
  CardTitle,
  FormLabel,
  HelperText,
} from "@/components/app-ui/typography";
import { GeminiLogo } from "@/components/brand/gemini-logo";
import { RuntimeProviderMark } from "@/components/brand/runtime-provider-mark";
import { Badge } from "@/components/ui/badge";
import { Input, INPUT_CLASSNAME } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { RUNTIME_PROVIDER_CATALOG } from "@/lib/connections/runtime-provider-catalog";
import {
  notifyGeminiRuntimeConfigurationChanged,
} from "@/lib/connections/gemini-runtime-configuration";
import { ApiService } from "@/lib/services/api-service";
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
import detailStyles from "@/components/profile/profile-preference-details.module.css";

export type GeminiRuntimeSettingsCardProps = {
  userId?: string | null;
  vaultKey?: string | null;
  vaultOwnerToken?: string | null;
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
};

type CredentialValidationState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; validatedAt: number; revision: number }
  | { status: "error"; message: string };

const CREDENTIAL_VALIDATION_TTL_MS = 60_000;
const IDLE_VALIDATION: CredentialValidationState = { status: "idle" };
const COMING_SOON_PROVIDERS = RUNTIME_PROVIDER_CATALOG.filter(
  (provider) => provider.availability === "coming_soon",
);

class RuntimeSettingsVisit {
  live = false; read = 0; draftEdited = false; validationGeneration = 0;
  readonly credential = { current: 0 };
  readonly selection = { current: 0 };
  readonly pending = { current: false };
  readonly validating = { current: false };
  savedConfiguration: { transport: GeminiRuntimeTransport; project: string; location: string } = { transport: "developer_api", project: "", location: "global" };
  // Credential changes select a new visit, without retaining another replica.
  constructor(readonly owner: string | null | undefined, readonly enabled: boolean, readonly epoch: number, ..._credentials: unknown[]) {}
  start() { this.live = this.enabled; }
  retire() { this.live = false; this.read += 1; }
  current() { return this.live && this.epoch === snapshotVaultSessionEpoch(); }
}

function assertRuntimeSecretStored(result: { success: boolean; conflict?: boolean }) {
  if (!result.success) {
    throw new Error(result.conflict ? "PKM_CONFLICT" : "PKM_WRITE_FAILED");
  }
}

export function useGeminiRuntimeSettingsModel({
  userId,
  vaultKey,
  vaultOwnerToken,
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
  enabled = true,
}: GeminiRuntimeSettingsCardProps & { enabled?: boolean }) {
  const epoch = snapshotVaultSessionEpoch();
  const visit = useMemo(() => new RuntimeSettingsVisit(userId, enabled, epoch, vaultKey, vaultOwnerToken), [userId, vaultKey, vaultOwnerToken, enabled, epoch]);
  useLayoutEffect(() => { visit.start(); return () => visit.retire(); }, [visit]);
  const current = useCallback(() => visit.current(), [visit]);
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
  const selectionRevisionRef = visit.selection;
  const selectionPendingRef = visit.pending;
  const validationPendingRef = visit.validating;
  const [loadFailed, setLoadFailed] = useOwnerPresentationState(visit, false);
  const [hasExplicitSelection, setHasExplicitSelection] = useOwnerPresentationState(visit,
    !requiresExplicitSelection || initiallyConfigured,
  );
  const [selectedOption, setSelectedOption] = useOwnerPresentationState<string>(visit, initiallyConfigured ? (initialSetupChoice === "byok_pending_vault" ? "byok" : "hushh_managed_vertex") : "");
  const vaultReady = Boolean(userId && vaultKey && vaultOwnerToken);
  // An already unlocked owner may save BYOK directly to the encrypted vault.
  // Trust that choice only after refresh has read both the saved mode and key;
  // an unlocked vault by itself does not prove the key survived a reload.
  const savedByokReady =
    requiresExplicitSelection &&
    initialSetupChoice === "byok_pending_vault" &&
    mode === "byok" &&
    hasSavedKey === true;
  const configuredChoiceReady = initiallyConfigured || savedByokReady;

  const invalidateCredentialValidation = useCallback(() => {
    if (!current()) return;
    credentialRevisionRef.current += 1;
    visit.validationGeneration += 1; visit.validating.current = false;
    setCredentialValidation(IDLE_VALIDATION);
    if (requiresExplicitSelection) setHasExplicitSelection(false);
  }, [current, visit, credentialRevisionRef, setCredentialValidation, setHasExplicitSelection, requiresExplicitSelection]);

  useEffect(() => {
    if (current()) onCanContinueChange?.(hasExplicitSelection && !isSaving && !isRemoving);
  }, [current, hasExplicitSelection, isSaving, isRemoving, onCanContinueChange]);

  useEffect(() => {
    setHasExplicitSelection(
      !requiresExplicitSelection || configuredChoiceReady,
    );
  }, [configuredChoiceReady, requiresExplicitSelection, setHasExplicitSelection]);

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
    if (!current()) return;
    const request = ++visit.read;
    setLoadFailed(false);
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      if (!requiresExplicitSelection) setMode("hushh_managed_vertex");
      setHasSavedKey(null);
      return;
    }
    const selectionRevision = selectionRevisionRef.current;
    const credentialRevision = credentialRevisionRef.current;
    try {
      const [savedMode, savedKey, savedTransport, savedProject, savedLocation] = await Promise.all([
        PersonalKnowledgeModelService.loadRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: RUNTIME_CREDENTIAL_MODE_REF,
        }),
        PersonalKnowledgeModelService.loadRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_RUNTIME_CREDENTIAL_REF,
        }),
        PersonalKnowledgeModelService.loadRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_RUNTIME_TRANSPORT_REF,
        }),
        PersonalKnowledgeModelService.loadRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_VERTEX_PROJECT_REF,
        }),
        PersonalKnowledgeModelService.loadRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_VERTEX_LOCATION_REF,
        }),
      ]);
      if (!current() || visit.read !== request || selectionRevisionRef.current !== selectionRevision ||
          credentialRevisionRef.current !== credentialRevision || selectionPendingRef.current || validationPendingRef.current) return;
      const restoredMode = savedMode === "byok" ? "byok" : "hushh_managed_vertex";
      setMode(restoredMode);
      if (requiresExplicitSelection) {
        setSelectedOption((current) => current ? restoredMode : "");
        if (restoredMode === "byok" && !savedKey) setHasExplicitSelection(false);
      }
      setHasSavedKey(Boolean(savedKey));
      visit.savedConfiguration = { transport: savedTransport === "vertex_api_key" ? "vertex_api_key" : "developer_api", project: savedProject || "", location: savedLocation || "global" };
      if (!visit.draftEdited) {
        credentialRevisionRef.current += 1;
        setCredentialValidation(IDLE_VALIDATION);
        setTransport(savedTransport === "vertex_api_key" ? "vertex_api_key" : "developer_api");
        setVertexProject(savedProject || "");
        setVertexLocation(savedLocation || "global");
      }
    } catch {
      if (!current() || visit.read !== request || selectionRevisionRef.current !== selectionRevision ||
          credentialRevisionRef.current !== credentialRevision || selectionPendingRef.current || validationPendingRef.current) return;
      setLoadFailed(true);
      if (requiresExplicitSelection) setHasExplicitSelection(false);
      else setMode("hushh_managed_vertex");
      setHasSavedKey(false);
      if (!visit.draftEdited) { setTransport("developer_api"); setVertexProject(""); setVertexLocation("global"); }
    }
  }, [current, visit, credentialRevisionRef, selectionRevisionRef, selectionPendingRef, validationPendingRef, setCredentialValidation, setLoadFailed, setMode, setHasSavedKey, setTransport, setVertexProject, setVertexLocation, setSelectedOption, setHasExplicitSelection, userId, vaultKey, vaultOwnerToken, vaultReady, requiresExplicitSelection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const requestVault = () => {
    if (!current()) return;
    if (needsVaultCreation) onRequestVaultCreation();
    else onRequestVaultUnlock();
  };

  const persistMode = async (nextMode: RuntimeCredentialMode) => {
    if (!current() || !vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
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
    if (!current()) throw new Error("RUNTIME_VISIT_RETIRED");
    assertRuntimeSecretStored(result);
  };

  const selectManaged = async (): Promise<boolean> => {
    if (!current() || selectionPendingRef.current || validationPendingRef.current) return false;
    selectionPendingRef.current = true;
    selectionRevisionRef.current += 1;
    const previousMode = mode;
    const previousSelection = hasExplicitSelection;
    const previousOption = selectedOption;
    setSelectedOption("hushh_managed_vertex");
    setIsSaving(true);
    if (requiresExplicitSelection) setHasExplicitSelection(false);
    try {
      if (requiresExplicitSelection) {
        await onSelectionReadyChange?.("hushh_managed_vertex");
        if (!current()) return false;
        onPreVaultDraftCleared?.();
      } else {
        await persistMode("hushh_managed_vertex");
      }
      setMode("hushh_managed_vertex");
      setHasExplicitSelection(true);
      notifyGeminiRuntimeConfigurationChanged();
      toast.success("Using Hussh's AI.");
      return true;
    } catch (error) {
      if (!current()) return false;
      setMode(previousMode);
      setHasExplicitSelection(previousSelection);
      setSelectedOption(previousOption);
      toast.error(
        error instanceof Error && error.message === "PKM_CONFLICT"
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

  const selectByok = async () => {
    if (!current() || selectionPendingRef.current || validationPendingRef.current) return;
    if (requiresExplicitSelection) {
      selectionRevisionRef.current += 1;
      setSelectedOption("byok");
      setMode("byok");
      setHasExplicitSelection(false);
      setDraftKey("");
      invalidateCredentialValidation();
      return;
    }
    if (!vaultReady) {
      requestVault();
      return;
    }
    selectionRevisionRef.current += 1;
    setMode("byok");
  };

  const validateByok = async (): Promise<boolean> => {
    if (!current() || selectionPendingRef.current || validationPendingRef.current) return false;
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
      if (!current() || credentialRevisionRef.current !== revision) return false;
      setCredentialValidation({ status: "ready", revision, validatedAt: Date.now() });
      return true;
    } catch (error) {
      if (!current() || credentialRevisionRef.current !== revision) return false;
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
    if (!current() || selectionPendingRef.current || validationPendingRef.current) return false;
    const credential = draftKey.trim();
    const validationIsFresh =
      credentialValidation.status === "ready" &&
      credentialValidation.revision === credentialRevisionRef.current &&
      Date.now() - credentialValidation.validatedAt <= CREDENTIAL_VALIDATION_TTL_MS;
    if (!validationIsFresh) {
      setCredentialValidation({ status: "error", message: "Validate this Gemini key before confirming it." });
      return false;
    }
    if (requiresExplicitSelection && !vaultReady && userId) {
      if (!onPreVaultDraftStaged) {
        // A setup surface must never acknowledge BYOK without a volatile
        // owner for the credential. Treat a missing coordinator as a wiring
        // error rather than accidentally persisting a non-secret selection
        // whose credential has been discarded.
        toast.error("Gemini access could not be staged. Try again.");
        return false;
      }
      setIsSaving(true);
      selectionPendingRef.current = true;
      selectionRevisionRef.current += 1;
      try {
        onPreVaultDraftStaged({
          transport,
          credential,
          vertexProject: transport === "vertex_api_key" ? vertexProject.trim() || null : null,
          vertexLocation: transport === "vertex_api_key" ? vertexLocation.trim() || null : null,
        });
        await onSelectionReadyChange?.("byok_pending_vault");
        if (!current()) return false;
        setDraftKey("");
        invalidateCredentialValidation();
        setMode("byok");
        setHasExplicitSelection(true);
        toast.success("Gemini access is ready to protect when you finish setup.");
        return true;
      } catch {
        if (!current()) return false;
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
    try {
      const credentialResult = await PersonalKnowledgeModelService.storeRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: GEMINI_RUNTIME_CREDENTIAL_REF,
        secret: credential,
        confirmation: {
          confirmedByUser: true,
          surface: "web",
          source: "profile_gemini_api_key",
        },
      });
      if (!current()) return false;
      assertRuntimeSecretStored(credentialResult);
      const transportResult = await PersonalKnowledgeModelService.storeRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_RUNTIME_TRANSPORT_REF,
          secret: transport,
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "profile_gemini_transport",
          },
        });
      if (!current()) return false;
      assertRuntimeSecretStored(transportResult);
      if (transport === "vertex_api_key") {
        const [projectResult, locationResult] = await Promise.all([
          PersonalKnowledgeModelService.storeRuntimeSecret({
            userId, vaultKey, vaultOwnerToken, credentialRef: GEMINI_VERTEX_PROJECT_REF,
            secret: vertexProject.trim(),
            confirmation: { confirmedByUser: true, surface: "web", source: "profile_gemini_vertex_project" },
          }),
          PersonalKnowledgeModelService.storeRuntimeSecret({
            userId, vaultKey, vaultOwnerToken, credentialRef: GEMINI_VERTEX_LOCATION_REF,
            secret: vertexLocation.trim(),
            confirmation: { confirmedByUser: true, surface: "web", source: "profile_gemini_vertex_location" },
          }),
        ]);
        if (!current()) return false;
        assertRuntimeSecretStored(projectResult);
        assertRuntimeSecretStored(locationResult);
      } else {
        const [projectResult, locationResult] = await Promise.all([
          PersonalKnowledgeModelService.removeRuntimeSecret({
            userId, vaultKey, vaultOwnerToken, credentialRef: GEMINI_VERTEX_PROJECT_REF,
            confirmation: { confirmedByUser: true, surface: "web", source: "profile_gemini_vertex_project_clear" },
          }),
          PersonalKnowledgeModelService.removeRuntimeSecret({
            userId, vaultKey, vaultOwnerToken, credentialRef: GEMINI_VERTEX_LOCATION_REF,
            confirmation: { confirmedByUser: true, surface: "web", source: "profile_gemini_vertex_location_clear" },
          }),
        ]);
        if (!current()) return false;
        assertRuntimeSecretStored(projectResult);
        assertRuntimeSecretStored(locationResult);
      }
      await persistMode("byok");
      if (!current()) return false;
      setDraftKey("");
      invalidateCredentialValidation();
      setMode("byok");
      setHasSavedKey(true);
      if (requiresExplicitSelection) {
        await onSelectionReadyChange?.("byok_pending_vault");
        if (!current()) return false;
      }
      setHasExplicitSelection(true);
      visit.draftEdited = false;
      visit.savedConfiguration = { transport, project: transport === "vertex_api_key" ? vertexProject.trim() : "", location: transport === "vertex_api_key" ? vertexLocation.trim() : "global" };
      notifyGeminiRuntimeConfigurationChanged();
      toast.success("Your Gemini configuration is saved in your encrypted vault.");
      return true;
    } catch {
      if (!current()) return false;
      toast.error("Gemini key could not be saved.");
      return false;
    } finally {
      selectionPendingRef.current = false;
      setIsSaving(false);
    }
  };

  const removeByok = async (): Promise<boolean> => {
    if (!current() || selectionPendingRef.current || validationPendingRef.current) return false;
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      requestVault();
      return false;
    }
    selectionPendingRef.current = true;
    selectionRevisionRef.current += 1;
    setIsRemoving(true);
    try {
      const credentialResult = await PersonalKnowledgeModelService.removeRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: GEMINI_RUNTIME_CREDENTIAL_REF,
        confirmation: {
          confirmedByUser: true,
          surface: "web",
          source: "profile_gemini_api_key_remove",
        },
      });
      if (!current()) return false;
      assertRuntimeSecretStored(credentialResult);
      const transportResult = await PersonalKnowledgeModelService.removeRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_RUNTIME_TRANSPORT_REF,
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "profile_gemini_transport_remove",
          },
        });
      if (!current()) return false;
      assertRuntimeSecretStored(transportResult);
      const projectResult = await PersonalKnowledgeModelService.removeRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_VERTEX_PROJECT_REF,
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "profile_gemini_vertex_project_remove",
          },
        });
      if (!current()) return false;
      assertRuntimeSecretStored(projectResult);
      const locationResult = await PersonalKnowledgeModelService.removeRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_VERTEX_LOCATION_REF,
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "profile_gemini_vertex_location_remove",
          },
        });
      if (!current()) return false;
      assertRuntimeSecretStored(locationResult);
      await persistMode("hushh_managed_vertex");
      if (!current()) return false;
      selectionRevisionRef.current += 1;
      setMode("hushh_managed_vertex");
      setSelectedOption("hushh_managed_vertex");
      setHasSavedKey(false);
      visit.savedConfiguration = { transport: "developer_api", project: "", location: "global" };
      notifyGeminiRuntimeConfigurationChanged();
      toast.success("Your saved Gemini key was removed.");
      return true;
    } catch {
      if (!current()) return false;
      toast.error("Your Gemini key could not be removed.");
      return false;
    } finally {
      selectionPendingRef.current = false;
      setIsRemoving(false);
    }
  };

  const editable = () => current() && !selectionPendingRef.current;
  return { mode, hasSavedKey, draftKey, transport, vertexProject, vertexLocation, isSaving, isRemoving, credentialValidation, loadFailed,
    hasExplicitSelection, selectedOption,
    setDraftKey: (value: string) => { if (editable()) { visit.draftEdited = true; setDraftKey(value); invalidateCredentialValidation(); } },
    setTransport: (value: GeminiRuntimeTransport) => { if (editable()) { visit.draftEdited = true; setTransport(value); invalidateCredentialValidation(); } },
    setVertexProject: (value: string) => { if (editable()) { visit.draftEdited = true; setVertexProject(value); invalidateCredentialValidation(); } },
    setVertexLocation: (value: string) => { if (editable()) { visit.draftEdited = true; setVertexLocation(value); invalidateCredentialValidation(); } },
    invalidateCredentialValidation, selectManaged, selectByok, validateByok, saveByok, removeByok, refresh,
    needsVaultCreation, needsUnlock, requiresExplicitSelection, current,
    inputRevision: () => credentialRevisionRef.current,
    cancelEdit: () => {
      if (!editable()) return;
      setDraftKey(""); setTransport(visit.savedConfiguration.transport); setVertexProject(visit.savedConfiguration.project); setVertexLocation(visit.savedConfiguration.location);
      visit.draftEdited = false; invalidateCredentialValidation();
    },
    reconcileFinalDraft: (draft: { credential: string; transport: GeminiRuntimeTransport; project: string; location: string }, expectedRevision: number) => {
      if (!editable() || validationPendingRef.current || credentialRevisionRef.current !== expectedRevision) return false;
      if (draft.credential === draftKey && draft.transport === transport && draft.project === vertexProject && draft.location === vertexLocation) return true;
      visit.draftEdited = true; setDraftKey(draft.credential); setTransport(draft.transport); setVertexProject(draft.project); setVertexLocation(draft.location);
      invalidateCredentialValidation(); return true;
    },
    operationPending: () => selectionPendingRef.current || validationPendingRef.current,
    mutationPending: () => selectionPendingRef.current };
}

export type GeminiRuntimeSettingsModel = ReturnType<typeof useGeminiRuntimeSettingsModel>;

export function GeminiRuntimeSettingsCard(props: GeminiRuntimeSettingsCardProps) {
  const model = useGeminiRuntimeSettingsModel(props);
  return <GeminiRuntimeSettingsView model={model} />;
}

/** Both renderers receive this controller; neither creates another key store. */
export function GeminiRuntimeSettingsView({ model }: { model: GeminiRuntimeSettingsModel }) {
  const { mode, hasSavedKey, draftKey, transport, vertexProject, vertexLocation, isSaving, isRemoving, credentialValidation,
    hasExplicitSelection, selectedOption, setDraftKey, setTransport, setVertexProject, setVertexLocation,
    selectManaged, selectByok, validateByok, saveByok, removeByok,
    needsVaultCreation, needsUnlock, requiresExplicitSelection } = model;

  return (
    <div className={cn(requiresExplicitSelection ? "space-y-3" : "contents", detailStyles.geminiRoot)}>
      <RadioPrimitive.Root
        asChild
        value={selectedOption}
        onValueChange={(value) => { if (value === "byok") void selectByok(); else void selectManaged(); }}
        role={requiresExplicitSelection ? "radiogroup" : "group"}
        aria-label="Choose your AI"
        disabled={isSaving || isRemoving}
      >
      <div>
      <SettingsGroup
        title="Gemini"
        description={requiresExplicitSelection ? undefined : "Available now"}
        testId="profile-gemini-runtime"
        separatorInset
      >
        <SettingsRow
        asChild
        leading={<GeminiLogo className="h-8 w-8" />}
        title="Use Hussh's AI"
        description="No key needed."
        // The default we want people to take. Until it is chosen the row says
        // so out loud, so the fast path is the obvious one rather than the one
        // you work out by elimination.
        trailing={
          requiresExplicitSelection ? (
            <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground">
              {selectedOption === "hushh_managed_vertex" ? <span className="size-3 rounded-full bg-primary" /> : null}
            </span>
          ) : mode === "hushh_managed_vertex" && hasExplicitSelection ? (
            <Badge variant="secondary">Selected</Badge>
          ) : (
            <Badge variant="outline">Recommended</Badge>
          )
        }
        testId="profile-managed-runtime"
      >
        {requiresExplicitSelection ? <RadioPrimitive.Item value="hushh_managed_vertex" /> : <button type="button" onClick={() => void selectManaged()} aria-pressed={mode === "hushh_managed_vertex"} />}
        </SettingsRow>

        <SettingsRow
        asChild
        leading={<GeminiLogo className="h-8 w-8" />}
        title="Use my own key"
        description={
          requiresExplicitSelection
            ? "Add your own Gemini key."
            : "Your key stays locked to you."
        }
        trailing={
          requiresExplicitSelection ? (
            <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground">
              {selectedOption === "byok" ? <span className="size-3 rounded-full bg-primary" /> : null}
            </span>
          ) : mode === "byok" && hasExplicitSelection ? (
            <Badge variant="secondary">Selected</Badge>
          ) : null
        }
        testId="profile-byok-runtime"
      >
        {requiresExplicitSelection ? <RadioPrimitive.Item value="byok" /> : <button type="button" onClick={() => void selectByok()} aria-pressed={mode === "byok"} />}
        </SettingsRow>

        {mode === "byok" ? (
          <div className="space-y-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <div className="flex items-center justify-between gap-3">
              <CardTitle as="p">Gemini connection</CardTitle>
              <Badge variant={hasSavedKey ? "secondary" : "outline"}>
                {requiresExplicitSelection && hasExplicitSelection ? "Ready" : needsVaultCreation ? "Vault needed" : needsUnlock ? "Locked" : hasSavedKey ? "Saved" : "Not set"}
              </Badge>
            </div>
            <FormLabel className="block space-y-1">
              API endpoint
              <select
                data-ui-role="input-text"
                value={transport}
                onChange={(event) => {
                  setTransport(event.target.value as GeminiRuntimeTransport);
                }}
                disabled={isSaving || isRemoving || credentialValidation.status === "checking"}
                /* The SAME class the key field under it uses, so the two
                   stacked controls finally agree on radius, height, inset,
                   surface, border and focus ring — they were 24px/40px/12px
                   against 14px/44px/14px.

                   `appearance-none` is not cosmetic and is not optional. This
                   is a native <select>, and WebKit — the engine inside the iOS
                   app — draws `appearance: menulist` itself and OVERRIDES the
                   author's border-radius and padding. Measured in WebKit: the
                   select computes 5px against the input's 14px, and simply
                   handing it the input's classes leaves it at 5px. Without this
                   line the reported mismatch survives the fix on the only
                   platform most of our users are on.

                   `pr-9` then reserves the space the arrow used to get for
                   free, now that we are drawing the control ourselves. */
                className={cn(INPUT_CLASSNAME, "appearance-none bg-no-repeat pr-9")}
                style={{
                  // The disclosure arrow, drawn by us because appearance-none
                  // removes the UA's. Inline because it is a data: URI keyed to
                  // the label colour token, not a reusable utility.
                  backgroundImage:
                    "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8' fill='none'><path d='M1 1.5L6 6.5L11 1.5' stroke='%236e6e73' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'/></svg>\")",
                  backgroundPosition: "right 14px center",
                }}
              >
                <option value="developer_api">Google AI Studio</option>
                <option value="vertex_api_key">
                  Google Cloud Vertex API key
                </option>
              </select>
            </FormLabel>
            {transport === "vertex_api_key" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  value={vertexProject}
                  onChange={(event) => {
                    setVertexProject(event.target.value);
                  }}
                  placeholder="Google Cloud project ID"
                  disabled={isSaving || isRemoving}
                  autoComplete="off"
                  aria-label="Google Cloud project ID"
                />
                <Input
                  value={vertexLocation}
                  onChange={(event) => {
                    setVertexLocation(event.target.value);
                  }}
                  placeholder="Vertex location, for example global"
                  disabled={isSaving || isRemoving}
                  autoComplete="off"
                  aria-label="Vertex location"
                />
              </div>
            ) : null}
            <Input
              type="password"
              autoComplete="off"
              value={draftKey}
              onChange={(event) => {
                setDraftKey(event.target.value);
              }}
              placeholder={transport === "vertex_api_key" ? "Paste a Google Cloud Vertex API key" : "Paste a Google AI Studio Gemini key"}
              disabled={isSaving || isRemoving}
              aria-label="Gemini API key"
              aria-invalid={credentialValidation.status === "error"}
              aria-describedby="gemini-key-validation"
            />
            <HelperText
              as="div"
              className="min-h-5"
              id="gemini-key-validation"
              role={credentialValidation.status === "error" ? "alert" : "status"}
              aria-live="polite"
            >
              {requiresExplicitSelection && hasExplicitSelection ? (
                "Your key is validated. Continue to finish setup."
              ) : credentialValidation.status === "checking" ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  Checking key access and available quota…
                </span>
              ) : credentialValidation.status === "ready" ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                  Key is responding and ready to save.
                </span>
              ) : credentialValidation.status === "error" ? (
                <span className="text-destructive">{credentialValidation.message}</span>
              ) : (
                "Validate the key before confirming it."
              )}
            </HelperText>
            <div className="flex flex-wrap gap-2">
              {requiresExplicitSelection && hasExplicitSelection ? null : credentialValidation.status === "ready" ? (
                <Button type="button" onClick={() => void saveByok()} disabled={isSaving || isRemoving}>
                  {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
                  Confirm and save
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => void validateByok()}
                  disabled={
                    isSaving ||
                    isRemoving ||
                    credentialValidation.status === "checking"
                  }
                >
                  {credentialValidation.status === "checking" ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  ) : null}
                  Validate key
                </Button>
              )}
              {hasSavedKey ? (
                <Button type="button" variant="none" effect="fade" onClick={() => void removeByok()} disabled={isSaving || isRemoving}>
                  {isRemoving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : <Trash2 className="mr-2 h-4 w-4" aria-hidden />}
                  Remove key
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </SettingsGroup>
      </div>
      </RadioPrimitive.Root>

      {requiresExplicitSelection ? (
        <section aria-labelledby="upcoming-providers-heading" data-testid="setup-coming-soon-runtime">
          <h2 id="upcoming-providers-heading" className="text-foreground" style={{
            "--foundation-title3-size": "14px",
            "--foundation-title3-line": "20px",
            "--foundation-title3-weight": "500",
            "--foundation-title3-tracking": "0px",
          } as CSSProperties}>
            Coming soon
          </h2>
          <ul className="mt-1 grid grid-cols-1 gap-y-3">
            {COMING_SOON_PROVIDERS.map((provider) => (
              <li key={provider.id} className="flex min-w-0 items-start gap-2 text-[14px] font-normal leading-5 text-muted-foreground">
                <RuntimeProviderMark provider={provider} className="!h-5 !w-5" />
                <span>{provider.name}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : <SettingsGroup
        title="Coming soon"
        testId="profile-coming-soon-runtime"
        separatorInset
      >
        {COMING_SOON_PROVIDERS.map((provider) => (
          <SettingsRow
            key={provider.id}
            leading={<RuntimeProviderMark provider={provider} className="!h-8 !w-8" />}
            title={provider.name}
            trailing={<Badge variant="outline">Coming soon</Badge>}
            disabled
            testId={`profile-coming-soon-${provider.id}`}
          />
        ))}
      </SettingsGroup>}
    </div>
  );
}
