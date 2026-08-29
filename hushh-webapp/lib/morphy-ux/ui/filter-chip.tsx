"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * A chip that narrows a list.
 *
 * Two of these already existed, file-local, written twice from the same
 * instinct: `nearby-filters.tsx`'s `Chip` and the reason row in
 * `one-location/redesign/selectors.tsx`. This is that pattern, exported once,
 * before a third copy arrives.
 *
 * It is a FILTER, not navigation, and the difference is load-bearing. A
 * segmented strip says "you are here" and divides the width between its
 * options, so a long label ellipsises and a fourth option makes every option
 * narrower. A chip row says "show me only these", sizes each chip to its own
 * content, and wraps. That is why the Around-you strip became chips when a
 * second strip appeared above it: Advisors / Insurance / Places are three
 * sources filtered by one location, a slice of a list rather than a place you
 * go, and three pill strips on one 375px screen is not an interface.
 *
 * `aria-pressed` rather than a radio group: a chip row is a control over a list
 * that is already on screen, not a form the reader is filling in.
 */
export function FilterChip({
  children,
  active,
  onClick,
  count,
  disabled = false,
  className,
  testId,
}: {
  children: ReactNode;
  active: boolean;
  onClick: () => void;
  /** Rendered `tabular-nums` so a row of counts does not jitter as it changes. */
  count?: number;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={disabled}
      data-testid={testId}
      data-state={active ? "active" : "inactive"}
      onClick={onClick}
      className={cn(
        "press-scale inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5",
        "type-footnote transition-[background-color,border-color,color] duration-200",
        "disabled:cursor-not-allowed disabled:opacity-60",
        active
          ? "border-[color:var(--app-accent-border)] bg-[color:var(--app-accent-surface)] text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]"
          : "border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-compact)] text-[color:var(--app-primary-label)] hover:bg-foreground/[0.035]",
        className,
      )}
    >
      <span className="min-w-0 truncate">{children}</span>
      {typeof count === "number" ? (
        <span className="tabular-nums opacity-70">{count}</span>
      ) : null}
    </button>
  );
}

/**
 * The row a `FilterChip` set lives in.
 *
 * `flex-wrap`, never a horizontal scroller. A chip that has scrolled out of
 * view is a filter the reader does not know exists, and the count beside it is
 * a fact they cannot see — which is worse on a narrow screen, where the row is
 * most likely to overflow and least likely to look scrollable.
 */
export function FilterChipRow({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {children}
    </div>
  );
}
