"use client";

/**
 * Deferred Hydration Wrapper
 * 
 * Optimizes Next.js SSR hydration by deferring non-critical providers
 * until after initial page render. This reduces Time to Interactive (TTI)
 * and First Contentful Paint (FCP).
 * 
 * Benefits:
 * - Reduces layout thrashing from theme/context initialization
 * - Improves perceived performance on mobile (LCP/FID metrics)
 * - Prevents hydration mismatches from async theme detection
 */

import { ReactNode, Suspense, useEffect, useState } from "react";

interface DeferredHydrationProps {
  children: ReactNode;
  fallback?: ReactNode;
  delay?: number;
}

/**
 * Wrapper that defers rendering of children until after hydration
 * Prevents expensive computations from blocking the main thread
 */
export function DeferredHydration({
  children,
  fallback = null,
  delay = 0,
}: DeferredHydrationProps) {
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    if (delay > 0) {
      const timer = setTimeout(() => setIsHydrated(true), delay);
      return () => clearTimeout(timer);
    }
    
    // Use requestIdleCallback for better performance
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(() => setIsHydrated(true), { timeout: 2000 });
      return () => cancelIdleCallback(id);
    }
    
    // Fallback to immediate state update
    setIsHydrated(true);
    return;
  }, [delay]);

  if (!isHydrated) {
    return fallback;
  }

  return <>{children}</>;
}

/**
 * Suspense boundary with fallback for deferred providers
 * Prevents waterfall loading of nested providers
 */
export function DeferredProviderBoundary({
  children,
  fallback = null,
}: {
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <DeferredHydration delay={100}>{children}</DeferredHydration>
    </Suspense>
  );
}

/**
 * Critical providers (these run during SSR and initial hydration)
 * Include only essential providers like Auth, Theme (with suppression)
 */
export function CriticalProviders({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

/**
 * Non-critical providers (deferred until after hydration)
 * Include heavy providers like routing observers, animations, etc.
 */
export function DeferredProviders({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
