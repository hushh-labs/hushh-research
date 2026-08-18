"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2 } from "lucide-react";

import {
  getCapabilityStatusDisplay,
} from "@/lib/onboarding/capability-status-display";
import {
  type OneCapabilityIcon,
  type OneCapabilityTone,
} from "@/lib/onboarding/one-capabilities";
import {
  isCapabilitySetupComplete,
  type CapabilityStatus,
} from "@/lib/services/capability-setup-state-service";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { cn } from "@/lib/utils";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

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

export interface CapabilitySetupTileProps {
  capabilityId: string;
  title: string;
  /** Plain, One-voice description of what this step sets up. Omit for a bare, one-line row. */
  description?: string;
  /** Capability-specific next action for the trailing state label. */
  actionLabel: string;
  /** Capability-specific continuation label after a partial setup. */
  resumeActionLabel: string;
  href: string;
  voiceControlId: string;
  icon: OneCapabilityIcon;
  /** Omit or pass `null` for a neutral (untoned) icon well. */
  tone?: OneCapabilityTone | null;
  /** Overrides the icon well's background/foreground classes. */
  iconClassName?: string;
  status: CapabilityStatus;
  /** Explore-only capability — its badge reads "Explore"/"Explored". */
  isExploreOnly?: boolean;
  /** Mark the tile active when it is the current step in a guided sequence. */
  isCurrent?: boolean;
  className?: string;
}

/**
 * A setup row that opens a route but does not represent a tracked capability.
 *
 * Connections configures how One's private agent runs; it must therefore not
 * fabricate a capability completion state. It still uses the exact same row,
 * icon well, prefetch, press feedback, and native-safe navigation mechanics as
 * a tracked setup capability.
 */
export interface SetupNavigationTileProps {
  id: string;
  title: string;
  description?: string;
  href: string;
  voiceControlId: string;
  icon: OneCapabilityIcon;
  /** Omit or pass `null` for a neutral (untoned) icon well. */
  tone?: OneCapabilityTone | null;
  /** Overrides the icon well's background/foreground classes. */
  iconClassName?: string;
  statusLabel?: string;
  isComplete?: boolean;
  /** Mark the row as the current step in a guided sequence. */
  isCurrent?: boolean;
  /** Defaults to true; pass false to omit the trailing chevron entirely. */
  chevron?: boolean;
  className?: string;
}

export function SetupNavigationTile({
  id,
  title,
  description,
  href,
  voiceControlId,
  icon,
  tone,
  iconClassName,
  statusLabel,
  isComplete = false,
  isCurrent = false,
  chevron = true,
  className,
}: SetupNavigationTileProps) {
  const router = useRouter();
  const didPrefetch = useRef(false);
  const prefetchRoute = useCallback(() => {
    if (didPrefetch.current) return;
    didPrefetch.current = true;
    router.prefetch(href);
  }, [href, router]);
  const handleOpen = useCallback(() => {
    const requested = requestInternalAppNavigation({
      href,
      scroll: false,
      source: "tap",
      transitionMode: "full",
    });
    if (!requested) router.push(href, { scroll: false });
  }, [href, router]);

  return (
    <SettingsRow
      asChild
      leading={
        <AgentSectionIcon
          id={id}
          icon={icon}
          tone={tone}
          isActive={isComplete}
          size="menu"
          className={iconClassName}
        />
      }
      title={title}
      description={
        description ? (
          <div className="line-clamp-2 md:line-clamp-none">{description}</div>
        ) : undefined
      }
      trailing={
        isComplete ? (
          <CheckCircle2
            className="h-[18px] w-[18px] shrink-0 text-[var(--app-accent)]"
            aria-hidden
          />
        ) : statusLabel ? (
          <span className="shrink-0 text-xs font-semibold text-[var(--app-accent)]">
            {statusLabel}
          </span>
        ) : undefined
      }
      chevron={chevron}
      className={className}
    >
      <button
        type="button"
        onClick={handleOpen}
        onPointerEnter={prefetchRoute}
        onFocus={prefetchRoute}
        onTouchStart={prefetchRoute}
        aria-label={
          isComplete
            ? `${title}: Selected`
            : statusLabel
              ? `${title}: ${statusLabel}`
              : title
        }
        aria-current={isCurrent ? "step" : undefined}
        data-href={href}
        data-voice-control-id={voiceControlId}
        className={cn(
          "[&]:focus-visible:ring-2 [&]:focus-visible:ring-ring [&]:focus-visible:ring-inset",
          className,
        )}
      />
    </SettingsRow>
  );
}

export function CapabilitySetupTile({
  capabilityId,
  title,
  description,
  actionLabel,
  resumeActionLabel,
  href,
  voiceControlId,
  icon,
  tone,
  iconClassName,
  status,
  isExploreOnly = false,
  isCurrent = false,
  className,
}: CapabilitySetupTileProps) {
  const router = useRouter();
  const display = getCapabilityStatusDisplay(status, {
    isExploreOnly,
    actionLabel,
    resumeActionLabel,
  });
  const isComplete = isCapabilitySetupComplete(status);
  const didPrefetch = useRef(false);
  const prefetchRoute = useCallback(() => {
    if (didPrefetch.current) return;
    didPrefetch.current = true;
    router.prefetch(href);
  }, [href, router]);
  const handleOpen = useCallback(() => {
    const requested = requestInternalAppNavigation({
      href,
      scroll: false,
      source: "tap",
      transitionMode: "full",
    });
    if (!requested) router.push(href, { scroll: false });
  }, [href, router]);

  return (
    <SettingsRow
      asChild
      leading={
        <AgentSectionIcon
          id={capabilityId}
          icon={icon}
          tone={tone}
          isActive={isCapabilitySetupComplete(status)}
          size="menu"
          className={iconClassName}
        />
      }
      title={title}
      description={
        description ? (
          <div className="line-clamp-2 md:line-clamp-none">{description}</div>
        ) : undefined
      }
      chevron={!isComplete}
      className={className}
      trailing={
        isComplete ? (
          <CheckCircle2
            className="h-[18px] w-[18px] shrink-0 text-[var(--app-accent)]"
            aria-hidden
          />
        ) : null
      }
    >
      <button
        type="button"
        onClick={handleOpen}
        onPointerEnter={prefetchRoute}
        onFocus={prefetchRoute}
        onTouchStart={prefetchRoute}
        aria-label={`${title}: ${display.label}`}
        aria-current={isCurrent ? "step" : undefined}
        data-href={href}
        data-voice-control-id={voiceControlId}
        className={cn(
          "[&]:focus-visible:ring-2 [&]:focus-visible:ring-ring [&]:focus-visible:ring-inset",
          className,
        )}
      />
    </SettingsRow>
  );
}
