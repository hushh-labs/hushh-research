"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function AppNotFoundPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/");
  }, [router]);

  return null;
}
