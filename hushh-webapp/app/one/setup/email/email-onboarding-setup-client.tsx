"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import {
  SetupCapabilityLoading,
  SetupCapabilityTerminalFooter,
  useSetupCapabilityCoordinator,
} from "@/components/onboarding/setup/setup-capability-coordinator";
import { KycIdentityPreface } from "@/components/onboarding/setup/kyc-identity-preface";
import { CapabilityVaultPrerequisite } from "@/components/vault/capability-vault-prerequisite";
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

import { KycIdentityProfilePkmService } from "@/lib/services/kyc-identity-profile-pkm-service";

export function EmailOnboardingSetupClient() {
  const { user, userId } = useAuth();
  const { vaultKey, vaultOwnerToken } = useVault();
  const [enabled, setEnabled] = useState(false);
  const [loadState, setLoadState] = useState<PreferenceLoadState>("loading");
  const [saving, setSaving] = useState(false);
  const [identityStatus, setIdentityStatus] = useState<{
    ownerId: string; vaultKey: string | null; complete: boolean; checking: boolean;
  } | null>(null);
  const identityStatusCurrent = identityStatus?.ownerId === userId && identityStatus?.vaultKey === vaultKey;
  const identityPrefaceComplete = identityStatusCurrent && identityStatus?.complete;
  const checkingIdentity = Boolean(userId && vaultKey && vaultOwnerToken &&
    (!identityStatusCurrent || identityStatus?.checking));

  // The intake marker belongs to Soul's private envelope, not its Markdown.
  useEffect(() => {
    if (!userId || !vaultKey || !vaultOwnerToken) return;

    let cancelled = false;
    const setResult = (complete: boolean, checking: boolean) => {
      if (!cancelled) setIdentityStatus({ ownerId: userId, vaultKey, complete, checking });
    };
    setResult(false, true);
    void (async () => {
      try {
        const completed = await KycIdentityProfilePkmService.hasCompletedIntake({
          userId,
          vaultKey,
          vaultOwnerToken,
        });
        setResult(completed, false);
      } catch (err) {
        console.warn(
          "[EmailOnboardingSetupClient] Failed to load existing identity profile:",
          err,
        );
        // A failed protected read must not be interpreted as an incomplete KYC flow.
        setResult(true, false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, vaultKey, vaultOwnerToken]);

  const loadPreference = useCallback(async () => {
    if (!user || !userId) return;
    setLoadState("loading");
    try {
      const idToken = await user.getIdToken();
      const value = await loadEmailDraftingEnabled({
        userId,
        idToken,
      });
      setEnabled(value);
      setLoadState("ready");
    } catch {
      setEnabled(false);
      setLoadState("error");
      toast.error("Couldn't load this setting. Try again.");
    }
  }, [user, userId]);

  useEffect(() => {
    if (!user || !userId) {
      setEnabled(false);
      setLoadState("loading");
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoadState("loading");
      try {
        const idToken = await user.getIdToken();
        const value = await loadEmailDraftingEnabled({
          userId,
          idToken,
        });
        if (!cancelled) {
          setEnabled(value);
          setLoadState("ready");
        }
      } catch {
        if (!cancelled) {
          setEnabled(false);
          setLoadState("error");
          toast.error("Couldn't load this setting. Try again.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, userId]);

  const coordinator = useSetupCapabilityCoordinator({
    capabilityId: "email",
    isOperationallyReady: loadState === "ready",
    settlementBlocked: saving,
    finishActionId: "setup.finish_email",
    skipActionId: "setup.skip_email",
  });

  const persistPreference = useCallback(
    async (checked: boolean) => {
      const previous = enabled;
      if (!user || !userId || loadState !== "ready") return;

      setEnabled(checked);
      setSaving(true);
      try {
        if (checked && vaultKey && vaultOwnerToken) {
          await OneKycClientZkService.ensureConnector({
            userId,
            vaultKey,
            vaultOwnerToken,
          });
          if (isApplePrivateRelayEmail(user.email)) {
            const aliases =
              await AccountService.listEmailAliases(vaultOwnerToken);
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
        userId,
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
          ? "Verify a non-relay sending address first."
          : "Couldn't save this setting. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }, [enabled, loadState, user, userId, vaultKey, vaultOwnerToken]);

  const handleToggle = useCallback(
    (checked: boolean) => {
      if (!userId || loadState !== "ready" || saving) return;
      void persistPreference(checked);
    },
    [loadState, persistPreference, saving, userId],
  );

  if (!user || !userId || checkingIdentity) {
    return <SetupCapabilityLoading label="One moment…" />;
  }

  if (!identityPrefaceComplete) {
    return (
      <CapabilityVaultPrerequisite
        capabilityLabel="KYC"
        routeKey="/one/setup/email"
      >
        <KycIdentityPreface
          key={userId}
          onComplete={() => setIdentityStatus({ ownerId: userId, vaultKey, complete: true, checking: false })}
        />
      </CapabilityVaultPrerequisite>
    );
  }

  if (!coordinator.isReady) return <SetupCapabilityLoading label="One moment…" />;

  return (
    <AppPageShell
      as="main"
      width="reading"
      headerContentSpacing="compact"
      className="pb-[calc(var(--app-bottom-inset)+1rem)]"
      nativeTest={{
        routeId: "/one/setup/email",
        marker: "native-route-one-setup-email",
        authState: "authenticated",
        dataState:
          loadState === "loading"
            ? "loading"
            : loadState === "error"
              ? "unavailable-valid"
              : "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          // Matches the setup row. "KYC" is an abbreviation nobody meets for
          // the first time and understands; it stays in the code and the id.
          title="Identity checks"
          description={`Requests must come from ${user?.email || "your verified mail"}.`}
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
                    : "No mail requests will trigger One"
            }
            trailing={
              <Switch
                checked={enabled}
                onCheckedChange={handleToggle}
                disabled={saving || loadState !== "ready"}
                aria-label="Prepare replies automatically"
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
