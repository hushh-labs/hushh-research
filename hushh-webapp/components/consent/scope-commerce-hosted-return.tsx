"use client";

import { useEffect, useState, type ReactNode } from "react";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { notifyCommercePopupReturn } from "@/lib/services/scope-commerce-browser";

/** A matching arrival closes only the auxiliary window. Cold entry stays guarded. */
export function ScopeCommerceHostedReturn({ fallback }: { fallback: ReactNode }) {
  const [state, setState] = useState<"checking" | "returned" | "cold">("checking");
  useEffect(() => {
    setState(notifyCommercePopupReturn(window.location.pathname + window.location.search + window.location.hash) ? "returned" : "cold");
  }, []);
  if (state === "checking") return <HushhLoader stage="session" label="Returning to your payment screen…" />;
  if (state === "cold") return <>{fallback}</>;
  return <p role="status" className="p-4 text-sm">Return to your original One window. It will check payment status securely. You can close this window.</p>;
}
