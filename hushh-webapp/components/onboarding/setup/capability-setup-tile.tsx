"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, type LucideIcon } from "lucide-react";

import {
  getCapabilityStatusDisplay,
  type CapabilityStatusTone,
} from "@/lib/onboarding/capability-status-display";
import { type OneCapabilityTone } from "@/lib/onboarding/one-capabilities";
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
 * tinting the row to "pop". Whole-row tap uses a real `<button>` and
 * programmatic navigation so iOS WKWebView/Capacitor static builds do not
 * silently drop cloned `<Link>` taps; press feedback is SettingsRow's built-in
 * wash.
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
  status,
  isExploreOnly = false,
  isCurrent = false,
  className,
}: CapabilitySetupTileProps) {
  const router = useRouter();
  const display = getCapabilityStatusDisplay(status, { isExploreOnly });
  const isComplete = isCapabilitySetupComplete(status);
  const handleOpen = useCallback(() => {
    router.push(href, { scroll: false });
  }, [href, router]);

  return (
    <SettingsRow
      asChild
      leading={
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[rgba(156,116,52,0.10)] text-[#9C7434] dark:bg-[rgba(212,175,106,0.16)] dark:text-[#D4AF6A]">
          <Icon className="h-5 w-5" aria-hidden />
        </span>
      }
      title={title}
      description={description}
      chevron
      trailing={
        isComplete ? (
          <CheckCircle2
            className="h-[18px] w-[18px] shrink-0 text-[#12A150] dark:text-[#3FBF77]"
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
      <button
        type="button"
        onClick={handleOpen}
        aria-label={`${title}: ${display.label}`}
        aria-current={isCurrent ? "step" : undefined}
        data-href={href}
        className={cn(
          "[&]:focus-visible:ring-2 [&]:focus-visible:ring-ring [&]:focus-visible:ring-inset",
          className,
        )}
      />
    </SettingsRow>
  );
}
