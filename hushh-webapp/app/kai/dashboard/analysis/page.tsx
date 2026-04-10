import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function KaiDashboardAnalysisCompatibilityPage() {
  redirect(ROUTES.KAI_ANALYSIS);
}
