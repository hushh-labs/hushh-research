"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ScopeCommerceService, parseCommerceDollarInput, type CommerceAccount, type CommerceTransferPreview } from "@/lib/services/scope-commerce-service";
import { COMMERCE_RETURN_EVENT, commerceReturnAction } from "@/lib/services/scope-commerce-browser";
import { useCommerceRead } from "@/components/consent/use-commerce-session";
import { useCommerceAction } from "@/components/consent/use-commerce-action";
import { useCommerceHostedFlow } from "@/components/consent/use-commerce-hosted-flow";
import { useCommerceManagement } from "@/components/consent/use-commerce-management";
import { subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { parseCommerceReturn } from "@/lib/services/scope-commerce-return";

type TransferReview = { kind: "withdraw" | "refund"; lotId?: string; preview: CommerceTransferPreview; key: string };

function useOnboardingRefresh({ user, capture, refresh }: ReturnType<typeof useCommerceRead<CommerceAccount>>) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  type Hint = { user: typeof user; current: () => boolean; query?: string };
  const [returnedRefresh, setReturnedRefresh] = useState<Hint | null>(null);
  const [queryRefresh, setQueryRefresh] = useState<Hint | null>(null);
  const query = searchParams.toString();
  const refreshQuery = !parseCommerceReturn(`${pathname}?${query}`)?.source && commerceReturnAction(`${pathname}?${query}`) === "onboarding_refresh" ? query : "";
  useEffect(() => {
    setQueryRefresh(previous => !refreshQuery ? null : previous?.query === refreshQuery ? previous :
      user ? { user, current: capture(), query: refreshQuery } : null);
  }, [refreshQuery, user, capture]);
  useEffect(() => subscribeVaultSessionEpoch(() => {
    setReturnedRefresh(null);
    setQueryRefresh(previous => previous ? { ...previous, current: () => false } : null);
  }), []);
  useEffect(() => {
    const onReturn = (event: Event) => {
      if ((event as CustomEvent<{ source?: string }>).detail?.source !== undefined) return;
      setReturnedRefresh(user && (event as CustomEvent<{ action?: string }>).detail?.action === "onboarding_refresh" ?
        { user, current: capture() } : null);
      void refresh();
    };
    window.addEventListener(COMMERCE_RETURN_EVENT, onReturn);
    return () => window.removeEventListener(COMMERCE_RETURN_EVENT, onReturn);
  }, [user, capture, refresh]);
  return Boolean([queryRefresh, returnedRefresh].some(hint => hint && hint.user === user && hint.current()));
}

export function useScopeCommerceAccount({ active = true }: { active?: boolean } = {}) {
  const load = useCallback(async (token: string) => {
    const account = await ScopeCommerceService.account(token);
    const [readiness, sandboxVerified] = await Promise.all([
      account.readiness || ScopeCommerceService.readiness(token).catch(() => undefined),
      ScopeCommerceService.sandboxVerified(token).catch(() => undefined),
    ]);
    return { ...account, readiness, sandboxVerified };
  }, []);
  const resource = useCommerceRead("account", load, (value: CommerceAccount) => Boolean(
    value.balance?.reserved_cents || value.balance?.frozen_cents || value.earnings?.pending_cents || value.earnings?.withdrawing_cents ||
    value.recent_withdrawals?.some(item => ["queued", "pending", "processing", "transferred", "unknown"].includes(item.status)),
  ), active);
  const { user, data: account, refresh } = resource;
  const capture = resource.capture;
  const current = useCallback(() => capture()(), [capture]);
  const actions = useCommerceAction(resource, "account");
  const { busy, message, setMessage, run } = actions;
  const managePayoutAccount = useCommerceManagement(resource, actions, ScopeCommerceService.managePayoutAccount);
  const [amount, setAmount] = useState("10.00");
  const [country, setCountry] = useState("US");
  const [review, setReview] = useState<TransferReview | null>(null);
  const fundingKey = useRef<string | null>(null);
  const fundingValue = useRef(amount);
  const onboardingRefresh = useOnboardingRefresh(resource);
  useEffect(() => { setReview(null); fundingKey.current = null; }, [user]);
  const changeAmount = (value: string) => {
    if (fundingValue.current === value) return;
    fundingValue.current = value; setAmount(value); fundingKey.current = null;
  };
  const hosted = useCommerceHostedFlow(resource, actions, async (token, purpose) => {
    if (purpose === "checkout") {
      const cents = parseCommerceDollarInput(amount, 50);
      fundingKey.current ??= crypto.randomUUID();
      return ScopeCommerceService.checkout(token, cents, fundingKey.current);
    }
    return ScopeCommerceService.onboarding(token, account?.seller.country || country, crypto.randomUUID());
  }, async purpose => {
    if (purpose === "checkout") fundingKey.current = null;
    await refresh();
  });
  const checkout = () => hosted.startHosted("checkout");
  const onboarding = () => hosted.startHosted("onboarding");
  const withdrawal = () => run(async (token, current) => {
    const preview = await ScopeCommerceService.withdrawalPreview(token);
    if (current()) setReview({ kind: "withdraw", preview, key: crypto.randomUUID() });
  });
  const refund = (lotId: string, refundable: number) => run(async (token, current) => {
    const preview = await ScopeCommerceService.refundPreview(token, lotId, refundable);
    if (current()) setReview({ kind: "refund", lotId, preview, key: crypto.randomUUID() });
  });
  const confirmTransfer = () => run(async (token, current) => {
    if (!review || review.preview.blocked_reason) return;
    if (review.kind === "withdraw") await ScopeCommerceService.withdraw(token, review.key, review.preview.preview_token);
    else if (review.lotId) await ScopeCommerceService.refund(token, review.lotId, review.preview.amount_cents, review.key, review.preview.preview_token);
    if (!current()) return;
    setReview(null); await refresh();
    if (current()) setMessage("Request received. Settlement remains unconfirmed until payment status updates.");
  });
  return { user, userId: resource.userId, account, refresh, busy, message: message || resource.error, amount, country, changeAmount,
    changeCountry: setCountry, review, closeReview: () => { if (!busy) setReview(null); }, onboardingRefresh,
    checkout, onboarding, managePayoutAccount, hostedPending: hosted.hostedPending, cancelHosted: hosted.cancelHosted, withdrawal, refund, confirmTransfer,
    current, loading: resource.loading };
}
