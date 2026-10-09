import { beforeEach, describe, expect, it, vi } from "vitest";
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/api-service", () => ({ ApiService: { apiFetch: fetcher } }));
import { ScopeCommerceService, parseCommerceReadiness, CommerceActionError, parseScopeQuote, parseCommerceDollarInput, parseCommerceTransferPreview, parseCommerceAccount, parseCommerceActivityPage, formatCommerceMoney, formatCommerceMicroUsd, commerceWithdrawalStatusCopy, commerceActivityStatusCopy } from "@/lib/services/scope-commerce-service";
import { commerceReturnAttempt, validateCommerceHostedUrl } from "@/lib/services/scope-commerce-browser";
import { verifyCommerceSandbox } from "@/lib/services/scope-commerce-sandbox";
const requestId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";
function reply(value: unknown) { return Response.json(value); }

describe("scope commerce review boundary", () => {
  it("requires exact HTTPS app origin and a persisted test-mode Sandbox pin", () => {
    const origin = "https://preview.example.com";
    const proof = { app_origin: origin, environment: "sandbox", livemode: false, persisted_pin_matches: true, platform_account_id: "acct_synthetic" };
    expect(verifyCommerceSandbox(proof, origin)).toBe(true);
    for (const change of [{ app_origin: "https://other.example.com" }, { environment: "live" }, { livemode: true }, { persisted_pin_matches: false }]) {
      expect(() => verifyCommerceSandbox({ ...proof, ...change }, origin)).toThrow();
    }
    expect(() => verifyCommerceSandbox(proof, "http://preview.example.com")).toThrow();
  });
  beforeEach(() => vi.resetAllMocks());
  const quote = () => ({ id: requestId, request_id: documentId, scope_handle: "scope_food", machine_scope: "attr.food.preferences.*",
    amount_cents: 1, base_price_cents: 7, base_duration_seconds: 604800, duration_seconds: 86400,
    currency: "USD", expires_at: "2099-01-01T00:00:00Z" });

  it("accepts a server-quoted cent purchase and rejects malformed or above-ceiling terms", () => {
    expect(parseScopeQuote(quote()).amount_cents).toBe(1);
    expect(() => parseScopeQuote({ ...quote(), amount_cents: 100001 })).toThrow();
    expect(() => parseScopeQuote({ ...quote(), amount_cents: 0.5 })).toThrow();
    expect(() => parseScopeQuote({ ...quote(), duration_seconds: 0 })).toThrow();
    expect(parseCommerceDollarInput("0.01", 1)).toBe(1);
    expect(parseCommerceDollarInput("1000.00", 50)).toBe(100000);
    expect(() => parseCommerceDollarInput("0.49", 50)).toThrow();
    expect(() => parseCommerceDollarInput("1e3", 1)).toThrow();
  });

  it("keeps buyer cancellation and owner revocation on their separate authorities", async () => {
    fetcher.mockResolvedValueOnce(reply({ status: "cancelled" }));
    await ScopeCommerceService.cancelPurchase("firebase", requestId, "buyer-retry");
    expect(fetcher.mock.calls[0][0]).toBe(`/api/scope-commerce/purchases/${requestId}/cancel`);
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer firebase");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ idempotency_key: "buyer-retry" });
    fetcher.mockResolvedValueOnce(reply({ status: "revoked" }));
    await ScopeCommerceService.revokePurchase("vault-owner", requestId, "owner-retry");
    expect(fetcher.mock.calls[1][0]).toBe(`/api/scope-commerce/purchases/${requestId}/revoke`);
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe("Bearer vault-owner");
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ idempotency_key: "owner-retry" });
    await expect(ScopeCommerceService.revokePurchase("", requestId, "retry")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("confirms only the reviewed quote identity and preserves the retry key", async () => {
    fetcher.mockResolvedValueOnce(reply({ id: requestId, status: "reserved" }));
    await ScopeCommerceService.purchase("firebase", parseScopeQuote(quote()), "retry-key");
    expect(fetcher.mock.calls[0][0]).toBe("/api/scope-commerce/purchases");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ quote_id: requestId, confirmed: true, idempotency_key: "retry-key" });
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer firebase");
  });

  it("never falls back from an exact leaf tariff to a shared registry handle", async () => {
    const tariff = { scope_handle: "shared-handle", machine_scope: "attr.travel.plans.destination", price_cents: 1, base_duration_seconds: 86400, tariff_revision: 1 };
    fetcher.mockResolvedValueOnce(reply({ tariff }));
    expect(await ScopeCommerceService.tariff("firebase", tariff.scope_handle, tariff.machine_scope)).toEqual(tariff);
    const query = new URL(fetcher.mock.calls[0][0], "https://one.hushh.ai").searchParams;
    expect(query.get("scope_handle")).toBe(tariff.scope_handle);
    expect(query.get("machine_scope")).toBe(tariff.machine_scope);
    fetcher.mockResolvedValueOnce(reply({ tariff: { ...tariff, machine_scope: "attr.travel.plans.*" } }));
    await expect(ScopeCommerceService.tariff("firebase", tariff.scope_handle, tariff.machine_scope)).rejects.toThrow();
  });

  it("requires reviewed transfer costs and keeps fee debt visible during rollback", () => {
    const preview = { amount_cents: 1000, fee_cents: 50, net_cents: 950, preview_token: "a".repeat(64) };
    expect(parseCommerceTransferPreview(preview).net_cents).toBe(950);
    expect(() => parseCommerceTransferPreview({ ...preview, preview_token: undefined })).toThrow();
    expect(() => parseCommerceTransferPreview({ ...preview, net_cents: 1001 })).toThrow();
    const account = { enabled: false, managed_balances: true, currency: "USD", balance: { available_cents: 1, reserved_cents: 0 },
      earnings: { pending_cents: 0, available_cents: -25, debt_cents: 25 }, seller: { onboarded: true, eligible: true, country: "US" },
      payout: { minimum_net_cents: 50 }, funding_lots: [] };
    expect(parseCommerceAccount(account).earnings.available_cents).toBe(-25);
    expect(() => parseCommerceAccount({ ...account, balance: { available_cents: -1, reserved_cents: 0 } })).toThrow();
    const withdrawal = { id: requestId, status: "transferred", net_cents: 50, fee_micro_usd: 1, fees_final: false, created_at: "2026-10-06T00:00:00Z" };
    expect(parseCommerceAccount({ ...account, recent_withdrawals: [withdrawal] }).recent_withdrawals?.[0].status).toBe("transferred");
    expect(() => parseCommerceAccount({ ...account, recent_withdrawals: [{ ...withdrawal, fee_micro_usd: -1 }] })).toThrow();
    expect(commerceReturnAttempt(`/one/profile/account?commerceReturn=1&commerceAttemptId=${requestId}`)).toBe(requestId);
    expect(commerceReturnAttempt(`/one/profile/account?commerceReturn=1&commerceAttemptId=${requestId}&commerceAttemptId=another`)).toBeNull();
    expect(commerceReturnAttempt(`/one/profile/account?commerceReturn=1&commerceAttemptId=${requestId}&token=unexpected`)).toBeNull();
    expect(commerceReturnAttempt(`/one/consent?commerceReturn=1&commerceAttemptId=${requestId}`)).toBeNull();
  });

  it("separates checkout from Connect onboarding destinations and rejects authority-confusing URLs", () => {
    expect(validateCommerceHostedUrl("https://checkout.stripe.com/c/pay/example", "checkout")).toContain("checkout.stripe.com");
    expect(validateCommerceHostedUrl("https://connect.stripe.com/setup/example", "onboarding")).toContain("connect.stripe.com");
    for (const url of ["https://checkout.stripe.com.evil.invalid/", "http://checkout.stripe.com/", "https://secret@checkout.stripe.com/", "https://connect.stripe.com/setup/example"]) {
      expect(() => validateCommerceHostedUrl(url, "checkout")).toThrow();
    }
  });

  it("preserves signed micro-USD costs and distinguishes transfer from confirmed bank payout", () => {
    expect(formatCommerceMoney(parseCommerceDollarInput("0.01", 1))).toBe("1 Hussh coin ($0.01)");
    expect(formatCommerceMoney(parseCommerceDollarInput("1.00", 1))).toBe("100 Hussh coins ($1.00)");
    expect(formatCommerceMicroUsd(1)).toBe("0.0001 Hussh coins ($0.000001)");
    expect(formatCommerceMicroUsd(-12345)).toBe("-1.2345 Hussh coins (-$0.012345)");
    expect(commerceWithdrawalStatusCopy("transferred")).toContain("Bank payout is unconfirmed");
    expect(commerceWithdrawalStatusCopy("succeeded")).toBe("Bank payout confirmed.");
    expect(commerceWithdrawalStatusCopy("unknown")).toContain("unconfirmed");
    expect(commerceActivityStatusCopy("funding", "reserved")).toContain("does not confirm funding");
    expect(commerceActivityStatusCopy("funding", "paid")).toContain("Funding confirmed");
    expect(commerceActivityStatusCopy("refund", "unknown")).toContain("unconfirmed");
    expect(commerceActivityStatusCopy("refund", "succeeded")).toContain("confirmed");
  });

  it("accepts signed owner net earnings only as integer micro-USD on the exact request", async () => {
    const result = { request_id: requestId, role: "owner", machine_scope: "attr.food.preferences.*", scope_handle: "scope_food",
      duration_seconds: 86400, purpose: "Approved purpose", tariff: null,
      purchase: { id: documentId, request_id: requestId, status: "active", amount_cents: 1, processing_fee_micro_usd: 12345, net_earnings_micro_usd: -2345 } };
    fetcher.mockResolvedValueOnce(reply(result));
    expect((await ScopeCommerceService.scopeRequest("firebase", requestId)).purchase?.net_earnings_micro_usd).toBe(-2345);
    fetcher.mockResolvedValueOnce(reply({ ...result, purchase: { ...result.purchase, net_earnings_micro_usd: -0.5 } }));
    await expect(ScopeCommerceService.scopeRequest("firebase", requestId)).rejects.toThrow();
  });

  it("pages owner-scoped financial history without accepting external or other-request actions", async () => {
    const item = { id: documentId, request_id: requestId, purchase_id: documentId, kind: "sale", status: "reserved", direction: "incoming",
      counterpart: { label: "Approved requester" }, scope_label: "Food preferences", machine_scope: "attr.food.preferences.*", scope_handle: "scope_food",
      amount_cents: 1, gross_cents: 1, processing_fee_micro_usd: 12345, net_earnings_micro_usd: -2345, refunded_cents: 0,
      created_at: "2026-10-06T00:00:00Z", activation_at: null, expires_at: null, matures_at: null, fulfillment_deadline: null,
      next_action: { label: "Prepare information", href: `/one/consent?commerceRequestId=${requestId}` } };
    const page = { items: [item], next_cursor: "opaque_cursor" };
    expect(parseCommerceActivityPage(page).items[0].net_earnings_micro_usd).toBe(-2345);
    for (const href of ["https://evil.invalid/", `/one/consent?commerceRequestId=${documentId}`, "/one/profile/account?token=bad"]) {
      expect(() => parseCommerceActivityPage({ ...page, items: [{ ...item, next_action: { label: "Review", href } }] })).toThrow();
    }
    expect(() => parseCommerceActivityPage({ ...page, items: [{ ...item, amount_cents: -1 }] })).toThrow();
    fetcher.mockResolvedValueOnce(reply(page));
    await ScopeCommerceService.activity("firebase", "sales", "opaque_cursor");
    const query = new URL(fetcher.mock.calls[0][0], "https://one.hushh.ai").searchParams;
    expect(Object.fromEntries(query)).toEqual({ view: "sales", limit: "25", cursor: "opaque_cursor" });
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer firebase");
    expect(fetcher.mock.calls[0][1].cache).toBe("no-store");
  });

  it("binds an explicit negative-net acknowledgement to both vault-authorized preparation and staging", async () => {
    const acknowledgement = { version: 1 as const, binding: "a".repeat(64), acknowledged: true as const };
    const purchase = { id: documentId, request_id: requestId, status: "reserved", amount_cents: 1, processing_fee_micro_usd: 12345, net_earnings_micro_usd: -2345 };
    const result = { request_id: requestId, role: "owner", machine_scope: "attr.food.preferences.*", scope_handle: "scope_food",
      duration_seconds: 86400, purpose: "Approved purpose", tariff: null, purchase,
      negative_net_acknowledgement: { version: 1, binding: acknowledgement.binding, gross_cents: 1, processing_fee_micro_usd: 12345, net_earnings_micro_usd: -2345 } };
    fetcher.mockResolvedValueOnce(reply(result));
    expect((await ScopeCommerceService.scopeRequest("firebase", requestId)).negative_net_acknowledgement?.binding).toBe(acknowledgement.binding);
    fetcher.mockResolvedValueOnce(reply({ ...result, negative_net_acknowledgement: { ...result.negative_net_acknowledgement, gross_cents: 2 } }));
    await expect(ScopeCommerceService.scopeRequest("firebase", requestId)).rejects.toThrow();
    fetcher.mockResolvedValueOnce(reply({}));
    await ScopeCommerceService.preparePurchase(documentId, { sourceRevisions: { contentRevision: 1, manifestRevision: 2 }, negative_net_acknowledgement: acknowledgement }, "vault-owner");
    fetcher.mockResolvedValueOnce(reply({}));
    await ScopeCommerceService.stagePurchase(documentId, { preparation_id: requestId, envelope: {}, negative_net_acknowledgement: acknowledgement }, "vault-owner");
    for (const call of fetcher.mock.calls.slice(2)) {
      expect(call[1].headers.Authorization).toBe("Bearer vault-owner");
      expect(JSON.parse(call[1].body).negative_net_acknowledgement).toEqual(acknowledgement);
    }
    await expect(ScopeCommerceService.stagePurchase(documentId, { preparation_id: requestId, envelope: {}, negative_net_acknowledgement: { ...acknowledgement, binding: "wrong" } }, "vault-owner")).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});


describe("server-authored sharing readiness", () => {
  beforeEach(() => vi.resetAllMocks());
  const freeOnly = () => ({ schema_version: 1, enabled: false,
    free: { requires_payment_provider: false, requires_owner_approval: true, tariff_controls_available: true },
    platform: { status: "unconfigured", reason_code: "provider_credentials_required", verification_scope: "configured_and_persisted" },
    seller: { status: "not_onboarded", reason_code: "seller_onboarding_required" },
    capabilities: { set_free_tariff: true, set_paid_tariff: false, approve_paid_request: false, reserve_paid_purchase: false, start_funding: false, start_onboarding: false } });
  it("accepts free controls without provider setup and rejects unknown codes or contradictory paid authority", async () => {
    expect(parseCommerceReadiness(freeOnly()).capabilities.set_free_tariff).toBe(true);
    expect(parseCommerceAccount({ enabled: false, readiness: freeOnly() }).readiness?.platform.status).toBe("unconfigured");
    expect(() => parseCommerceReadiness({ ...freeOnly(), platform: { ...freeOnly().platform, reason_code: "private_diagnostic" } })).toThrow();
    expect(() => parseCommerceReadiness({ ...freeOnly(), capabilities: { ...freeOnly().capabilities, reserve_paid_purchase: true } })).toThrow();
    expect(() => parseCommerceReadiness({ ...freeOnly(), free: { ...freeOnly().free, requires_owner_approval: false } })).toThrow();
    const managed = parseCommerceAccount({ enabled: false, managed_balances: true, currency: "USD",
      readiness: { ...freeOnly(), platform: { ...freeOnly().platform, reason_code: "unknown_private_diagnostic" } },
      balance: { available_cents: 50, reserved_cents: 0 }, earnings: { pending_cents: 0, available_cents: 0 },
      seller: { onboarded: false, eligible: false }, payout: { minimum_net_cents: 50 }, funding_lots: [] });
    expect(managed.balance.available_cents).toBe(50);
    expect(managed.readiness).toBeUndefined();
    fetcher.mockResolvedValueOnce(reply(freeOnly()));
    await ScopeCommerceService.readiness("firebase");
    expect(fetcher.mock.calls[0][0]).toBe("/api/scope-commerce/readiness");
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer firebase");
    expect(fetcher.mock.calls[0][1].cache).toBe("no-store");
  });
  it("uses allowlisted setup guidance while suppressing unknown server diagnostics", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ detail: { code: "seller_onboarding_required", message: "private account secret" } }, { status: 409 }));
    await expect(ScopeCommerceService.readiness("firebase")).rejects.toMatchObject({ name: "CommerceActionError", code: "seller_onboarding_required", message: "Complete payout setup in Account before charging for information." });
    fetcher.mockResolvedValueOnce(Response.json({ detail: { code: "private account secret", message: "private account secret" } }, { status: 500 }));
    try { await ScopeCommerceService.readiness("firebase"); throw new Error("expected rejection"); } catch (error) {
      expect(error).toBeInstanceOf(CommerceActionError);
      expect((error as CommerceActionError).code).toBeNull();
      expect((error as Error).message).not.toContain("private account secret");
    }
  });
});
