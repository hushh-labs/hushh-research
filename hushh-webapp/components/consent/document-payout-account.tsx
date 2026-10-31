"use client";

// Compatibility facade: importers and their vi.mock factories keep this path.
// The payout UI lives in ./payouts/.
export { PAYOUT_FALLBACK_POLL_MS, PAYOUT_READY_SOURCE, usePayoutSnapshot } from "./payouts/use-payout-snapshot";
export { DocumentPayoutAccountCard } from "./payouts/payout-bank-row";
export type { PayoutAccountState } from "./payouts/payout-bank-row";
export { DocumentEarningsHistory } from "./payouts/earnings-history";
export { DocumentBankPayoutStatusCard } from "./payouts/bank-deposits";
