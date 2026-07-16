"use client";

import { usePathname } from "next/navigation";

import { isFoundationPublicRoute } from "@/lib/navigation/routes";

/** A single fixed Foundation field for public editorial routes. */
export function FoundationPublicAmbient() {
  const pathname = usePathname();
  if (!isFoundationPublicRoute(pathname ?? "")) return null;

  return (
    <div
      aria-hidden
      data-foundation-public="true"
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-[#f5f5f7] dark:bg-[#1c1c1e]"
    >
      <div className="one-grain absolute inset-0" />
    </div>
  );
}
