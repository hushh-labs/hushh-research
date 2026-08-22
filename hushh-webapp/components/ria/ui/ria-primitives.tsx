"use client";

/**
 * RIA sub-agent — Apple-clean presentational primitives.
 *
 * These are PURELY VISUAL building blocks for the RIA premium revamp. They carry
 * NO interaction semantics (no role/aria/voice-id/testid) so callers keep those
 * on their own interactive elements — the contract-pinned hooks
 * (data-voice-control-id, data-testid, role, aria-checked) must stay on the
 * existing rows/buttons. Drop these in as the visual layer only.
 *
 * All colors resolve from the --ria-* namespace defined in
 * `body[data-persona-surface="ria"]` (app/globals.css), so they only render the
 * premium palette inside the RIA scope.
 */

import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";
import { Check, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";

/** 5-segment (or N) progress bar: done = ink, current = gold, todo = faint. */
export function RiaProgress({
  total,
  currentIndex,
  className,
}: {
  total: number;
  currentIndex: number;
  className?: string;
}) {
  return (
    <div className={cn("flex gap-2", className)} aria-hidden="true">
      {Array.from({ length: total }, (_, i) => {
        const color =
          i < currentIndex
            ? "var(--ria-progress-done)"
            : i === currentIndex
              ? "var(--ria-progress-current)"
              : "var(--ria-progress-todo)";
        return (
          <div
            key={i}
            className="h-1 flex-1 rounded-[2px] transition-colors"
            style={{ backgroundColor: color }}
          />
        );
      })}
    </div>
  );
}

/**
 * Selection indicator (presentational only — put role + aria-checked on the
 * parent control). Two variants:
 *  - "radio" (onboarding): gold ring + inner gold dot when checked, empty warm
 *    ring when not. Matches the (1) design's register/services selectors.
 *  - "check" (default, picks/workspace): filled gold square/circle + white check.
 */
export function RiaSelectControl({
  checked,
  shape = "circle",
  variant = "check",
  className,
}: {
  checked: boolean;
  shape?: "circle" | "square";
  variant?: "check" | "radio";
  className?: string;
}) {
  if (variant === "radio") {
    return (
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full border-2 transition-colors",
          className,
        )}
        style={{
          borderColor: checked
            ? "var(--ria-select-fill)"
            : "var(--ria-select-border)",
        }}
      >
        {checked ? (
          <span
            className="h-[11px] w-[11px] rounded-full"
            style={{ backgroundColor: "var(--ria-select-fill)" }}
          />
        ) : null}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center border transition-colors",
        shape === "circle" ? "rounded-full" : "rounded-[7px]",
        className,
      )}
      style={{
        backgroundColor: checked ? "var(--ria-select-fill)" : "transparent",
        borderColor: checked ? "var(--ria-select-fill)" : "var(--ria-select-border)",
      }}
    >
      {checked ? (
        <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />
      ) : null}
    </span>
  );
}

type RiaChipVariant = "outline" | "filled" | "gold" | "success";

const RIA_CHIP_STYLES: Record<RiaChipVariant, CSSProperties> = {
  outline: {
    border: "1px solid var(--ria-divider-outer)",
    color: "var(--ria-alt)",
  },
  filled: {
    backgroundColor: "var(--ria-selected-tint)",
    color: "var(--ria-ink)",
  },
  gold: {
    backgroundColor: "var(--foundation-accent-surface)",
    color: "var(--ria-gold)",
    border: "1px solid var(--foundation-accent-border)",
  },
  success: {
    backgroundColor: "var(--ria-success-bg)",
    color: "var(--ria-success-text)",
    border: "1px solid var(--ria-success-border)",
  },
};

/** Small pill/chip for values (fees, certs, services). */
export function RiaChip({
  children,
  variant = "outline",
  className,
  style,
  ...props
}: ComponentPropsWithoutRef<"span"> & { variant?: RiaChipVariant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-[var(--ria-chip-radius)] px-3 py-1.5 text-[13px] font-medium",
        className,
      )}
      style={{ ...RIA_CHIP_STYLES[variant], ...style }}
      {...props}
    >
      {children}
    </span>
  );
}

/** Label (muted) + value (ink) row with optional trailing (e.g. edit pencil). */
export function RiaDetailRow({
  label,
  value,
  trailing,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-[58px] items-center justify-between gap-4 py-3",
        className,
      )}
    >
      <span className="text-[15px] text-[color:var(--ria-muted)]">{label}</span>
      <span className="flex items-center gap-2 text-right text-[15px] font-medium text-[color:var(--ria-ink)]">
        {value}
        {trailing}
      </span>
    </div>
  );
}

type RiaBannerTone = "gold" | "success";

/** Status banner (gold "pending verification" / green "verified"). */
export function RiaBanner({
  tone = "gold",
  icon,
  title,
  children,
  className,
}: {
  tone?: RiaBannerTone;
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const style: CSSProperties =
    tone === "success"
      ? {
          backgroundColor: "var(--ria-success-bg)",
          borderColor: "var(--ria-success-border)",
          color: "var(--ria-success-text)",
        }
      : {
          backgroundColor: "var(--foundation-accent-surface)",
          borderColor: "var(--foundation-accent-border)",
          color: "var(--ria-gold)",
        };
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-[18px] border px-4 py-3.5",
        className,
      )}
      style={style}
    >
      {icon ? <span className="mt-0.5 shrink-0">{icon}</span> : null}
      <div className="min-w-0 space-y-0.5">
        {title ? (
          <p className="text-[14px] font-semibold leading-5">{title}</p>
        ) : null}
        {children ? (
          <div className="text-[13px] leading-5 opacity-90">{children}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Ask One" action pill (white + gold sparkle). Forwards all button props so the
 * caller can attach onClick / data-voice-control-id / testid.
 */
export function RiaAiActionPill({
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"button">) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[14px] font-semibold transition-transform active:scale-[0.98]",
        className,
      )}
      style={{
        backgroundColor: "var(--ria-selected-tint)",
        borderColor: "var(--ria-divider-outer)",
        color: "var(--ria-ink)",
      }}
      {...props}
    >
      <Sparkles
        className="h-4 w-4 text-[color:var(--ria-gold)]"
        fill="currentColor"
      />
      {children}
    </button>
  );
}
