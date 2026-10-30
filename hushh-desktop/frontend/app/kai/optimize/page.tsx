import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyKaiOptimizePage() {
  redirect(ROUTES.KAI_OPTIMIZE);
}
