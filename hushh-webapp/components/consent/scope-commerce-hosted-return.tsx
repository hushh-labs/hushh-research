"use client";

import { useEffect, useState, type ReactNode } from "react";
import { HushhLoader } from "@/components/app-ui/hushh-loader";
import { notifyCommercePopupReturn } from "@/lib/services/scope-commerce-browser";

/** A matching arrival closes only the auxiliary window. Cold entry stays guarded. */
export function ScopeCommerceHostedReturn({ fallback }: { fallback: ReactNode }) {
  const [state, setState] = useState<"checking" | "returned" | "cold">(() => {
    if (typeof window === "undefined") return "checking";
    return notifyCommercePopupReturn(window.location.pathname + window.location.search + window.location.hash)
      ? "returned"
      : "cold";
  });
  useEffect(() => {
    if (state !== "checking") return;
    setState(notifyCommercePopupReturn(window.location.pathname + window.location.search + window.location.hash) ? "returned" : "cold");
  }, [state]);
  if (state === "checking") return <div className="consent-presentation-surface"><HushhLoader stage="session" label="Returning to your payment screen…" /></div>;
  if (state === "cold") return <>{fallback}</>;
  return <div className="consent-presentation-surface"><p data-consent-role="status" role="status" className="p-4 text-sm">Return to your original One window. It will check payment status securely. You can close this window.</p></div>;
}
