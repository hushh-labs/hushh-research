"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ScopeCommerceService, parseCommerceDollarInput, type CommerceAccount, type CommerceTransferPreview } from "@/lib/services/scope-commerce-service";
import { COMMERCE_RETURN_EVENT, commerceReturnAction, openCommerceHostedUrl } from "@/lib/services/scope-commerce-browser";
import { useCommerceRead } from "@/components/consent/use-commerce-session";
import { useCommerceAction } from "@/components/consent/use-commerce-action";

type TransferReview = { kind: "withdraw" | "refund"; lotId?: string; preview: CommerceTransferPreview; key: string };

function useOnboardingRefresh(refresh: () => Promise<void>) {
  const searchParams = useSearchParams();
  const [returnedRefresh, setReturnedRefresh] = useState(false);
  const queryRefresh = commerceReturnAction(`/one/profile/account?${searchParams.toString()}`) === "onboarding_refresh";
  useEffect(() => {
    const onReturn = (event: Event) => {
      setReturnedRefresh((event as CustomEvent<{ action?: string }>).detail?.action === "onboarding_refresh");
      void refresh();
    };
    window.addEventListener(COMMERCE_RETURN_EVENT, onReturn);
    return () => window.removeEventListener(COMMERCE_RETURN_EVENT, onReturn);
  }, [refresh]);
  return queryRefresh || returnedRefresh;
}

export function useScopeCommerceAccount() {
  const load = useCallback(async (token: string) => {
    const account = await ScopeCommerceService.account(token);
    return { ...account, readiness: account.readiness || await ScopeCommerceService.readiness(token).catch(() => undefined) };
  }, []);
  const resource = useCommerceRead("account", load, (value: CommerceAccount) => Boolean(
    value.balance?.reserved_cents || value.balance?.frozen_cents || value.earnings?.pending_cents || value.earnings?.withdrawing_cents ||
    value.recent_withdrawals?.some(item => ["queued", "pending", "processing", "transferred", "unknown"].includes(item.status)),
  ));
  const { user, data: account, refresh } = resource;
  const { busy, message, setMessage, run } = useCommerceAction(resource, "account");
  const [amount, setAmount] = useState("10.00");
  const [country, setCountry] = useState("US");
  const [review, setReview] = useState<TransferReview | null>(null);
  const fundingKey = useRef<string | null>(null);
  const onboardingRefresh = useOnboardingRefresh(refresh);
  useEffect(() => { setReview(null); fundingKey.current = null; }, [user]);
  const changeAmount = (value: string) => { setAmount(value); fundingKey.current = null; };
  const checkout = () => run(async (token, current) => {
    const cents = parseCommerceDollarInput(amount, 50); fundingKey.current ??= crypto.randomUUID();
    const url = await ScopeCommerceService.checkout(token, cents, fundingKey.current);
    if (current()) { await openCommerceHostedUrl(url, "checkout"); fundingKey.current = null; }
  });
  const onboarding = () => run(async (token, current) => {
    const url = await ScopeCommerceService.onboarding(token, account?.seller.country || country, crypto.randomUUID());
    if (current()) await openCommerceHostedUrl(url, "onboarding");
  });
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
  return { user, account, refresh, busy, message: message || resource.error, amount, country, changeAmount,
    changeCountry: setCountry, review, closeReview: () => { if (!busy) setReview(null); }, onboardingRefresh,
    checkout, onboarding, withdrawal, refund, confirmTransfer };
}
