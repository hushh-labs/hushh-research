import { ApiService } from "@/lib/services/api-service";
import { parseCommerceReadiness, commerceActionError, type CommerceReadiness } from "@/lib/services/scope-commerce-readiness";
export { parseCommerceReadiness, commerceReadinessCopy, CommerceActionError } from "@/lib/services/scope-commerce-readiness";
export type { CommerceReadiness } from "@/lib/services/scope-commerce-readiness";

export type ScopeTariff = {
  scope_handle: string; machine_scope: string; price_cents: number;
  base_duration_seconds: number; tariff_revision: number;
};
export type ScopeQuote = {
  id: string; request_id: string; scope_handle: string; machine_scope: string;
  amount_cents: number; base_price_cents: number; base_duration_seconds: number;
  duration_seconds: number; currency: "USD"; expires_at: string;
};
export type ScopePurchase = {
  id: string; request_id: string; status: string; amount_cents: number;
  duration_seconds?: number; activation_at?: string | null; expires_at?: string | null;
  processing_fee_micro_usd?: number; net_earnings_micro_usd?: number;
  fulfillment_deadline?: string | null;
};
export type CommerceAccount = {
  enabled: boolean; managed_balances?: boolean; currency: "USD";
  readiness?: CommerceReadiness;
  balance: { available_cents: number; reserved_cents: number; frozen_cents?: number };
  earnings: { pending_cents: number; available_cents: number; debt_cents?: number; withdrawing_cents?: number };
  seller: { onboarded: boolean; eligible: boolean; country: string | null };
  payout: { minimum_net_cents: number };
  funding_lots: Array<{ id: string; refundable_cents: number }>;
  recent_withdrawals?: Array<{ id: string; status: string; net_cents: number; fee_micro_usd: number; fees_final: boolean; created_at: string }>;
};
export type ScopeCommerceRequest = {
  request_id: string; role: "owner" | "payer";
  machine_scope: string; scope_handle: string; duration_seconds: number;
  purpose: string; tariff: ScopeTariff | null; purchase: ScopePurchase | null;
  refresh_policy?: string;
  scope_label?: string; counterpart_label?: string; recipient_label?: string;
  available_balance_cents?: number; shortfall_cents?: number;
  request_deadline?: string | null;
  negative_net_acknowledgement?: NegativeNetTerms | null;
};
export type NegativeNetAcknowledgement = { version: 1; binding: string; acknowledged: true };
export type NegativeNetTerms = {
  version: 1; binding: string; gross_cents: number;
  processing_fee_micro_usd: number; net_earnings_micro_usd: number;
};
export type CommerceActivityView = "purchases" | "sales" | "transactions";
export type CommerceActivityItem = {
  id: string; request_id: string | null; purchase_id: string | null;
  kind: string; status: string; direction: "incoming" | "outgoing" | "neutral";
  counterpart: { label: string; public_ref?: string } | null;
  scope_label: string | null; machine_scope: string | null; scope_handle: string | null;
  amount_cents: number; gross_cents: number; processing_fee_micro_usd: number | null;
  net_earnings_micro_usd: number | null; refunded_cents: number | null;
  created_at: string; activation_at: string | null; expires_at: string | null;
  matures_at: string | null; fulfillment_deadline: string | null;
  next_action: { label: string; href: string } | null;
};
export type CommerceActivityPage = { items: CommerceActivityItem[]; next_cursor: string | null };
export type CommerceTransferPreview = {
  amount_cents: number; fee_cents: number; net_cents: number;
  minimum_net_cents?: number; blocked_reason?: string | null;
  preview_token: string;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The payment response could not be verified.");
  return value as Record<string, unknown>;
}
function cents(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new Error("The payment amount could not be verified.");
  return Number(value);
}
function identity(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error("The payment identity could not be verified.");
  return value;
}
function timestamp(value: unknown): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("The payment timeline could not be verified.");
}
function signedInteger(value: unknown): void {
  if (!Number.isSafeInteger(value)) throw new Error("The earnings could not be verified.");
}
function cursor(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || !/^[A-Za-z0-9_.=-]+$/.test(value)) throw new Error("The payment history cursor could not be verified.");
  return value;
}
function validateNegativeNetAcknowledgement(value: NegativeNetAcknowledgement): void {
  if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.binding) || value.acknowledged !== true) throw new Error("Review the owner costs before preparing information.");
}
export function parseCommerceActivityPage(value: unknown): CommerceActivityPage {
  const page = record(value);
  if (!Array.isArray(page.items) || page.items.length > 100 || (page.next_cursor !== null && typeof page.next_cursor !== "string")) throw new Error("Payment history could not be verified.");
  if (page.next_cursor !== null) cursor(page.next_cursor);
  page.items.forEach(value => {
    const item = record(value); identity(item.id);
    for (const key of ["request_id", "purchase_id"]) if (item[key] !== null) identity(item[key]);
    for (const key of ["kind", "status"]) if (typeof item[key] !== "string" || !item[key]) throw new Error("Payment history could not be verified.");
    if (!["incoming", "outgoing", "neutral"].includes(String(item.direction))) throw new Error("Payment history could not be verified.");
    for (const key of ["scope_label", "machine_scope", "scope_handle"]) if (item[key] !== null && typeof item[key] !== "string") throw new Error("The sharing section could not be verified.");
    cents(item.amount_cents); cents(item.gross_cents);
    for (const key of ["processing_fee_micro_usd", "refunded_cents"]) if (item[key] !== null) cents(item[key]);
    if (item.net_earnings_micro_usd !== null) signedInteger(item.net_earnings_micro_usd);
    timestamp(item.created_at);
    for (const key of ["activation_at", "expires_at", "matures_at", "fulfillment_deadline"]) if (item[key] !== null) timestamp(item[key]);
    if (item.counterpart !== null) {
      const counterpart = record(item.counterpart);
      if (typeof counterpart.label !== "string" || !counterpart.label || (counterpart.public_ref !== undefined && typeof counterpart.public_ref !== "string")) throw new Error("The recipient could not be verified.");
    }
    if (item.next_action !== null) {
      const action = record(item.next_action);
      const expected = item.request_id ? `/one/consent?commerceRequestId=${encodeURIComponent(String(item.request_id))}` : null;
      if (typeof action.label !== "string" || !action.label || (action.href !== "/one/profile/account" && action.href !== expected)) throw new Error("The payment action could not be verified.");
    }
  });
  return page as unknown as CommerceActivityPage;
}
export function parseCommerceTransferPreview(value: unknown): CommerceTransferPreview {
  const preview = record(value);
  cents(preview.amount_cents); cents(preview.fee_cents); cents(preview.net_cents);
  if (typeof preview.preview_token !== "string" || !/^[a-f0-9]{64}$/.test(preview.preview_token)) throw new Error("Refresh the transfer costs before confirming.");
  if (Number(preview.net_cents) > Number(preview.amount_cents) ||
      (preview.minimum_net_cents !== undefined && (!Number.isSafeInteger(preview.minimum_net_cents) || Number(preview.minimum_net_cents) < 50)) ||
      (preview.blocked_reason !== undefined && preview.blocked_reason !== null && typeof preview.blocked_reason !== "string")) {
    throw new Error("The transfer costs could not be verified. Refresh before confirming.");
  }
  return preview as unknown as CommerceTransferPreview;
}
export function parseScopeQuote(value: unknown): ScopeQuote {
  const quote = record(value);
  identity(quote.id); identity(quote.request_id);
  cents(quote.amount_cents, 100_000); cents(quote.base_price_cents, 100_000);
  if (quote.currency !== "USD" || typeof quote.scope_handle !== "string" || !quote.scope_handle ||
      typeof quote.machine_scope !== "string" || !quote.machine_scope ||
      !Number.isSafeInteger(quote.duration_seconds) || Number(quote.duration_seconds) <= 0 ||
      !Number.isSafeInteger(quote.base_duration_seconds) || Number(quote.base_duration_seconds) <= 0 ||
      typeof quote.expires_at !== "string" || !Number.isFinite(Date.parse(quote.expires_at))) {
    throw new Error("The access quote could not be verified.");
  }
  return quote as unknown as ScopeQuote;
}
export function parseCommerceAccount(value: unknown): CommerceAccount {
  const account = record(value);
  if (account.readiness !== undefined) {
    // Additive availability must fail closed for new actions without hiding
    // already-owned funds or receipts when its schema cannot be verified.
    try { account.readiness = parseCommerceReadiness(account.readiness); }
    catch { delete account.readiness; }
  }
  if (account.enabled === false && account.managed_balances !== true && account.balance === undefined) return account as unknown as CommerceAccount;
  if (typeof account.enabled !== "boolean" || account.currency !== "USD") throw new Error("Payments are unavailable.");
  for (const [group, keys] of [["balance", ["available_cents", "reserved_cents"]], ["payout", ["minimum_net_cents"]]] as const) {
    const values = record(account[group]); keys.forEach(key => cents(values[key]));
  }
  const balance = record(account.balance);
  if (balance.frozen_cents !== undefined) cents(balance.frozen_cents);
  const earnings = record(account.earnings);
  for (const key of ["pending_cents", "available_cents"]) if (!Number.isSafeInteger(earnings[key])) throw new Error("The earnings could not be verified.");
  if (earnings.debt_cents !== undefined) cents(earnings.debt_cents);
  if (earnings.withdrawing_cents !== undefined) cents(earnings.withdrawing_cents);
  const seller = record(account.seller);
  if (typeof seller.onboarded !== "boolean" || typeof seller.eligible !== "boolean" || !Array.isArray(account.funding_lots)) throw new Error("The payment account could not be verified.");
  account.funding_lots.forEach(lot => { const item = record(lot); identity(item.id); cents(item.refundable_cents); });
  if (account.recent_withdrawals !== undefined) {
    if (!Array.isArray(account.recent_withdrawals)) throw new Error("Withdrawal history could not be verified.");
    account.recent_withdrawals.forEach(value => {
      const item = record(value); identity(item.id); cents(item.net_cents); cents(item.fee_micro_usd);
      if (typeof item.status !== "string" || typeof item.fees_final !== "boolean" || typeof item.created_at !== "string" || !Number.isFinite(Date.parse(item.created_at))) throw new Error("Withdrawal history could not be verified.");
    });
  }
  return account as unknown as CommerceAccount;
}

async function request(token: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!token) throw new Error("Sign in to manage payments.");
  const response = await ApiService.apiFetch(`/api/scope-commerce/${path}`, {
    method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw commerceActionError(await response.json().catch(() => null), response.status);
  return record(await response.json());
}

export const ScopeCommerceService = {
  async readiness(token: string) { return parseCommerceReadiness(await request(token, "readiness")); },
  async account(token: string) { return parseCommerceAccount(await request(token, "account")); },
  async tariff(token: string, handle: string, machineScope: string): Promise<ScopeTariff | null> {
    const query = new URLSearchParams({ scope_handle: handle, machine_scope: machineScope });
    const result = await request(token, `tariffs?${query.toString()}`);
    if (result.tariff === null) return null;
    const tariff = record(result.tariff);
    if (tariff.scope_handle !== handle || tariff.machine_scope !== machineScope ||
        !Number.isSafeInteger(tariff.base_duration_seconds) || Number(tariff.base_duration_seconds) <= 0) throw new Error("The exact sharing price could not be verified.");
    cents(tariff.price_cents, 100_000);
    return tariff as unknown as ScopeTariff;
  },
  async saveTariff(token: string, tariff: Omit<ScopeTariff, "tariff_revision">, key: string) {
    return request(token, "tariffs", { ...tariff, idempotency_key: key });
  },
  async scopeRequest(token: string, id: string): Promise<ScopeCommerceRequest> {
    const result = await request(token, `requests/${identity(id)}`);
    if (result.request_id !== id || !["owner", "payer"].includes(String(result.role)) ||
        typeof result.machine_scope !== "string" || !result.machine_scope ||
        typeof result.scope_handle !== "string" || !result.scope_handle ||
        !Number.isSafeInteger(result.duration_seconds) || Number(result.duration_seconds) <= 0 || typeof result.purpose !== "string") {
      throw new Error("The approved request could not be verified.");
    }
    if (result.tariff !== null) {
      const tariff = record(result.tariff);
      if (tariff.machine_scope !== result.machine_scope || tariff.scope_handle !== result.scope_handle) throw new Error("The exact sharing price changed. Refresh before continuing.");
      cents(tariff.price_cents, 100_000);
    }
    if (result.purchase !== null) {
      const purchase = record(result.purchase); identity(purchase.id); cents(purchase.amount_cents, 100_000);
      if (purchase.request_id !== id || typeof purchase.status !== "string") throw new Error("The sharing agreement could not be verified.");
      if (purchase.processing_fee_micro_usd !== undefined) cents(purchase.processing_fee_micro_usd);
      if (purchase.net_earnings_micro_usd !== undefined && !Number.isSafeInteger(purchase.net_earnings_micro_usd)) throw new Error("The sharing earnings could not be verified.");
      for (const key of ["activation_at", "expires_at", "fulfillment_deadline"]) if (purchase[key] !== undefined && purchase[key] !== null) timestamp(purchase[key]);
    }
    for (const key of ["scope_label", "counterpart_label", "recipient_label"]) if (result[key] !== undefined && typeof result[key] !== "string") throw new Error("The sharing identities could not be verified.");
    for (const key of ["available_balance_cents", "shortfall_cents"]) if (result[key] !== undefined) cents(result[key]);
    if (result.request_deadline !== undefined && result.request_deadline !== null) timestamp(result.request_deadline);
    if (result.negative_net_acknowledgement !== undefined && result.negative_net_acknowledgement !== null) {
      const terms = record(result.negative_net_acknowledgement);
      validateNegativeNetAcknowledgement({ version: terms.version as 1, binding: String(terms.binding), acknowledged: true });
      cents(terms.gross_cents); cents(terms.processing_fee_micro_usd); signedInteger(terms.net_earnings_micro_usd);
      const purchase = record(result.purchase);
      if (Number(terms.net_earnings_micro_usd) >= 0 || terms.gross_cents !== purchase.amount_cents ||
          terms.processing_fee_micro_usd !== purchase.processing_fee_micro_usd || terms.net_earnings_micro_usd !== purchase.net_earnings_micro_usd) throw new Error("Review the current owner costs before sharing.");
    }
    return result as unknown as ScopeCommerceRequest;
  },
  async activity(token: string, view: CommerceActivityView, nextCursor?: string | null): Promise<CommerceActivityPage> {
    if (!["purchases", "sales", "transactions"].includes(view)) throw new Error("Choose a payment history view.");
    const query = new URLSearchParams({ view, limit: "25" });
    if (nextCursor) query.set("cursor", cursor(nextCursor));
    return parseCommerceActivityPage(await request(token, `activity?${query}`));
  },
  async approveInactive(token: string, id: string, duration: number, key: string) {
    return request(token, `requests/${identity(id)}/approve`, { duration_seconds: duration, idempotency_key: key });
  },
  async quote(token: string, id: string, duration: number, key: string) {
    const quote = parseScopeQuote(await request(token, "quotes", { request_id: id, duration_seconds: duration, idempotency_key: key }));
    if (quote.request_id !== id || quote.duration_seconds !== duration) throw new Error("The approved quote changed. Refresh before continuing.");
    return quote;
  },
  async purchase(token: string, quote: ScopeQuote, key: string) {
    return request(token, "purchases", { quote_id: quote.id, confirmed: true, idempotency_key: key });
  },
  async purchaseStatus(token: string, id: string) { return request(token, `purchases/${identity(id)}`); },
  async cancelPurchase(token: string, id: string, key: string) {
    return request(token, `purchases/${identity(id)}/cancel`, { idempotency_key: key });
  },
  async revokePurchase(vaultOwnerToken: string, id: string, key: string) {
    return request(vaultOwnerToken, `purchases/${identity(id)}/revoke`, { idempotency_key: key });
  },
  async getPurchase(id: string, vaultOwnerToken: string): Promise<Record<string, unknown> & { machineScope: string }> {
    const row = await request(vaultOwnerToken, `purchases/${identity(id)}/export-context`);
    return { ...row, machineScope: String(row.machine_scope || "") };
  },
  async preparePurchase(id: string, input: { sourceRevisions: { contentRevision: number; manifestRevision: number }; negative_net_acknowledgement?: NegativeNetAcknowledgement }, vaultOwnerToken: string) {
    if (input.negative_net_acknowledgement) validateNegativeNetAcknowledgement(input.negative_net_acknowledgement);
    const row = await request(vaultOwnerToken, `purchases/${identity(id)}/prepare`, {
      source_revisions: { content_revision: input.sourceRevisions.contentRevision, manifest_revision: input.sourceRevisions.manifestRevision },
      ...(input.negative_net_acknowledgement ? { negative_net_acknowledgement: input.negative_net_acknowledgement } : {}),
    });
    return {
      preparationId: String(row.preparation_id || ""), grantId: String(row.grant_id || ""),
      exportId: String(row.export_id || ""), exportRevision: Number(row.export_revision),
      startsAtMs: Number(row.starts_at_ms), expiresAtMs: Number(row.expires_at_ms),
      buyerAppId: String(row.buyer_app_id || ""), machineScope: String(row.machine_scope || ""),
      scopeHandle: String(row.scope_handle || ""), recipientKeyFingerprint: String(row.recipient_key_fingerprint || ""),
      connectorPublicKey: String(row.connector_public_key || ""), connectorKeyId: String(row.connector_key_id || ""),
    };
  },
  async stagePurchase(id: string, input: { preparation_id: string; envelope: unknown; negative_net_acknowledgement?: NegativeNetAcknowledgement }, vaultOwnerToken: string) {
    if (input.negative_net_acknowledgement) validateNegativeNetAcknowledgement(input.negative_net_acknowledgement);
    return request(vaultOwnerToken, `purchases/${identity(id)}/stage`, input);
  },
  async checkout(token: string, amount: number, key: string) {
    const result = await request(token, "funding/checkout", { amount_cents: amount, idempotency_key: key });
    if (typeof result.url !== "string") throw new Error("The checkout address could not be verified.");
    return result.url;
  },
  async onboarding(token: string, country: string, key: string) {
    const result = await request(token, "onboarding", { country, idempotency_key: key });
    if (typeof result.url !== "string") throw new Error("The onboarding address could not be verified.");
    return result.url;
  },
  async withdrawalPreview(token: string) { return parseCommerceTransferPreview(await request(token, "withdrawals/preview")); },
  async withdraw(token: string, key: string, previewToken: string) {
    return request(token, "withdrawals", { idempotency_key: key, preview_token: previewToken });
  },
  async refundPreview(token: string, id: string, amount: number) {
    return parseCommerceTransferPreview(await request(token, `funding/${identity(id)}/refund-preview`, { amount_cents: amount }));
  },
  async refund(token: string, id: string, amount: number, key: string, previewToken: string) {
    return request(token, `funding/${identity(id)}/refund`, { amount_cents: amount, idempotency_key: key, preview_token: previewToken });
  },
};

export const HUSSH_COINS_PER_USD = 100;

function commerceCoinAmount(coins: number, usd: string): string {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(coins)} Hussh ${Math.abs(coins) === 1 ? "coin" : "coins"} (${usd})`;
}

/** One coin is one USD cent; the quote and ledger retain their USD denomination. */
export function formatCommerceMoney(value: number): string {
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);
  return commerceCoinAmount(value, usd);
}

export function formatCommerceMicroUsd(value: number): string {
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 6, maximumFractionDigits: 6 }).format(value / 1_000_000);
  return commerceCoinAmount(value / (1_000_000 / HUSSH_COINS_PER_USD), usd);
}

export function commerceWithdrawalStatusCopy(status: string): string {
  if (status === "succeeded") return "Bank payout confirmed.";
  if (status === "transferred") return "Transferred to your connected account. Bank payout is unconfirmed.";
  if (status === "failed" || status === "cancelled") return "Withdrawal did not complete. Review settlement status before requesting another.";
  return "Withdrawal is pending or uncertain. Bank payout is unconfirmed.";
}

/** Decimal input converted exactly, with no floating-point rounding or silent clamp. */
export function parseCommerceDollarInput(value: string, minimum: number): number {
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(value.trim())) throw new Error("Enter a USD amount with up to two decimal places.");
  const [whole, fractional = ""] = value.trim().split(".");
  const amount = Number(whole) * 100 + Number(fractional.padEnd(2, "0"));
  if (amount < minimum || amount > 100_000) throw new Error(`Choose ${formatCommerceMoney(minimum)} to ${formatCommerceMoney(100_000)}.`);
  return amount;
}

const COMMERCE_STATUS_COPY: Record<string, string> = {
  awaiting_payment: "Owner approved these terms. Payment confirmation is still required before information is released.",
  reserved: "Payment reserved. The owner must prepare encrypted information before access starts.",
  preparing: "The owner is preparing encrypted information. Access has not started.",
  staged: "Encrypted information is prepared. Access starts at the verified activation time.",
  armed: "Encrypted information is prepared. Access starts at the verified activation time.",
  active: "Paid access is active for the agreed term.",
  revoked: "Access ended early. Unused calendar time is being reconciled to the buyer balance.",
  cancelled: "Sharing cancelled before activation. Reserved funds return to the buyer balance.",
  expired: "The access term ended.",
  approved_awaiting_payment: "Terms approved. Payment confirmation and encrypted preparation are still required.",
};
export function scopeCommerceStatusCopy(status: unknown): string {
  return typeof status === "string" && Object.hasOwn(COMMERCE_STATUS_COPY, status)
    ? COMMERCE_STATUS_COPY[status]! : "Review payment and encrypted preparation status.";
}

export function commerceActivityStatusCopy(kind: string, status: string): string {
  if (kind === "purchase" || kind === "sale") return scopeCommerceStatusCopy(status);
  if (kind === "withdrawal") return commerceWithdrawalStatusCopy(status);
  if (kind === "funding") {
    const copy: Record<string, string> = {
      reserved: "Checkout is awaiting settlement. Returning from Stripe does not confirm funding.",
      paid: "Funding confirmed. Your balance was credited.",
      cancelled: "Checkout ended without confirmed funding.",
      refund_pending: "A balance refund is awaiting settlement.",
      refunded: "The funding was refunded.",
    };
    return Object.hasOwn(copy, status) ? copy[status]! : "Funding remains unconfirmed. Refresh payment status.";
  }
  if (kind === "refund") {
    if (status === "succeeded") return "Refund to the original payment method confirmed.";
    if (status === "failed") return "Refund failed. Review payment status before retrying.";
    if (["queued", "dispatching", "pending"].includes(status)) return "Refund requested. Settlement to the original payment method is pending.";
    return "Refund settlement is unconfirmed and needs reconciliation.";
  }
  return "Payment settlement remains unconfirmed. Review payment status.";
}
