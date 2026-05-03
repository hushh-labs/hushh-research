"use client";

import { useRouter } from "next/navigation";
import { ROUTES } from "@/lib/navigation/routes";

export default function LeaguesIndexPage() {
  const router = useRouter();

  // Redirect to main iAlphabets page which shows "My Leagues"
  router.replace(ROUTES.IALPHABETS_HOME);
  return null;
}
