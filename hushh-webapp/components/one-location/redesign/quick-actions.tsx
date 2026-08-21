"use client";

/**
 * Location agent redesign — Quick Actions grid (Now tab).
 *
 * PRESENTATION ONLY. A single reusable `QuickActionCard` renders every tile in
 * the Location action block so first-class actions stay equal, responsive
 * controls. Each card uses the shared typography roles and iOS grouped-card
 * geometry. Cards are prop-driven and delegate taps to the hub.
 */

import type { ReactNode } from "react";

import {
  RowDescription,
  RowLabel,
  SectionTitle,
} from "@/components/app-ui/typography";
import { cn } from "@/lib/utils";

export type QuickActionTone = "green" | "red" | "blue" | "violet" | "slate";

/**
 * Per-tone semantic icon palette. The tile owns service/action color; labels
 * stay neutral through the shared typography roles.
 */
const TONE_STYLES: Record<QuickActionTone, { tile: string; icon: string }> = {
  // Tokens, not literals: these hard-coded the LIGHT hex, so in dark mode the
  // glyphs stayed at the light-appearance shade while every other semantic
  // colour on the screen switched.
  green: {
    tile: "bg-[color:var(--app-success)]/12",
    icon: "text-[color:var(--app-success)]",
  },
  red: {
    tile: "bg-[color:var(--app-destructive)]/12",
    icon: "text-[color:var(--app-destructive)]",
  },
  blue: {
    tile: "bg-[color:var(--app-accent-surface)]",
    icon: "text-[color:var(--app-accent-deep)]",
  },
  violet: {
    tile: "bg-[color:var(--app-accent-surface)]",
    icon: "text-[color:var(--app-accent-deep)]",
  },
  slate: {
    tile: "bg-[#E5E5EA]",
    icon: "text-[#6E6E73]",
  },
};

export type QuickActionCardProps = {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  tone?: QuickActionTone;
  onClick?: () => void;
  /** Non-interactive treatment for actions that aren't wired up yet. */
  comingSoon?: boolean;
  /** Disable interaction without the coming-soon semantics. */
  disabled?: boolean;
  /**
   * The `control_ids` anchor from this tile's entry in the Location voice
   * action contract. It is what lets One and the search bar name the button a
   * person is looking at, rather than only the screen it sits on.
   */
  controlId?: string;
  voiceActionId?: string;
  ariaLabel?: string;
};

export function QuickActionCard({
  icon,
  title,
  subtitle,
  tone = "slate",
  onClick,
  comingSoon = false,
  disabled = false,
  controlId,
  voiceActionId,
  ariaLabel,
}: QuickActionCardProps) {
  const palette = TONE_STYLES[tone];
  const interactive = !comingSoon && !disabled;
  const isEmergency = tone === "red";

  return (
    <button
      type="button"
      data-ui-role="grouped-card"
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      aria-disabled={!interactive}
      aria-label={ariaLabel}
      data-voice-control-id={controlId}
      data-voice-action-id={voiceActionId}
      className={cn(
        "group flex min-h-[132px] w-full min-w-0 flex-col items-center justify-center gap-3 rounded-[20px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] px-3 py-4 text-center shadow-[var(--app-card-shadow-standard)] transition-colors duration-150 dark:border-white/10",
        isEmergency &&
          "bg-[color:var(--app-destructive)]/7 dark:bg-[color:var(--app-destructive)]/12",
        interactive
          ? cn(
              "cursor-pointer active:bg-[rgba(120,120,128,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]",
              isEmergency
                ? "hover:bg-[color:var(--app-destructive)]/10"
                : "hover:bg-[color:var(--app-card-surface-compact)]",
            )
          : "cursor-not-allowed",
      )}
    >
      <span
        className={cn(
          "flex h-14 w-14 items-center justify-center rounded-full [&_svg]:h-7 [&_svg]:w-7 [&_svg]:stroke-[2]",
          palette.tile,
          palette.icon,
          isEmergency &&
            "bg-[color:var(--app-destructive)] text-[color:var(--app-destructive-fg)]",
        )}
      >
        {icon}
      </span>

      <div className="w-full min-w-0">
        <RowLabel
          as="p"
          className={cn(
            "truncate !font-semibold",
            isEmergency && "text-[color:var(--app-destructive)]",
          )}
        >
          {title}
        </RowLabel>
        {subtitle ? (
          <RowDescription
            as="span"
            className={cn(
              "mt-0.5 block truncate",
              isEmergency && "text-[color:var(--app-destructive)] opacity-80",
            )}
          >
            {subtitle}
          </RowDescription>
        ) : null}
      </div>
    </button>
  );
}

export function QuickActionsSection({
  title = "Quick actions",
  children,
  columns = 3,
  className,
  testId,
}: {
  title?: string;
  children: ReactNode;
  columns?: 2 | 3;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={cn("space-y-3", className)} data-testid={testId}>
      <div className="flex items-center px-1">
        <SectionTitle>{title}</SectionTitle>
      </div>
      <div
        className={cn(
          "grid auto-rows-fr gap-2.5 sm:gap-3",
          columns === 2 ? "grid-cols-2" : "grid-cols-3",
        )}
      >
        {children}
      </div>
    </section>
  );
}
