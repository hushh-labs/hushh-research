"use client";

import { forwardRef, useId } from "react";
import { ShareNetwork } from "@phosphor-icons/react";
import type { CanonicalIconProps } from "../legacy-ui-icons";
import { cn } from "@/lib/utils";

/** Keep the official ShareNetwork geometry with the source node accented. */
export const AccentedShareNetworkIcon = forwardRef<SVGSVGElement, CanonicalIconProps>(function AccentedShareNetworkIcon(
  { className, style, weight = "regular", strokeWidth: _strokeWidth, absoluteStrokeWidth: _absoluteStrokeWidth, ...props },
  ref,
) {
  const toneId = useId();
  return (
    <ShareNetwork
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
          <circle className="profile-pane-icon-accent-fill" cx="64" cy="128" r="36" fill="var(--ios-account-accent)" />
        </pattern>
      </defs>
    </ShareNetwork>
  );
});
