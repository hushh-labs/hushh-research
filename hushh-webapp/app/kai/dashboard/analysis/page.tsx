import { ClientRedirect } from "@/components/navigation/client-redirect";
import { ROUTES } from "@/lib/navigation/routes";

export default function KaiDashboardAnalysisCompatibilityPage() {
  return <ClientRedirect to={ROUTES.KAI_ANALYSIS} />;
}
