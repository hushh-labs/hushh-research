"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ROUTES } from "@/lib/navigation/routes";

export default function LegacyProfileMemoryDomainRedirectPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace(ROUTES.PKM);
  }, [router]);
  return null;
}
