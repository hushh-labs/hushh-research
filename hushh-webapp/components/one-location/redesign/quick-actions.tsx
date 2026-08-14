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
const TONE_STYLES: Record<QuickActionTone, { icon: string }> = {
  green: {
    icon: "text-[color:var(--app-secondary-label)]",
  },
  red: {
    icon: "text-[color:var(--app-destructive)]",
  },
  blue: {
    icon: "text-[color:var(--app-accent)]",
  },
  violet: {
    icon: "text-[color:var(--app-purple)]",
  },
  slate: {
    icon: "text-[color:var(--app-secondary-label)]",
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
        "group flex min-h-[140px] w-full min-w-0 flex-col gap-4 rounded-[var(--app-radius-md)] bg-[color:var(--app-primary-surface)] p-5 text-left shadow-[var(--app-card-shadow-standard)] transition-[background-color,transform] duration-200 motion-reduce:transition-none sm:min-h-[132px] sm:p-[22px]",
        interactive
          ? "cursor-pointer hover:bg-[color:var(--app-neutral-fill)] active:scale-[0.98] motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]"
          : "cursor-not-allowed",
      )}
    >
      <div className="flex w-full items-start">
        <span className={cn("flex h-6 w-6 items-center justify-center [&_svg]:h-5 [&_svg]:w-5", palette.icon)}>
          {icon}
        </span>
      </div>

      <div className="mt-auto w-full min-w-0">
        <RowLabel as="p" className="text-[18px] font-semibold leading-[23px] tracking-[-0.35px] sm:text-[19px] sm:leading-6 sm:tracking-[-0.4px]">
          {title}
        </RowLabel>
        <RowDescription as="span" className="mt-0.5 block text-[14px] leading-[19px] sm:mt-1 sm:text-[15px] sm:leading-5">
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
  title?: ReactNode;
  children: ReactNode;
  columns?: 2 | 3;
  className?: string;
}) {
  return (
    <section className={cn(title ? "space-y-3" : "space-y-0", className)}>
      {title ? (
        <div className="flex items-center px-1">
          <SectionTitle>{title}</SectionTitle>
        </div>
      ) : null}
      <div
        className={cn(
          "grid auto-rows-fr gap-3.5 sm:gap-4",
          columns === 2
            ? "grid-cols-2 max-[359px]:grid-cols-1"
            : "grid-cols-3 max-[359px]:grid-cols-1",
        )}
      >
        {children}
      </div>
    </section>
  );
}
