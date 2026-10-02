"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/lib/morphy-ux/morphy";
import { OneMarketplaceService, type OwnerPayouts } from "@/lib/one-marketplace/service";

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Where the owner's packet earnings go. hussh collects from buyers and pays the
 * owner through Stripe once a packet is delivered and payouts are set up.
 */
export function PayoutsCard({ token }: { token?: string }) {
  const [payouts, setPayouts] = useState<OwnerPayouts | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    OneMarketplaceService.getPayouts({ vaultOwnerToken: token })
      .then((next) => !cancelled && setPayouts(next))
      .catch(() => !cancelled && setPayouts(null));
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token) return null;

  const start = async () => {
    setBusy(true);
    try {
      const { url } = await OneMarketplaceService.startPayoutOnboarding({ vaultOwnerToken: token });
      if (url.startsWith("https://connect.stripe.com/")) window.location.assign(url);
      else throw new Error("Unexpected onboarding link");
    } catch {
      toast.error("Couldn't open payout setup. Try again.");
      setBusy(false);
    }
  };

  const ready = payouts?.account?.payoutsEnabled === true;
  const e = payouts?.earningsCents;

  return (
    <section className="rounded-2xl border p-5" aria-labelledby="payouts-heading">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="payouts-heading" className="text-lg font-semibold">
            Payouts
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {ready ? "Your earnings are paid to your bank." : "Set up payouts to get paid for your packets."}
          </p>
        </div>
        {ready ? null : (
          <Button type="button" size="sm" disabled={busy} onClick={start}>
            {payouts?.account ? "Finish setup" : "Set up payouts"}
          </Button>
        )}
      </div>
      {e ? (
        <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Waiting for delivery</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">{usd(e.awaitingDelivery)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Due to you</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">{usd(e.due)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Paid out</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">{usd(e.paidOut)}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
