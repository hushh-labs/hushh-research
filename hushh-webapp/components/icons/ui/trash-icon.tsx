"use client";

import { Trash } from "@phosphor-icons/react";
import { forwardRef } from "react";
import type { CanonicalIconProps } from "../legacy-ui-icons";
import { cn } from "@/lib/utils";

/** Deletion glyphs keep Apple's destructive red, independent of row text. */
export const AppleTrashIcon = forwardRef<SVGSVGElement, CanonicalIconProps>(
  function AppleTrashIcon(
    { weight = "regular", className, style, strokeWidth: _strokeWidth, absoluteStrokeWidth: _absoluteStrokeWidth, ...props },
    ref,
  ) {
    return (
      <Trash
        {...props}
        ref={ref}
        weight={weight}
        color="var(--app-destructive)"
        className={cn(className, "!text-[color:var(--app-destructive)]")}
        style={{ ...style, color: "var(--app-destructive)" }}
        data-canonical-icon="true"
        data-trash-icon="true"
      />
    );
  },
);
