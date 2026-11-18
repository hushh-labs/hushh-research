"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ROUTES } from "@/lib/navigation/routes";

export function LegacyTasksRedirect() {
  const router = useRouter();
  useEffect(() => { router.replace(ROUTES.ONE_TASKS); }, [router]);
  return null;
}
