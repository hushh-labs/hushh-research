"use client";

import { useState } from "react";
import { ArrowLeft, Check, ChevronRight, type LucideIcon } from "lucide-react";

import {
  AppPageContentRegion,
  AppPageHeaderRegion,
  AppPageShell,
} from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { Button } from "@/components/ui/button";
import { getCapabilitySetupCopy } from "@/lib/onboarding/capability-setup-copy";
import {
  ONE_CAPABILITY_ICON_CLASS_BY_TONE,
  getOneCapability,
} from "@/lib/onboarding/one-capabilities";
import { usePublishVoiceSurfaceMetadata } from "@/lib/voice/voice-surface-metadata";
import { cn } from "@/lib/utils";

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
      className="space-y-5 px-4 py-5 pb-[calc(var(--app-bottom-fixed-ui,96px)+1.25rem)] sm:px-6"
      nativeTest={{
        routeId: `/one/setup/${capabilityId}`,
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
        <div className="rounded-2xl border border-transparent bg-card/78 p-5 shadow-[var(--app-card-shadow-standard)] sm:p-6">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex h-12 w-12 shrink-0 items-center justify-center rounded-xl",
                ONE_CAPABILITY_ICON_CLASS_BY_TONE[capability.tone],
              )}
            >
              <Icon className="h-6 w-6" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-base font-semibold leading-5 text-foreground">
                {capability.title}
              </p>
              <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
                {subline}
              </p>
            </div>
          </div>

          {bullets && bullets.length > 0 ? (
            <ul className="mt-5 space-y-3" aria-label="What this does">
              {bullets.map((bullet) => (
                <li key={bullet} className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground/8 text-foreground">
                    <Check className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <span className="text-sm leading-5 text-foreground">
                    {bullet}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <Button
            type="button"
            size="lg"
            className="mt-6 w-full"
            onClick={handlePrimary}
            disabled={busy || acted}
            data-testid="one-setup-capability-primary"
          >
            {ctaLabel}
            {!isExploreOnly ? (
              <ChevronRight className="size-4" aria-hidden />
            ) : null}
          </Button>
        </div>
      </AppPageContentRegion>
    </AppPageShell>
  );
}
