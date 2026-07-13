"use client";

import { useState } from "react";
import { ArrowLeft, Check, type LucideIcon } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { getCapabilitySetupCopy } from "@/lib/onboarding/capability-setup-copy";
import { getOneCapability } from "@/lib/onboarding/one-capabilities";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import styles from "./one-setup-hub.module.css";

/**
 * OnboardingCapabilityStep — the shared, copy-driven setup screen rendered
 * at `/one/setup/<id>` for every capability.
 *
 * It lives inside the setup surface (allow-listed through the hard gate),
 * so a first-time user reaches it without being bounced back to `/one/setup`.
 *
 * Two flavors, both driven by the shared capability catalog + setup copy (no
 * bespoke per-capability UI):
 * - Explore-only capabilities (collect nothing): warm "here's what's in this
 *   tab" copy + a "Got it" primary action.
 * - Setup capabilities (need a connection or preferences): "what you'll do"
 *   copy + a "Continue" primary action that forwards to the live route, which
 *   owns the actual connect / OAuth flow.
 *
 * This component is presentational. The page wires `onPrimary` (resolve the gate
 * + mark explored + forward) and `onBack` (return to the hub).
 */
export interface OnboardingCapabilityStepProps {
  capabilityId: string;
  /** Invoked by the primary CTA. The page resolves the gate and forwards. */
  onPrimary: () => void;
  /** Invoked by the back affordance. The page returns to the setup hub. */
  onBack: () => void;
  /** Disables the CTA while the page resolves the gate. */
  busy?: boolean;
  /**
   * True when this capability's real workspace needs an unlocked vault and the
   * vault is currently locked. The step still forwards (the destination owns
   * the unlock prompt), but the CTA + helper copy set the honest expectation so
   * the person is not surprised by an unlock screen on the next step.
   */
  needsVaultUnlock?: boolean;
}

export function OnboardingCapabilityStep({
  capabilityId,
  onPrimary,
  onBack,
  busy = false,
  needsVaultUnlock = false,
}: OnboardingCapabilityStepProps) {
  const capability = getOneCapability(capabilityId);
  const copy = getCapabilitySetupCopy(capabilityId);
  const [acted, setActed] = useState(false);

  const isExploreOnly = capability?.isExploreOnly === true;

  const title = isExploreOnly
    ? copy?.exploreTitle ?? copy?.setupTitle ?? ""
    : copy?.setupTitle ?? "";
  const blurb = isExploreOnly
    ? copy?.exploreBlurb ?? copy?.setupBlurb ?? ""
    : copy?.setupBlurb ?? "";
  const bullets = isExploreOnly ? copy?.exploreBullets : copy?.setupBullets;
  const ctaLabel = isExploreOnly
    ? "Got it"
    : needsVaultUnlock
      ? "Unlock & continue"
      : "Continue";
  const subline = isExploreOnly
    ? "No setup required. Just explore."
    : needsVaultUnlock
      ? "A quick, one-time setup. You'll unlock your vault next."
      : "A quick, one-time setup.";

  // Publish screen context so the onboarding guide can explain this exact step.
  // Called before the early return below so hook order stays stable.
  usePublishVoiceSurfaceMetadata(
    capability && copy
      ? {
          screenId: `one_setup_${capabilityId}`,
          title,
          purpose: blurb,
          primaryEntity: capability.title,
          actions: [
            {
              id: "primary",
              actionId: "setup.capability_continue",
              label: ctaLabel,
              purpose: isExploreOnly
                ? "Acknowledge and continue."
                : "Start this setup.",
            },
            {
              id: "back",
              label: "Back to setup",
              purpose: "Return to the setup home.",
            },
          ],
        }
      : null
  );

  if (!capability || !copy) {
    return null;
  }

  const Icon: LucideIcon = capability.icon;

  function handlePrimary() {
    if (busy || acted) return;
    setActed(true);
    onPrimary();
  }

  return (
    <AppPageShell
      as="main"
      width="content"
      className="space-y-4 px-4 py-4 pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:px-6"
      nativeTest={{
        routeId: "/one/setup/[capability]",
        marker: "native-route-one-setup-capability",
        authState: "authenticated",
        dataState: "loaded",
      }}
    >
      <AppPageHeaderRegion>
        <PageHeader
          eyebrow="Set up One"
          title={title}
          description={blurb}
          icon={Icon}
          accent="neutral"
          className={styles.stepHeader}
          actions={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onBack}
              disabled={busy}
            >
              <ArrowLeft className="size-4" />
              Back
            </Button>
          }
        />
      </AppPageHeaderRegion>

      <AppPageContentRegion>
        <div className="space-y-4">
          <SettingsGroup
            testId="one-setup-capability-details"
            separatorInset
            className={styles.stepGroup}
          >
            <SettingsRow
              leading={
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-accent-border bg-accent-surface text-accent-strong">
                  <Icon className="h-5 w-5" aria-hidden />
                </span>
              }
              title={capability.title}
              description={subline}
            />

            {bullets && bullets.length > 0
              ? bullets.map((bullet) => (
                <SettingsRow
                  key={bullet}
                  leading={
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-foreground/70">
                      <Check className="h-4 w-4" aria-hidden />
                    </span>
                  }
                  title={bullet}
                />
              ))
              : null}
          </SettingsGroup>

          <Button
            type="button"
            size="lg"
            className="h-12 w-full rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={handlePrimary}
            disabled={busy || acted}
            data-testid="one-setup-capability-primary"
            data-voice-control-id="one_setup_capability_primary"
          >
            {ctaLabel}
          </Button>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
