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
  "bg-[#f1f1f3] text-[#1d1d1f] dark:bg-white/[0.14] dark:text-white group-data-[selected=true]:bg-white group-data-[selected=true]:text-[#1d1d1f] dark:group-data-[selected=true]:bg-[#2c2c2e] dark:group-data-[selected=true]:text-white";

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
}: {
  id: string;
  icon: OneCapabilityIcon;
  tone?: OneCapabilityTone | null;
  size?: AgentSectionIconSize;
  className?: string;
}) {
  const classes = ICON_SIZE_CLASS[size];
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
