"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { getNativeTestConfig } from "@/lib/testing/native-test";

let lastAppliedInitialRoute: string | null = null;
let lastAppliedInitialRouteRequest: { route: string; appliedAt: number } | null = null;
let lastAppliedExpectedRouteRecovery: { key: string; appliedAt: number } | null = null;

const NATIVE_TEST_CONFIG_UPDATED_EVENT = "hushh:native-test-config-updated";
const EXPECTED_ROUTE_RECOVERY_RETRY_MS = 5_000;

function normalizeRoute(value: string | null | undefined) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/") {
    return trimmed || "/";
  }

  try {
    const url = new URL(trimmed, "https://native-test.local");
    let pathname = url.pathname || "/";
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    return `${pathname}${url.search}`;
  } catch {
    return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  }
}

function sameRoute(left: string | null | undefined, right: string | null | undefined) {
  return normalizeRoute(left) === normalizeRoute(right);
}

function getRedirectTarget(route: string | null | undefined) {
  if (!route) return null;

  try {
    const url = new URL(route, "https://native-test.local");
    return url.searchParams.get("redirect");
  } catch {
    return null;
  }
}

function canRecoverToExpectedRoute() {
  if (typeof window === "undefined") {
    return false;
  }

  const bridge = window.__HUSHH_NATIVE_TEST__;
  if (!bridge?.expectedUserId) {
    return true;
  }

  return [
    "authenticated",
    "loading_vault_state",
    "unlocking_vault",
    "vault_unlocked",
  ].includes(String(bridge.bootstrapState || ""));
}

export function NativeTestRouter() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const bridge = window.__HUSHH_NATIVE_TEST__;
    const navigateToRoute = (route: string) => {
      router.replace(route, { scroll: false });
    };
    if (bridge?.enabled) {
      bridge.navigateToRoute = navigateToRoute;
    }

    let missingConfigAttempts = 0;
    const maybeRoute = () => {
      const config = getNativeTestConfig();
      if (!config.enabled || !config.initialRoute) {
        missingConfigAttempts += 1;
        return missingConfigAttempts >= 40;
      }

      missingConfigAttempts = 0;
      const currentRoute = `${pathname}${window.location.search || ""}`;
      if (sameRoute(currentRoute, config.initialRoute)) {
        lastAppliedInitialRoute = config.initialRoute;
        lastAppliedExpectedRouteRecovery = null;
        return true;
      }

      if (lastAppliedInitialRoute === config.initialRoute) {
        const now = Date.now();
        const redirectTarget = getRedirectTarget(config.initialRoute);
        const recoveryKey = [
          config.initialRoute,
          config.expectedRoute,
          currentRoute,
          window.__HUSHH_NATIVE_TEST__?.bootstrapState || "",
        ].join("|");
        const recoveryRecentlyApplied =
          lastAppliedExpectedRouteRecovery?.key === recoveryKey &&
          now - lastAppliedExpectedRouteRecovery.appliedAt <
            EXPECTED_ROUTE_RECOVERY_RETRY_MS;
        if (
          config.autoReviewerLogin &&
          config.expectedRoute &&
          currentRoute.startsWith("/login") &&
          !sameRoute(currentRoute, config.expectedRoute) &&
          canRecoverToExpectedRoute() &&
          !recoveryRecentlyApplied
        ) {
          lastAppliedInitialRoute = config.initialRoute;
          lastAppliedExpectedRouteRecovery = { key: recoveryKey, appliedAt: now };
          router.replace(config.expectedRoute, { scroll: false });
        }

        if (
          config.autoReviewerLogin &&
          config.expectedRoute &&
          redirectTarget &&
          sameRoute(currentRoute, redirectTarget) &&
          !sameRoute(currentRoute, config.expectedRoute) &&
          canRecoverToExpectedRoute() &&
          !recoveryRecentlyApplied
        ) {
          lastAppliedInitialRoute = config.initialRoute;
          lastAppliedExpectedRouteRecovery = { key: recoveryKey, appliedAt: now };
          router.replace(config.expectedRoute, { scroll: false });
        }

        const alreadyAtExpectedRoute =
          Boolean(config.expectedRoute) && sameRoute(currentRoute, config.expectedRoute);
        const initialRouteRecentlyApplied =
          lastAppliedInitialRouteRequest?.route === config.initialRoute &&
          now - lastAppliedInitialRouteRequest.appliedAt <
            EXPECTED_ROUTE_RECOVERY_RETRY_MS;
        if (
          !alreadyAtExpectedRoute &&
          !sameRoute(currentRoute, config.initialRoute) &&
          !initialRouteRecentlyApplied
        ) {
          lastAppliedInitialRouteRequest = {
            route: config.initialRoute,
            appliedAt: now,
          };
          router.replace(config.initialRoute, { scroll: false });
        }
        return true;
      }

      lastAppliedInitialRoute = config.initialRoute;
      lastAppliedExpectedRouteRecovery = null;
      lastAppliedInitialRouteRequest = {
        route: config.initialRoute,
        appliedAt: Date.now(),
      };
      // Keep native audit route changes in the Next.js router so memory-only
      // BYOK state stays in the same WebView document whenever possible.
      router.replace(config.initialRoute, { scroll: false });
      return true;
    };

    maybeRoute();

    const timer = window.setInterval(() => {
      const shouldStop = maybeRoute();
      if (shouldStop && !getNativeTestConfig().enabled) {
        window.clearInterval(timer);
      }
    }, 500);

    window.addEventListener(NATIVE_TEST_CONFIG_UPDATED_EVENT, maybeRoute);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener(NATIVE_TEST_CONFIG_UPDATED_EVENT, maybeRoute);
      const currentBridge = window.__HUSHH_NATIVE_TEST__;
      if (currentBridge && currentBridge.navigateToRoute === navigateToRoute) {
        currentBridge.navigateToRoute = null;
      }
    };
  }, [pathname, router]);

  return null;
}
