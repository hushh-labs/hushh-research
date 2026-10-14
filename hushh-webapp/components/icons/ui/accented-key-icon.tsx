"use client";

import { useId } from "react";
import { Key, type CanonicalIconProps } from "../legacy-ui-icons";
import { cn } from "@/lib/utils";

/** Recolor the canonical key without changing its artwork, weight or size. */
export function AccentedKeyIcon({ className, ...props }: CanonicalIconProps) {
  const toneId = useId();
  return (
    <Key
      aria-hidden="true"
      {...props}
      className={cn("text-[color:var(--ios-account-label)]", className)}
      fill={`url(#${toneId})`}
    >
      <defs>
        <pattern id={toneId} patternUnits="userSpaceOnUse" width="256" height="256">
          <rect width="256" height="256" fill="currentColor" />
          {/* This is the existing pinpoint in Phosphor's combined key path. */}
          <circle cx="180" cy="76" r="12" fill="var(--ios-account-accent)" />
        </pattern>
      </defs>
    </Key>
  );
}
