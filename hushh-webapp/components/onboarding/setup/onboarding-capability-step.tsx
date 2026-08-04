"use client";

import { useState } from "react";
import { ArrowLeft, Check } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { PageHeader } from "@/components/app-ui/page-sections";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { SetupCompletionFooter } from "@/components/onboarding/setup/setup-completion-footer";
import { getCapabilitySetupCopy } from "@/lib/onboarding/capability-setup-copy";
import { getOneSetupCapability } from "@/lib/onboarding/one-capabilities";
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
  /** Explicitly leaves an unfinished setup without recording completion. */
  onSkip: () => void;
  /** Disables the CTA while the page resolves the gate. */
  busy?: boolean;
  /**
   * True when this capability's real workspace needs private vault access and
   * the current session is locked. The step still forwards (the destination
   * owns that prompt); the helper copy simply sets expectations.
   */
  needsVaultUnlock?: boolean;
  /** Terminal acknowledgement after the capability's real work settles. */
  completion?: boolean;
}

export function OnboardingCapabilityStep({
  capabilityId,
  onPrimary,
  onBack,
  onSkip,
  busy = false,
  needsVaultUnlock = false,
  completion = false,
}: OnboardingCapabilityStepProps) {
  const capability = getOneSetupCapability(capabilityId);
  const copy = getCapabilitySetupCopy(capabilityId);
  const [acted, setActed] = useState(false);

  const isExploreOnly = capability?.isExploreOnly === true;
  const setupActionLabel =
    copy?.actionLabel ?? `Set up ${capability?.title || "capability"}`;
  const finishActionLabel =
    copy?.resumeActionLabel ?? `Finish ${capability?.title || "capability"}`;

  const title = completion
    ? finishActionLabel
    : isExploreOnly
      ? (copy?.exploreTitle ?? copy?.setupTitle ?? "")
      : (copy?.setupTitle ?? "");
  const blurb = completion
    ? "Last step, then back to setup."
    : isExploreOnly
      ? (copy?.exploreBlurb ?? copy?.setupBlurb ?? "")
      : (copy?.setupBlurb ?? "");
  const bullets = isExploreOnly ? copy?.exploreBullets : copy?.setupBullets;
  const ctaLabel = completion
    ? finishActionLabel
    : isExploreOnly
      ? finishActionLabel
      : setupActionLabel;
  const skipActionLabel = `Skip ${capability?.title || "this"} setup`;
  const subline = completion
    ? "Finish when you're ready."
    : isExploreOnly
      ? "Nothing to set up."
      : needsVaultUnlock
        ? "One will guide you through the private setup next."
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
                ? "Finish this capability and return to setup."
                : completion
                  ? "Finish this capability and return to setup."
                  : "Start this setup.",
            },
            {
              id: "back",
              actionId: completion ? undefined : "setup.capability_skip",
              label: completion ? "Back to setup" : skipActionLabel,
              purpose: completion
                ? "Return to the setup home."
                : "Return to the setup home without recording this capability as complete.",
            },
          ],
        }
      : null,
  );

  if (!capability || !copy) {
    return null;
  }

  const HeaderIcon =
    capability.icon.kind === "lucide" ? capability.icon.icon : undefined;

  function handlePrimary() {
    if (busy || acted) return;
    setActed(true);
    onPrimary();
  }

  function handleSkip() {
    if (busy || acted) return;
    setActed(true);
    onSkip();
  }

  return (
    <AppPageShell
      as="main"
      width="reading"
      className="space-y-4 px-4 py-4 pb-[calc(var(--app-bottom-inset)+1.5rem)] sm:px-6"
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
          icon={HeaderIcon}
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
                <AgentSectionIcon
                  id={capability.id}
                  icon={capability.icon}
                  tone={capability.tone}
                  size="menu"
                />
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

          {completion ? (
            <SetupCompletionFooter
              label={ctaLabel}
              onComplete={handlePrimary}
              busy={busy || acted}
              controlId="one_setup_capability_primary"
              testId="one-setup-capability-primary"
              purpose="finishes this capability and returns to setup."
            />
          ) : (
            <>
              <Button
                type="button"
                size="lg"
                className="h-12 w-full rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={handlePrimary}
                disabled={busy || acted}
                data-testid="one-setup-capability-primary"
                data-voice-control-id="one_setup_capability_primary"
                data-voice-action-id="setup.capability_continue"
              >
                {ctaLabel}
              </Button>
              <SetupCompletionFooter
                label={skipActionLabel}
                onComplete={handleSkip}
                busy={busy || acted}
                controlId="one_setup_capability_skip"
                actionId="setup.capability_skip"
                testId="one-setup-capability-skip"
                purpose="returns to setup without recording this capability as complete."
                supportingText="Come back any time."
                variant="none"
                effect="fade"
              />
            </>
          )}
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
