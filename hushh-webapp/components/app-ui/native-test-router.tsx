"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { getNativeTestConfig } from "@/lib/testing/native-test";

// Module-level flag ensures the initial route is only ever applied once per app lifecycle
let initialRouteApplied = false;

const POLL_INTERVAL_MS = 250;
const MAX_ATTEMPTS = 40;

export function NativeTestRouter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Use a ref to persist attempt counts across React re-renders
  const attemptsRef = useRef(0);

  useEffect(() => {
    // Early exit if routing has already been handled or if running on the server
    if (initialRouteApplied || typeof window === "undefined") {
      return;
    }

    let timerId: number | undefined;

    const attemptRouting = (): boolean => {
      const config = getNativeTestConfig();

      if (!config.enabled || !config.initialRoute) {
        attemptsRef.current += 1;
        // Stop polling if we've reached the maximum attempts
        return attemptsRef.current >= MAX_ATTEMPTS;
      }

      // Safely construct the current route using pure Next.js hooks
      const search = searchParams.toString();
      const currentRoute = search ? `${pathname}?${search}` : pathname;

      // Only execute the router replace if we aren't already on the target route
      if (currentRoute !== config.initialRoute) {
        router.replace(config.initialRoute);
      }

      // Mark as applied so it never runs again
      initialRouteApplied = true;
      return true; // Stop polling
    };

    // Execute first attempt immediately
    if (!attemptRouting()) {
      // If it returns false (needs to keep trying), start the interval
      timerId = window.setInterval(() => {
        if (attemptRouting()) {
          window.clearInterval(timerId);
        }
      }, POLL_INTERVAL_MS);
    }

    // Cleanup interval on component unmount or effect re-run
    return () => {
      if (timerId !== undefined) {
        window.clearInterval(timerId);
      }
    };
  }, [pathname, router, searchParams]);

  return null;
}