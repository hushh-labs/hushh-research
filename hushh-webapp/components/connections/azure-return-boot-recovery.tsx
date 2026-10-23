"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";

import {
  BOOT_TIMING,
  hasBootRouteCommitted,
  subscribeBootSurface,
} from "@/lib/boot/boot-surface-store";
import { useAuth } from "@/lib/firebase/auth-context";
import { ROUTES } from "@/lib/navigation/routes";

const RECOVERABLE_OWNER_ROUTES = new Set<string>([
  ROUTES.HOME,
  ROUTES.ONE_HOME,
  ROUTES.ONE_PUPPY,
  ROUTES.ONE_FILES,
  ROUTES.ONE_SETUP,
  ROUTES.ONE_SETUP_CLOUD,
  ROUTES.PROFILE_SOFTWARE_UPDATES,
  ROUTES.ONE_SETUP_CLOUD_AZURE_RETURN,
]);

/**
 * A hidden browser tab can withhold React's streamed shell reveal while the
 * session above it has already verified. Recover once through Next's supported
 * navigation boundary; mounted pages still own unlock, approval and execution.
 * Mount above AppShell's Suspense, otherwise the recovery also waits for it.
 */
export function AzureReturnBootRecovery() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading, sessionVerificationRequired } = useAuth();
  const attempted = useRef(false);
  const ownerId = user?.uid ?? null;

  useEffect(() => {
    if (
      !pathname ||
      !RECOVERABLE_OWNER_ROUTES.has(pathname) ||
      !ownerId ||
      loading ||
      sessionVerificationRequired ||
      attempted.current ||
      hasBootRouteCommitted()
    ) return;

    let current = true;
    const timer = setTimeout(() => {
      if (!current || attempted.current || hasBootRouteCommitted()) return;
      attempted.current = true;
      router.refresh();
    }, BOOT_TIMING.stuckAfterMs);
    const unsubscribe = subscribeBootSurface(() => {
      if (hasBootRouteCommitted()) clearTimeout(timer);
    });
    return () => {
      current = false;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [pathname, ownerId, loading, sessionVerificationRequired, router]);

  return null;
}
