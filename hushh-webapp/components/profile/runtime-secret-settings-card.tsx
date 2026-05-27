"use client";

import { useCallback, useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { SettingsGroup } from "@/components/profile/settings-ui";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/lib/morphy-ux/morphy";
import {
  KAI_GEMINI_RUNTIME_CREDENTIAL_REF,
  KAI_RUNTIME_CREDENTIAL_MODE_REF,
  PersonalKnowledgeModelService,
  type KaiRuntimeCredentialMode,
} from "@/lib/services/personal-knowledge-model-service";

type RuntimeSecretSettingsCardProps = {
  userId?: string | null;
  vaultKey?: string | null;
  vaultOwnerToken?: string | null;
  needsVaultCreation: boolean;
  needsUnlock: boolean;
  onRequestVaultUnlock: () => void;
  onRequestVaultCreation: () => void;
};

export function RuntimeSecretSettingsCard({
  userId,
  vaultKey,
  vaultOwnerToken,
  needsVaultCreation,
  needsUnlock,
  onRequestVaultUnlock,
  onRequestVaultCreation,
}: RuntimeSecretSettingsCardProps) {
  const [draftKey, setDraftKey] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [savingMode, setSavingMode] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [credentialMode, setCredentialMode] = useState<KaiRuntimeCredentialMode>("byok");
  const vaultReady = Boolean(userId && vaultKey && vaultOwnerToken);

  const refreshStatus = useCallback(async () => {
    if (!userId || !vaultKey || !vaultOwnerToken) {
      setConfigured(null);
      return;
    }
    setLoadingStatus(true);
    try {
      const secret = await PersonalKnowledgeModelService.loadRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: KAI_GEMINI_RUNTIME_CREDENTIAL_REF,
      });
      const mode = await PersonalKnowledgeModelService.loadRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: KAI_RUNTIME_CREDENTIAL_MODE_REF,
      });
      setConfigured(Boolean(secret));
      setCredentialMode(mode === "hushh_managed_vertex" ? "hushh_managed_vertex" : "byok");
    } catch {
      setConfigured(false);
    } finally {
      setLoadingStatus(false);
    }
  }, [userId, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleSave = async () => {
    const trimmedKey = draftKey.trim();
    if (needsVaultCreation) {
      onRequestVaultCreation();
      return;
    }
    if (needsUnlock || !vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      onRequestVaultUnlock();
      return;
    }
    if (!trimmedKey) {
      toast.error("Enter a Gemini API key before saving.");
      return;
    }

    setSaving(true);
    try {
      await PersonalKnowledgeModelService.storeRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: KAI_GEMINI_RUNTIME_CREDENTIAL_REF,
        secret: trimmedKey,
      });
      setDraftKey("");
      setConfigured(true);
      toast.success("Gemini key saved to your encrypted personal data.");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't save your Gemini key.";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleModeChange = async (useManaged: boolean) => {
    const nextMode: KaiRuntimeCredentialMode = useManaged ? "hushh_managed_vertex" : "byok";
    if (needsVaultCreation) {
      onRequestVaultCreation();
      return;
    }
    if (needsUnlock || !vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      onRequestVaultUnlock();
      return;
    }

    setSavingMode(true);
    try {
      await PersonalKnowledgeModelService.storeRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: KAI_RUNTIME_CREDENTIAL_MODE_REF,
        secret: nextMode,
      });
      setCredentialMode(nextMode);
      toast.success(
        nextMode === "byok"
          ? "Kai will use your Gemini key."
          : "Kai will use Hushh managed Gemini."
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't update Kai model access.";
      toast.error(message);
    } finally {
      setSavingMode(false);
    }
  };

  const handleRemove = async () => {
    if (needsVaultCreation) {
      onRequestVaultCreation();
      return;
    }
    if (needsUnlock || !vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      onRequestVaultUnlock();
      return;
    }

    setRemoving(true);
    try {
      await PersonalKnowledgeModelService.removeRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: KAI_GEMINI_RUNTIME_CREDENTIAL_REF,
      });
      setDraftKey("");
      setConfigured(false);
      toast.success("Gemini key removed from your encrypted personal data.");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Couldn't remove your Gemini key.";
      toast.error(message);
    } finally {
      setRemoving(false);
    }
  };

  const statusLabel = needsVaultCreation
    ? "Vault needed"
    : needsUnlock
      ? "Locked"
      : loadingStatus
        ? "Checking"
        : configured
          ? "Saved"
          : "Not set";

  return (
    <SettingsGroup
      title="Kai BYOK"
      description="Use your own Gemini key for Kai."
      testId="runtime-secret-settings"
    >
      <div className="space-y-3 px-[var(--settings-row-px)] py-[var(--settings-row-py)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-muted/65 text-muted-foreground">
              <KeyRound className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-medium tracking-tight text-foreground">
                Gemini key
              </p>
              <p className="text-[12px] leading-[1.45] text-muted-foreground">
                Encrypted in your PKM vault.
              </p>
            </div>
          </div>
          <Badge variant={configured ? "secondary" : "outline"} className="shrink-0">
            {statusLabel}
          </Badge>
        </div>

        <div className="flex min-h-12 items-center justify-between gap-4 rounded-[var(--app-card-radius-compact)] border border-border/60 bg-background/45 px-3 py-2">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">
              Use Hushh managed Gemini
            </p>
            <p className="text-[12px] leading-[1.4] text-muted-foreground">
              Turn off to use your saved Gemini key.
            </p>
          </div>
          <Switch
            checked={credentialMode === "hushh_managed_vertex"}
            onCheckedChange={(checked) => void handleModeChange(checked)}
            disabled={savingMode || needsVaultCreation || needsUnlock}
            aria-label="Use Hushh managed Gemini"
          />
        </div>

        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="relative min-w-0">
            <Input
              value={draftKey}
              onChange={(event) => setDraftKey(event.target.value)}
              type={showKey ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder={
                configured
                  ? "Replace saved Gemini key"
                  : "Gemini API key"
              }
              aria-label="Gemini API key"
              disabled={
                saving ||
                removing ||
                needsVaultCreation ||
                needsUnlock ||
                credentialMode === "hushh_managed_vertex"
              }
              className="h-10 rounded-[var(--app-card-radius-compact)] pr-10"
            />
            <button
              type="button"
              onClick={() => setShowKey((current) => !current)}
              className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
              aria-label={showKey ? "Hide Gemini API key" : "Show Gemini API key"}
              disabled={saving || removing}
            >
              {showKey ? (
                <EyeOff className="h-4 w-4" aria-hidden />
              ) : (
                <Eye className="h-4 w-4" aria-hidden />
              )}
            </button>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 md:flex md:flex-nowrap">
            <Button
              onClick={() => void handleSave()}
              disabled={
                saving ||
                removing ||
                credentialMode === "hushh_managed_vertex" ||
                (!draftKey.trim() && vaultReady)
              }
              className="h-10 min-w-[6.5rem]"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  Saving...
                </>
              ) : needsVaultCreation ? (
                "Create vault"
              ) : needsUnlock || !vaultReady ? (
                "Unlock vault"
              ) : (
                "Save"
              )}
            </Button>
            <Button
              variant="none"
              effect="fade"
              onClick={() => void handleRemove()}
              disabled={saving || removing || !configured}
              aria-label="Remove saved Gemini API key"
              className="h-10 min-w-[5.5rem]"
            >
              {removing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                  Removing...
                </>
              ) : (
                <>
                  <Trash2 className="mr-2 h-4 w-4" aria-hidden />
                  Remove
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </SettingsGroup>
  );
}
