"use client";

import { Trash } from "@phosphor-icons/react";
import { forwardRef } from "react";
import type { CanonicalIconProps } from "../legacy-ui-icons";
import { cn } from "@/lib/utils";

/** Standalone deletion glyphs use Apple red. Paired glyphs can inherit their action’s foreground. */
export const AppleTrashIcon = forwardRef<SVGSVGElement, CanonicalIconProps & { inheritColor?: boolean }>(
  function AppleTrashIcon(
    { weight = "regular", className, style, inheritColor = false, strokeWidth: _strokeWidth, absoluteStrokeWidth: _absoluteStrokeWidth, ...props },
    ref,
  ) {
    return (
      <Trash
        {...props}
        ref={ref}
        weight={weight}
        color={inheritColor ? "currentColor" : "var(--app-destructive)"}
        className={cn(className, !inheritColor && "!text-[color:var(--app-destructive)]")}
        style={inheritColor ? style : { ...style, color: "var(--app-destructive)" }}
        data-canonical-icon="true"
        data-trash-icon="true"
      />
    );
  },
);
