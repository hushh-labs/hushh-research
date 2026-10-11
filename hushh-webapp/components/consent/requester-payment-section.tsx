"use client";

import type { RequesterPaymentView, RequesterPriceView } from "@/lib/consent/document-request-payment-view";

export type RequesterPaymentSectionProps = {
  requestId: string;
  revision: number;
  payment: RequesterPaymentView | null;
  price: RequesterPriceView | null;
  /** Called after Pay, Withdraw or a state change, so the panel reloads its snapshot. */
  onChanged: () => void;
};

/**
 * CONTRACT (request-money lane): the requester's payment block inside the
 * request details panel: state and countdown from the shared presenter, Pay
 * while payable, a clear next step once expired, and Withdraw request (#23)
 * with an armed confirmation. Renders nothing when no payment applies.
 */
export function RequesterPaymentSection(props: RequesterPaymentSectionProps) {
  void props;
  return null;
}
