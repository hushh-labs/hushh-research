"use client";

import type { ReactNode } from "react";
import { Loader2 } from "@/components/icons";

import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import { cn } from "@/lib/utils";
import type { PersonProfilePreviewIdentity } from "@/lib/connections/person-profile-preview";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";

/**
 * Shared row furniture for the SMS contact picker.
 *
 * Extracted from `sms-contacts-flow` when the picker grew a second list (the
 * per-Circle member picker) and a third (the review sheet). Three copies of a
 * 58px person row is how they drift apart.
 */

/**
 * A person avatar reports no state of its own — the initials identify, the
 * trailing control acts. Keeping it neutral leaves exactly one accent per row
 * instead of two competing across the same 58px.
 */
export const CONTACT_AVATAR_TONE = cn(
  roleClasses("neutral").tile,
  roleClasses("neutral").glyph,
);

/** The row height every list here is measured and virtualized against. */
export const CONTACT_ROW_HEIGHT_PX = 58;

export function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? ""))
    .slice(0, 2)
    .toUpperCase();
}

export function ContactAvatar({
  personRef,
  userId,
  label,
  photoUrl,
  className,
  verified = false,
  fromContacts = false,
}: PersonProfilePreviewIdentity & {
  label: string;
  photoUrl?: string | null;
  className?: string;
  verified?: boolean;
  fromContacts?: boolean;
}) {
  return (
    <ConnectionPersonAvatar
      personRef={personRef}
      userId={userId}
      label={label}
      photoUrl={photoUrl}
      verified={verified}
      fromContacts={fromContacts}
      className={cn("h-9 w-9 text-[15px]", className)}
    />
  );
}

export function ContactGroup({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "divide-y divide-[color:var(--app-separator)] overflow-hidden rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-card-surface-default-solid)] shadow-none",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function EmptyStateCard({ message }: { message: string }) {
  return (
    <div className="flex min-h-[72px] w-full items-center justify-center rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-card-surface-default-solid)] px-5 py-4 text-center text-[15px] font-normal leading-5 text-[color:var(--app-secondary-label)] shadow-none transition-[background-color,color,opacity] duration-150 ease-out">
      <p data-location-type-role="body" className="max-w-[280px]">{message}</p>
    </div>
  );
}

/**
 * The Add / Remove control that ends a person row.
 *
 * `ready === false` means receiving-key readiness is unavailable,
 * so adding them would silently produce a contact who receives nothing. The
 * button says "Setup" rather than going disabled-and-silent, because the row
 * still has to explain why it will not act.
 */
export function ContactRowAction({
  selected,
  busy,
  ready,
  label,
  onAction,
  addDisabled = false,
}: {
  selected: boolean;
  busy: boolean;
  ready: boolean;
  label: string;
  onAction: () => void;
  addDisabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onAction}
      disabled={busy || (!selected && (!ready || addDisabled))}
      aria-label={`${selected ? "Remove" : "Add"} ${label}`}
      className="group inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        data-location-type-role="compact-action"
        className={cn(
          "inline-flex min-h-8 items-center justify-center whitespace-nowrap rounded-full px-3 transition-opacity group-hover:opacity-85 group-active:opacity-75 group-disabled:bg-[color:var(--app-neutral-fill)] group-disabled:text-[color:var(--app-tertiary-label)]",
          selected
            ? "min-w-[76px] bg-[color:var(--app-destructive-tint)] text-[color:var(--app-destructive)]"
            : "min-w-[58px] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]",
        )}
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : selected ? "Remove" : ready ? "Add" : "Setup"}
      </span>
    </button>
  );
}

export function ContactRow({
  personRef,
  userId,
  label,
  photoUrl,
  verified = false,
  subtitle,
  fromContacts,
  selected,
  busy,
  ready,
  onAdd,
  onRemove,
  addDisabled,
}: PersonProfilePreviewIdentity & {
  label: string;
  photoUrl?: string | null;
  verified?: boolean;
  subtitle?: string | null;
  fromContacts?: boolean;
  selected: boolean;
  busy: boolean;
  ready: boolean;
  onAdd: () => void;
  onRemove: () => void;
  addDisabled?: boolean;
}) {
  return (
    <div
      className="flex min-h-[58px] items-center gap-3 px-3.5 py-2"
      data-testid="contact-picker-row"
    >
      <ContactAvatar personRef={personRef} userId={userId} label={label} photoUrl={photoUrl} verified={verified} fromContacts={fromContacts} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-start gap-1.5">
          <span data-location-type-role="row-title" className="min-w-0 truncate text-[17px] font-normal leading-[22px] text-[color:var(--app-label)]">
            {label}
          </span>
        </span>
        {subtitle ? (
          <span data-location-type-role="row-description" className="mt-0.5 block truncate text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
            {subtitle}
          </span>
        ) : null}
      </span>
      <ContactRowAction
        selected={selected}
        busy={busy}
        ready={ready}
        label={label}
        onAction={selected ? onRemove : onAdd}
        addDisabled={addDisabled}
      />
    </div>
  );
}
