"use client";

import { Lock, MapPin, Users } from "@/components/icons";

import {
  HelperText,
  MediumRowLabel,
  RowDescription,
} from "@/components/app-ui/typography";
import { Button } from "@/components/ui/button";
import { CARD_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import { cn } from "@/lib/utils";

export type IntroStepProps = {
  busy: boolean;
  /** Calls the same `start` PATCH the `start_location_setup` tool calls. */
  onStart: () => void;
  onSkip?: () => void;
};

const POINTS = [
  {
    icon: Users,
    title: "Only people you choose",
    body: "Nothing is shared until you name someone, and you can stop any share at any time.",
  },
  {
    icon: Lock,
    title: "Encrypted on this device",
    body: "Your position is sealed to each recipient's key before it leaves your phone. Hussh cannot read it.",
  },
  {
    icon: MapPin,
    title: "You decide how precise",
    body: "Share your exact position, or an approximate one that is coarsened here before it is encrypted.",
  },
] as const;

/** First screen of Location setup: what it is, before anything is asked. */
export function IntroStep({ busy, onStart, onSkip }: IntroStepProps) {
  return (
    <div className="space-y-6" data-testid="location-setup-intro">
      <ul
        className={cn(
          CARD_SURFACE,
          "divide-y divide-[color:var(--app-separator)] p-1",
        )}
      >
        {POINTS.map(({ icon: Icon, title, body }) => (
          <li key={title} className="flex gap-3 px-3 py-3.5">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
              <Icon className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <div className="min-w-0">
              <MediumRowLabel as="p">{title}</MediumRowLabel>
              <RowDescription className="mt-0.5">{body}</RowDescription>
            </div>
          </li>
        ))}
      </ul>

      <div className="space-y-3">
        <Button
          type="button"
          size="lg"
          className="w-full"
          onClick={onStart}
          isLoading={busy}
          disabled={busy}
          data-testid="location-setup-start"
        >
          Get started
        </Button>
        {onSkip ? (
          <Button
            type="button"
            variant="ghost"
            size="lg"
            className="w-full"
            onClick={onSkip}
            disabled={busy}
            data-testid="location-setup-skip"
          >
            Not now
          </Button>
        ) : null}
        <HelperText className="text-center">
          Setup takes about a minute. You can say &ldquo;set up location&rdquo;
          to One at any time.
        </HelperText>
      </div>
    </div>
  );
}
