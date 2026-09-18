"use client";

import Link from "next/link";

import { Progress } from "@/components/ui/progress";
import { ROUTES } from "@/lib/navigation/routes";
import { resolveOnboardingProgress } from "@/lib/onboarding/onboarding-progress";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";
import { useOnboardingDismissStore } from "@/lib/stores/onboarding-dismiss-store";

/**
 * "Finish setting up One" -- lives above the agent roster on the dashboard.
 * Renders nothing once every capability is completed or dismissed (not
 * collapsed, not hidden -- absent), so there's nothing left to see once
 * there's nothing left to decide.
 */
export function OneSetupProgressTile({
  capabilityStatusById,
  userId,
}: {
  capabilityStatusById: Record<string, CapabilityStatus>;
  userId?: string | null;
}) {
  const sessionDismissedIds = useOnboardingDismissStore(
    (state) => state.sessionDismissedIds,
  );
  const declinedIds = userId
    ? (PreVaultUserStateService.getCachedBootstrapState(userId)
        ?.setupCapabilityDeclinedIds ?? [])
    : [];
  const dismissedIds = new Set([...declinedIds, ...sessionDismissedIds]);
  const progress = resolveOnboardingProgress(
    capabilityStatusById,
    dismissedIds,
  );

  if (progress.isFinished) return null;

  const percent =
    progress.total > 0
      ? Math.round((progress.completed / progress.total) * 100)
      : 100;

  return (
    <Link
      href={ROUTES.ONE_SETUP_CAPABILITIES}
      data-testid="one-setup-progress-tile"
      className="mx-auto mb-4 block w-full max-w-[720px] rounded-[14px] border border-[color:var(--app-accent-border)] bg-[color:var(--app-accent-tint)] px-4 py-3.5 transition-colors hover:bg-[color:var(--app-accent-tint)]/80"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-[14px] font-semibold text-foreground">
          Finish setting up One
        </span>
        <span className="shrink-0 text-xs font-semibold tabular-nums text-[color:var(--app-accent-deep)]">
          {progress.completed} of {progress.total}
        </span>
      </div>
      <Progress value={percent} className="mt-2 h-1.5" />
    </Link>
  );
}
