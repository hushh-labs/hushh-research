"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { parseCommerceReturn } from "@/lib/services/scope-commerce-return";
import { AnswerPayoutAccount, type AnswerPayoutAccountModel } from "./answer-payout-account";
import { DocumentHashcoinPayouts } from "./document-hashcoins";

/** Existing payouts with source-bound recovery for an answer Stripe return. */
export function PaymentsAndEarnings({ answer }: { answer?: AnswerPayoutAccountModel } = {}) {
  const pathname = usePathname();
  const query = useSearchParams();
  const arrival = parseCommerceReturn(`${pathname}?${query.toString()}`);
  return <div className="consent-presentation-surface contents">
    {arrival?.source === "answers" ? <section aria-label="Answer payout setup"><AnswerPayoutAccount model={answer} /></section> : null}
    <DocumentHashcoinPayouts />
  </div>;
}
