import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function KaiDashboardCompatibilityPage() {
  redirect(ROUTES.KAI_PORTFOLIO);
}
