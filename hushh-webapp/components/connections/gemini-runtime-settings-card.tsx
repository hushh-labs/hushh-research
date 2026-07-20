"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, KeyRound, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/lib/morphy-ux/button";
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
  onConfigured?: () => void | Promise<void>;
};

type CredentialValidationState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ready"; validatedAt: number; revision: number }
  | { status: "error"; message: string };

const CREDENTIAL_VALIDATION_TTL_MS = 60_000;

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
  onConfigured,
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
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) return;
    await PersonalKnowledgeModelService.storeRuntimeSecret({
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
  };

  const selectManaged = async () => {
    selectionRevisionRef.current += 1;
    setMode("hushh_managed_vertex");
    try {
      await persistMode("hushh_managed_vertex");
      await onConfigured?.();
      setHasExplicitSelection(true);
      notifyGeminiRuntimeConfigurationChanged();
      toast.success("Hushh managed Gemini is selected.");
    } catch {
      toast.error("Your choice could not be saved. Please try again.");
    }
  };

  const selectByok = () => {
    if (!vaultReady) {
      requestVault();
      return;
    }
    selectionRevisionRef.current += 1;
    setMode("byok");
  };

  const validateByok = async () => {
    const credential = draftKey.trim();
    const project = vertexProject.trim();
    const location = vertexLocation.trim();
    if (!credential) {
      toast.error("Enter your Gemini API key.");
      return;
    }
    if (transport === "vertex_api_key" && (!project || !location)) {
      toast.error("Enter the Google Cloud project ID and Vertex location.");
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
        vertexProject: transport === "vertex_api_key" ? project : null,
        vertexLocation: transport === "vertex_api_key" ? location : null,
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
    const credential = draftKey.trim();
    const project = vertexProject.trim();
    const location = vertexLocation.trim();
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
    try {
      await PersonalKnowledgeModelService.storeRuntimeSecret({
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
      await Promise.all([
        PersonalKnowledgeModelService.storeRuntimeSecret({
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
        }),
        PersonalKnowledgeModelService.storeRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_VERTEX_PROJECT_REF,
          secret: transport === "vertex_api_key" ? project : "",
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "connections_gemini_vertex_project",
          },
        }),
        PersonalKnowledgeModelService.storeRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_VERTEX_LOCATION_REF,
          secret: transport === "vertex_api_key" ? location : "",
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "connections_gemini_vertex_location",
          },
        }),
      ]);
      await persistMode("byok");
      await onConfigured?.();
      setDraftKey("");
      invalidateCredentialValidation();
      setMode("byok");
      setHasSavedKey(true);
      setHasExplicitSelection(true);
      notifyGeminiRuntimeConfigurationChanged();
      toast.success("Your Gemini configuration is saved in your encrypted vault.");
    } catch {
      toast.error("Gemini key could not be saved.");
    } finally {
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
      await PersonalKnowledgeModelService.removeRuntimeSecret({
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
      await Promise.all([
        PersonalKnowledgeModelService.removeRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_RUNTIME_TRANSPORT_REF,
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "connections_gemini_transport_remove",
          },
        }),
        PersonalKnowledgeModelService.removeRuntimeSecret({
          userId,
          vaultKey,
          vaultOwnerToken,
          credentialRef: GEMINI_VERTEX_PROJECT_REF,
          confirmation: {
            confirmedByUser: true,
            surface: "web",
            source: "connections_gemini_vertex_project_remove",
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
            source: "connections_gemini_vertex_location_remove",
          },
        }),
      ]);
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
      description="Choose how your private agent runs."
      testId="connections-gemini-runtime"
    >
      <div className="space-y-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
        <button
          type="button"
          onClick={() => void selectManaged()}
          className="flex w-full items-start gap-3 rounded-[var(--app-card-radius-compact)] border border-border/60 bg-background/45 p-3 text-left transition-colors hover:bg-muted/35"
          aria-pressed={mode === "hushh_managed_vertex"}
        >
          <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-muted/65 text-muted-foreground">
            <KeyRound className="h-4 w-4" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-3 text-[14px] font-medium text-foreground">
              Hushh managed Gemini
              {mode === "hushh_managed_vertex" && hasExplicitSelection ? <Badge variant="secondary">Selected</Badge> : null}
            </span>
            <span className="mt-1 block text-[12px] leading-[1.45] text-muted-foreground">
              Uses Hushh-operated Vertex with workload identity. No vault or key is needed.
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={selectByok}
          className="flex w-full items-start gap-3 rounded-[var(--app-card-radius-compact)] border border-border/60 bg-background/45 p-3 text-left transition-colors hover:bg-muted/35"
          aria-pressed={mode === "byok"}
        >
          <span className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-muted/65 text-muted-foreground">
            <KeyRound className="h-4 w-4" aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-3 text-[14px] font-medium text-foreground">
              Use my Gemini API key
              {mode === "byok" && hasExplicitSelection ? <Badge variant="secondary">Selected</Badge> : null}
            </span>
            <span className="mt-1 block text-[12px] leading-[1.45] text-muted-foreground">
              Choose Google AI Studio or a Google Cloud Vertex API key. It stays encrypted in your vault and is used only for your private-agent turns.
            </span>
          </span>
        </button>

        {mode === "byok" ? (
          <div className="space-y-2 rounded-[var(--app-card-radius-compact)] border border-border/50 bg-background/35 p-3">
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
                <option value="vertex_api_key">Google Cloud Vertex</option>
              </select>
            </label>
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
      </div>
    </SettingsGroup>
  );
}
