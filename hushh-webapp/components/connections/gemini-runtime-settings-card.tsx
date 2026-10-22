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

import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { CloudAiChoice } from "./cloud-ai-choice";
import { GeminiKeyChoice, type CredentialValidationState } from "./gemini-key-choice";
import { cn } from "@/lib/utils";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { BringYourOwnAiProviders } from "@/components/connections/byo-ai-providers";
import { notifyGeminiRuntimeConfigurationChanged } from "@/lib/connections/gemini-runtime-configuration";
import { ApiService } from "@/lib/services/api-service";
import {
  clearAgentAiSelectionFor,
  sendAiSelectionToAgent,
  aiSelectionRefusalMessage,
  shareGeminiSelectionWithAgent,
  verifyAgentCloudAi,
} from "@/lib/one/ai-selection-agent";
import { hasStoredAiKey } from "@/lib/one/setup-runtime-readiness";
import { useAiPlacement } from "@/lib/connections/use-ai-placement";
import {
  recordSelectedAiProvider,
  loadSelectedAiProvider,
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

const CREDENTIAL_VALIDATION_TTL_MS = 60_000;
const EMPTY_PENDING_AI_PROVIDERS: Record<string, boolean> = Object.freeze({});
const IDLE_VALIDATION: CredentialValidationState = { status: "idle" };

class RuntimeSettingsVisit {
  live = false; read = 0; draftEdited = false; validationGeneration = 0;
  readonly credential = { current: 0 };
  readonly selection = { current: 0 };
  readonly pending = { current: false };
  readonly validating = { current: false };
  credentialCurrent() { return this.current() && snapshotValidatedAuthSessionOwner()?.generation === this.authGeneration; }
  savedConfiguration: { transport: GeminiRuntimeTransport; project: string; location: string } = { transport: "developer_api", project: "", location: "global" };
  // Credential changes select a new visit, without retaining another replica.
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
  const { placement } = useAiPlacement(captureOwnerGuard, setCloudAiVerified);
  const privateCloud = placement === "gcp" || placement === "azure";
  const defaultLabel = privateCloud ? "Use existing cloud" : "Use Hussh AI";
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
    (otherProvider ? hasSavedProviderKey : hasSavedKey === true);
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
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return;
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
      const [savedMode, savedKey, savedTransport, savedProject, savedLocation, savedProvider] = await Promise.all([
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
        loadSelectedAiProvider({ userId, vaultKey, vaultOwnerToken }, { requireReadable: true }),
      ]);
      if (!ownerIsCurrent()) return;
      const providerKeySaved = savedProvider && savedProvider !== "gemini"
        ? await hasStoredAiKey(userId, vaultKey, vaultOwnerToken, savedProvider) : false;
      if (!ownerIsCurrent() || visit.read !== request || selectionRevisionRef.current !== selectionRevision ||
          credentialRevisionRef.current !== credentialRevision || selectionPendingRef.current || validationPendingRef.current) return;
      const restoredMode = savedMode === "byok" ? "byok" : "hushh_managed_vertex";
      setMode(restoredMode);
      setHasSavedProviderKey(providerKeySaved);
      setOtherProvider(restoredMode === "byok" && savedProvider && savedProvider !== "gemini" ? savedProvider : null);
      if (requiresExplicitSelection) {
        setSelectedOption((current) => current ? restoredMode : "");
        if (restoredMode === "byok" && !(savedProvider && savedProvider !== "gemini" ? providerKeySaved : savedKey)) setHasExplicitSelection(false);
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
      if (!ownerIsCurrent() || visit.read !== request || selectionRevisionRef.current !== selectionRevision ||
          credentialRevisionRef.current !== credentialRevision || selectionPendingRef.current || validationPendingRef.current) return;
      setLoadFailed(true);
      if (requiresExplicitSelection) setHasExplicitSelection(false);
      else setMode("hushh_managed_vertex");
      setHasSavedKey(false);
      setHasSavedProviderKey(false);
      if (!visit.draftEdited) { setTransport("developer_api"); setVertexProject(""); setVertexLocation("global"); }
    }
  }, [captureOwnerGuard, setHasSavedProviderKey, setOtherProvider, visit, credentialRevisionRef, selectionRevisionRef, selectionPendingRef, validationPendingRef, setCredentialValidation, setLoadFailed, setMode, setHasSavedKey, setTransport, setVertexProject, setVertexLocation, setSelectedOption, setHasExplicitSelection, userId, vaultKey, vaultOwnerToken, vaultReady, requiresExplicitSelection]);

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

  const selectManaged = async (): Promise<boolean> => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return false;
    if (selectionPendingRef.current || validationPendingRef.current || externalAiPending) return false;
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
      // Verify BEFORE persisting, exactly as the BYOK path does. Two reasons this
      // ordering matters and is not merely tidy:
      //
      //   1. Honesty. Persisting first and probing second means a person can be
      //      told "selected" about a runtime that cannot generate.
      //   2. This is the only moment the server learns an AI connection exists for
      //      a managed user. Provisioning their private agent hangs off this call;
      //      before it, choosing managed contacted no server route at all.
      if (!privateCloud && placement !== "shared")
        throw new Error("HOSTING_NOT_READY");
      let selection;
      if (privateCloud) {
        const outcome = await verifyAgentCloudAi();
        if (!ownerIsCurrent()) return false;
        if (!outcome.ok) {
          setCloudAiFailure(outcome.code);
          throw new Error(outcome.code);
        }
        setCloudAiFailure(null);
        selection = { agentScheduled: false, agentReason: "host already connected" };
      } else selection = await ApiService.selectManagedGeminiRuntime();
      if (!selection) throw new Error("AGENT_UNREACHABLE");
      if (!ownerIsCurrent()) return false;
      if (!privateCloud && (await clearAgentAiSelectionFor(null)) === "failed")
        throw new Error("AGENT_UNREACHABLE");
      if (!ownerIsCurrent()) return false;
      setCloudAiVerified(privateCloud);
      setShowAiAlternatives(false);
      if (requiresExplicitSelection) {
        await onSelectionReadyChange?.("hushh_managed_vertex");
        if (!ownerIsCurrent()) return false;
        onPreVaultDraftCleared?.();
      } else {
        await persistMode("hushh_managed_vertex");
      }
      if (!ownerIsCurrent()) return false;
      setMode("hushh_managed_vertex");
      setOtherProvider(null);
      setHasExplicitSelection(true);
      notifyGeminiRuntimeConfigurationChanged();
      // Say which of the two things actually happened. "We are building your
      // private agent" and "you are on the shared runtime" are different promises,
      // and a single cheerful string for both is how a product starts lying.
      // When no agent was started, the server says WHY (a human-readable
      // sentence); dropping it left people never told their agent was not
      // started (audit finding, 2026-08-21). "host already ..." is the one
      // positive not-scheduled state: the agent exists or is mid-build.
      const agentLine = selection.agentScheduled
        ? "Your private agent is being built."
        : selection.agentReason.startsWith("host already")
          ? "Your private agent is already set up."
          : selection.agentReason
            ? `Your private agent was not started: ${selection.agentReason}.`
            : "";
      // Keep the full outcome on the screen: toast descriptions are clamped and
      // disappear. This preserves the agent-start explanation without exceeding
      // the shared two-line toast ceiling.
      setAgentOutcome(agentLine);
      toast.success(
        privateCloud ? "Using your cloud’s AI." : "Using Hussh AI.",
      );
      return true;
    } catch (error) {
      if (!ownerIsCurrent()) return false;
      setMode(previousMode);
      setHasExplicitSelection(previousSelection);
      setSelectedOption(previousOption);
      // The schedule-time cloud verdicts route to the exact recovery, not a generic
      // retry: a gone project needs reconnecting (reinit), a revoked grant needs the
      // authorization step re-run. Both land on the cloud setup page.
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
      toast.error(
        error instanceof Error && privateCloud && ["QUOTA_EXCEEDED", "MODEL_UNAVAILABLE", "KEY_REFUSED", "AI_DEFAULT_UNAVAILABLE"].includes(error.message)
          ? "Your cloud AI is unavailable. Check model access or connect your own key below."
          : error instanceof Error && error.message === "AGENT_UNREACHABLE"
          ? "Your private agent could not be reached. Try again."
          : error instanceof Error && error.message === "PKM_CONFLICT"
            ? "This setting changed on another device. Refresh and try again."
            : error instanceof Error &&
                error.message === "MANAGED_RUNTIME_NOT_READY"
              ? "The hushh runtime isn’t responding right now. Try again in a moment."
              : requiresExplicitSelection
                ? "We couldn’t save this setup choice. Try again."
                : "Open your private vault again, then try this setting.",
      );
      return false;
    } finally {
      // The lock belongs to this keyed instance, never a subsequent owner.
      selectionPendingRef.current = false;
      setIsSaving(false);
    }
  };

  const selectByok = async () => {
    if (!privateCloud && placement !== "shared") return;
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
    setOtherProvider(null);
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
        if (!ownerIsCurrent()) return false;
        setDraftKey("");
        invalidateCredentialValidation();
        setMode("byok");
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
        const outcome = await sendAiSelectionToAgent({ provider: "gemini", model: null, apiKey: credential, transport,
          vertexProject: transport === "vertex_api_key" ? vertexProject.trim() : null,
          vertexLocation: transport === "vertex_api_key" ? vertexLocation.trim() : null });
        if (!ownerIsCurrent()) return false;
        if (!outcome.ok) {
          setCredentialValidation({ status: "error", message: aiSelectionRefusalMessage(outcome.code, "Gemini") ?? "Your private agent could not check this connection." });
          return false;
        }
        agentAccepted = true;
        setCloudAiVerified(false);
      }
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
      if (!ownerIsCurrent()) return false;
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
      if (!ownerIsCurrent()) return false;
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
        if (!ownerIsCurrent()) return false;
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
        if (!ownerIsCurrent()) return false;
        assertRuntimeSecretStored(projectResult);
        assertRuntimeSecretStored(locationResult);
      }
      await persistMode("byok");
      if (!ownerIsCurrent()) return false;
      if (privateCloud) await recordSelectedAiProvider({ userId, vaultKey, vaultOwnerToken }, "gemini", null, ownerIsCurrent);
      if (!ownerIsCurrent()) return false;
      const agentRefusal = privateCloud ? null : await shareGeminiSelectionWithAgent({ userId, vaultKey, vaultOwnerToken, credential, transport,
        vertexProject: vertexProject.trim() || null, vertexLocation: vertexLocation.trim() || null });
      if (!ownerIsCurrent()) return false;
      if (agentRefusal) toast.error(agentRefusal); else setOtherProvider(null);
      setDraftKey("");
      invalidateCredentialValidation();
      setMode("byok");
      setHasSavedKey(true);
      if (requiresExplicitSelection) {
        await onSelectionReadyChange?.("byok_pending_vault");
        if (!ownerIsCurrent()) return false;
      }
      setHasExplicitSelection(true);
      visit.draftEdited = false;
      visit.savedConfiguration = { transport, project: transport === "vertex_api_key" ? vertexProject.trim() : "", location: transport === "vertex_api_key" ? vertexLocation.trim() : "global" };
      notifyGeminiRuntimeConfigurationChanged();
      toast.success("Your Gemini configuration is saved in your encrypted vault.");
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

  const removeByok = async (): Promise<boolean> => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent() || selectionPendingRef.current || validationPendingRef.current) return false;
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      requestVault();
      return false;
    }
    selectionPendingRef.current = true;
    selectionRevisionRef.current += 1;
    setIsRemoving(true);
    try {
      if ((await clearAgentAiSelectionFor("gemini")) === "failed") throw new Error("AGENT_UNREACHABLE");
      if (!ownerIsCurrent()) return false;
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
      if (!ownerIsCurrent()) return false;
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
      if (!ownerIsCurrent()) return false;
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
      if (!ownerIsCurrent()) return false;
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
      if (!ownerIsCurrent()) return false;
      assertRuntimeSecretStored(locationResult);
      await persistMode("hushh_managed_vertex");
      if (!ownerIsCurrent()) return false;
      selectionRevisionRef.current += 1;
      setMode("hushh_managed_vertex");
      setSelectedOption("hushh_managed_vertex");
      setHasSavedKey(false);
      visit.savedConfiguration = { transport: "developer_api", project: "", location: "global" };
      notifyGeminiRuntimeConfigurationChanged();
      toast.success("Your saved Gemini key was removed.");
      return true;
    } catch {
      if (!ownerIsCurrent()) return false;
      toast.error("Your Gemini key could not be removed.");
      return false;
    } finally {
      selectionPendingRef.current = false;
      setIsRemoving(false);
    }
  };

  const compactDefault = privateCloud && cloudAiVerified && !showAiAlternatives;
  useBackLayer(pathname, showAiAlternatives ? 1 : 0, () => {
    if (isSaving || isRemoving || externalAiPending) return true;
    setShowAiAlternatives(false);
    if (cloudAiVerified) {
      setMode("hushh_managed_vertex");
      setSelectedOption("hushh_managed_vertex");
      setHasExplicitSelection(true);
      setDraftKey("");
      invalidateCredentialValidation();
    }
    return true;
  });
  const editable = () => visit.credentialCurrent() && !selectionPendingRef.current;
  return { userId, vaultKey, vaultOwnerToken, placement, privateCloud, defaultLabel, cloudAiVerified, cloudAiFailure,
    showAiAlternatives, setShowAiAlternatives, setCloudAiVerified, setCloudAiFailure, onProviderPendingChange,
    otherProvider, agentOutcome, compactDefault, managedChoiceDisabled: isSaving || isRemoving || externalAiPending || (!privateCloud && placement !== "shared"),
    onRequestVaultUnlock, onRequestVaultCreation,
    providerChanged: async () => {
      const ownerIsCurrent = captureOwnerGuard(); if (!ownerIsCurrent()) return;
      setShowAiAlternatives(false);
      if (requiresExplicitSelection) await onSelectionReadyChange?.("byok_pending_vault");
      if (!ownerIsCurrent()) return;
      setHasExplicitSelection(true); setMode("byok"); setSelectedOption("byok"); await refresh();
    },
    mode, hasSavedKey, draftKey, transport, vertexProject, vertexLocation, isSaving, isRemoving, credentialValidation, loadFailed,
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
  const { userId, vaultKey, vaultOwnerToken, mode, hasSavedKey, draftKey, transport, vertexProject, vertexLocation, isSaving, isRemoving, credentialValidation,
    hasExplicitSelection, selectedOption, setDraftKey, setTransport, setVertexProject, setVertexLocation, invalidateCredentialValidation,
    selectManaged, selectByok, needsVaultCreation, needsUnlock, requiresExplicitSelection,
    placement, privateCloud, defaultLabel, otherProvider, cloudAiVerified, cloudAiFailure, agentOutcome, compactDefault, managedChoiceDisabled,
    setShowAiAlternatives, setCloudAiVerified, setCloudAiFailure, onProviderPendingChange,
    onRequestVaultUnlock, onRequestVaultCreation } = model;
  const saveByok = async () => { await model.saveByok(); };
  const validateByok = async () => { await model.validateByok(); };
  const removeByok = async () => { await model.removeByok(); };
  const geminiKeyChoice = <GeminiKeyChoice isSaving={isSaving} isRemoving={isRemoving} privateCloud={privateCloud} placement={placement} requiresExplicitSelection={requiresExplicitSelection} selectedOption={selectedOption} mode={mode} hasExplicitSelection={hasExplicitSelection} otherProvider={Boolean(otherProvider)} hasSavedKey={Boolean(hasSavedKey)} needsVaultCreation={needsVaultCreation} needsUnlock={needsUnlock} transport={transport} vertexProject={vertexProject} vertexLocation={vertexLocation} draftKey={draftKey} credentialValidation={credentialValidation} selectByok={selectByok} setTransport={setTransport} setVertexProject={setVertexProject} setVertexLocation={setVertexLocation} setDraftKey={setDraftKey} invalidateCredentialValidation={invalidateCredentialValidation} saveByok={saveByok} validateByok={validateByok} removeByok={removeByok} />;
  const otherProviderChoices = (
    <BringYourOwnAiProviders
      ungrouped
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
      <RadioPrimitive.Root
        asChild
        value={otherProvider ?? selectedOption}
        onValueChange={(value) => {
          if (value === "byok") void selectByok();
          else void selectManaged();
        }}
        role={requiresExplicitSelection ? "radiogroup" : "group"}
        aria-label="Choose your AI"
        disabled={isSaving || isRemoving}
      >
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
            description={
              requiresExplicitSelection ? undefined : "Available now"
            }
            testId="profile-gemini-runtime"
            separatorInset
          >
            <CloudAiChoice
              placement={placement}
              title={defaultLabel}
              disabled={managedChoiceDisabled}
              requiresExplicitSelection={requiresExplicitSelection}
              selectedOption={selectedOption}
              mode={mode}
              hasExplicitSelection={hasExplicitSelection}
              otherProvider={Boolean(otherProvider)}
              cloudAiVerified={cloudAiVerified}
              onSelect={() => {
                if (!requiresExplicitSelection ||
                  (selectedOption === "hushh_managed_vertex" &&
                    (!hasExplicitSelection || (privateCloud && !cloudAiVerified))))
                  void selectManaged();
              }}
            />

            {!compactDefault ? geminiKeyChoice : null}
            {!compactDefault ? otherProviderChoices : null}
          </SettingsGroup>
          {placement === "azure" && cloudAiFailure && ["QUOTA_EXCEEDED", "MODEL_UNAVAILABLE", "KEY_REFUSED", "AI_DEFAULT_UNAVAILABLE"].includes(cloudAiFailure) ? (
            <p role="status" className="px-[var(--settings-row-px)] text-sm text-muted-foreground">
              Azure AI needs model access. Use a key below, or {" "}
              <a href="https://portal.azure.com/#view/Microsoft_Azure_Billing/SubscriptionsBlade"
                target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center underline underline-offset-4">manage your subscription</a>
              {" "}and check this connection again. Upgrading alone does not guarantee quota.
            </p>
          ) : null}
        </div>
      </RadioPrimitive.Root>

    </div>
  );
}
