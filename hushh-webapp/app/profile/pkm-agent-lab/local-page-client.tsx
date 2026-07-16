"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { isPkmDeveloperHost } from "@/app/one/pkm/developer-visibility";
import { ROUTES } from "@/lib/navigation/routes";

import PkmAgentLabPageClient from "./page-client";

export default function LocalPkmAgentLabPage() {
  const router = useRouter();
  const [hostAllowed, setHostAllowed] = useState(false);

  useEffect(() => {
    const allowed = isPkmDeveloperHost(window.location.hostname);
    setHostAllowed(allowed);
    if (!allowed) {
      router.replace(ROUTES.PKM);
    }
  }, [router]);

  return hostAllowed ? <PkmAgentLabPageClient /> : null;
}
