/** Compose commerce transport/authority evidence into existing route inventory. */
export function applyScopeCommerceSurfaceOverrides(routeOverrides) {
const commerceRoutes = {
  "/one/consent": ["readiness", "scopeRequest", "quote", "purchase", "cancelPurchase", "revokePurchase", "approveInactive", "getPurchase", "preparePurchase", "stagePurchase"],
  "/one/profile/account": ["readiness", "account", "activity", "checkout", "onboarding", "withdrawalPreview", "withdraw", "refundPreview", "refund"],
  "/one/profile/my-data": ["readiness", "tariff", "saveTariff"],
  "/one/profile/my-data/domain": ["readiness", "tariff", "saveTariff"],
};
for (const [route, serviceMethods] of Object.entries(commerceRoutes)) {
  const existing = routeOverrides[route] || {};
  routeOverrides[route] = {
    ...existing,
    api_dependencies: [...(existing.api_dependencies || []), {
      service_file: "lib/services/scope-commerce-service.ts",
      service_methods: serviceMethods,
      nextjs_api_route: "/api/scope-commerce/{path*}",
      nextjs_proxy_file: "app/api/scope-commerce/[...path]/route.ts",
      backend_endpoint_family: "/api/scope-commerce/*",
      native_transport: "CapacitorHttp direct backend through ApiService.apiFetch; finance uses Firebase, export preparation uses vault-owner authority",
    }],
    native_plugin_dependencies: [...(existing.native_plugin_dependencies || []), ...(route === "/one/profile/account" ? [{
      js_name: "Browser", reason: "Stripe Checkout and Connect use the system browser; trusted App Links trigger server status refresh only.",
    }] : [])],
    thread_and_consent_contract: {
      ...(existing.thread_and_consent_contract || {}),
      commerce_authority: "Explicit human quote confirmation reserves funds; owner-device v2 encryption stages the exact scope and recipient for server-fixed activation and expiry. Provider returns confer no authority.",
    },
  };
}
routeOverrides["/one/marketplace"] = {
  api_dependencies: [{
    service_file: "lib/one-marketplace/service.ts",
    service_methods: ["listAvailable", "requestListing", "listRequests", "getDelivery"],
    nextjs_api_route: "/api/one/{path*}", nextjs_proxy_file: "app/api/one/[...path]/route.ts",
    backend_endpoint_family: "/api/one/marketplace/*",
    native_transport: "CapacitorHttp direct backend through ApiService.apiFetch; buyer connector custody reuses OneKycClientZkService and encrypted PKM",
  }],
  native_plugin_dependencies: [],
  thread_and_consent_contract: {
    paid_delivery: "Canonical v2 X25519 export only; legacy P-256 envelopes are free compatibility. Owner vault key remains memory-only; connector recovery is encrypted in the existing PKM domain.",
  },
};

}
