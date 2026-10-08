const PLATFORM_REASONS = ["commerce_disabled", "provider_disabled", "provider_configuration_required", "provider_credentials_required", "provider_webhooks_required", "provider_connect_webhook_configuration_required", "provider_sandbox_policy_required", "commerce_schema_required", "platform_account_unverified", "platform_account_mismatch", "commerce_retention_resolution_required"] as const;
const SELLER_REASONS = ["seller_onboarding_required", "seller_not_eligible", "seller_country_unavailable", "seller_account_mismatch"] as const;
type PlatformReason = typeof PLATFORM_REASONS[number];
type SellerReason = typeof SELLER_REASONS[number];
/** Safe server-authored capabilities; readiness does not attest live Stripe reachability. */
export type CommerceReadiness = {
  schema_version: 1;
  enabled: boolean;
  free: { requires_payment_provider: false; requires_owner_approval: true; tariff_controls_available: boolean };
  platform: { status: "disabled" | "unconfigured" | "unverified" | "ready"; reason_code: PlatformReason | null; verification_scope: "configured_and_persisted" };
  seller: { status: "not_onboarded" | "not_eligible" | "eligible"; reason_code: SellerReason | null };
  capabilities: { set_free_tariff: boolean; set_paid_tariff: boolean; approve_paid_request: boolean; reserve_paid_purchase: boolean; start_funding: boolean; start_onboarding: boolean };
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Sharing availability could not be verified.");
  return value as Record<string, unknown>;
}
function reason(value: unknown, allowed: readonly string[]): void {
  if (value !== null && (typeof value !== "string" || !allowed.includes(value))) throw new Error("Sharing availability could not be verified.");
}
export function parseCommerceReadiness(value: unknown): CommerceReadiness {
  const data = object(value), free = object(data.free), platform = object(data.platform), seller = object(data.seller), capabilities = object(data.capabilities);
  if (data.schema_version !== 1 || typeof data.enabled !== "boolean" || free.requires_payment_provider !== false || free.requires_owner_approval !== true ||
      typeof free.tariff_controls_available !== "boolean" || platform.verification_scope !== "configured_and_persisted" ||
      !["disabled", "unconfigured", "unverified", "ready"].includes(String(platform.status)) ||
      !["not_onboarded", "not_eligible", "eligible"].includes(String(seller.status))) throw new Error("Sharing availability could not be verified.");
  reason(platform.reason_code, PLATFORM_REASONS); reason(seller.reason_code, SELLER_REASONS);
  for (const key of ["set_free_tariff", "set_paid_tariff", "approve_paid_request", "reserve_paid_purchase", "start_funding", "start_onboarding"]) {
    if (typeof capabilities[key] !== "boolean") throw new Error("Sharing availability could not be verified.");
  }
  if (capabilities.set_free_tariff && !free.tariff_controls_available) throw new Error("Sharing availability could not be verified.");
  if ((capabilities.set_paid_tariff || capabilities.approve_paid_request || capabilities.reserve_paid_purchase || capabilities.start_funding || capabilities.start_onboarding) &&
      (!data.enabled || platform.status !== "ready")) throw new Error("Sharing availability could not be verified.");
  if (capabilities.set_paid_tariff && seller.status !== "eligible") throw new Error("Sharing availability could not be verified.");
  return data as unknown as CommerceReadiness;
}

export function commerceReadinessCopy(readiness?: CommerceReadiness): string {
  if (!readiness) return "Paid sharing availability could not be checked. Refresh before continuing.";
  switch (readiness.platform.status) {
    case "disabled": return "New paid purchases and funding are paused. Free sharing still requires your approval.";
    case "unconfigured": return "Payments are not set up for this app yet. Free sharing does not require Stripe.";
    case "unverified": return "Paid sharing is unavailable until payment setup is verified. Free sharing does not require Stripe.";
    case "ready": return readiness.seller.status === "eligible" ? "Paid sharing is available. Every purchase needs a separate price confirmation." : "You can share for free. Complete payout setup in Account before setting a paid price.";
  }
}

const ACTION_ERRORS: Record<string, string> = {
  ...Object.fromEntries(PLATFORM_REASONS.map(code => [code, "Paid sharing is unavailable. Review payment availability in Account; free sharing does not require Stripe."])),
  ...Object.fromEntries(SELLER_REASONS.map(code => [code, "Review payout setup in Account before continuing with paid sharing."])),
  seller_onboarding_required: "Complete payout setup in Account before charging for information.",
  seller_not_eligible: "Check payout setup in Account before continuing with paid sharing.",
  provider_configuration_invalid: "Payments are not available for this app yet. Free sharing does not require Stripe.",
  commerce_unavailable: "New paid sharing is unavailable. Existing agreements and funds remain governed separately.",
  commerce_environment_unbound: "Payment setup has not been verified. Free sharing does not require Stripe.",
  commerce_environment_mismatch: "Payment setup could not be verified. Check payment status in Account.",
  scope_commerce_schema_unavailable: "Sharing price controls are unavailable. Refresh before changing saved terms.",
  insufficient_balance: "Add funds in Account, then review the exact price again.",
  quote_expired: "Quote expired. Request access again so the owner can approve new terms.",
  negative_net_acknowledgement_required: "Refresh and acknowledge the exact owner costs before sharing.",
};
export class CommerceActionError extends Error {
  constructor(readonly code: string | null, status: number) {
    super((code && ACTION_ERRORS[code]) || (status === 409 ? "These terms changed. Refresh and review them again." : "This payment action could not be confirmed. Refresh and try again."));
    this.name = "CommerceActionError";
  }
}
export function commerceActionError(value: unknown, status: number): CommerceActionError {
  const detail = value && typeof value === "object" ? (value as Record<string, unknown>).detail : null;
  const code = detail && typeof detail === "object" ? (detail as Record<string, unknown>).code : null;
  return new CommerceActionError(typeof code === "string" && Object.hasOwn(ACTION_ERRORS, code) ? code : null, status);
}
