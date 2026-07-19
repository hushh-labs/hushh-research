"use client";

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
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
  onConfigured?: () => void;
};

export function GeminiRuntimeSettingsCard({
  userId,
  vaultKey,
  vaultOwnerToken,
  needsVaultCreation,
  needsUnlock,
  onRequestVaultUnlock,
  onRequestVaultCreation,
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
  const vaultReady = Boolean(userId && vaultKey && vaultOwnerToken);

  const refresh = useCallback(async () => {
    if (!vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      setMode("hushh_managed_vertex");
      setHasSavedKey(null);
      return;
    }
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
      setMode(savedMode === "byok" ? "byok" : "hushh_managed_vertex");
      setHasSavedKey(Boolean(savedKey));
      setTransport(savedTransport === "vertex_api_key" ? "vertex_api_key" : "developer_api");
      setVertexProject(savedProject || "");
      setVertexLocation(savedLocation || "global");
    } catch {
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
    setMode("hushh_managed_vertex");
    try {
      await persistMode("hushh_managed_vertex");
      notifyGeminiRuntimeConfigurationChanged();
      onConfigured?.();
      toast.success("Hushh managed Gemini is selected.");
    } catch {
      toast.error("Your choice could not be saved. Hushh managed Gemini remains the safe default.");
    }
  };

  const selectByok = () => {
    if (!vaultReady) {
      requestVault();
      return;
    }
    setMode("byok");
  };

  const saveByok = async () => {
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
    setIsSaving(true);
    try {
      await ApiService.validateGeminiRuntimeCredential({
        credential,
        transport,
        vertexProject: transport === "vertex_api_key" ? project : null,
        vertexLocation: transport === "vertex_api_key" ? location : null,
      });
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
      setDraftKey("");
      setMode("byok");
      setHasSavedKey(true);
      notifyGeminiRuntimeConfigurationChanged();
      onConfigured?.();
      toast.success("Your Gemini configuration is saved in your encrypted vault.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Gemini key could not be saved.");
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
              {mode === "hushh_managed_vertex" ? <Badge variant="secondary">Selected</Badge> : null}
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
              {mode === "byok" ? <Badge variant="secondary">Selected</Badge> : null}
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
                onChange={(event) => setTransport(event.target.value as GeminiRuntimeTransport)}
                disabled={isSaving || isRemoving}
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
                  onChange={(event) => setVertexProject(event.target.value)}
                  placeholder="Google Cloud project ID"
                  disabled={isSaving || isRemoving}
                  autoComplete="off"
                  aria-label="Google Cloud project ID"
                />
                <Input
                  value={vertexLocation}
                  onChange={(event) => setVertexLocation(event.target.value)}
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
              onChange={(event) => setDraftKey(event.target.value)}
              placeholder={transport === "vertex_api_key" ? "Paste a Google Cloud Vertex API key" : "Paste a Google AI Studio Gemini key"}
              disabled={isSaving || isRemoving}
              aria-label="Gemini API key"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void saveByok()} disabled={isSaving || isRemoving}>
                {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
                Validate and save
              </Button>
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
