import { ClientRedirect } from "@/components/navigation/client-redirect";
import { buildKaiMarketRoute } from "@/lib/navigation/routes";

export default function LegacyKaiInvestmentsPage() {
  return (
    <ClientRedirect
      to={buildKaiMarketRoute("portfolio")}
      redirectRouteId="kai_dashboard_legacy_redirect"
    />
  );
}
