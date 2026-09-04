import { redirect } from "next/navigation";

import { ROUTES } from "@/lib/navigation/routes";

/** One-release compatibility route for the retired Optimize workspace. */
export default function RetiredPortfolioOptimizePage() {
  redirect(ROUTES.KAI_PORTFOLIO);
}
