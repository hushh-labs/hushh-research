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
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-[#FCF9F2] dark:bg-[#100D0A]"
    >
      <div className="one-grain absolute inset-0" />
    </div>
  );
}
