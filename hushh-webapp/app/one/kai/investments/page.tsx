import { ClientRedirect } from "@/components/navigation/client-redirect";
import { buildKaiMarketRoute } from "@/lib/navigation/routes";

/**
 * Temporary recovery endpoint for saved links and OAuth returns. The former
 * Investments workspace was consolidated into the canonical Portfolio tab.
 */
export default function RetiredKaiInvestmentsPage() {
  return (
    <ClientRedirect
      to={buildKaiMarketRoute("portfolio")}
      redirectRouteId="kai_dashboard_legacy_redirect"
    />
  );
}
