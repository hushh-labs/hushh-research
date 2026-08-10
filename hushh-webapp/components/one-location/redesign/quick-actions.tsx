"use client";

/**
 * Location agent redesign — Quick Actions grid (Now tab).
 *
 * PRESENTATION ONLY. A single reusable `QuickActionCard` renders every tile in
 * the "Quick actions" block so Check-In and Alert stay equal, responsive
 * controls. Each card uses the shared typography roles and iOS grouped-card
 * geometry. Cards are prop-driven and delegate taps to the hub.
 */

import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

import {
  CardTitle,
  MajorSectionTitle,
  RowDescription,
} from "@/components/app-ui/typography";
import { cn } from "@/lib/utils";

export type QuickActionTone = "green" | "red" | "blue" | "violet" | "slate";

/**
 * Per-tone semantic icon palette. The tile owns service/action color; labels
 * stay neutral through the shared typography roles.
 */
const TONE_STYLES: Record<QuickActionTone, { tile: string; icon: string }> = {
  green: {
    tile: "bg-[color:var(--app-success)]",
    icon: "text-white",
  },
  red: {
    tile: "bg-[color:var(--app-destructive)]",
    icon: "text-white",
  },
  blue: {
    tile: "bg-[color:var(--app-accent)]",
    icon: "text-white",
  },
  violet: {
    tile: "bg-[color:var(--app-purple)]",
    icon: "text-white",
  },
  slate: {
    tile: "bg-[color:var(--app-icon-tile-background)]",
    icon: "text-white",
  },
};

export type QuickActionCardProps = {
  icon: ReactNode;
  title: string;
  subtitle: string;
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
}: QuickActionCardProps) {
  const palette = TONE_STYLES[tone];
  const interactive = !comingSoon && !disabled;

  return (
    <button
      type="button"
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      aria-disabled={!interactive}
      data-voice-control-id={controlId}
      className={cn(
        "group flex min-h-[120px] w-full min-w-0 flex-col gap-3 rounded-[22px] bg-white p-4 text-left shadow-none transition-all duration-200 dark:bg-[color:var(--app-card-surface-default-solid)]",
        interactive
          ? "cursor-pointer active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
          : "cursor-not-allowed",
      )}
    >
      <div className="flex w-full items-start justify-between gap-2">
        <span
          className={cn(
            "flex h-[34px] w-[34px] items-center justify-center rounded-[9px] [&_svg]:h-[19px] [&_svg]:w-[19px]",
            palette.tile,
            palette.icon,
          )}
        >
          {icon}
        </span>
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-neutral-fill)] dark:bg-white/10">
          <ChevronRight className="h-3 w-3 text-[color:var(--app-tertiary-label)]" />
        </span>
      </div>

      <div className="mt-auto w-full min-w-0">
        <CardTitle as="p" className="truncate">
          {title}
        </CardTitle>
        <RowDescription as="span" className="mt-1 block truncate">
          {subtitle}
        </RowDescription>
      </div>
    </button>
  );
}


export function QuickActionsSection({
  title = "Quick actions",
  children,
  columns = 3,
  className,
}: {
  title?: string;
  children: ReactNode;
  columns?: 2 | 3;
  className?: string;
}) {
  return (
    <section className={cn("space-y-4", className)}>
      <div className="flex items-center px-1">
        <MajorSectionTitle>{title}</MajorSectionTitle>
      </div>
      <div
        className={cn(
          "grid auto-rows-fr gap-3",
          columns === 2 ? "grid-cols-2" : "grid-cols-3",
        )}
      >
        {children}
      </div>
    </section>
  );
}
