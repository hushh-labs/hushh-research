import React, { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// Tone limits derived from our Figma standards and earlier static configurations
// 'finance', 'ria', 'gmail' -> use Blue
// 'kyc', 'consent', 'memory', 'connected-systems' -> use Emerald
export type MorphyGlassTone = "finance" | "ria" | "gmail" | "email" | "location" | "pkm" | "consent" | "connected";

interface MorphyGlassIconProps extends ComponentProps<"div"> {
  tone: MorphyGlassTone;
  children?: React.ReactNode;
}

export function MorphyGlassIcon({ tone, children, className, ...props }: MorphyGlassIconProps) {
  // Determine if it should map to Blue or Emerald internal styling
  const isBlue = tone === "finance" || tone === "ria" || tone === "gmail";

  // Ambient radial glow that hides strictly behind the glass
  const glowColorClass = isBlue ? "bg-[#0071e3]" : "bg-[#10b981]";

  // The translucent geometric background box matching the static generated logic
  const glassClasses = cn(
    "relative flex h-14 w-14 sm:h-16 sm:w-16 shrink-0 items-center justify-center rounded-[18px] sm:rounded-[20px]",
    // Light Mode Styling (White frosted with solid drop-shadow)
    "bg-white/70 shadow-[0_12px_24px_rgba(0,0,0,0.1)] ring-1 ring-white/60",
    // Dark Mode Styling (Deep space frosted with silky, robust dark drop-shadow)
    "dark:bg-[#20202F]/60 dark:shadow-[0_16px_32px_rgba(0,0,0,0.5)] dark:ring-white/10",
    "overflow-hidden isolate backdrop-blur-[8px]",
    className
  );

  return (
    <div className={cn("relative inline-flex items-center justify-center", className)} {...props}>
      {/* 1. Underlying soft pulse matching SVGs exactly */}
      <div
        className={cn(
          "absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-[140%] w-[140%] blur-[24px] rounded-full opacity-35 dark:opacity-20",
          glowColorClass
        )}
        aria-hidden
      />

      {/* 2. Glass Base */}
      <div className={glassClasses}>
        {/* 3. Render Inner SVG Asset */}
        <div className="relative z-10 flex h-7 w-7 sm:h-8 sm:w-8 items-center justify-center text-white scale-[1.1] sm:scale-100">
          {children}
        </div>
      </div>
    </div>
  );
}
