"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { getNativeTestConfig } from "@/lib/testing/native-test";

const INITIAL_ROUTE_KEY = "__hushh_native_test_initial_route_applied__";

export function NativeTestRouter() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let attempts = 0;
    const maybeRoute = () => {
      const config = getNativeTestConfig();
      if (!config.enabled || !config.initialRoute) {
        attempts += 1;
        return attempts >= 40;
      }

      const currentRoute = `${pathname}${window.location.search || ""}`;
      if (currentRoute === config.initialRoute) {
        sessionStorage.setItem(INITIAL_ROUTE_KEY, "1");
        return true;
      }

      if (sessionStorage.getItem(INITIAL_ROUTE_KEY) === "1") {
        return true;
      }

      sessionStorage.setItem(INITIAL_ROUTE_KEY, "1");
      router.replace(config.initialRoute);
      return true;
    };

    if (maybeRoute()) {
      return;
    }

    const timer = window.setInterval(() => {
      if (maybeRoute()) {
        window.clearInterval(timer);
      }
    }, 250);

    return () => {
      window.clearInterval(timer);
    };
  }, [pathname, router]);

  return null;
}
