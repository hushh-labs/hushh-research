"use client";

import { ProfileAccountLink } from "@/components/profile/profile-account-link";
import { SettingsGroup } from "@/components/app-ui/settings-ui";
import { useCommerceRead } from "@/components/consent/use-commerce-session";
import { ScopeCommerceService, commerceReadinessCopy, formatCommerceMoney, type CommerceAccount } from "@/lib/services/scope-commerce-service";

const hasPendingEarnings = (account: CommerceAccount) => (account.earnings?.pending_cents ?? 0) > 0;

/** Memory shows canonical earnings; Account owns funding, onboarding and transactions. */
export function MemoryCommerceSummary() {
  const { user, data, loading, error } = useCommerceRead("memory-earnings", ScopeCommerceService.account, hasPendingEarnings);
  if (!user) return null;
  return <SettingsGroup title="Memory earnings">
    <div className="space-y-2 px-4 py-3">
      {data?.earnings ? <dl className="grid grid-cols-2 gap-3 text-sm">
        <div><dt className="text-muted-foreground">Pending earnings</dt><dd>{formatCommerceMoney(data.earnings.pending_cents)}</dd></div>
        <div><dt className="text-muted-foreground">Available earnings</dt><dd>{formatCommerceMoney(data.earnings.available_cents)}</dd></div>
        {(data.earnings.debt_cents ?? 0) > 0 ? <div className="col-span-2"><dt className="text-muted-foreground">Unrecovered costs</dt><dd>{formatCommerceMoney(data.earnings.debt_cents!)}</dd></div> : null}
      </dl> : null}
      <p className="text-xs text-muted-foreground" role="status">{error || (loading && !data ? "Checking earnings…" : commerceReadinessCopy(data?.readiness))}</p>
      <ProfileAccountLink className="inline-flex min-h-11 items-center text-sm underline">{data?.readiness?.capabilities.start_onboarding && !data.seller?.eligible ? "Set up payouts and view your wallet" : "View wallet and transactions in Account"}</ProfileAccountLink>
    </div>
  </SettingsGroup>;
}
