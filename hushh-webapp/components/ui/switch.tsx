"use client";

import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Check, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const VARIANTS = {
  primary: "data-[state=checked]:bg-primary",
  success: "data-[state=checked]:bg-emerald-500",
  warning: "data-[state=checked]:bg-amber-500",
  danger: "data-[state=checked]:bg-rose-500",
};

function Switch({
  className,
  size = "default",
  variant = "primary",
  showIcon = false,
  loading = false,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
  size?: "sm" | "default";
  variant?: keyof typeof VARIANTS;
  showIcon?: boolean;
  loading?: boolean;
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      disabled={props.disabled || loading}
      className={cn(
        "peer group/switch inline-flex shrink-0 items-center rounded-full border border-transparent shadow-xs transition-all outline-none",
        "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[size=default]:h-5 data-[size=default]:w-9 data-[size=sm]:h-4 data-[size=sm]:w-7",
        "data-[state=unchecked]:bg-input dark:data-[state=unchecked]:bg-input/80",
        VARIANTS[variant],
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none flex items-center justify-center rounded-full bg-background ring-0 transition-transform",
          "group-data-[size=default]/switch:size-4 group-data-[size=sm]/switch:size-3",
          "group-data-[size=default]/switch:data-[state=checked]:translate-x-4 group-data-[size=sm]/switch:data-[state=checked]:translate-x-3",
          "data-[state=unchecked]:translate-x-0"
        )}
      >
        {loading ? (
          <Loader2 className="size-2.5 animate-spin text-muted-foreground" />
        ) : showIcon ? (
          props.checked ? (
            <Check className="size-2.5 text-primary" />
          ) : (
            <X className="size-2.5 text-muted-foreground" />
          )
        ) : null}
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  );
}

export { Switch };