"use client";

import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
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
  label,
  className,
}: {
  label: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[15px] font-semibold",
        CONTACT_AVATAR_TONE,
        className,
      )}
      aria-hidden
    >
      {initials(label)}
    </span>
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
    <div className="flex min-h-[72px] w-full items-center justify-center rounded-[var(--app-card-radius-compact)] bg-[color:var(--app-card-surface-default-solid)] px-5 py-4 text-center text-[15px] font-normal leading-5 text-muted-foreground shadow-none transition-all duration-200 ease-out">
      <p className="max-w-[280px]">{message}</p>
    </div>
  );
}

/**
 * The Add / Remove control that ends a person row.
 *
 * `ready === false` means the person has not finished Location or phone setup,
 * so adding them would silently produce a contact who receives nothing. The
 * button says "Setup" rather than going disabled-and-silent, because the row
 * still has to explain why it will not act.
 */
export function ContactRowAction({
  selected,
  busy,
  ready,
  label,
  onAdd,
  onRemove,
}: {
  selected: boolean;
  busy: boolean;
  ready: boolean;
  label: string;
  onAdd: () => void;
  onRemove: () => void;
}) {
  if (selected) {
    return (
      <button
        type="button"
        onClick={onRemove}
        disabled={busy}
        aria-label={`Remove ${label}`}
        className="press-scale flex h-8 min-w-[76px] items-center justify-center rounded-full bg-[color:var(--app-destructive-tint)] px-3 text-[13px] font-semibold text-[color:var(--app-destructive)] disabled:bg-[color:var(--app-neutral-fill-strong)] disabled:opacity-45"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Remove"}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onAdd}
      disabled={busy || !ready}
      aria-label={`Add ${label}`}
      className="press-scale flex h-8 min-w-[58px] items-center justify-center rounded-full bg-[color:var(--app-accent)] px-3 text-[13px] font-semibold text-[color:var(--app-accent-fg)] disabled:bg-[color:var(--app-neutral-fill-strong)] disabled:text-muted-foreground"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : ready ? "Add" : "Setup"}
    </button>
  );
}

export function ContactRow({
  label,
  subtitle,
  selected,
  busy,
  ready,
  onAdd,
  onRemove,
}: {
  label: string;
  subtitle?: string | null;
  selected: boolean;
  busy: boolean;
  ready: boolean;
  onAdd: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className="flex min-h-[58px] items-center gap-3 px-3.5 py-2"
      data-testid="contact-picker-row"
    >
      <ContactAvatar label={label} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[17px] font-normal leading-[22px] text-foreground">
          {label}
        </span>
        {subtitle ? (
          <span className="mt-0.5 block truncate text-[13px] leading-4 text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
      <ContactRowAction
        selected={selected}
        busy={busy}
        ready={ready}
        label={label}
        onAdd={onAdd}
        onRemove={onRemove}
      />
    </div>
  );
}
