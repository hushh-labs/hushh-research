import type { CSSProperties } from "react";
import Image from "next/image";

import {
  ONE_CAPABILITY_ICON_CLASS_BY_TONE,
  type OneCapabilityIcon,
  type OneCapabilityTone,
} from "@/lib/onboarding/one-capabilities";
import { cn } from "@/lib/utils";

// Fallback chip for sections with no tone (the "agents" root switcher and the
// tone-less RIA workspace entry). Solid neutral in both themes. The
// `group-data-[selected=true]` variant keeps this readable when the icon sits
// on an accent/amber cmdk highlight row (see components/ui/command.tsx
// CommandItem): the default translucent dark tint (white/0.14) is nearly
// invisible against that highlight, so the selected state forces the same
// solid chip used everywhere else instead of blending into the highlight.
const AGENT_ICON_SURFACE_FALLBACK_CLASSNAME =
  "bg-[color:var(--app-card-surface-compact)] text-foreground ring-1 ring-border/60 group-data-[selected=true]:bg-accent-surface group-data-[selected=true]:text-accent-strong";

const ICON_SIZE_CLASS = {
  card: {
    surface: "h-14 w-14",
    lucideSurface:
      "rounded-[18px] shadow-[0_8px_20px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
    imageSurface: "rounded-[18px]",
    lucide: "h-6 w-6",
    image: "h-full w-full object-contain",
    pixels: 72,
  },
  launcher: {
    surface: "h-16 w-16",
    lucideSurface:
      "h-16 w-16 rounded-[20px] shadow-[0_10px_24px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
    imageSurface: "rounded-[20px]",
    lucide: "h-7 w-7",
    image: "h-full w-full object-contain",
    pixels: 80,
  },
  topbar: {
    surface: "h-8 w-8",
    lucideSurface:
      "h-8 w-8 rounded-[10px] shadow-[0_5px_13px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
    imageSurface: "rounded-[10px]",
    lucide: "h-4 w-4",
    image: "h-full w-full object-contain",
    pixels: 40,
  },
  menu: {
    surface: "h-8 w-8",
    lucideSurface:
      "h-8 w-8 rounded-[10px] shadow-[0_5px_13px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
    imageSurface: "rounded-[10px]",
    lucide: "h-4 w-4",
    image: "h-full w-full object-contain",
    pixels: 40,
  },
} as const;

type AgentSectionIconSize = keyof typeof ICON_SIZE_CLASS;

const CAPABILITY_ICON_STYLE_BY_TONE: Partial<
  Record<OneCapabilityTone, CSSProperties>
> = {
  finance: { backgroundColor: "#B85CF6" }, // Lavender Mist
  ria: { backgroundColor: "#60A5FA" }, // Sky Blue
  gmail: { backgroundColor: "#ffffff" }, // Cloud White (multicolor logo)
  email: { backgroundColor: "#14B8A6" }, // Mint Teal
  location: { backgroundColor: "#A7D7A1" }, // Sage Green
  pkm: { backgroundColor: "#B85CF6" }, // Lavender Mist (Memory + Information)
  consent: { backgroundColor: "#C8923A" }, // Warm Gold
  connected: { backgroundColor: "#94A3B8" }, // Slate Blue-Gray
};

export function AgentSectionIcon({
  id,
  icon,
  tone,
  size = "launcher",
  className,
  isActive,
}: {
  id: string;
  icon: OneCapabilityIcon;
  tone?: OneCapabilityTone | null;
  size?: AgentSectionIconSize;
  className?: string;
  isActive?: boolean;
}) {
  const classes = ICON_SIZE_CLASS[size];

  if (icon.kind === "solar") {
     const SolarIcon = icon.component as React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
     // If explicitly inactive, it stays grey/muted. Otherwise defaults to full Morphy color!
     const active = isActive !== false;
     const toneStyle = tone ? CAPABILITY_ICON_STYLE_BY_TONE[tone] : undefined;
     const brandColor = toneStyle?.backgroundColor ? String(toneStyle.backgroundColor) : "var(--app-accent)";

     const surfaceSizes = {
       card: "h-14 w-14 rounded-[18px]",
       launcher: "h-16 w-16 rounded-[20px]",
       topbar: "h-8 w-8 rounded-[10px]",
       menu: "h-8 w-8 rounded-[10px]"
     };
     const innerSizes = {
       card: "h-10 w-10",
       launcher: "h-12 w-12",
       topbar: "h-7 w-7",
       menu: "h-6 w-6"
     };

     return (
       <div className={cn("relative inline-flex items-center justify-center", surfaceSizes[size], className)} data-testid={`one-agent-icon-${id}`}>
         {active && (
           <div
             className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 h-full w-full blur-[14px] rounded-full opacity-35 dark:opacity-20 scale-90 transition-all duration-300"
             style={{ backgroundColor: brandColor }}
             aria-hidden
           />
         )}

         <div className={cn("relative flex items-center justify-center w-full h-full overflow-hidden isolate backdrop-blur-[8px]",
            surfaceSizes[size],
            active ? "bg-white/80 dark:bg-[rgba(30,30,45,0.7)] shadow-[0_12px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_16px_32px_rgba(0,0,0,0.4)] ring-1 ring-white/60 dark:ring-white/10"
                   : "bg-[color:var(--app-card-surface-compact)] ring-1 ring-border/60 shadow-sm"
         )}>
           <div className={cn("relative z-10 flex items-center justify-center", innerSizes[size])}>
               <SolarIcon
                 className={cn("w-full h-full drop-shadow-[0_2px_4px_rgba(0,0,0,0.15)] dark:drop-shadow-[0_4px_8px_rgba(0,0,0,0.3)] transition-all duration-300",
                   !active ? "text-muted-foreground/60 dark:text-muted-foreground/50" : ""
                 )}
                 style={active ? { color: brandColor } : undefined}
               />
           </div>
         </div>
       </div>
     );
  }


  const toneClassName = tone
    ? ONE_CAPABILITY_ICON_CLASS_BY_TONE[tone]
    : AGENT_ICON_SURFACE_FALLBACK_CLASSNAME;
  const toneStyle =
    icon.kind === "lucide" && tone
      ? CAPABILITY_ICON_STYLE_BY_TONE[tone]
      : undefined;
  const Icon = icon.kind === "lucide" ? icon.icon : null;

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        classes.surface,
        icon.kind === "image"
          ? classes.imageSurface
          : cn(classes.lucideSurface, toneClassName),
        className,
      )}
      style={toneStyle}
      data-testid={`one-agent-icon-${id}`}
      data-agent-icon-kind={icon.kind}
      data-agent-icon-src={icon.kind === "image" ? icon.src : undefined}
      aria-hidden
    >
      {icon.kind === "image" ? (
        <Image
          src={icon.src}
          alt=""
          width={classes.pixels}
          height={classes.pixels}
          unoptimized
          draggable={false}
          className={classes.image}
        />
      ) : Icon ? (
        <Icon
          // cmdk applies a muted foreground to bare SVGs. Give this icon an
          // explicit, important theme-aware foreground so a command/menu
          // ancestor cannot override the requested contrast. Branded chips
          // use dark glyphs in light mode and light glyphs in dark mode; the
          // same primitive drives the dashboard grid and the top switcher.
          className={cn(
            classes.lucide,
            tone ? "!text-[#1d1d1f] dark:!text-white" : "text-current",
          )}
          aria-hidden
        />
      ) : null}
    </span>
  );
}
