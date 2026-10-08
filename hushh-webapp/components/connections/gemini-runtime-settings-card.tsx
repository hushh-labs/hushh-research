"use client";

import { RadioGroup as RadioPrimitive } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircleIcon as CheckCircle2, SpinnerGapIcon as Loader2, TrashIcon as Trash2 } from "@/components/icons";

import { ROUTES } from "@/lib/navigation/routes";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { CardTitle, FormLabel, HelperText } from "@/components/app-ui/typography";
import { GeminiLogo } from "@/components/brand/gemini-logo";
import { GeminiFreeTierNote } from "@/components/connections/gemini-free-tier-note";
import { Badge } from "@/components/ui/badge";
import { Input, INPUT_CLASSNAME } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
import { BringYourOwnAiProviders } from "@/components/connections/byo-ai-providers";
import { notifyGeminiRuntimeConfigurationChanged } from "@/lib/connections/gemini-runtime-configuration";
import { ApiService } from "@/lib/services/api-service";
import { clearAgentAiSelectionFor, shareGeminiSelectionWithAgent } from "@/lib/one/ai-selection-agent";
import { loadSelectedAiProvider } from "@/lib/one/ai-selection-vault";
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

type GeminiRuntimeSettingsCardProps = {
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

function assertRuntimeSecretStored(result: {
  success: boolean;
  conflict?: boolean;
}) {
  if (!result.success) {
    throw new Error(result.conflict ? "PKM_CONFLICT" : "PKM_WRITE_FAILED");
  }
}

export function GeminiRuntimeSettingsCard(props: GeminiRuntimeSettingsCardProps) {
  // Credentials and owner-specific results must not survive an account switch.
  const owner = snapshotValidatedAuthSessionOwner();
  return (
    <OwnerRuntimeSettingsCard
      key={`${props.userId ?? "signed-out"}:${owner?.generation ?? "unresolved"}`}
      {...props}
    />
  );
}

function OwnerRuntimeSettingsCard({
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
}: GeminiRuntimeSettingsCardProps) {
  const router = useRouter();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const captureOwnerGuard = useCallback(() => {
    const owner = snapshotValidatedAuthSessionOwner();
    return () => Boolean(
      mountedRef.current && owner && owner.userId === userId &&
      isValidatedAuthSessionOwnerCurrent(owner),
    );
  }, [userId]);
  const [mode, setMode] = useState<RuntimeCredentialMode>(
    "hushh_managed_vertex",
  );
  // The person's own recorded cloud, when one exists. For them "Use Hussh's
  // AI" does NOT mean a shared runtime: their pod thinks with their own
  // project's Vertex AI identity, and that linkage was invisible at the moment
  // of choice (founder finding, 2026-08-21).
  const [ownCloudProject, setOwnCloudProject] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return;
    void ApiService.getByocSetupStatus()
      .then((status) => {
        if (!cancelled && ownerIsCurrent() && status.status === "recorded" && status.projectId) {
          setOwnCloudProject(status.projectId);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [captureOwnerGuard]);
  const [hasSavedKey, setHasSavedKey] = useState<boolean | null>(null);
  const [otherProvider, setOtherProvider] = useState<string | null>(null); // e.g. OpenAI is the own key in use
  const [draftKey, setDraftKey] = useState("");
  const [transport, setTransport] =
    useState<GeminiRuntimeTransport>("developer_api");
  const [vertexProject, setVertexProject] = useState("");
  const [vertexLocation, setVertexLocation] = useState("global");
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [agentOutcome, setAgentOutcome] = useState("");
  const [credentialValidation, setCredentialValidation] =
    useState<CredentialValidationState>({ status: "idle" });
  const credentialRevisionRef = useRef(0);
  const selectionRevisionRef = useRef(0);
  const selectionPendingRef = useRef(false);
  const [hasExplicitSelection, setHasExplicitSelection] = useState(
    !requiresExplicitSelection || initiallyConfigured,
  );
  const [selectedOption, setSelectedOption] = useState<string>(initiallyConfigured ? (initialSetupChoice === "byok_pending_vault" ? "byok" : "hushh_managed_vertex") : "");
  const vaultReady = Boolean(userId && vaultKey && vaultOwnerToken);

  useEffect(() => {
    setAgentOutcome("");
  }, [userId]);

  const invalidateCredentialValidation = useCallback(() => {
    credentialRevisionRef.current += 1;
    setCredentialValidation({ status: "idle" });
    if (requiresExplicitSelection) setHasExplicitSelection(false);
  }, [requiresExplicitSelection]);

  useEffect(() => {
    onCanContinueChange?.(hasExplicitSelection && !isSaving && !isRemoving);
  }, [hasExplicitSelection, isSaving, isRemoving, onCanContinueChange]);

  useEffect(() => {
    setHasExplicitSelection(!requiresExplicitSelection || initiallyConfigured);
  }, [initiallyConfigured, requiresExplicitSelection]);

  useEffect(() => {
    if (!requiresExplicitSelection) return;
    setSelectedOption(initiallyConfigured ? (initialSetupChoice === "byok_pending_vault" ? "byok" : "hushh_managed_vertex") : "");
    setMode(
      initialSetupChoice === "byok_pending_vault"
        ? "byok"
        : "hushh_managed_vertex",
    );
  }, [initialSetupChoice, initiallyConfigured, requiresExplicitSelection]);

  const refresh = useCallback(async () => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return;
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      if (!requiresExplicitSelection) setMode("hushh_managed_vertex");
      setHasSavedKey(null);
      return;
    }
    const selectionRevision = selectionRevisionRef.current;
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
        loadSelectedAiProvider({ userId, vaultKey, vaultOwnerToken }),
      ]);
      if (!ownerIsCurrent() || selectionRevisionRef.current !== selectionRevision) return;
      const restoredMode = savedMode === "byok" ? "byok" : "hushh_managed_vertex";
      setMode(restoredMode);
      setOtherProvider(restoredMode === "byok" && savedProvider && savedProvider !== "gemini" ? savedProvider : null);
      if (requiresExplicitSelection) {
        setSelectedOption((current) => current ? restoredMode : "");
        if (restoredMode === "byok" && !savedKey) setHasExplicitSelection(false);
      }
      setHasSavedKey(Boolean(savedKey));
      setTransport(
        savedTransport === "vertex_api_key"
          ? "vertex_api_key"
          : "developer_api",
      );
      setVertexProject(savedProject || "");
      setVertexLocation(savedLocation || "global");
    } catch {
      if (!ownerIsCurrent() || selectionRevisionRef.current !== selectionRevision) return;
      if (requiresExplicitSelection) setHasExplicitSelection(false);
      else setMode("hushh_managed_vertex");
      setHasSavedKey(false);
      setTransport("developer_api");
      setVertexProject("");
      setVertexLocation("global");
    }
  }, [captureOwnerGuard, userId, vaultKey, vaultOwnerToken, vaultReady, requiresExplicitSelection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const requestVault = () => {
    if (needsVaultCreation) onRequestVaultCreation();
    else onRequestVaultUnlock();
  };

  const persistMode = async (nextMode: RuntimeCredentialMode) => {
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
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
    assertRuntimeSecretStored(result);
  };

  const selectManaged = async () => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return;
    if (selectionPendingRef.current) return;
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
      const selection = await ApiService.selectManagedGeminiRuntime();
      if (!ownerIsCurrent()) return;
      if ((await clearAgentAiSelectionFor(null)) === "failed") throw new Error("AGENT_UNREACHABLE"); // agents never fall back on their own
      if (requiresExplicitSelection) {
        await onSelectionReadyChange?.("hushh_managed_vertex");
        if (!ownerIsCurrent()) return;
        onPreVaultDraftCleared?.();
      } else {
        await persistMode("hushh_managed_vertex");
      }
      if (!ownerIsCurrent()) return;
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
        ownCloudProject ? "Using your pod's AI." : "Using Hussh's AI.",
      );
    } catch (error) {
      if (!ownerIsCurrent()) return;
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
        return;
      }
      if (error instanceof Error && error.message === "CLOUD_GRANT_REVOKED") {
        toast.error("Re-authorize Hushh’s access to your project to continue.");
        router.push(ROUTES.ONE_SETUP_CLOUD);
        return;
      }
      toast.error(
        error instanceof Error && error.message === "AGENT_UNREACHABLE"
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
    } finally {
      // The lock belongs to this keyed instance, never a subsequent owner.
      selectionPendingRef.current = false;
      setIsSaving(false);
    }
  };

  const selectByok = async () => {
    if (selectionPendingRef.current) return;
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

  const validateByok = async () => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return;
    const credential = draftKey.trim();
    if (!credential) {
      setCredentialValidation({ status: "error", message: "Enter your Gemini API key." });
      return;
    }
    if (transport === "vertex_api_key" && (!vertexProject.trim() || !vertexLocation.trim())) {
      setCredentialValidation({ status: "error", message: "Enter the Google Cloud project ID and Vertex location." });
      return;
    }
    if (
      !requiresExplicitSelection &&
      (!vaultReady || !userId || !vaultKey || !vaultOwnerToken)
    ) {
      requestVault();
      return;
    }
    const revision = credentialRevisionRef.current;
    setCredentialValidation({ status: "checking" });
    try {
      await ApiService.validateGeminiRuntimeCredential({
        credential,
        transport,
        vertexProject:
          transport === "vertex_api_key" ? vertexProject.trim() : null,
        vertexLocation:
          transport === "vertex_api_key" ? vertexLocation.trim() : null,
      });
      if (!ownerIsCurrent() || credentialRevisionRef.current !== revision) return;
      setCredentialValidation({
        status: "ready",
        revision,
        validatedAt: Date.now(),
      });
    } catch (error) {
      if (!ownerIsCurrent() || credentialRevisionRef.current !== revision) return;
      const message =
        error instanceof Error
          ? error.message
          : "Gemini could not be reached to validate this key.";
      setCredentialValidation({ status: "error", message });
    }
  };

  const saveByok = async () => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return;
    if (selectionPendingRef.current) return;
    const credential = draftKey.trim();
    const validationIsFresh =
      credentialValidation.status === "ready" &&
      credentialValidation.revision === credentialRevisionRef.current &&
      Date.now() - credentialValidation.validatedAt <=
        CREDENTIAL_VALIDATION_TTL_MS;
    if (!validationIsFresh) {
      setCredentialValidation({ status: "error", message: "Validate this Gemini key before confirming it." });
      return;
    }
    if (requiresExplicitSelection && !vaultReady && userId) {
      if (!onPreVaultDraftStaged) {
        // A setup surface must never acknowledge BYOK without a volatile
        // owner for the credential. Treat a missing coordinator as a wiring
        // error rather than accidentally persisting a non-secret selection
        // whose credential has been discarded.
        toast.error("Gemini access could not be staged. Try again.");
        return;
      }
      setIsSaving(true);
      selectionPendingRef.current = true;
      try {
        onPreVaultDraftStaged({
          transport,
          credential,
          vertexProject:
            transport === "vertex_api_key"
              ? vertexProject.trim() || null
              : null,
          vertexLocation:
            transport === "vertex_api_key"
              ? vertexLocation.trim() || null
              : null,
        });
        await onSelectionReadyChange?.("byok_pending_vault");
        if (!ownerIsCurrent()) return;
        setDraftKey("");
        invalidateCredentialValidation();
        setMode("byok");
        setHasExplicitSelection(true);
        toast.success(
          "Gemini access is ready to protect when you finish setup.",
        );
      } catch {
        if (!ownerIsCurrent()) return;
        toast.error("Gemini access could not be staged. Try again.");
      } finally {
        selectionPendingRef.current = false;
        if (ownerIsCurrent()) {
          setIsSaving(false);
        }
      }
      return;
    }
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      requestVault();
      return;
    }
    setIsSaving(true);
    selectionPendingRef.current = true;
    try {
      const credentialResult =
        await PersonalKnowledgeModelService.storeRuntimeSecret({
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
      if (!ownerIsCurrent()) return;
      assertRuntimeSecretStored(credentialResult);
      const transportResult =
        await PersonalKnowledgeModelService.storeRuntimeSecret({
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
      if (!ownerIsCurrent()) return;
      assertRuntimeSecretStored(transportResult);
      if (transport === "vertex_api_key") {
        const [projectResult, locationResult] = await Promise.all([
          PersonalKnowledgeModelService.storeRuntimeSecret({
            userId,
            vaultKey,
            vaultOwnerToken,
            credentialRef: GEMINI_VERTEX_PROJECT_REF,
            secret: vertexProject.trim(),
            confirmation: {
              confirmedByUser: true,
              surface: "web",
              source: "profile_gemini_vertex_project",
            },
          }),
          PersonalKnowledgeModelService.storeRuntimeSecret({
            userId,
            vaultKey,
            vaultOwnerToken,
            credentialRef: GEMINI_VERTEX_LOCATION_REF,
            secret: vertexLocation.trim(),
            confirmation: {
              confirmedByUser: true,
              surface: "web",
              source: "profile_gemini_vertex_location",
            },
          }),
        ]);
        if (!ownerIsCurrent()) return;
        assertRuntimeSecretStored(projectResult);
        if (!ownerIsCurrent()) return;
        assertRuntimeSecretStored(locationResult);
      } else {
        const [projectResult, locationResult] = await Promise.all([
          PersonalKnowledgeModelService.removeRuntimeSecret({
            userId,
            vaultKey,
            vaultOwnerToken,
            credentialRef: GEMINI_VERTEX_PROJECT_REF,
            confirmation: {
              confirmedByUser: true,
              surface: "web",
              source: "profile_gemini_vertex_project_clear",
            },
          }),
          PersonalKnowledgeModelService.removeRuntimeSecret({
            userId,
            vaultKey,
            vaultOwnerToken,
            credentialRef: GEMINI_VERTEX_LOCATION_REF,
            confirmation: {
              confirmedByUser: true,
              surface: "web",
              source: "profile_gemini_vertex_location_clear",
            },
          }),
        ]);
        if (!ownerIsCurrent()) return;
        assertRuntimeSecretStored(projectResult);
        if (!ownerIsCurrent()) return;
        assertRuntimeSecretStored(locationResult);
      }
      await persistMode("byok");
      if (!ownerIsCurrent()) return;
      const agentRefusal = await shareGeminiSelectionWithAgent({ userId, vaultKey, vaultOwnerToken, credential, transport, vertexProject: vertexProject.trim() || null, vertexLocation: vertexLocation.trim() || null });
      if (!ownerIsCurrent()) return;
      if (agentRefusal) toast.error(agentRefusal); // the agent keeps its previous selection
      else setOtherProvider(null);
      setDraftKey("");
      invalidateCredentialValidation();
      setMode("byok");
      setHasSavedKey(true);
      if (requiresExplicitSelection) {
        await onSelectionReadyChange?.("byok_pending_vault");
      }
      if (!ownerIsCurrent()) return;
      setHasExplicitSelection(true);
      notifyGeminiRuntimeConfigurationChanged();
      toast.success(
        "Your Gemini configuration is saved in your encrypted vault.",
      );
    } catch {
      if (!ownerIsCurrent()) return;
      toast.error("Gemini key could not be saved.");
    } finally {
      selectionPendingRef.current = false;
      if (ownerIsCurrent()) {
        setIsSaving(false);
      }
    }
  };

  const removeByok = async () => {
    const ownerIsCurrent = captureOwnerGuard();
    if (!ownerIsCurrent()) return;
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      requestVault();
      return;
    }
    setIsRemoving(true);
    try {
      if ((await clearAgentAiSelectionFor("gemini")) === "failed") throw new Error("AGENT_UNREACHABLE");
      const credentialResult =
        await PersonalKnowledgeModelService.removeRuntimeSecret({
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
      if (!ownerIsCurrent()) return;
      assertRuntimeSecretStored(credentialResult);
      const transportResult =
        await PersonalKnowledgeModelService.removeRuntimeSecret({
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
      if (!ownerIsCurrent()) return;
      assertRuntimeSecretStored(transportResult);
      const projectResult =
        await PersonalKnowledgeModelService.removeRuntimeSecret({
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
      if (!ownerIsCurrent()) return;
      assertRuntimeSecretStored(projectResult);
      const locationResult =
        await PersonalKnowledgeModelService.removeRuntimeSecret({
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
      if (!ownerIsCurrent()) return;
      assertRuntimeSecretStored(locationResult);
      await persistMode("hushh_managed_vertex");
      if (!ownerIsCurrent()) return;
      selectionRevisionRef.current += 1;
      setMode("hushh_managed_vertex");
      setSelectedOption("hushh_managed_vertex");
      setHasSavedKey(false);
      notifyGeminiRuntimeConfigurationChanged();
      toast.success("Your saved Gemini key was removed.");
    } catch {
      if (!ownerIsCurrent()) return;
      toast.error("Your Gemini key could not be removed.");
    } finally {
      if (ownerIsCurrent()) setIsRemoving(false);
    }
  };

  return (
    <div className={requiresExplicitSelection ? "space-y-6" : "contents"}>
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
        title={ownCloudProject ? "Use your pod's AI" : "Use Hussh's AI"}
        description={ownCloudProject
          ? `Vertex AI in your own project ${ownCloudProject}, on your pod's identity. Typed turns and recorded commands run on your pod. Live conversation is not available on this connection.`
          : "No key needed."}
        // The default we want people to take. Until it is chosen the row says
        // so out loud, so the fast path is the obvious one rather than the one
        // you work out by elimination.
        trailing={
          requiresExplicitSelection ? (
            <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground">
              {selectedOption === "hushh_managed_vertex" ? <span className="size-3 rounded-full bg-primary" /> : null}
            </span>
          ) : mode === "hushh_managed_vertex" && hasExplicitSelection && !otherProvider ? (
            <Badge variant="secondary">Selected</Badge>
          ) : (
            <Badge variant="outline">Recommended</Badge>
          )
        }
        testId="profile-managed-runtime"
      >
        {requiresExplicitSelection ? <RadioPrimitive.Item value="hushh_managed_vertex" onClick={() => {
          if (selectedOption === "hushh_managed_vertex" && !hasExplicitSelection) void selectManaged();
        }} /> : <button type="button" onClick={() => void selectManaged()} aria-pressed={mode === "hushh_managed_vertex"} />}
        </SettingsRow>

        <SettingsRow
        asChild
        leading={<GeminiLogo className="h-8 w-8" />}
        title="Use your own key"
        description={
          requiresExplicitSelection && !vaultReady
            ? "Add your own Gemini key."
            : "Your key stays locked to you."
        }
        trailing={
          requiresExplicitSelection ? (
            <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground">
              {selectedOption === "byok" ? <span className="size-3 rounded-full bg-primary" /> : null}
            </span>
          ) : mode === "byok" && hasExplicitSelection && !otherProvider ? (
            <Badge variant="secondary">Selected</Badge>
          ) : null
        }
        testId="profile-byok-runtime"
      >
        {requiresExplicitSelection ? <RadioPrimitive.Item value="byok" /> : <button type="button" onClick={() => void selectByok()} aria-pressed={mode === "byok" && !otherProvider} />}
        </SettingsRow>

        {mode === "byok" && !otherProvider ? (
          <div className="space-y-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <div className="flex items-center justify-between gap-3">
              <CardTitle as="p">Gemini connection</CardTitle>
              <Badge variant={hasSavedKey ? "secondary" : "outline"}>
                {needsVaultCreation ? "Vault needed" : needsUnlock ? "Locked" : hasSavedKey ? "Saved" : "Not set"}
              </Badge>
            </div>
            <FormLabel className="block space-y-1">
              API endpoint
              <select
                data-ui-role="input-text"
                value={transport}
                onChange={(event) => {
                  setTransport(event.target.value as GeminiRuntimeTransport);
                  invalidateCredentialValidation();
                }}
                disabled={
                  isSaving ||
                  isRemoving ||
                  credentialValidation.status === "checking"
                }
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
                className={cn(
                  INPUT_CLASSNAME,
                  "appearance-none bg-no-repeat pr-9",
                )}
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
            <GeminiFreeTierNote transport={transport} />
            {transport === "vertex_api_key" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  value={vertexProject}
                  onChange={(event) => {
                    setVertexProject(event.target.value);
                    invalidateCredentialValidation();
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
                    invalidateCredentialValidation();
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
                invalidateCredentialValidation();
              }}
              placeholder={
                transport === "vertex_api_key"
                  ? "Paste a Google Cloud Vertex API key"
                  : "Paste a Google AI Studio Gemini key"
              }
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
                <span className="text-destructive">
                  {credentialValidation.message}
                </span>
              ) : (
                "Validate the key before confirming it."
              )}
            </HelperText>
            <div className="flex flex-wrap gap-2">
              {requiresExplicitSelection && hasExplicitSelection ? null : credentialValidation.status === "ready" ? (
                // In first-run the footer "Finish AI access setup" is the screen's one
                // primary; this in-panel step demotes to solid blue so the gradient
                // footer reads as primary (Restraint Charter: one primary action). In
                // the settings context there is no footer, so it stays the primary.
                <Button
                  type="button"
                  variant={requiresExplicitSelection ? "blue" : "blue-gradient"}
                  onClick={() => void saveByok()}
                  disabled={isSaving || isRemoving}
                >
                  {isSaving ? (
                    <Loader2
                      className="mr-2 h-4 w-4 animate-spin"
                      aria-hidden
                    />
                  ) : null}
                  Confirm and save
                </Button>
              ) : (
                <Button
                  type="button"
                  variant={requiresExplicitSelection ? "blue" : "blue-gradient"}
                  onClick={() => void validateByok()}
                  disabled={
                    isSaving ||
                    isRemoving ||
                    credentialValidation.status === "checking"
                  }
                >
                  {credentialValidation.status === "checking" ? (
                    <Loader2
                      className="mr-2 h-4 w-4 animate-spin"
                      aria-hidden
                    />
                  ) : null}
                  Validate key
                </Button>
              )}
              {hasSavedKey ? (
                <Button
                  type="button"
                  variant="none"
                  effect="fade"
                  onClick={() => void removeByok()}
                  disabled={isSaving || isRemoving}
                >
                  {isRemoving ? (
                    <Loader2
                      className="mr-2 h-4 w-4 animate-spin"
                      aria-hidden
                    />
                  ) : (
                    <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                  )}
                  Remove key
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </SettingsGroup>
      </div>
      </RadioPrimitive.Root>

      {/* Settings context only: on the first-run step the person can only choose
          Gemini, so other providers would compete with that one decision. */}
      {!requiresExplicitSelection ? (
        <BringYourOwnAiProviders userId={userId} vaultKey={vaultKey} vaultOwnerToken={vaultOwnerToken} needsVaultCreation={needsVaultCreation} needsUnlock={needsUnlock}
          onRequestVaultUnlock={onRequestVaultUnlock} onRequestVaultCreation={onRequestVaultCreation} onChanged={() => void refresh()} />
      ) : null}
    </div>
  );
}
