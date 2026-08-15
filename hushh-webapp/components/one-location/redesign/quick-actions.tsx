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
  green: {
    tile: "bg-[rgba(52,199,89,0.12)]",
    icon: "text-[#34C759]",
  },
  red: {
    tile: "bg-[rgba(255,59,48,0.12)]",
    icon: "text-[#FF3B30]",
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
      data-ui-role="grouped-card"
      onClick={interactive ? onClick : undefined}
      disabled={!interactive}
      aria-disabled={!interactive}
      data-voice-control-id={controlId}
      className={cn(
        "group flex min-h-[112px] w-full min-w-0 flex-col gap-2.5 rounded-[18px] border border-[rgba(60,60,67,0.10)] bg-white p-3.5 text-left shadow-none transition-colors duration-150 dark:border-white/10 dark:bg-[color:var(--app-card-surface-default-solid)]",
        interactive
          ? "cursor-pointer active:bg-[rgba(120,120,128,0.08)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
          : "cursor-not-allowed",
      )}
    >
      <div className="flex w-full items-start justify-between gap-2">
        <span
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-[9px] [&_svg]:h-[18px] [&_svg]:w-[18px] [&_svg]:stroke-[1.8]",
            palette.tile,
            palette.icon,
          )}
        >
          {icon}
        </span>
        <span className="flex h-6 w-6 shrink-0 items-center justify-end">
          <ChevronRight className="h-3.5 w-3.5 text-[#C7C7CC] [stroke-width:1.8]" />
        </span>
      </div>

      <div className="mt-auto w-full min-w-0">
        <RowLabel as="p" className="truncate !font-medium">
          {title}
        </RowLabel>
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
    <section className={cn("space-y-3", className)}>
      <div className="flex items-center px-1">
        <SectionTitle>{title}</SectionTitle>
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
