"use client";

import Link from "next/link";

import { Progress } from "@/components/ui/progress";
import { ROUTES } from "@/lib/navigation/routes";
import { CAPABILITY_SETUP_COPY } from "@/lib/onboarding/capability-setup-copy";
import { resolveOnboardingProgress } from "@/lib/onboarding/onboarding-progress";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import type { CapabilityStatus } from "@/lib/services/capability-setup-state-service";
import { useOnboardingDismissStore } from "@/lib/stores/onboarding-dismiss-store";

/**
 * "Finish setting up One" -- lives above the agent roster on the dashboard.
 * Renders nothing once every capability is completed or dismissed (not
 * collapsed, not hidden -- absent), so there's nothing left to see once
 * there's nothing left to decide.
 *
 * Styled as the same neutral white card + hairline border + soft shadow as
 * the agent grid it sits above (not a whole tinted-blue card) -- this app's
 * own card model reserves tone color for one accent per surface (see
 * capability-setup-tile.tsx), never for tinting outer chrome.
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

  const nextUp = progress.remainingIds
    .slice(0, 2)
    .map(
      (id) => CAPABILITY_SETUP_COPY.find((copy) => copy.id === id)?.title ?? id,
    );
  const remainderCount = progress.remainingIds.length - nextUp.length;
  const subtitle =
    nextUp.length === 0
      ? "Everything left is dismissed"
      : remainderCount > 0
        ? `${nextUp.join(", ")}, and ${remainderCount} more`
        : nextUp.join(" and ");

  return (
    <Link
      href={ROUTES.ONE_SETUP_CAPABILITIES}
      data-testid="one-setup-progress-tile"
      className="group block overflow-hidden rounded-[20px] border border-[rgba(60,60,67,.10)] bg-white/95 p-4 shadow-[0_16px_42px_-28px_rgba(0,0,0,.12)] transition-[box-shadow,transform] active:scale-[0.995] dark:border-white/[0.1] dark:bg-[#0A0A0C] dark:shadow-[0_12px_40px_-20px_rgba(0,0,0,0.85)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold leading-5 text-[#1D1D1F] dark:text-[#F5F5F7]">
            Finish setting up One
          </p>
          <p className="mt-0.5 truncate text-[13px] leading-4 text-[#8E8E93]">
            {subtitle}
          </p>
        </div>
        <span className="shrink-0 rounded-full bg-[color:var(--app-accent-tint)] px-2.5 py-1 text-[12px] font-semibold tabular-nums text-[color:var(--app-accent-deep)]">
          {progress.completed} of {progress.total}
        </span>
      </div>
      <Progress
        value={percent}
        className="mt-3 h-[5px] bg-[rgba(60,60,67,.12)] dark:bg-white/[0.1]"
        indicatorClassName="bg-[color:var(--app-accent)]"
      />
    </Link>
  );
}
