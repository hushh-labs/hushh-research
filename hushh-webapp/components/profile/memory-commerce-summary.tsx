"use client";

import { ProfilePaymentsLink } from "@/components/profile/profile-account-link";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { useCommerceRead } from "@/components/consent/use-commerce-session";
import { ScopeCommerceService, formatCommerceMoney, type CommerceAccount } from "@/lib/services/scope-commerce-service";

const hasPendingEarnings = (account: CommerceAccount) => (account.earnings?.pending_cents ?? 0) > 0;

/** Memory shows canonical earnings; Payments and earnings owns funding, onboarding and transactions. */
export function MemoryCommerceSummary() {
  const { user, data, loading, error } = useCommerceRead("memory-earnings", ScopeCommerceService.account, hasPendingEarnings);
  if (!user) return null;
  const hasEarnings = Boolean(data?.earnings && (data.earnings.pending_cents !== 0 || data.earnings.available_cents !== 0 || (data.earnings.debt_cents ?? 0) > 0 || (data.earnings.withdrawing_cents ?? 0) > 0));
  const content = (
    <div className="space-y-2 px-4 py-3">
      {hasEarnings && data?.earnings ? <dl className="grid grid-cols-2 gap-3 text-sm">
        <div><dt className="text-muted-foreground">Pending earnings</dt><dd>{formatCommerceMoney(data.earnings.pending_cents)}</dd></div>
        <div><dt className="text-muted-foreground">Available earnings</dt><dd>{formatCommerceMoney(data.earnings.available_cents)}</dd></div>
        {(data.earnings.debt_cents ?? 0) > 0 ? <div className="col-span-2"><dt className="text-muted-foreground">Unrecovered costs</dt><dd>{formatCommerceMoney(data.earnings.debt_cents!)}</dd></div> : null}
        {(data.earnings.withdrawing_cents ?? 0) > 0 ? <div className="col-span-2"><dt className="text-muted-foreground">Withdrawal in progress</dt><dd>{formatCommerceMoney(data.earnings.withdrawing_cents!)}</dd></div> : null}
      </dl> : null}
      {error || (loading && !data) ? <p className="text-xs text-muted-foreground" role="status">{error || "Checking earnings…"}</p> : null}
      <ProfilePaymentsLink className="inline-flex min-h-11 items-center text-sm underline">{data?.readiness?.capabilities.start_onboarding && !data.seller?.eligible ? "Set up payouts and view your wallet" : "View payments and earnings"}</ProfilePaymentsLink>
    </div>
  );
  return hasEarnings ? <SettingsGroup title="Memory earnings">{content}</SettingsGroup> : content;
}
