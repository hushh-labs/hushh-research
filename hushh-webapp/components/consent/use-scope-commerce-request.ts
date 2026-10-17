"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVault } from "@/lib/vault/vault-context";
import { prepareAndStagePaidScopeExport } from "@/lib/consent/scope-commerce-export";
import { dispatchConsentStateChanged } from "@/lib/consent/consent-events";
import { ScopeCommerceService, type NegativeNetAcknowledgement, type ScopeQuote } from "@/lib/services/scope-commerce-service";
import { useCommerceRead } from "@/components/consent/use-commerce-session";
import { useCommerceAction } from "@/components/consent/use-commerce-action";

const PENDING = new Set(["awaiting_payment", "reserved", "preparing", "staged", "armed", "active"]);

export function useScopeCommerceRequest(requestId: string) {
  const { vaultKey, getVaultOwnerToken } = useVault();
  const load = useCallback(async (token: string) => {
    const [request, readiness] = await Promise.all([ScopeCommerceService.scopeRequest(token, requestId), ScopeCommerceService.readiness(token).catch(() => undefined)]);
    return { request, readiness };
  }, [requestId]);
  const { user, data, refresh, error, capture } = useCommerceRead(`request:${requestId}`, load, value => Boolean(value.request.purchase && PENDING.has(value.request.purchase.status)));
  const [quote, setQuote] = useState<ScopeQuote | null>(null);
  const { busy, message, run } = useCommerceAction({ user, capture }, requestId);
  const [ended, setEnded] = useState(false);
  const keys = useRef({ quote: crypto.randomUUID(), purchase: crypto.randomUUID(), end: crypto.randomUUID() });
  useEffect(() => {
    setQuote(null); setEnded(false);
    keys.current = { quote: crypto.randomUUID(), purchase: crypto.randomUUID(), end: crypto.randomUUID() };
  }, [user, requestId]);
  const request = data?.request || null;
  async function reviewPrice() {
    if (!request) return;
    await run(async (token, current) => {
      const result = await ScopeCommerceService.quote(token, requestId, request.duration_seconds, keys.current.quote);
      if (!current()) return;
      if (result.machine_scope !== request.machine_scope || result.scope_handle !== request.scope_handle) throw new Error("The quoted sharing section changed. Refresh before continuing.");
      setQuote(result); keys.current.purchase = crypto.randomUUID();
    });
  }
  async function purchase() {
    if (!quote) return;
    await run(async (token, current) => {
      if (quote.request_id !== requestId || Date.parse(quote.expires_at) <= Date.now()) throw new Error("Quote expired. Request access again so the owner can approve new terms.");
      await ScopeCommerceService.purchase(token, quote, keys.current.purchase);
      if (!current()) return;
      setQuote(null); await refresh();
      if (current()) dispatchConsentStateChanged({ source: "scope_payment_reserved" });
    });
  }
  async function prepare(acknowledgement?: NegativeNetAcknowledgement) {
    await run(async (_token, current) => {
      const vaultOwnerToken = getVaultOwnerToken();
      if (!vaultKey || !vaultOwnerToken || !request?.purchase || !user || request.role !== "owner") throw new Error("Unlock the information owner's vault before preparing this information.");
      const terms = request.negative_net_acknowledgement;
      if ((request.purchase.net_earnings_micro_usd ?? 0) < 0 && (!terms || acknowledgement?.binding !== terms.binding || acknowledgement.acknowledged !== true)) throw new Error("Acknowledge the exact negative earnings and debt consequence before sharing.");
      await prepareAndStagePaidScopeExport({ purchaseId: request.purchase.id, userId: user.uid, vaultKey, vaultOwnerToken, negativeNetAcknowledgement: acknowledgement });
      if (!current()) return;
      await refresh();
      if (current()) dispatchConsentStateChanged({ source: "scope_payment_staged" });
    });
  }
  async function end() {
    await run(async (token, current) => {
      if (!request?.purchase) throw new Error("Refresh this sharing agreement before continuing.");
      if (request.role === "owner") {
        const ownerToken = getVaultOwnerToken();
        if (!vaultKey || !ownerToken) throw new Error("Unlock your vault before ending sharing.");
        await ScopeCommerceService.revokePurchase(ownerToken, request.purchase.id, keys.current.end);
      } else await ScopeCommerceService.cancelPurchase(token, request.purchase.id, keys.current.end);
      if (!current()) return;
      setEnded(true); setQuote(null); dispatchConsentStateChanged({ source: "scope_payment_ended" });
      await refresh();
    });
  }
  return { user, vaultKey, request, quote, busy, ended, readiness: data?.readiness, enabled: data?.readiness?.capabilities.reserve_paid_purchase === true,
    availableBalance: request?.available_balance_cents,
    message: message || error, refresh, reviewPrice, purchase, prepare, end };
}
