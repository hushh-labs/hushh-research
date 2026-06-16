"use client";

import * as React from "react";
import { Loader2Icon } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "size-3",
  md: "size-4",
  lg: "size-6",
  xl: "size-8",
};

const SPEEDS = {
  slow: "animate-[spin_2s_linear_infinite]",
  normal: "animate-spin",
  fast: "animate-[spin_0.5s_linear_infinite]",
};

interface SpinnerProps extends React.ComponentProps<"svg"> {
  size?: keyof typeof SIZES;
  speed?: keyof typeof SPEEDS;
}

function Spinner({ 
  className, 
  size = "md", 
  speed = "normal", 
  ...props 
}: SpinnerProps) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn(
        "text-current", 
        SIZES[size], 
        SPEEDS[speed], 
        className
      )}
      {...props}
    />
  );
}

export { Spinner };