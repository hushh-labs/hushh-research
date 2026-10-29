"use client";

import { Check } from "@/components/icons";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import type { OneLocationCircleEligibleConnection } from "@/lib/one-location/types";
import { connectPersonName, connectPersonSelectionDetail } from "@/lib/connections/person-label";
import { cn } from "@/lib/utils";

/** Shared presentation; each Circle flow retains its eligibility and mutation owner. */
export function CirclePersonSelectionRow({
  person,
  selected,
  disabled,
  onToggle,
  ariaLabel,
  testId,
}: {
  person: OneLocationCircleEligibleConnection;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
  ariaLabel?: string;
  testId?: string;
}) {
  const name = connectPersonName(person);
  return (
    <SettingsRow
      layout="person"
      leadingInteractive
      leading={
        <ConnectionPersonAvatar
          userId={person.userId}
          size="list"
          photoUrl={person.photoUrl}
          label={name}
          verified={Boolean(person.isRia)}
          fromContacts={person.connectedFromContacts}
        />
      }
      title={name}
      description={connectPersonSelectionDetail(person)}
      ariaPressed={selected}
      ariaLabel={ariaLabel}
      describeContent
      disabled={disabled}
      trailing={
        <span
          aria-hidden="true"
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full border",
            selected
              ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
              : "border-border bg-transparent",
          )}
        >
          {selected ? <Check className="size-4" weight="bold" /> : null}
        </span>
      }
      onClick={onToggle}
      testId={testId}
    />
  );
}
