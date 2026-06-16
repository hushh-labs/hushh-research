"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "h-4 min-w-4 px-0.5 text-[10px]",
  md: "h-5 min-w-5 px-1 text-xs",
  lg: "h-6 min-w-6 px-1.5 text-sm",
};

interface KbdProps extends React.ComponentProps<"kbd"> {
  size?: keyof typeof SIZES;
}

function Kbd({ className, size = "md", ...props }: KbdProps) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "bg-muted text-muted-foreground pointer-events-none inline-flex w-fit items-center justify-center gap-0.5 rounded-sm font-sans font-medium select-none shadow-[0_1px_0_0_hsl(var(--muted-foreground)/0.2)]",
        SIZES[size],
        "[&_svg]:shrink-0",
        className
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1", className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };