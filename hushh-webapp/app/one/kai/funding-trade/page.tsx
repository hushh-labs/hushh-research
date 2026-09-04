import { ClientRedirect } from "@/components/navigation/client-redirect";
import { buildKaiMarketRoute } from "@/lib/navigation/routes";

/**
 * Temporary recovery endpoint for saved links and in-flight OAuth returns.
 * Funding and trading are no longer exposed as a Portfolio surface.
 */
export default function RetiredKaiFundingTradePage() {
  return (
    <ClientRedirect
      to={buildKaiMarketRoute("portfolio")}
      redirectRouteId="kai_dashboard_legacy_redirect"
    />
  );
}
