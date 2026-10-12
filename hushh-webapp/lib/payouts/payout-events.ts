/**
 * The one client signal for payout state changes.
 *
 * The document-feed stream publishes it for typed `payout_changed` frames, and
 * local actions (cash out, a Stripe return) publish it too. Payout resources
 * subscribe by kind, so a bank-deposit update never rereads the coin wallet.
 * Consent and Feed listeners keep their own CONSENT_STATE_CHANGED bus.
 *
 * Kinds mirror consent-protocol/hushh_mcp/services/payout_doorbell.py. Missing
 * or unknown kinds mean every kind, which keeps an older server correct.
 */
export const PAYOUT_KINDS = ["wallet", "earnings", "bank_payouts", "account", "balance"] as const;
export type PayoutKind = (typeof PAYOUT_KINDS)[number];

export const PAYOUT_STATE_CHANGED_EVENT = "hushh:payout-state-changed";

export type PayoutChangeSource =
  | "sse"
  | "sse_reset"
  | "local_redeem"
  | "stripe_return"
  | "stall"
  | "resume"
  | "manual";

export type PayoutStateChangedDetail = {
  kinds: PayoutKind[];
  requestIds?: string[];
  source: PayoutChangeSource;
};

const KIND_SET: ReadonlySet<string> = new Set(PAYOUT_KINDS);
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Closed, de-duplicated kinds; anything missing or unknown means all kinds. */
export function normalizePayoutKinds(value: unknown): PayoutKind[] {
  if (!Array.isArray(value)) return [...PAYOUT_KINDS];
  const kinds = PAYOUT_KINDS.filter((kind) => value.includes(kind));
  return kinds.length && value.every((kind) => typeof kind === "string" && KIND_SET.has(kind))
    ? kinds
    : [...PAYOUT_KINDS];
}

function normalizeRequestIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((id): id is string => typeof id === "string" && REQUEST_ID.test(id)).slice(0, 20);
  return ids.length ? [...new Set(ids.map((id) => id.toLowerCase()))] : undefined;
}

export function dispatchPayoutStateChanged(detail: {
  kinds?: unknown;
  requestIds?: unknown;
  source: PayoutChangeSource;
}): void {
  if (typeof window === "undefined") return;
  const requestIds = normalizeRequestIds(detail.requestIds);
  const payload: PayoutStateChangedDetail = {
    kinds: normalizePayoutKinds(detail.kinds),
    source: detail.source,
    ...(requestIds ? { requestIds } : {}),
  };
  window.dispatchEvent(new CustomEvent<PayoutStateChangedDetail>(PAYOUT_STATE_CHANGED_EVENT, { detail: payload }));
}

export function subscribePayoutStateChanged(handler: (detail: PayoutStateChangedDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<PayoutStateChangedDetail>).detail;
    if (detail) handler(detail);
  };
  window.addEventListener(PAYOUT_STATE_CHANGED_EVENT, listener);
  return () => window.removeEventListener(PAYOUT_STATE_CHANGED_EVENT, listener);
}

/** True when a change names at least one of the kinds a resource depends on. */
export function payoutChangeTouches(detail: Pick<PayoutStateChangedDetail, "kinds">, kinds: readonly PayoutKind[]): boolean {
  return detail.kinds.some((kind) => kinds.includes(kind));
}
