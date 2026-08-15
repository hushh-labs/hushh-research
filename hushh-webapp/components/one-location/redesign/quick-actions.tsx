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
import {
  resolveRole,
  SEMANTIC_ROLE_CLASSES,
  type SemanticRole,
} from "@/lib/morphy-ux/tokens/semantic-roles";
import { cn } from "@/lib/utils";

export type QuickActionTone = "green" | "red" | "blue" | "violet" | "slate";

/**
 * Tone name -> the MEANING the tile is claiming. The class strings come from
 * the app-wide semantic role layer, so a tile cannot render a colour that
 * disagrees with the same status elsewhere in the app.
 *
 * `green` is a settled STATE, so it is only honest on a tile that is actually
 * reporting one. A tile whose job is to OPEN a flow is an action and takes
 * `blue`, however green the thing behind it eventually turns: green is a
 * status colour, never a CTA colour, and `resolveRole` below is what stops a
 * tile from claiming a state it cannot see.
 */
const TONE_ROLE: Record<QuickActionTone, SemanticRole> = {
  green: "success",
  red: "danger",
  blue: "action",
  violet: "people",
  slate: "neutral",
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
  const interactive = !comingSoon && !disabled;
  // STATE BEATS CATEGORY. A tile that cannot be tapped — not wired up yet, or
  // disabled for this person — has no state to report, so it renders neutral
  // however strong its category is. "Unavailable" is grey, never red.
  const iconClass =
    SEMANTIC_ROLE_CLASSES[
      resolveRole(TONE_ROLE[tone], { inactive: !interactive })
    ].glyph;

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
        <span className={cn("flex h-6 w-6 items-center justify-center [&_svg]:h-5 [&_svg]:w-5", iconClass)}>
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
