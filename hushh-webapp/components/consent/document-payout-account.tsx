"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { HelperText } from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import { CONSENT_STATE_CHANGED_EVENT } from "@/lib/consent/consent-events";
import {
  DocumentPayoutService,
  type DocumentPayoutAccount,
  type DocumentBankPayout,
} from "@/lib/services/document-payout-service";
import { useVault } from "@/lib/vault/vault-context";

function stripeConnectUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "connect.stripe.com"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** One Connect account serves packet and document earnings, but each has its own ledger. */
export function DocumentPayoutAccountCard({
  active = true,
  compact = false,
  handleReturn = false,
  disabled = false,
}: {
  active?: boolean;
  compact?: boolean;
  handleReturn?: boolean;
  disabled?: boolean;
}) {
  const { vaultOwnerToken } = useVault();
  const searchParams = useSearchParams();
  const returnState = handleReturn ? searchParams.get("documentPayouts") : null;
  const [account, setAccount] = useState<DocumentPayoutAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshAttemptedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!active || !vaultOwnerToken) {
      setAccount(null);
      return;
    }
    let cancelled = false;
    setAccount(null);
    setLoading(true);
    setError(null);
    void DocumentPayoutService.account(vaultOwnerToken)
      .then(({ account: next }) => {
        if (!cancelled) setAccount(next);
      })
      .catch(() => {
        if (!cancelled) setError("Couldn't check payout setup. Try again later.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, vaultOwnerToken]);

  const start = useCallback(async () => {
    if (!vaultOwnerToken) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await DocumentPayoutService.onboard(vaultOwnerToken);
      const destination = stripeConnectUrl(url);
      if (!destination) throw new Error("Unexpected onboarding link");
      window.location.assign(destination);
    } catch {
      setError("Couldn't open payout setup. Try again.");
      setBusy(false);
    }
  }, [vaultOwnerToken]);

  useEffect(() => {
    if (!active || returnState !== "refresh" || !vaultOwnerToken) return;
    if (refreshAttemptedFor.current === vaultOwnerToken) return;
    refreshAttemptedFor.current = vaultOwnerToken;
    void start();
  }, [active, returnState, start, vaultOwnerToken]);

  if (!active || !vaultOwnerToken) return null;

  const ready = account?.ready === true;
  const setupLabel = account ? "Finish payout setup" : "Set up US payouts";
  const description = ready
    ? "Ready to receive document earnings after delivery."
    : account?.status === "restricted"
      ? "Payout setup needs attention before you can receive earnings."
      : "Set up a US bank account to receive document earnings after delivery.";

  return (
    <section
      aria-label="Document payouts"
      className={compact ? "rounded-xl border border-border/60 p-3" : "rounded-2xl border border-border p-5"}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Document payouts</p>
          <HelperText className="mt-1">{description} US payouts only.</HelperText>
        </div>
        {!ready && !loading ? (
          <Button type="button" size="standard" disabled={busy || disabled} onClick={() => void start()}>
            {busy ? "Opening…" : setupLabel}
          </Button>
        ) : null}
      </div>
      {loading ? <HelperText role="status" className="mt-2">Checking payout setup…</HelperText> : null}
      {error ? <HelperText role="alert" className="mt-2">{error}</HelperText> : null}
    </section>
  );
}

function bankPayoutCopy(payout: DocumentBankPayout): string {
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(payout.amountCents / 100);
  switch (payout.status) {
    case "pending": return `${amount} bank payout pending.`;
    case "in_transit": return `${amount} bank payout on its way.`;
    case "paid": return `${amount} bank payout paid.`;
    case "canceled": return `${amount} bank payout canceled.`;
    case "failed": return `${amount} bank payout failed. Check your linked bank details.`;
  }
}

/** Stripe's aggregate bank payout is separate from a document transfer. */
export function DocumentBankPayoutStatusCard({
  compact = false,
  refreshOnFeedChange = false,
  onVisibleChange,
}: {
  compact?: boolean;
  refreshOnFeedChange?: boolean;
  onVisibleChange?: (visible: boolean) => void;
}) {
  const { vaultOwnerToken } = useVault();
  const [snapshot, setSnapshot] = useState<{ token: string; payout: DocumentBankPayout | null } | null>(null);
  const [error, setError] = useState(false);
  const latest = snapshot?.token === vaultOwnerToken ? snapshot.payout : null;

  useEffect(() => { onVisibleChange?.(Boolean(latest)); }, [latest, onVisibleChange]);

  useEffect(() => {
    if (!vaultOwnerToken) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    setSnapshot(null);
    setError(false);
    const load = () => {
      void DocumentPayoutService.bankPayouts(vaultOwnerToken)
        .then(({ payouts }) => {
          if (cancelled) return;
          setSnapshot({ token: vaultOwnerToken, payout: payouts[0] ?? null });
          setError(false);
        })
        .catch(() => { if (!cancelled) setError(true); });
    };
    load();
    const onFeedReset = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string; requestId?: string }>).detail;
      if (detail?.source === "sse_document_feed" && !detail.requestId) load();
    };
    if (refreshOnFeedChange) window.addEventListener(CONSENT_STATE_CHANGED_EVENT, onFeedReset);
    return () => {
      cancelled = true;
      if (refreshOnFeedChange) window.removeEventListener(CONSENT_STATE_CHANGED_EVENT, onFeedReset);
    };
  }, [vaultOwnerToken, refreshOnFeedChange]);

  if (!vaultOwnerToken || (!latest && (!error || compact))) return null;
  return (
    <section aria-label="Bank payout status"
      className={compact ? "rounded-xl border border-border/60 px-4 py-3" : "rounded-2xl border border-border p-5"}>
      <p className="text-sm font-semibold">Bank payout</p>
      {latest ? <HelperText className="mt-1">{bankPayoutCopy(latest)}</HelperText> : null}
      {error ? <HelperText className="mt-1">Couldn't check bank payouts right now.</HelperText> : null}
      {latest ? <HelperText className="mt-1">Bank payouts may combine earnings from multiple requests.</HelperText> : null}
    </section>
  );
}
