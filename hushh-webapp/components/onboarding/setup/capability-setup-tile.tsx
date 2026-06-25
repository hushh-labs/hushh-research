"use client";

import Link from "next/link";
import { ChevronRight, type LucideIcon } from "lucide-react";

import {
  getCapabilityStatusDisplay,
  type CapabilityStatusTone,
} from "@/lib/onboarding/capability-status-display";
import {
  ONE_CAPABILITY_ICON_CLASS_BY_TONE,
  type OneCapabilityTone,
} from "@/lib/onboarding/one-capabilities";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";
import { MaterialRipple } from "@/lib/morphy-ux/material-ripple";
import { cn } from "@/lib/utils";

/**
 * CapabilitySetupTile: the shared, premium, de-tinted tile used by the
 * `/one/setup` hub.
 *
 * CARD DEPTH MODEL (non-negotiable): the outer card is borderless neutral glass.
 * Depth comes ONLY from the shared shadow tokens
 * (`--app-card-shadow-standard` / `--app-card-shadow-feature`). Tone color is
 * sanctioned in exactly ONE place (the icon well), never on the card chrome,
 * never as a status pill border/background. State emphasis is carried by copy
 * weight, never by tinting the tile to "pop".
 */
const TILE_CLASS =
  "group relative isolate flex w-full items-center gap-3 overflow-hidden rounded-xl border border-transparent bg-card/78 p-4 text-left shadow-[var(--app-card-shadow-standard)] transition-[background-color,box-shadow] duration-200 hover:bg-card hover:shadow-[var(--app-card-shadow-feature)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const STATUS_TEXT_CLASS_BY_TONE: Record<CapabilityStatusTone, string> = {
  ready: "text-muted-foreground",
  action: "font-medium text-foreground",
  attention: "font-medium text-foreground",
  muted: "text-muted-foreground",
};

export interface CapabilitySetupTileProps {
  title: string;
  /** Plain, One-voice description of what this step sets up. */
  description: string;
  href: string;
  icon: LucideIcon;
  tone: OneCapabilityTone;
  status: CapabilityStatus;
  /** Mark the tile active when it is the current step in a guided sequence. */
  isCurrent?: boolean;
  className?: string;
}

export function CapabilitySetupTile({
  title,
  description,
  href,
  icon: Icon,
  tone,
  status,
  isCurrent = false,
  className,
}: CapabilitySetupTileProps) {
  const display = getCapabilityStatusDisplay(status);

  return (
    <Link
      href={href}
      aria-label={`${title}: ${display.label}`}
      aria-current={isCurrent ? "step" : undefined}
      className={cn(TILE_CLASS, isCurrent && "shadow-[var(--app-card-shadow-feature)]", className)}
    >
      <MaterialRipple variant="link" effect="glass" className="rounded-xl" />
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl",
          ONE_CAPABILITY_ICON_CLASS_BY_TONE[tone],
        )}
      >
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-base font-semibold leading-5 text-foreground">
          {title}
        </span>
        <span className="mt-0.5 line-clamp-2 text-sm leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span
          className={cn(
            "whitespace-nowrap text-xs sm:text-sm",
            STATUS_TEXT_CLASS_BY_TONE[display.tone],
          )}
        >
          {display.label}
        </span>
        <ChevronRight
          className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground"
          aria-hidden
        />
      </span>
    </Link>
  );
}
