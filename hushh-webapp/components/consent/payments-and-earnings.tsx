"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { parseCommerceReturn } from "@/lib/services/scope-commerce-return";
import { AnswerPayoutAccount, type AnswerPayoutAccountModel } from "./answer-payout-account";
import type { useScopeCommerceAccount } from "./use-scope-commerce-account";
import { DocumentHashcoinPayouts } from "./document-hashcoins";
import { ScopeCommerceAccountPanel } from "./scope-commerce-account-panel";

/** Compose existing financial owners; a hosted return never pools their funds. */
export function PaymentsAndEarnings({ commerce, answer }: { commerce?: ReturnType<typeof useScopeCommerceAccount>; answer?: AnswerPayoutAccountModel } = {}) {
  const pathname = usePathname();
  const query = useSearchParams();
  const arrival = parseCommerceReturn(`${pathname}?${query.toString()}`);
  return <div className="consent-presentation-surface contents">
    <ScopeCommerceAccountPanel model={commerce} />
    {arrival?.source === "answers" ? <section aria-label="Answer payout setup"><AnswerPayoutAccount model={answer} /></section> : null}
    <DocumentHashcoinPayouts />
  </div>;
}
