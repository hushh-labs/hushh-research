"use client";

import Link from "next/link";
import { CheckCircle2, type LucideIcon } from "lucide-react";

import {
  getCapabilityStatusDisplay,
  type CapabilityStatusTone,
} from "@/lib/onboarding/capability-status-display";
import {
  ONE_CAPABILITY_ICON_CLASS_BY_TONE,
  type OneCapabilityTone,
} from "@/lib/onboarding/one-capabilities";
import {
  isCapabilitySetupComplete,
  type CapabilityStatus,
} from "@/lib/services/capability-setup-state-service";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { cn } from "@/lib/utils";

/**
 * CapabilitySetupTile: the shared setup row used by the `/one/setup` hub.
 *
 * APPLE-NATIVE MODEL: rows live inside a single `SettingsGroup` grouped inset
 * list (hairline dividers, one calm surface). Tone color is sanctioned in
 * exactly ONE place — the leading icon well — never on row chrome, never as a
 * status pill background. State emphasis is carried by copy weight, never by
 * tinting the row to "pop". Whole-row tap navigates (and prefetches) via the
 * cloned `<Link>`; press feedback is SettingsRow's built-in wash.
 */
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
  /** Explore-only capability — its badge reads "Explore"/"Explored". */
  isExploreOnly?: boolean;
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
  isExploreOnly = false,
  isCurrent = false,
  className,
}: CapabilitySetupTileProps) {
  const display = getCapabilityStatusDisplay(status, { isExploreOnly });
  const isComplete = isCapabilitySetupComplete(status);

  return (
    <SettingsRow
      asChild
      leading={
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] sm:h-10 sm:w-10",
            ONE_CAPABILITY_ICON_CLASS_BY_TONE[tone],
          )}
        >
          <Icon className="h-5 w-5" aria-hidden />
        </span>
      }
      title={title}
      description={description}
      chevron
      trailing={
        isComplete ? (
          <CheckCircle2
            className="h-[18px] w-[18px] shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden
          />
        ) : (
          <span
            className={cn(
              "type-footnote whitespace-nowrap",
              STATUS_TEXT_CLASS_BY_TONE[display.tone],
            )}
          >
            {display.label}
          </span>
        )
      }
    >
      <Link
        href={href}
        prefetch
        aria-label={`${title}: ${display.label}`}
        aria-current={isCurrent ? "step" : undefined}
        className={cn(
          "[&]:focus-visible:ring-2 [&]:focus-visible:ring-ring [&]:focus-visible:ring-inset",
          className,
        )}
      />
    </SettingsRow>
  );
}
