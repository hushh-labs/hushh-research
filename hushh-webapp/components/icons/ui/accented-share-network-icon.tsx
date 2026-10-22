"use client";

import { forwardRef, useId } from "react";
import { ShareNetwork } from "@phosphor-icons/react";
import type { CanonicalIconProps } from "../legacy-ui-icons";

type AccentedShareNetworkIconProps = CanonicalIconProps & {
  /** Solid accent actions need a contrasting glyph rather than an invisible blue source. */
  onAccent?: boolean;
};

/** Keep the official ShareNetwork geometry with a legible source node. */
export const AccentedShareNetworkIcon = forwardRef<SVGSVGElement, AccentedShareNetworkIconProps>(function AccentedShareNetworkIcon(
  { className, style, onAccent = false, weight = "regular", strokeWidth: _strokeWidth, absoluteStrokeWidth: _absoluteStrokeWidth, ...props },
  ref,
) {
  const toneId = useId();
  const ink = onAccent ? "var(--app-accent-fg)" : "var(--ios-account-label)";
  const source = onAccent ? "var(--app-accent-fg)" : "var(--ios-account-accent)";
  return (
    <ShareNetwork
      aria-hidden="true"
      {...props}
      ref={ref}
      weight={weight === "duotone" ? "regular" : weight}
      data-canonical-icon="true"
      className={className}
      style={{ ...style, color: ink }}
      fill={`url(#${toneId})`}
    >
      <defs>
        <pattern id={toneId} patternUnits="userSpaceOnUse" width="256" height="256">
          <rect width="256" height="256" fill="currentColor" />
          <circle className="profile-pane-icon-accent-fill" cx="64" cy="128" r="36" fill={source} />
        </pattern>
      </defs>
    </ShareNetwork>
  );
});
