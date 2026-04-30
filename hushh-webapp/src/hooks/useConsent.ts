"use client";

import type { SensitivePermission } from "../components/privacy/permission-gate/permissionRules";

export function useConsent() {
  const hasConsentFor = (permission: SensitivePermission) => {
    // Mocked for this PR.
    // Future PR can connect this to consent APIs.
    if (permission === "portfolio_valuation") {
      return false;
    }

    return false;
  };

  return {
    hasConsentFor,
    isLoading: false,
  };
}