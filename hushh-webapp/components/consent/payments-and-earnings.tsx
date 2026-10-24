"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { parseCommerceReturn } from "@/lib/services/scope-commerce-return";
import { AnswerPayoutAccount } from "./answer-payout-account";
import { DocumentHashcoinPayouts } from "./document-hashcoins";
import { ScopeCommerceAccountPanel } from "./scope-commerce-account-panel";

/** Compose existing financial owners; a hosted return never pools their funds. */
export function PaymentsAndEarnings() {
  const pathname = usePathname();
  const query = useSearchParams();
  const arrival = parseCommerceReturn(`${pathname}?${query.toString()}`);
  return <div className="consent-presentation-surface contents">
    <ScopeCommerceAccountPanel />
    {arrival?.source === "answers" ? <section aria-label="Answer payout setup"><AnswerPayoutAccount /></section> : null}
    <DocumentHashcoinPayouts />
  </div>;
}
