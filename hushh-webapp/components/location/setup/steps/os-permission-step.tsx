"use client";

import { AlertTriangle, MapPinned, Settings2 } from "lucide-react";

import {
  HelperText,
  MediumRowLabel,
  RowDescription,
} from "@/components/app-ui/typography";
import { Button } from "@/components/ui/button";
import { StatusPill } from "@/lib/morphy-ux/ui/surface-primitives";
import type { LocationOsPermission } from "@/lib/location/sharing-state";
import { CARD_SURFACE, WARNING_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import type { LocationRecoveryGuide } from "@/lib/one-location/location-permission-recovery";
import { cn } from "@/lib/utils";

export type OsPermissionStepProps = {
  busy: boolean;
  /** Server-side `consent_accepted_at` is present. The prompt is refused without it. */
  consentAccepted: boolean;
  /** The device's current answer, read without prompting. */
  permission: LocationOsPermission;
  /** iOS precise-location switch, when the platform reports it. */
  precise: boolean | null;
  /** True after this screen observed a denial from a real prompt. */
  observedDenial: boolean;
  /** Where the switch is, for a denial. */
  guide: LocationRecoveryGuide | null;
  /** Show the OS prompt (only enabled once consent is recorded). */
  onRequest: () => void;
  /** Record the device's answer and move on. */
  onContinue: () => void;
  onOpenSettings: () => void;
};

export function osPermissionLabel(permission: LocationOsPermission): string {
  switch (permission) {
    case "granted":
      return "Allowed";
    case "denied":
      return "Denied";
    case "restricted":
      return "Restricted";
    case "unavailable":
      return "Unavailable";
    case "prompt":
      return "Not asked yet";
    default:
      return "Unknown";
  }
}

function pillTone(
  permission: LocationOsPermission,
): "ready" | "pending" | "neutral" {
  if (permission === "granted") return "ready";
  if (permission === "denied" || permission === "restricted") return "pending";
  return "neutral";
}

/**
 * Device permission — a separate fact from app sharing, shown as its own
 * row. The prompt button stays disabled until the server holds consent.
 */
export function OsPermissionStep({
  busy,
  consentAccepted,
  permission,
  precise,
  observedDenial,
  guide,
  onRequest,
  onContinue,
  onOpenSettings,
}: OsPermissionStepProps) {
  const granted = permission === "granted";
  const blocked =
    permission === "denied" ||
    permission === "restricted" ||
    permission === "unavailable";
  const showGuide = Boolean(guide) && (observedDenial || blocked);

  return (
    <div className="space-y-6" data-testid="location-setup-os-permission">
      <section className={cn(CARD_SURFACE, "p-4")}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
            <MapPinned className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <MediumRowLabel as="p">Device permission</MediumRowLabel>
            <RowDescription className="mt-0.5">
              Your device will ask once. This is separate from sharing in Hussh:
              allowing it here does not share anything with anyone.
            </RowDescription>
          </div>
        </div>
        <dl className="mt-4 divide-y divide-[color:var(--app-separator)] border-t border-[color:var(--app-separator)]">
          <div className="flex min-h-[44px] items-center justify-between gap-3 py-2">
            <dt className="ui-text-row-label">Device permission</dt>
            <dd data-testid="location-setup-os-permission-value">
              <StatusPill tone={pillTone(permission)}>
                {osPermissionLabel(permission)}
              </StatusPill>
            </dd>
          </div>
          {precise !== null ? (
            <div className="flex min-h-[44px] items-center justify-between gap-3 py-2">
              <dt className="ui-text-row-label">Precise location</dt>
              <dd>
                <StatusPill tone={precise ? "ready" : "neutral"}>
                  {precise ? "On" : "Off"}
                </StatusPill>
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      {showGuide && guide ? (
        <section
          className={cn(WARNING_SURFACE, "space-y-3 p-4")}
          role="status"
          data-testid="location-setup-recovery-guide"
        >
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div className="min-w-0">
              <MediumRowLabel as="p">{guide.title}</MediumRowLabel>
              <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[15px] leading-5">
                {guide.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          </div>
          {guide.canOpenSettings ? (
            <Button
              type="button"
              variant="outline"
              size="lg"
              className="w-full"
              onClick={onOpenSettings}
              disabled={busy}
            >
              <Settings2 aria-hidden />
              Open Settings
            </Button>
          ) : null}
        </section>
      ) : null}

      <div className="space-y-3">
        {granted ? (
          <Button
            type="button"
            size="lg"
            className="w-full"
            onClick={onContinue}
            isLoading={busy}
            disabled={busy}
            data-testid="location-setup-os-continue"
          >
            Continue
          </Button>
        ) : (
          <>
            <Button
              type="button"
              size="lg"
              className="w-full"
              onClick={onRequest}
              isLoading={busy}
              disabled={busy || !consentAccepted}
              aria-disabled={busy || !consentAccepted}
              data-testid="location-setup-os-request"
            >
              {blocked ? "Try again" : "Allow location access"}
            </Button>
            {blocked ? (
              <Button
                type="button"
                variant="ghost"
                size="lg"
                className="w-full"
                onClick={onContinue}
                disabled={busy}
                data-testid="location-setup-os-continue-anyway"
              >
                Continue without it for now
              </Button>
            ) : null}
          </>
        )}
        {!consentAccepted ? (
          <HelperText
            className="text-center"
            data-testid="location-setup-os-consent-hint"
          >
            Accept the Location consent first. The device prompt is only
            requested after it is recorded.
          </HelperText>
        ) : null}
      </div>
    </div>
  );
}
