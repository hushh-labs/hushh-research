"use client";

import { useCallback, useEffect, useState } from "react";
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

import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import { KycIdentityProfileDraftService } from "@/lib/services/kyc-identity-profile-pkm-service";

export function EmailOnboardingSetupClient() {
  const { user } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const [enabled, setEnabled] = useState(false);
  const [loadState, setLoadState] = useState<PreferenceLoadState>("loading");
  const [saving, setSaving] = useState(false);
  const [identityPrefaceComplete, setIdentityPrefaceComplete] = useState(false);
  const [checkingIdentity, setCheckingIdentity] = useState(true);

  // Synchronously check local draft or asynchronously load from PKM identity domain
  useEffect(() => {
    if (!user?.uid) {
      setCheckingIdentity(false);
      return;
    }
    if (KycIdentityProfileDraftService.hasPending(user.uid)) {
      setIdentityPrefaceComplete(true);
      setCheckingIdentity(false);
      return;
    }
    if (!vaultKey || !vaultOwnerToken) {
      setCheckingIdentity(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const snapshot = await PkmDomainResourceService.getStaleFirst({
          userId: user.uid,
          domain: "identity",
          vaultKey,
          vaultOwnerToken,
        });
        const profile = snapshot?.data?.identity_profile as any;
        if (!cancelled && profile?.about_me?.trim()) {
          setIdentityPrefaceComplete(true);
        }
      } catch (err) {
        console.warn("[EmailOnboardingSetupClient] Failed to load existing identity profile:", err);
      } finally {
        if (!cancelled) {
          setCheckingIdentity(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, vaultKey, vaultOwnerToken]);

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
    settlementBlocked: saving,
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
    }
  }, [enabled, loadState, user, vaultKey, vaultOwnerToken]);

  const handleToggle = useCallback(
    (checked: boolean) => {
      if (!user?.uid || loadState !== "ready" || saving) return;
      void persistPreference(checked);
    },
    [loadState, persistPreference, saving, user?.uid],
  );

  if (!user || checkingIdentity) {
    return <SetupCapabilityLoading label="Preparing KYC setup…" />;
  }

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
          description="One finds requests. You approve every reply."
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
                disabled={saving || loadState !== "ready"}
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
        pending={saving}
      />
    </AppPageShell>
  );
}
