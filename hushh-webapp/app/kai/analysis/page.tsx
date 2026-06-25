import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyKaiAnalysisPage() {
  redirect(ROUTES.KAI_ANALYSIS);
}
