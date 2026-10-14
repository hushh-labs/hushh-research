"use client";

import { RadioGroup as RadioPrimitive } from "radix-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { GeminiLogo } from "@/components/brand/gemini-logo";
import { GeminiKeyChoice, type CredentialValidationState } from "./gemini-key-choice";
import { Badge } from "@/components/ui/badge";
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
} from "@/lib/one/ai-selection-agent";
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


const CREDENTIAL_VALIDATION_TTL_MS = 60_000;

function assertRuntimeSecretStored(result: {
  success: boolean;
  conflict?: boolean;
}) {
  if (!result.success) {
    throw new Error(result.conflict ? "PKM_CONFLICT" : "PKM_WRITE_FAILED");
  }
}

export function GeminiRuntimeSettingsCard(
  props: GeminiRuntimeSettingsCardProps,
) {
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
    return () =>
      Boolean(
        mountedRef.current &&
        owner &&
        owner.userId === userId &&
        isValidatedAuthSessionOwnerCurrent(owner),
      );
  }, [userId]);
  const [mode, setMode] = useState<RuntimeCredentialMode>(
    "hushh_managed_vertex",
  );
  const [cloudAiVerified, setCloudAiVerified] = useState(false);
  const { placement, ownCloudProject } = useAiPlacement(captureOwnerGuard, setCloudAiVerified);
  const [showAiAlternatives, setShowAiAlternatives] = useState(false);
  const [pendingAiProviders, setPendingAiProviders] = useState<
    Record<string, boolean>
  >({});
  const externalAiPending = Object.values(pendingAiProviders).some(Boolean);
  const onProviderPendingChange = useCallback(
    (pending: boolean, provider: string) => {
      setPendingAiProviders((current) => ({ ...current, [provider]: pending }));
    },
    [],
  );
  const pathname = usePathname();

  const privateCloud = placement === "gcp" || placement === "azure";
  const defaultLabel =
    placement === "azure"
      ? "Use your Azure AI"
      : placement === "gcp"
        ? "Use your agent’s Vertex AI"
        : "Use Hussh's Gemini";
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
  const [selectedOption, setSelectedOption] = useState<string>(
    initiallyConfigured
      ? initialSetupChoice === "byok_pending_vault"
        ? "byok"
        : "hushh_managed_vertex"
      : "",
  );
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
    setSelectedOption(
      initiallyConfigured
        ? initialSetupChoice === "byok_pending_vault"
          ? "byok"
          : "hushh_managed_vertex"
        : "",
    );
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
      const [
        savedMode,
        savedKey,
        savedTransport,
        savedProject,
        savedLocation,
        savedProvider,
      ] = await Promise.all([
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
      if (
        !ownerIsCurrent() ||
        selectionRevisionRef.current !== selectionRevision
      )
        return;
      const restoredMode =
        savedMode === "byok" ? "byok" : "hushh_managed_vertex";
      setMode(restoredMode);
      setOtherProvider(
        restoredMode === "byok" && savedProvider && savedProvider !== "gemini"
          ? savedProvider
          : null,
      );
      if (requiresExplicitSelection) {
        setSelectedOption((current) => (current ? restoredMode : ""));
        if (
          restoredMode === "byok" &&
          (!savedProvider || savedProvider === "gemini") &&
          !savedKey
        )
          setHasExplicitSelection(false);
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
      if (
        !ownerIsCurrent() ||
        selectionRevisionRef.current !== selectionRevision
      )
        return;
      if (requiresExplicitSelection) setHasExplicitSelection(false);
      else setMode("hushh_managed_vertex");
      setHasSavedKey(false);
      setTransport("developer_api");
      setVertexProject("");
      setVertexLocation("global");
    }
  }, [
    captureOwnerGuard,
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
      if (!privateCloud && placement !== "shared")
        throw new Error("HOSTING_NOT_READY");
      const selection = privateCloud
        ? (await clearAgentAiSelectionFor(null, true)) === "failed"
          ? null
          : { agentScheduled: false, agentReason: "host already connected" }
        : await ApiService.selectManagedGeminiRuntime();
      if (!selection) throw new Error("AGENT_UNREACHABLE");
      if (!ownerIsCurrent()) return;
      if (!privateCloud && (await clearAgentAiSelectionFor(null)) === "failed")
        throw new Error("AGENT_UNREACHABLE");
      setCloudAiVerified(privateCloud);
      setShowAiAlternatives(false);
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
        privateCloud ? "Using your cloud’s AI." : "Using Hussh’s Gemini.",
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
    if (!privateCloud && placement !== "shared") return;
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
    if (!privateCloud && placement !== "shared") {
      setCredentialValidation({
        status: "error",
        message: "Confirm your hosting before choosing AI.",
      });
      return;
    }
    const credential = draftKey.trim();
    if (!credential) {
      setCredentialValidation({
        status: "error",
        message: "Enter your Gemini API key.",
      });
      return;
    }
    if (
      transport === "vertex_api_key" &&
      (!vertexProject.trim() || !vertexLocation.trim())
    ) {
      setCredentialValidation({
        status: "error",
        message: "Enter the Google Cloud project ID and Vertex location.",
      });
      return;
    }
    if (
      !requiresExplicitSelection &&
      (!vaultReady || !userId || !vaultKey || !vaultOwnerToken)
    ) {
      requestVault();
      return;
    }
    if (privateCloud) {
      await saveByok();
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
      if (!ownerIsCurrent() || credentialRevisionRef.current !== revision)
        return;
      setCredentialValidation({
        status: "ready",
        revision,
        validatedAt: Date.now(),
      });
    } catch (error) {
      if (!ownerIsCurrent() || credentialRevisionRef.current !== revision)
        return;
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
    if (!privateCloud && placement !== "shared") return;
    const credential = draftKey.trim();
    const validationIsFresh =
      credentialValidation.status === "ready" &&
      credentialValidation.revision === credentialRevisionRef.current &&
      Date.now() - credentialValidation.validatedAt <=
        CREDENTIAL_VALIDATION_TTL_MS;
    if (!privateCloud && !validationIsFresh) {
      setCredentialValidation({
        status: "error",
        message: "Validate this Gemini key before confirming it.",
      });
      return;
    }
    if (privateCloud && !vaultReady) {
      requestVault();
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
    let agentAccepted = false;
    try {
      if (privateCloud) {
        const outcome = await sendAiSelectionToAgent({
          provider: "gemini",
          model: null,
          apiKey: credential,
          transport,
          vertexProject:
            transport === "vertex_api_key" ? vertexProject.trim() : null,
          vertexLocation:
            transport === "vertex_api_key" ? vertexLocation.trim() : null,
        });
        if (!ownerIsCurrent()) return;
        if (!outcome.ok) {
          setCredentialValidation({
            status: "error",
            message:
              aiSelectionRefusalMessage(outcome.code, "Gemini") ??
              "Your private agent could not check this connection.",
          });
          return;
        }
        agentAccepted = true;
        setCloudAiVerified(false);
      }
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
      if (privateCloud)
        await recordSelectedAiProvider(
          { userId, vaultKey, vaultOwnerToken },
          "gemini",
        );
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
      if (!ownerIsCurrent()) return;
      if (agentRefusal)
        toast.error(agentRefusal); // the agent keeps its previous selection
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
      toast.error(
        agentAccepted
          ? "Your agent accepted the key, but its vault backup could not be saved. Retry saving."
          : "Gemini key could not be saved.",
      );
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
      if ((await clearAgentAiSelectionFor("gemini")) === "failed")
        throw new Error("AGENT_UNREACHABLE");
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
  const geminiKeyChoice = <GeminiKeyChoice isSaving={isSaving} isRemoving={isRemoving} privateCloud={privateCloud} placement={placement} requiresExplicitSelection={requiresExplicitSelection} vaultReady={Boolean(vaultReady)} selectedOption={selectedOption} mode={mode} hasExplicitSelection={hasExplicitSelection} otherProvider={Boolean(otherProvider)} hasSavedKey={Boolean(hasSavedKey)} needsVaultCreation={needsVaultCreation} needsUnlock={needsUnlock} transport={transport} vertexProject={vertexProject} vertexLocation={vertexLocation} draftKey={draftKey} credentialValidation={credentialValidation} selectByok={selectByok} setTransport={setTransport} setVertexProject={setVertexProject} setVertexLocation={setVertexLocation} setDraftKey={setDraftKey} invalidateCredentialValidation={invalidateCredentialValidation} saveByok={saveByok} validateByok={validateByok} removeByok={removeByok} />;
  const otherProviderChoices = (
    <BringYourOwnAiProviders
      onAccepted={() => setCloudAiVerified(false)}
      onPendingChange={onProviderPendingChange}
      showUnavailable={!requiresExplicitSelection}
      userId={userId}
      vaultKey={vaultKey}
      vaultOwnerToken={vaultOwnerToken}
      needsVaultCreation={needsVaultCreation}
      needsUnlock={needsUnlock}
      onRequestVaultUnlock={onRequestVaultUnlock}
      onRequestVaultCreation={onRequestVaultCreation}
      onChanged={async () => {
        setShowAiAlternatives(false);
        if (requiresExplicitSelection)
          await onSelectionReadyChange?.("byok_pending_vault");
        setHasExplicitSelection(true);
        setMode("byok");
        setSelectedOption("byok");
        await refresh();
      }}
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
        value={selectedOption}
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
            title="AI connection"
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
            <SettingsRow
              asChild
              leading={
                placement === "azure" ? undefined : (
                  <GeminiLogo className="h-8 w-8" />
                )
              }
              title={defaultLabel}
              disabled={
                isSaving ||
                isRemoving ||
                (!privateCloud && placement !== "shared")
              }
              description={
                placement === "azure"
                  ? `${cloudAiVerified ? "AI verified" : "Check AI connection"} · your Azure deployment`
                  : placement === "gcp"
                    ? `${cloudAiVerified ? "AI verified" : "Check AI connection"} · ${ownCloudProject ? "Vertex connection on your agent" : "Vertex connection"}`
                    : placement === "shared"
                      ? "Managed Gemini. No key needed."
                      : placement === "pending"
                        ? "Your cloud setup is still finishing."
                        : placement === "loading"
                          ? "Checking your hosting…"
                          : "Reconnect your hosting to choose its AI."
              }
              // The default we want people to take. Until it is chosen the row says
              // so out loud, so the fast path is the obvious one rather than the one
              // you work out by elimination.
              trailing={
                requiresExplicitSelection ? (
                  <span
                    aria-hidden
                    className="flex size-5 shrink-0 items-center justify-center rounded-full border border-muted-foreground"
                  >
                    {selectedOption === "hushh_managed_vertex" ? (
                      <span className="size-3 rounded-full bg-primary" />
                    ) : null}
                  </span>
                ) : mode === "hushh_managed_vertex" &&
                  hasExplicitSelection &&
                  !otherProvider ? (
                  <Badge variant="secondary">Selected</Badge>
                ) : (
                  <Badge variant="outline">Recommended</Badge>
                )
              }
              testId="profile-managed-runtime"
            >
              {requiresExplicitSelection ? (
                <RadioPrimitive.Item
                  value="hushh_managed_vertex"
                  onClick={() => {
                    if (
                      selectedOption === "hushh_managed_vertex" &&
                      (!hasExplicitSelection ||
                        (privateCloud && !cloudAiVerified))
                    )
                      void selectManaged();
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => void selectManaged()}
                  aria-pressed={mode === "hushh_managed_vertex"}
                />
              )}
            </SettingsRow>

            {!compactDefault ? geminiKeyChoice : null}
          </SettingsGroup>
        </div>
      </RadioPrimitive.Root>

      {!compactDefault ? otherProviderChoices : null}
    </div>
  );
}
