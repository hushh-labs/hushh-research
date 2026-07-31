"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, KeyRound, Loader2, Trash2 } from "lucide-react";

import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/lib/morphy-ux/button";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";
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
  onSelectionReadyChange?: (
    choice: OneRuntimeSetupChoice,
  ) => void | Promise<void>;
};

type CredentialValidationState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; validatedAt: number; revision: number }
  | { status: "error"; message: string };

const CREDENTIAL_VALIDATION_TTL_MS = 60_000;

function assertRuntimeSecretStored(result: { success: boolean; conflict?: boolean }) {
  if (!result.success) {
    throw new Error(result.conflict ? "PKM_CONFLICT" : "PKM_WRITE_FAILED");
  }
}

export function GeminiRuntimeSettingsCard({
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
}: GeminiRuntimeSettingsCardProps) {
  const [mode, setMode] = useState<RuntimeCredentialMode>("hushh_managed_vertex");
  const [hasSavedKey, setHasSavedKey] = useState<boolean | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [transport, setTransport] = useState<GeminiRuntimeTransport>("developer_api");
  const [vertexProject, setVertexProject] = useState("");
  const [vertexLocation, setVertexLocation] = useState("global");
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const [credentialValidation, setCredentialValidation] =
    useState<CredentialValidationState>({ status: "idle" });
  const credentialRevisionRef = useRef(0);
  const selectionRevisionRef = useRef(0);
  const selectionPendingRef = useRef(false);
  const [hasExplicitSelection, setHasExplicitSelection] = useState(
    !requiresExplicitSelection || initiallyConfigured,
  );
  const vaultReady = Boolean(userId && vaultKey && vaultOwnerToken);

  const invalidateCredentialValidation = useCallback(() => {
    credentialRevisionRef.current += 1;
    setCredentialValidation({ status: "idle" });
  }, []);

  useEffect(() => {
    setHasExplicitSelection(
      !requiresExplicitSelection || initiallyConfigured,
    );
  }, [initiallyConfigured, requiresExplicitSelection]);

  useEffect(() => {
    if (!requiresExplicitSelection) return;
    setMode(
      initialSetupChoice === "byok_pending_vault"
        ? "byok"
        : "hushh_managed_vertex",
    );
  }, [initialSetupChoice, requiresExplicitSelection]);

  const refresh = useCallback(async () => {
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      setMode("hushh_managed_vertex");
      setHasSavedKey(null);
      return;
    }
    const selectionRevision = selectionRevisionRef.current;
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
      if (selectionRevisionRef.current !== selectionRevision) return;
      setMode(savedMode === "byok" ? "byok" : "hushh_managed_vertex");
      setHasSavedKey(Boolean(savedKey));
      setTransport(savedTransport === "vertex_api_key" ? "vertex_api_key" : "developer_api");
      setVertexProject(savedProject || "");
      setVertexLocation(savedLocation || "global");
    } catch {
      if (selectionRevisionRef.current !== selectionRevision) return;
      setMode("hushh_managed_vertex");
      setHasSavedKey(false);
      setTransport("developer_api");
      setVertexProject("");
      setVertexLocation("global");
    }
  }, [userId, vaultKey, vaultOwnerToken, vaultReady]);

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
        source: "connections_gemini_runtime_mode",
      },
    });
    assertRuntimeSecretStored(result);
  };

  const selectManaged = async () => {
    if (selectionPendingRef.current) return;
    selectionPendingRef.current = true;
    selectionRevisionRef.current += 1;
    const previousMode = mode;
    const previousSelection = hasExplicitSelection;
    try {
      if (requiresExplicitSelection) {
        await onSelectionReadyChange?.("hushh_managed_vertex");
      } else {
        await persistMode("hushh_managed_vertex");
      }
      setMode("hushh_managed_vertex");
      setHasExplicitSelection(true);
      notifyGeminiRuntimeConfigurationChanged();
      toast.success("Hushh managed Gemini is selected.");
    } catch (error) {
      setMode(previousMode);
      setHasExplicitSelection(previousSelection);
      toast.error(
        error instanceof Error && error.message === "PKM_CONFLICT"
          ? "This setting changed on another device. Refresh and try again."
          : requiresExplicitSelection
            ? "We couldn’t save this setup choice. Try again."
            : "Open your private vault again, then try this setting.",
      );
    } finally {
      selectionPendingRef.current = false;
    }
  };

  const selectByok = async () => {
    if (selectionPendingRef.current) return;
    if (requiresExplicitSelection && !vaultReady) {
      selectionPendingRef.current = true;
      const previousMode = mode;
      const previousSelection = hasExplicitSelection;
      try {
        await onSelectionReadyChange?.("byok_pending_vault");
        setMode("byok");
        setHasExplicitSelection(true);
        toast.success("Your Gemini key can be added privately after setup.");
      } catch {
        setMode(previousMode);
        setHasExplicitSelection(previousSelection);
        toast.error("We couldn’t save this setup choice. Try again.");
      } finally {
        selectionPendingRef.current = false;
      }
      return;
    }
    if (!vaultReady) {
      requestVault();
      return;
    }
    selectionRevisionRef.current += 1;
    setMode("byok");
  };

  const validateByok = async () => {
    const credential = draftKey.trim();
    if (!credential) {
      toast.error("Enter your Gemini API key.");
      return;
    }
    if (transport === "vertex_api_key") {
      toast.error(
        "Vertex API-key transport is unavailable. Use Hushh managed Vertex or a Google AI Studio key.",
      );
      return;
    }
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      requestVault();
      return;
    }
    const revision = credentialRevisionRef.current;
    setCredentialValidation({ status: "checking" });
    try {
      await ApiService.validateGeminiRuntimeCredential({
        credential,
        transport,
        vertexProject: null,
        vertexLocation: null,
      });
      if (credentialRevisionRef.current !== revision) return;
      setCredentialValidation({ status: "ready", revision, validatedAt: Date.now() });
    } catch (error) {
      if (credentialRevisionRef.current !== revision) return;
      const message =
        error instanceof Error
          ? error.message
          : "Gemini could not be reached to validate this key.";
      setCredentialValidation({ status: "error", message });
    }
  };

  const saveByok = async () => {
    if (selectionPendingRef.current) return;
    if (transport === "vertex_api_key") {
      toast.error(
        "Vertex API-key transport is unavailable. Choose Google AI Studio or Hushh managed Gemini.",
      );
      return;
    }
    const credential = draftKey.trim();
    const validationIsFresh =
      credentialValidation.status === "ready" &&
      credentialValidation.revision === credentialRevisionRef.current &&
      Date.now() - credentialValidation.validatedAt <= CREDENTIAL_VALIDATION_TTL_MS;
    if (!validationIsFresh) {
      setCredentialValidation({ status: "idle" });
      toast.error("Validate this Gemini key before confirming it.");
      return;
    }
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      requestVault();
      return;
    }
    setIsSaving(true);
    selectionPendingRef.current = true;
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
          source: "connections_gemini_api_key",
        },
      });
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
            source: "connections_gemini_transport",
          },
        });
      assertRuntimeSecretStored(transportResult);
      const projectResult = await PersonalKnowledgeModelService.storeRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_VERTEX_PROJECT_REF,
          secret: "",
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "connections_gemini_vertex_project",
          },
        });
      assertRuntimeSecretStored(projectResult);
      const locationResult = await PersonalKnowledgeModelService.storeRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_VERTEX_LOCATION_REF,
          secret: "",
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "connections_gemini_vertex_location",
          },
        });
      assertRuntimeSecretStored(locationResult);
      await persistMode("byok");
      setDraftKey("");
      invalidateCredentialValidation();
      setMode("byok");
      setHasSavedKey(true);
      setHasExplicitSelection(true);
      if (requiresExplicitSelection) {
        await onSelectionReadyChange?.("byok_pending_vault");
      }
      notifyGeminiRuntimeConfigurationChanged();
      toast.success("Your Gemini configuration is saved in your encrypted vault.");
    } catch {
      toast.error("Gemini key could not be saved.");
    } finally {
      selectionPendingRef.current = false;
      setIsSaving(false);
    }
  };

  const removeByok = async () => {
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      requestVault();
      return;
    }
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
          source: "connections_gemini_api_key_remove",
        },
      });
      assertRuntimeSecretStored(credentialResult);
      const transportResult = await PersonalKnowledgeModelService.removeRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_RUNTIME_TRANSPORT_REF,
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "connections_gemini_transport_remove",
          },
        });
      assertRuntimeSecretStored(transportResult);
      const projectResult = await PersonalKnowledgeModelService.removeRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_VERTEX_PROJECT_REF,
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "connections_gemini_vertex_project_remove",
          },
        });
      assertRuntimeSecretStored(projectResult);
      const locationResult = await PersonalKnowledgeModelService.removeRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_VERTEX_LOCATION_REF,
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "connections_gemini_vertex_location_remove",
          },
        });
      assertRuntimeSecretStored(locationResult);
      await persistMode("hushh_managed_vertex");
      selectionRevisionRef.current += 1;
      setMode("hushh_managed_vertex");
      setHasSavedKey(false);
      notifyGeminiRuntimeConfigurationChanged();
      toast.success("Your saved Gemini key was removed.");
    } catch {
      toast.error("Your Gemini key could not be removed.");
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <SettingsGroup
      title="Gemini"
      description="Choose how your private agent reaches Gemini."
      testId="connections-gemini-runtime"
      separatorInset
    >
      <SettingsRow
        asChild
        icon={KeyRound}
        iconTone="blue"
        title="Hushh managed Gemini"
        description="Ready now with Hushh-managed Gemini. No personal key is needed."
        trailing={
          mode === "hushh_managed_vertex" && hasExplicitSelection ? (
            <Badge variant="secondary">Selected</Badge>
          ) : null
        }
        testId="connections-managed-runtime"
      >
        <button
          type="button"
          onClick={() => void selectManaged()}
          aria-pressed={mode === "hushh_managed_vertex"}
        />
      </SettingsRow>

      <SettingsRow
        asChild
        icon={KeyRound}
        iconTone="purple"
        title="Use my Gemini API key"
        description={
          requiresExplicitSelection && !vaultReady
            ? "Choose this now. Add and encrypt your Google AI Studio key after setup."
            : "Use a Google AI Studio key encrypted only in your private vault."
        }
        trailing={
          mode === "byok" && hasExplicitSelection ? (
            <Badge variant="secondary">Selected</Badge>
          ) : null
        }
        testId="connections-byok-runtime"
      >
        <button
          type="button"
          onClick={() => void selectByok()}
          aria-pressed={mode === "byok"}
        />
      </SettingsRow>

      {mode === "byok" && requiresExplicitSelection && !vaultReady ? (
        <p className="px-[var(--settings-row-px)] pb-[var(--settings-row-py)] text-[13px] leading-5 text-muted-foreground">
          Your key has not been entered or saved. Finish setup, then create or open your private vault to add it.
        </p>
      ) : null}

      {mode === "byok" && !(requiresExplicitSelection && !vaultReady) ? (
          <div className="space-y-2 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
            <div className="flex items-center justify-between gap-3">
              <p className="text-[13px] font-medium text-foreground">Gemini connection</p>
              <Badge variant={hasSavedKey ? "secondary" : "outline"}>
                {needsVaultCreation ? "Vault needed" : needsUnlock ? "Locked" : hasSavedKey ? "Saved" : "Not set"}
              </Badge>
            </div>
            <label className="block space-y-1 text-[12px] text-muted-foreground">
              API endpoint
              <select
                value={transport}
                onChange={(event) => {
                  setTransport(event.target.value as GeminiRuntimeTransport);
                  invalidateCredentialValidation();
                }}
                disabled={isSaving || isRemoving || credentialValidation.status === "checking"}
                className="h-10 w-full rounded-[var(--app-card-radius-compact)] border border-input bg-background px-3 text-[14px] text-foreground"
              >
                <option value="developer_api">Google AI Studio</option>
                <option value="vertex_api_key" disabled>
                  Google Cloud Vertex API key (unavailable)
                </option>
              </select>
            </label>
            {transport === "vertex_api_key" ? (
              <p className="text-[12px] leading-5 text-amber-700 dark:text-amber-300">
                This saved transport is disabled. Select Google AI Studio for BYOK, or use
                Hushh managed Gemini for Vertex workload identity.
              </p>
            ) : null}
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
              placeholder={transport === "vertex_api_key" ? "Paste a Google Cloud Vertex API key" : "Paste a Google AI Studio Gemini key"}
              disabled={isSaving || isRemoving}
              aria-label="Gemini API key"
            />
            <div
              className="min-h-5 text-[12px] leading-5 text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {credentialValidation.status === "checking" ? (
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
            </div>
            <div className="flex flex-wrap gap-2">
              {credentialValidation.status === "ready" ? (
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
                    credentialValidation.status === "checking" ||
                    !draftKey.trim()
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
  );
}
