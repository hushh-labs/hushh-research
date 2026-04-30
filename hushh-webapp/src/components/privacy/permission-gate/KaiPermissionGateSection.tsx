"use client";

import { KaiMarketPreviewView } from "@/components/kai/views/kai-market-preview-view";
import { useConsent } from "../../../hooks/useConsent";
import PermissionGate from "./PermissionGate";

export default function KaiPermissionGateSection() {
  const { hasConsentFor, isLoading } = useConsent();

  return (
    <PermissionGate
      permission="portfolio_valuation"
      hasConsent={hasConsentFor("portfolio_valuation")}
      isLoading={isLoading}
    >
      <KaiMarketPreviewView />
    </PermissionGate>
  );
}