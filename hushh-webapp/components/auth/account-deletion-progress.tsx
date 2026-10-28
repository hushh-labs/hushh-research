"use client";

import { AppStreamEventList } from "@/components/app-ui/stream-progress-panel";
import { accountDeletionSteps, formatCountdown, type AccountDeletionStep } from "@/lib/auth/account-deletion-progress";
import type { AccountRegistrationRecovery } from "@/lib/auth/account-registration";
import { HushhMark } from "@/lib/morphy-ux/ui/hushh-mark";
import { useCoarseClock } from "@/lib/perf/use-periodic-task";
import { cn } from "@/lib/utils";

/** Deletion progress, rendered in place inside the session privacy gate (never the boot
 * surface). The gate's role="alert" already announces step changes, so this adds no
 * second live region, and the per-second countdown stays out of the accessible text. */
export function AccountDeletionProgress({ steps, countdown }: { steps: readonly AccountDeletionStep[]; countdown?: string }) {
  return (
    <div className="mt-5 rounded-2xl border border-border/60 bg-background/60 p-4 text-left">
      <AppStreamEventList
        ariaLabel="Account deletion progress"
        className="max-h-none overflow-visible"
        items={steps.map((step) => ({ ...step }))}
      />
      {countdown && <p aria-hidden="true" className="mt-3 pl-5 text-xs tabular-nums text-muted-foreground">Opens in {countdown}</p>}
    </div>
  );
}

/** Breathes only while the backend is working; still while cleanup waits on the person. */
export function AccountDeletionMark({ still = false }: { still?: boolean }) {
  return (
    <div aria-hidden="true" className="relative mx-auto mb-5 size-12">
      <span className={cn("absolute inset-0 rounded-full bg-muted", !still && "motion-safe:animate-pulse")} />
      <HushhMark className="relative size-12 p-2.5" />
    </div>
  );
}

function SignInCountdown({ recovery }: { recovery: Extract<AccountRegistrationRecovery, { state: "waiting_for_identity" }> }) {
  // The shared clock can be stale for a new subscriber; never show a time from the past.
  // Only this list re-renders each second; the AuthProvider owns the re-check at retry_at.
  const now = Math.max(Date.now(), useCoarseClock(1_000));
  return <AccountDeletionProgress steps={accountDeletionSteps(null, recovery)} countdown={formatCountdown(recovery.retry_at - now / 1000)} />;
}

export function RegistrationProgress({ recovery }: { recovery: AccountRegistrationRecovery }) {
  return recovery.state === "waiting_for_identity"
    ? <SignInCountdown recovery={recovery} />
    : <AccountDeletionProgress steps={accountDeletionSteps(null, recovery)} />;
}
