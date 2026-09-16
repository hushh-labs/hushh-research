"use client";

import { Check, ShieldCheck } from "lucide-react";

import {
  HelperText,
  MediumRowLabel,
  RowDescription,
  SectionLabel,
} from "@/components/app-ui/typography";
import { Button } from "@/components/ui/button";
import { CARD_SURFACE, TRUST_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import { cn } from "@/lib/utils";

export type ConsentStepProps = {
  busy: boolean;
  /** The version string recorded with the acceptance; shown so it is never invented. */
  consentVersion: string;
  /** True once the server holds `consent_accepted_at`. */
  accepted: boolean;
  /** Calls the same `accept_consent` PATCH the `accept_location_setup_consent` tool calls. */
  onAccept: () => void;
  /** Move on when consent is already recorded (a voice acceptance landed first). */
  onContinue: () => void;
  onDecline?: () => void;
};

/**
 * What the person is agreeing to. Explicit and complete: this is the text the
 * consent version identifies, and the OS prompt is refused until it is
 * recorded server-side.
 */
export const LOCATION_SHARING_CONSENT_TERMS = [
  {
    title: "What is shared",
    body: "Your device's position, its accuracy, the time it was taken, and the platform it came from. Nothing else about you.",
  },
  {
    title: "Who can see it",
    body: "Only a person you name, for the time you choose. Each share is a separate decision; there is no standing access.",
  },
  {
    title: "How it travels",
    body: "Encrypted on this device to that person's key. Hussh stores ciphertext it cannot open and never sees a coordinate.",
  },
  {
    title: "Precision",
    body: "You choose precise or approximate next. Approximate is applied on this device before it's encrypted.",
  },
  {
    title: "Save My Soul",
    body: "An emergency alert always sends your precise position to your emergency contacts, whatever precision you choose.",
  },
  {
    title: "Changing your mind",
    body: "Turn sharing off at any time. That stops every active share and link at once.",
  },
] as const;

export function ConsentStep({
  busy,
  consentVersion,
  accepted,
  onAccept,
  onContinue,
  onDecline,
}: ConsentStepProps) {
  return (
    <div className="space-y-6" data-testid="location-setup-consent">
      <section
        className={cn(CARD_SURFACE, "p-4")}
        aria-labelledby="location-consent-terms"
      >
        <SectionLabel as="h2" id="location-consent-terms" compact>
          Location sharing consent
        </SectionLabel>
        <ul className="mt-3 space-y-3.5">
          {LOCATION_SHARING_CONSENT_TERMS.map((term) => (
            <li key={term.title} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
                <Check className="h-3.5 w-3.5" aria-hidden />
              </span>
              <div className="min-w-0">
                <MediumRowLabel as="p">{term.title}</MediumRowLabel>
                <RowDescription className="mt-0.5">{term.body}</RowDescription>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <div className={cn(TRUST_SURFACE, "flex gap-3 p-3.5")}>
        <ShieldCheck
          className="mt-0.5 h-4 w-4 shrink-0 text-[color:var(--app-success-deep)] dark:text-[color:var(--app-success-bright)]"
          aria-hidden
        />
        <RowDescription>
          Tapping Accept records consent version{" "}
          <span className="font-medium text-foreground">{consentVersion}</span>{" "}
          to your account. Your device is asked for location permission only
          after that.
        </RowDescription>
      </div>

      <div className="space-y-3">
        {accepted ? (
          <Button
            type="button"
            size="lg"
            className="w-full"
            onClick={onContinue}
            disabled={busy}
            data-testid="location-setup-consent-continue"
          >
            Consent recorded. Continue
          </Button>
        ) : (
          <Button
            type="button"
            size="lg"
            className="w-full"
            onClick={onAccept}
            isLoading={busy}
            disabled={busy}
            data-testid="location-setup-consent-accept"
          >
            Accept and continue
          </Button>
        )}
        {onDecline && !accepted ? (
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="w-full"
            onClick={onDecline}
            disabled={busy}
            data-testid="location-setup-consent-decline"
          >
            Not now
          </Button>
        ) : null}
        <HelperText className="text-center">
          You can also say &ldquo;I accept&rdquo; to One; it still needs your
          tap to confirm.
        </HelperText>
      </div>
    </div>
  );
}
