"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import {
  SettingsGroup,
  SettingsRow,
} from "@/components/app-ui/settings-ui";
import {
  SetupCapabilityLoading,
  SetupCapabilityTerminalFooter,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { KycIdentityPreface } from "@/components/onboarding/setup/kyc-identity-preface";
import { Switch } from "@/components/ui/switch";
import { VaultUnlockDialog } from "@/components/vault/vault-unlock-dialog";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { isApplePrivateRelayEmail } from "@/lib/auth/private-relay";
import {
  loadEmailDraftingEnabled,
  saveEmailDraftingEnabled,
} from "@/lib/onboarding/email-drafting-preference";
import { OneKycClientZkService } from "@/lib/services/one-kyc-client-zk-service";
import { AccountService } from "@/lib/services/account-service";

type PreferenceLoadState = "loading" | "ready" | "error";

export function EmailOnboardingSetupClient() {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const [enabled, setEnabled] = useState(false);
  const [loadState, setLoadState] = useState<PreferenceLoadState>("loading");
  const [saving, setSaving] = useState(false);
  const [vaultOpen, setVaultOpen] = useState(false);
  const [enablePending, setEnablePending] = useState(false);
  const [identityPrefaceComplete, setIdentityPrefaceComplete] = useState(false);
  const enableAttemptRef = useRef(0);

  const loadPreference = useCallback(async () => {
    if (!user?.uid) return;
    setLoadState("loading");
    try {
      const idToken = await user.getIdToken();
      const value = await loadEmailDraftingEnabled({ userId: user.uid, idToken });
      setEnabled(value);
      setLoadState("ready");
    } catch {
      setEnabled(false);
      setLoadState("error");
      toast.error("KYC preference could not be loaded. Please try again.");
    }
  }, [user]);

  useEffect(() => {
    if (!user?.uid) {
      setEnabled(false);
      setLoadState("loading");
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoadState("loading");
      try {
        const idToken = await user.getIdToken();
        const value = await loadEmailDraftingEnabled({ userId: user.uid, idToken });
        if (!cancelled) {
          setEnabled(value);
          setLoadState("ready");
        }
      } catch {
        if (!cancelled) {
          setEnabled(false);
          setLoadState("error");
          toast.error("KYC preference could not be loaded. Please try again.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "email",
    isOperationallyReady: loadState === "ready",
    settlementBlocked: saving || enablePending,
    finishActionId: "setup.finish_email",
    skipActionId: "setup.skip_email",
  });

  const persistPreference = useCallback(async (checked: boolean) => {
    const previous = enabled;
    if (!user?.uid || loadState !== "ready") return;

    setEnabled(checked);
    setSaving(true);
    try {
      if (checked && vaultKey && vaultOwnerToken) {
        await OneKycClientZkService.ensureConnector({
          userId: user.uid,
          vaultKey,
          vaultOwnerToken,
        });
        if (isApplePrivateRelayEmail(user.email)) {
          const aliases = await AccountService.listEmailAliases(vaultOwnerToken);
          const verifiedSender = aliases.aliases.some(
            (alias) =>
              alias.verification_status === "verified" &&
              !isApplePrivateRelayEmail(alias.email),
          );
          if (!verifiedSender) {
            throw new Error("A verified non-relay sender is required.");
          }
        }
      }
      const idToken = await user.getIdToken();
      const saved = await saveEmailDraftingEnabled({
        userId: user.uid,
        idToken,
        enabled: checked,
      });
      if (!saved) {
        throw new Error("Preference save did not settle.");
      }
    } catch (error) {
      setEnabled(previous);
      toast.error(
        error instanceof Error && error.message.includes("non-relay")
          ? "Verify a non-relay sending address before enabling KYC."
          : "KYC preference could not be saved. Please try again.",
      );
    } finally {
      setSaving(false);
      setEnablePending(false);
    }
  }, [enabled, loadState, user, vaultKey, vaultOwnerToken]);

  const handleToggle = useCallback((checked: boolean) => {
    if (!user?.uid || loadState !== "ready" || saving || enablePending) return;
    if (checked && (!vaultKey || !vaultOwnerToken)) {
      setEnablePending(true);
      setVaultOpen(true);
      return;
    }
    void persistPreference(checked);
  }, [enablePending, loadState, persistPreference, saving, user?.uid, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    if (
      !enablePending ||
      !vaultKey ||
      !vaultOwnerToken ||
      enableAttemptRef.current !== 0
    ) return;
    const attempt = 1;
    enableAttemptRef.current = attempt;
    void persistPreference(true).finally(() => {
      if (enableAttemptRef.current === attempt) {
        enableAttemptRef.current = 0;
        setVaultOpen(false);
      }
    });
  }, [enablePending, persistPreference, vaultKey, vaultOwnerToken]);

  if (!user) return <SetupCapabilityLoading label="Preparing KYC setup…" />;

  if (!identityPrefaceComplete) {
    return <KycIdentityPreface onComplete={() => setIdentityPrefaceComplete(true)} />;
  }

  if (!coordinator.isReady) return <SetupCapabilityLoading label="Preparing KYC setup…" />;

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="space-y-4 pb-[calc(var(--app-bottom-inset)+1rem)]"
    >
      <AppPageHeaderRegion>
        <PageHeader
          title="KYC"
          description={`Requests must come from ${user?.email || "your verified email"}.`}
          accent="neutral"
        />
      </AppPageHeaderRegion>
      <AppPageContentRegion>
        <SettingsGroup
          title="Response preparation"
          description="This is off by default. When enabled, One recognizes requests sent from your verified email to one@hushh.ai. You still approve every response before it is sent."
          separatorInset
        >
          <SettingsRow
            title="Prepare automatically"
            description={
              loadState === "error"
                ? "Preference unavailable. Retry before finishing."
                : enabled
                ? "Enabled for one@hushh.ai"
                : isApplePrivateRelayEmail(user?.email)
                  ? "Private Relay needs a verified non-relay sending address"
                : "No email requests will trigger One"
            }
            trailing={
              <Switch
                checked={enabled}
                onCheckedChange={handleToggle}
                disabled={saving || enablePending || loadState !== "ready"}
                aria-label="Prepare KYC responses automatically"
                data-voice-control-id="one-setup-email-drafting-toggle"
              />
            }
          />
          {loadState === "error" ? (
            <SettingsRow
              title="Retry preference"
              description="Load the authoritative account preference again."
              onClick={() => void loadPreference()}
            />
          ) : null}
        </SettingsGroup>
      </AppPageContentRegion>
      <SetupCapabilityTerminalFooter
        capabilityId="email"
        isOperationallyReady={loadState === "ready"}
        coordinator={coordinator}
        pending={saving || enablePending}
      />
      {user ? (
        <VaultUnlockDialog
          user={user}
          open={vaultOpen}
          onOpenChange={(open) => {
            setVaultOpen(open);
            if (!open && !vaultOwnerToken) setEnablePending(false);
          }}
          title="Open your private vault"
          description="KYC uses your private vault to prepare consent-bound responses."
          allowVaultCreation={false}
          onSuccess={() => setEnablePending(true)}
        />
      ) : null}
    </AppPageShell>
  );
}
