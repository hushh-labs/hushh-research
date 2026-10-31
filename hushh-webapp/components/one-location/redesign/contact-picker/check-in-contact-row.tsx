"use client";

import { Check } from "@/components/icons";
import { PersonSelectionSurface } from "@/components/connections/person-selection-surface";
import { MediumRowLabel, RowDescription, StatusText } from "@/components/app-ui/typography";
import { ContactAvatar } from "./atoms";
import { cn } from "@/lib/utils";

export function ContactRow({
  userId,
  checked,
  ready,
  locked,
  completed,
  label,
  photoUrl,
  verified,
  fromContacts,
  isLast,
  onToggle,
}: {
  userId?: string;
  checked: boolean;
  ready: boolean;
  locked: boolean;
  completed: boolean;
  label: string;
  photoUrl?: string | null;
  verified?: boolean;
  fromContacts?: boolean;
  isLast: boolean;
  onToggle: () => void;
}) {
  const disabled = !ready || locked || completed;
  return (
    <PersonSelectionSurface
      type="button"
      onClick={disabled ? undefined : onToggle}
      disabled={disabled}
      aria-pressed={checked}
      className={cn(
        "flex w-full items-center gap-[13px] py-3 text-left transition-opacity",
        !isLast && "border-b border-black/[0.06] dark:border-white/[0.08]",
        disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
      )}
    >
      <ContactAvatar userId={userId}
        label={label}
        photoUrl={photoUrl}
        verified={verified}
        fromContacts={fromContacts}
        className="h-[42px] w-[42px]"
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-start gap-1.5">
          <MediumRowLabel as="span" data-location-type-role="row-title" className="min-w-0 truncate">
            {label}
          </MediumRowLabel>
        </span>
        {completed ? (
          <StatusText
            as="span"
            className="block truncate text-[color:var(--app-success)]"
          >
            Already shared in this check-in
          </StatusText>
        ) : !ready ? (
          <RowDescription as="span" className="block truncate">
            Hasn't set up sharing yet
          </RowDescription>
        ) : null}
      </span>
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors",
          checked
            ? "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
            : "border-[1.5px] border-black/25 dark:border-white/25",
        )}
      >
        {checked ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : null}
      </span>
    </PersonSelectionSurface>
  );
}
