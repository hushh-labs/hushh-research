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
  CLAUDE_RUNTIME_CREDENTIAL_REF,
  GEMINI_RUNTIME_CREDENTIAL_REF,
  GROK_RUNTIME_CREDENTIAL_REF,
  OPENAI_RUNTIME_CREDENTIAL_REF,
  PersonalKnowledgeModelService,
  RUNTIME_CREDENTIAL_MODE_REF,
  type RuntimeCredentialMode,
} from "@/lib/services/personal-knowledge-model-service";

type RuntimeSecretProviderId = "gemini" | "claude" | "grok" | "openai";

type RuntimeSecretProviderConfig = {
  id: RuntimeSecretProviderId;
  label: string;
  credentialRef: string;
  placeholder: string;
};

const RUNTIME_SECRET_PROVIDERS: RuntimeSecretProviderConfig[] = [
  {
    id: "gemini",
    label: "Gemini",
    credentialRef: GEMINI_RUNTIME_CREDENTIAL_REF,
    placeholder: "Gemini API key",
  },
  {
    id: "claude",
    label: "Claude",
    credentialRef: CLAUDE_RUNTIME_CREDENTIAL_REF,
    placeholder: "Claude API key",
  },
  {
    id: "grok",
    label: "Grok",
    credentialRef: GROK_RUNTIME_CREDENTIAL_REF,
    placeholder: "Grok API key",
  },
  {
    id: "openai",
    label: "OpenAI",
    credentialRef: OPENAI_RUNTIME_CREDENTIAL_REF,
    placeholder: "OpenAI API key",
  },
];
const MASKED_RUNTIME_SECRET_PLACEHOLDER = "••••••••••••••••";

function emptyProviderState<T>(value: T): Record<RuntimeSecretProviderId, T> {
  return RUNTIME_SECRET_PROVIDERS.reduce(
    (state, provider) => ({ ...state, [provider.id]: value }),
    {} as Record<RuntimeSecretProviderId, T>,
  );
}

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
  const [draftKeys, setDraftKeys] = useState(() => emptyProviderState(""));
  const [configuredKeys, setConfiguredKeys] = useState(() =>
    emptyProviderState<boolean | null>(null),
  );
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [savingKeys, setSavingKeys] = useState(() => emptyProviderState(false));
  const [removingKeys, setRemovingKeys] = useState(() => emptyProviderState(false));
  const [savingMode, setSavingMode] = useState(false);
  const [showKeys, setShowKeys] = useState(() => emptyProviderState(false));
  const [revealedKeys, setRevealedKeys] = useState(() =>
    emptyProviderState<string | null>(null),
  );
  const [revealingKeys, setRevealingKeys] = useState(() => emptyProviderState(false));
  const [credentialMode, setCredentialMode] =
    useState<RuntimeCredentialMode>("hushh_managed_vertex");
  const vaultReady = Boolean(userId && vaultKey && vaultOwnerToken);

  const refreshStatus = useCallback(async () => {
    if (!userId || !vaultKey || !vaultOwnerToken) {
      setConfiguredKeys(emptyProviderState<boolean | null>(null));
      return;
    }
    setLoadingStatus(true);
    try {
      const secretResults = await Promise.all(
        RUNTIME_SECRET_PROVIDERS.map(async (provider) => {
          const secret = await PersonalKnowledgeModelService.loadRuntimeSecret({
            userId,
            vaultKey,
            vaultOwnerToken,
            credentialRef: provider.credentialRef,
          });
          return [provider.id, Boolean(secret)] as const;
        }),
      );
      const mode = await PersonalKnowledgeModelService.loadRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: RUNTIME_CREDENTIAL_MODE_REF,
      });
      const nextConfigured = emptyProviderState(false);
      const missingProviderIds: RuntimeSecretProviderId[] = [];
      for (const [providerId, configured] of secretResults) {
        nextConfigured[providerId] = configured;
        if (!configured) {
          missingProviderIds.push(providerId);
        }
      }
      setConfiguredKeys(nextConfigured);
      if (missingProviderIds.length > 0) {
        setRevealedKeys((current) => {
          const next = { ...current };
          for (const providerId of missingProviderIds) {
            next[providerId] = null;
          }
          return next;
        });
        setShowKeys((current) => {
          const next = { ...current };
          for (const providerId of missingProviderIds) {
            next[providerId] = false;
          }
          return next;
        });
      }
      setCredentialMode(mode === "byok" ? "byok" : "hushh_managed_vertex");
    } catch {
      setConfiguredKeys(emptyProviderState(false));
      setRevealedKeys(emptyProviderState<string | null>(null));
      setShowKeys(emptyProviderState(false));
    } finally {
      setLoadingStatus(false);
    }
  }, [userId, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleSave = async (provider: RuntimeSecretProviderConfig) => {
    const trimmedKey = draftKeys[provider.id].trim();
    if (needsVaultCreation) {
      onRequestVaultCreation();
      return;
    }
    if (needsUnlock || !vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      onRequestVaultUnlock();
      return;
    }
    if (!trimmedKey) {
      toast.error(`Enter a ${provider.label} API key before saving.`);
      return;
    }

    setSavingKeys((current) => ({ ...current, [provider.id]: true }));
    try {
      await PersonalKnowledgeModelService.storeRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: provider.credentialRef,
        secret: trimmedKey,
      });
      setDraftKeys((current) => ({ ...current, [provider.id]: "" }));
      setRevealedKeys((current) => ({ ...current, [provider.id]: null }));
      setShowKeys((current) => ({ ...current, [provider.id]: false }));
      setConfiguredKeys((current) => ({ ...current, [provider.id]: true }));
      toast.success(`${provider.label} key saved to your encrypted personal data.`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Couldn't save your ${provider.label} key.`;
      toast.error(message);
    } finally {
      setSavingKeys((current) => ({ ...current, [provider.id]: false }));
    }
  };

  const handleModeChange = async (useManaged: boolean) => {
    const nextMode: RuntimeCredentialMode = useManaged ? "hushh_managed_vertex" : "byok";
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
        credentialRef: RUNTIME_CREDENTIAL_MODE_REF,
        secret: nextMode,
      });
      setCredentialMode(nextMode);
      toast.success(
        nextMode === "byok"
          ? "Your saved Gemini key is selected."
          : "Hushh managed Gemini is selected."
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

  const handleRemove = async (provider: RuntimeSecretProviderConfig) => {
    if (needsVaultCreation) {
      onRequestVaultCreation();
      return;
    }
    if (needsUnlock || !vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      onRequestVaultUnlock();
      return;
    }

    setRemovingKeys((current) => ({ ...current, [provider.id]: true }));
    try {
      await PersonalKnowledgeModelService.removeRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: provider.credentialRef,
      });
      setDraftKeys((current) => ({ ...current, [provider.id]: "" }));
      setRevealedKeys((current) => ({ ...current, [provider.id]: null }));
      setShowKeys((current) => ({ ...current, [provider.id]: false }));
      setConfiguredKeys((current) => ({ ...current, [provider.id]: false }));
      toast.success(`${provider.label} key removed from your encrypted personal data.`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Couldn't remove your ${provider.label} key.`;
      toast.error(message);
    } finally {
      setRemovingKeys((current) => ({ ...current, [provider.id]: false }));
    }
  };

  const handleRevealToggle = async (provider: RuntimeSecretProviderConfig) => {
    if (showKeys[provider.id]) {
      setShowKeys((current) => ({ ...current, [provider.id]: false }));
      setRevealedKeys((current) => ({ ...current, [provider.id]: null }));
      return;
    }

    if (draftKeys[provider.id].trim() || !configuredKeys[provider.id]) {
      setShowKeys((current) => ({ ...current, [provider.id]: true }));
      return;
    }

    if (needsVaultCreation) {
      onRequestVaultCreation();
      return;
    }
    if (needsUnlock || !vaultReady || !userId || !vaultKey || !vaultOwnerToken) {
      onRequestVaultUnlock();
      return;
    }

    setRevealingKeys((current) => ({ ...current, [provider.id]: true }));
    try {
      const secret = await PersonalKnowledgeModelService.loadRuntimeSecret({
        userId,
        vaultKey,
        vaultOwnerToken,
        credentialRef: provider.credentialRef,
      });
      if (!secret) {
        setConfiguredKeys((current) => ({ ...current, [provider.id]: false }));
        toast.error(`No saved ${provider.label} key found in your encrypted personal data.`);
        return;
      }
      setRevealedKeys((current) => ({ ...current, [provider.id]: secret }));
      setShowKeys((current) => ({ ...current, [provider.id]: true }));
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Couldn't reveal your ${provider.label} key.`;
      toast.error(message);
    } finally {
      setRevealingKeys((current) => ({ ...current, [provider.id]: false }));
    }
  };

  const statusLabel = (providerId: RuntimeSecretProviderId) =>
    needsVaultCreation
      ? "Vault needed"
      : needsUnlock
        ? "Locked"
        : loadingStatus
          ? "Checking"
          : configuredKeys[providerId]
            ? "Saved"
            : "Not set";

  return (
    <SettingsGroup
      title="Runtime keys"
      description="Store model provider keys in your encrypted PKM vault."
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
                Model provider keys
              </p>
              <p className="text-[12px] leading-[1.45] text-muted-foreground">
                Encrypted in your PKM vault.
              </p>
            </div>
          </div>
          <Badge
            variant={
              RUNTIME_SECRET_PROVIDERS.some((provider) => configuredKeys[provider.id])
                ? "secondary"
                : "outline"
            }
            className="shrink-0"
          >
            {RUNTIME_SECRET_PROVIDERS.filter((provider) => configuredKeys[provider.id]).length} saved
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

        <div className="space-y-2">
          {RUNTIME_SECRET_PROVIDERS.map((provider) => {
            const saving = savingKeys[provider.id];
            const removing = removingKeys[provider.id];
            const revealing = revealingKeys[provider.id];
            const configured = configuredKeys[provider.id];
            const showKey = showKeys[provider.id];
            const draftKey = draftKeys[provider.id];
            const inputValue = revealedKeys[provider.id] ?? draftKey;
            const disabled =
              saving ||
              removing ||
              revealing ||
              needsVaultCreation ||
              needsUnlock;

            return (
              <div
                key={provider.id}
                className="grid gap-2 rounded-[var(--app-card-radius-compact)] border border-border/50 bg-background/35 p-2 md:grid-cols-[8rem_minmax(0,1fr)_auto]"
              >
                <div className="flex min-w-0 items-center justify-between gap-2 md:block">
                  <p className="truncate text-[13px] font-medium text-foreground">
                    {provider.label}
                  </p>
                  <Badge variant={configured ? "secondary" : "outline"} className="md:mt-1">
                    {statusLabel(provider.id)}
                  </Badge>
                </div>
                <div className="relative min-w-0">
                  <Input
                    value={inputValue}
                    onChange={(event) => {
                      setRevealedKeys((current) => ({
                        ...current,
                        [provider.id]: null,
                      }));
                      setDraftKeys((current) => ({
                        ...current,
                        [provider.id]: event.target.value,
                      }));
                    }}
                    type={showKey ? "text" : "password"}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    placeholder={
                      configured
                        ? MASKED_RUNTIME_SECRET_PLACEHOLDER
                        : provider.placeholder
                    }
                    aria-label={`${provider.label} API key`}
                    disabled={disabled}
                    className="h-10 rounded-[var(--app-card-radius-compact)] pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => void handleRevealToggle(provider)}
                    className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/15"
                    aria-label={
                      showKey
                        ? `Hide ${provider.label} API key`
                        : `Show ${provider.label} API key`
                    }
                    disabled={saving || removing || revealing}
                  >
                    {revealing ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : showKey ? (
                      <EyeOff className="h-4 w-4" aria-hidden />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden />
                    )}
                  </button>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 md:flex md:flex-nowrap">
                  <Button
                    onClick={() => void handleSave(provider)}
                    disabled={
                      saving ||
                      removing ||
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
                    onClick={() => void handleRemove(provider)}
                    disabled={saving || removing || !configured}
                    aria-label={`Remove saved ${provider.label} API key`}
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
            );
          })}
        </div>
      </div>
    </SettingsGroup>
  );
}
