// hooks/use-auth.ts

/**
 * Authentication Hook Strategy
 * ============================
 *
 * This file replaces the previous local-state hook with a direct re-export
 * of the Global Auth Context.
 *
 * This ensures that:
 * 1. All components (Navbar, Login, Dashboard) share the exact same state
 * 2. Native login updates (via Context.checkAuth()) propagate immediately
 * 3. No "Split Brain" state between different parts of the app
 */

"use client";

import { useAuth as useContextAuth } from "@/lib/firebase/auth-context";
import { useRouter, usePathname } from "next/navigation";
import { useEffect } from "react";

// Re-export the Context Hook as the primary useAuth
export const useAuth = useContextAuth;

/**
 * Hook to require authentication on a page
 * Redirects to login if not authenticated
 */
export function useRequireAuth() {
  const auth = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!auth.loading && !auth.isAuthenticated) {
      // Avoid redirect loop if already on login
      if (pathname !== "/login") {
        router.push("/login");
      }
    }
  }, [auth.loading, auth.isAuthenticated, router, pathname]);

  return auth;
}
