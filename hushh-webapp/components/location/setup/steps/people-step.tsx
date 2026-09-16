"use client";

import { Users } from "lucide-react";

import {
  HelperText,
  MediumRowLabel,
  RowDescription,
  SectionLabel,
} from "@/components/app-ui/typography";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AvatarBubble,
  StatusPill,
} from "@/lib/morphy-ux/ui/surface-primitives";
import { CARD_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import { cn } from "@/lib/utils";

/**
 * A person the server said can (or cannot yet) receive an encrypted
 * position. Rendered by NAME ONLY — an id is never shown, and a spoken name
 * is never treated as one.
 */
export type SetupPerson = {
  /** Used as a React key only; never rendered. */
  userId: string;
  displayName: string;
  photoUrl?: string | null;
  canReceiveLocation: boolean;
};

export type PeopleStepProps = {
  busy: boolean;
  loading: boolean;
  people: SetupPerson[];
  onContinue: () => void;
};

const PREVIEW_LIMIT = 6;

export function personInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase() || "?";
}

/**
 * Optional step: who could receive a share once setup is done. Reads only;
 * no share is created here. Names come from the server's recipient list.
 */
export function PeopleStep({
  busy,
  loading,
  people,
  onContinue,
}: PeopleStepProps) {
  const ready = people.filter((person) => person.canReceiveLocation);
  const preview = people.slice(0, PREVIEW_LIMIT);
  const remaining = Math.max(0, people.length - preview.length);

  return (
    <div className="space-y-6" data-testid="location-setup-people">
      <section className={cn(CARD_SURFACE, "p-4")}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
            <Users className="h-[18px] w-[18px]" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <MediumRowLabel as="p">Who you could share with</MediumRowLabel>
            <RowDescription className="mt-0.5">
              Nothing is shared yet. Once setup is done, say &ldquo;share my
              location with &hellip;&rdquo; and name someone, or pick them on
              the Location screen.
            </RowDescription>
          </div>
        </div>

        <div className="mt-4 border-t border-[color:var(--app-separator)] pt-3">
          <SectionLabel as="p" compact>
            {loading
              ? "Your people"
              : ready.length === 0
                ? "No one can receive a share yet"
                : `${ready.length} ${ready.length === 1 ? "person" : "people"} can receive a share`}
          </SectionLabel>
          {loading ? (
            <ul className="mt-2 space-y-2" aria-busy>
              {[0, 1, 2].map((index) => (
                <li key={index} className="flex items-center gap-3 py-1.5">
                  <Skeleton className="h-9 w-9 rounded-full" />
                  <Skeleton className="h-4 w-40" />
                </li>
              ))}
            </ul>
          ) : preview.length === 0 ? (
            <RowDescription className="mt-2">
              People appear here once they open Location in Hussh. Invite them
              from the Location screen when you&rsquo;re ready.
            </RowDescription>
          ) : (
            <ul className="mt-2 divide-y divide-[color:var(--app-separator)]">
              {preview.map((person) => (
                <li
                  key={person.userId}
                  className="flex min-h-[44px] items-center gap-3 py-1.5"
                  data-testid="location-setup-person"
                >
                  <AvatarBubble
                    initials={personInitials(person.displayName)}
                    imageUrl={person.photoUrl ?? null}
                    size={36}
                  />
                  <MediumRowLabel as="span" className="min-w-0 flex-1 truncate">
                    {person.displayName}
                  </MediumRowLabel>
                  <StatusPill
                    tone={person.canReceiveLocation ? "ready" : "neutral"}
                  >
                    {person.canReceiveLocation ? "Ready" : "Not set up"}
                  </StatusPill>
                </li>
              ))}
              {remaining > 0 ? (
                <li className="py-2">
                  <HelperText>and {remaining} more</HelperText>
                </li>
              ) : null}
            </ul>
          )}
        </div>
      </section>

      <Button
        type="button"
        size="lg"
        className="w-full"
        onClick={onContinue}
        disabled={busy}
        data-testid="location-setup-people-continue"
      >
        Continue
      </Button>
    </div>
  );
}
