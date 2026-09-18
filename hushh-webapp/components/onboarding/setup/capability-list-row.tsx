"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, X } from "@/components/icons";

import { AgentSectionIcon } from "@/components/app-ui/agent-section-icon";
import { SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import type { CapabilitySetupCopy } from "@/lib/onboarding/capability-setup-copy";
import {
  getCapabilityStatusDisplay,
  isCapabilityOnboarded,
} from "@/lib/onboarding/capability-status-display";
import type { OneSetupCapability } from "@/lib/onboarding/one-capabilities";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

/**
 * One capability row on the `/one/setup/capabilities` screen. Unlike the
 * removed hub's CapabilitySetupTile, the whole row is NOT one tap target --
 * "Connect" and dismiss are two separate, real buttons in the trailing slot,
 * so SettingsRow renders them via its own trailingInteractive split instead
 * of a full-row `<button>` overlay.
 */
export function CapabilityListRow({
  capability,
  copy,
  status,
  isDismissed,
  onRequestDismiss,
  onUndoDismiss,
}: {
  capability: OneSetupCapability;
  copy: CapabilitySetupCopy;
  status: CapabilityStatus;
  isDismissed: boolean;
  onRequestDismiss: () => void;
  onUndoDismiss: () => void;
}) {
  const router = useRouter();
  const display = getCapabilityStatusDisplay(status, {
    isExploreOnly: capability.isExploreOnly,
    actionLabel: copy.actionLabel,
    resumeActionLabel: copy.resumeActionLabel,
  });
  const isComplete = status.state === "completed";
  const didPrefetch = useRef(false);
  const prefetchRoute = useCallback(() => {
    if (didPrefetch.current) return;
    didPrefetch.current = true;
    router.prefetch(copy.href);
  }, [copy.href, router]);
  const handleConnect = useCallback(() => {
    const requested = requestInternalAppNavigation({
      href: copy.href,
      scroll: false,
      source: "tap",
      transitionMode: "full",
    });
    if (!requested) router.push(copy.href, { scroll: false });
  }, [copy.href, router]);

  return (
    <SettingsRow
      leading={
        <AgentSectionIcon
          id={capability.id}
          icon={capability.icon}
          tone={capability.tone}
          isActive={isCapabilityOnboarded(status)}
          size="setup"
        />
      }
      title={copy.title}
      description={
        <div className="line-clamp-2 md:line-clamp-none">{copy.setupBlurb}</div>
      }
      trailing={
        isComplete ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs font-medium text-[var(--tone-green)]">
            <CheckCircle2 className="h-[18px] w-[18px]" aria-hidden />
            Ready
          </span>
        ) : isDismissed ? (
          <Button type="button" variant="ghost" size="sm" onClick={onUndoDismiss}>
            Undo
          </Button>
        ) : (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              onClick={handleConnect}
              onPointerEnter={prefetchRoute}
              onFocus={prefetchRoute}
              data-voice-control-id={capability.setupControlId}
              data-href={copy.href}
            >
              {display.label}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0 rounded-full"
              aria-label={`Not set up ${copy.title}`}
              onClick={onRequestDismiss}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
        )
      }
      trailingInteractive
      testId={`one-setup-capability-row-${capability.id}`}
    />
  );
}
