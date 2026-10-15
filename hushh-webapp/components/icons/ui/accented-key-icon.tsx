"use client";

import { forwardRef, useId } from "react";
import { Key } from "@phosphor-icons/react";
import type { CanonicalIconProps } from "../legacy-ui-icons";
import { cn } from "@/lib/utils";

/** One outline key palette for password fields and every public key alias. */
export const AccentedKeyIcon = forwardRef<SVGSVGElement, CanonicalIconProps>(function AccentedKeyIcon(
  { className, style, weight = "regular", strokeWidth: _strokeWidth, absoluteStrokeWidth: _absoluteStrokeWidth, ...props },
  ref,
) {
  const toneId = useId();
  return (
    <Key
      aria-hidden="true"
      {...props}
      ref={ref}
      weight={weight === "duotone" ? "regular" : weight}
      data-canonical-icon="true"
      className={cn("text-[color:var(--ios-account-label)]", className)}
      style={{ ...style, color: "var(--ios-account-label)" }}
      fill={`url(#${toneId})`}
    >
      <defs>
        <pattern id={toneId} patternUnits="userSpaceOnUse" width="256" height="256">
          <rect width="256" height="256" fill="currentColor" />
          {/* This is the existing pinpoint in Phosphor's combined key path. */}
          <circle cx="180" cy="76" r="12" fill="var(--app-key-accent)" />
        </pattern>
      </defs>
    </Key>
  );
});
