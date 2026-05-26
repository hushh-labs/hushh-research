"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { getNativeTestConfig } from "@/lib/testing/native-test";

export function NativeTestRouter() {
  const router = useRouter();
  const pathname = usePathname();
  // Using a ref instead of a global variable keeps state localized to the component lifecycle
  const hasApplied = useRef(false);

  useEffect(() => {
    // Safety check for SSR environments
    if (typeof window === "undefined") return;

    let attempts = 0;
    const interval = window.setInterval(() => {
      const config = getNativeTestConfig();

      // If config isn't ready, wait
      if (!config.enabled || !config.initialRoute) {
        attempts++;
        if (attempts >= 40) window.clearInterval(interval);
        return;
      }

      // If already at the target route, stop
      const currentRoute = `${pathname}${window.location.search || ""}`;
      if (currentRoute === config.initialRoute || hasApplied.current) {
        window.clearInterval(interval);
        return;
      }

      // Apply redirect
      hasApplied.current = true;
      router.replace(config.initialRoute);
      window.clearInterval(interval);
    }, 250);

    return () => window.clearInterval(interval);
  }, [pathname, router]);

  return null;
}