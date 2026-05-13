"use client";

import type { ReactNode } from "react";

type AsyncRecoveryBoundaryProps = {
  loading?: boolean;
  stale?: boolean;
  error?: boolean;
  offline?: boolean;
  loadingFallback?: ReactNode;
  staleFallback?: ReactNode;
  errorFallback?: ReactNode;
  offlineFallback?: ReactNode;
  children: ReactNode;
};

export function AsyncRecoveryBoundary({
  loading = false,
  stale = false,
  error = false,
  offline = false,
  loadingFallback = null,
  staleFallback = null,
  errorFallback = null,
  offlineFallback = null,
  children,
}: AsyncRecoveryBoundaryProps) {
  if (offline && offlineFallback) {
    return <>{offlineFallback}</>;
  }

  if (error && errorFallback) {
    return <>{errorFallback}</>;
  }

  if (loading && loadingFallback) {
    return <>{loadingFallback}</>;
  }

  if (stale && staleFallback) {
    return <>{staleFallback}</>;
  }

  return <>{children}</>;
}