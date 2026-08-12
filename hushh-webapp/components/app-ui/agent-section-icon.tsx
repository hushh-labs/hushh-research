import type { CSSProperties } from "react";
import Image from "next/image";

import {
  ONE_CAPABILITY_ICON_CLASS_BY_TONE,
  type OneCapabilityIcon,
  type OneCapabilityTone,
} from "@/lib/onboarding/one-capabilities";
import {
  AGENT_PROFILE_LAUNCHER_PALETTE,
  AGENT_THEME_BY_TONE,
} from "@/lib/design/agent-theme-registry";
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
    surface: "h-14 w-14 sm:h-16 sm:w-16",
    lucideSurface:
      "h-16 w-16 rounded-[20px] shadow-[0_10px_24px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
    imageSurface: "rounded-[20px]",
    lucide: "h-6 w-6 sm:h-7 sm:w-7",
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
    surface: "h-9 w-9",
    lucideSurface:
      "h-8 w-8 rounded-[10px] shadow-[0_5px_13px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
    imageSurface: "rounded-[11px]",
    lucide: "h-[18px] w-[18px]",
    image: "h-full w-full object-contain",
    pixels: 40,
  },
  roster: {
    surface: "h-10 w-10",
    lucideSurface: "h-10 w-10 rounded-[12px]",
    imageSurface: "rounded-[12px]",
    lucide: "h-[20px] w-[20px]",
    image: "h-full w-full object-contain",
    pixels: 40,
  },
  // Larger rounded-square tile for the dashboard grid card (reference design).
  "roster-lg": {
    surface: "h-[68px] w-[68px]",
    lucideSurface: "h-[68px] w-[68px] rounded-[18px]",
    imageSurface: "rounded-[18px]",
    lucide: "h-7 w-7",
    image: "h-full w-full object-contain",
    pixels: 72,
  },
} as const;

const PROFILE_ICON_RADIUS_CLASS: Record<AgentSectionIconSize, string> = {
  card: "rounded-[16px]",
  launcher: "rounded-[17px] sm:rounded-[20px]",
  topbar: "rounded-[10px]",
  menu: "rounded-[11px]",
  roster: "rounded-[12px]",
  "roster-lg": "rounded-[18px]",
};

type AgentSectionIconSize = keyof typeof ICON_SIZE_CLASS;

function resolveProfileIconStyle(
  tone: OneCapabilityTone | null | undefined,
  paletteIndex: number | undefined,
): CSSProperties | undefined {
  if (paletteIndex !== undefined && Number.isInteger(paletteIndex)) {
    return AGENT_PROFILE_LAUNCHER_PALETTE[
      ((paletteIndex % AGENT_PROFILE_LAUNCHER_PALETTE.length) +
        AGENT_PROFILE_LAUNCHER_PALETTE.length) %
        AGENT_PROFILE_LAUNCHER_PALETTE.length
    ];
  }
  return tone ? AGENT_THEME_BY_TONE[tone]?.profileIconStyle : undefined;
}

export function AgentSectionIcon({
  id,
  icon,
  tone,
  paletteIndex,
  size = "launcher",
  treatment = "default",
  glyphContrast = "default",
  className,
  isActive,
}: {
  id: string;
  icon: OneCapabilityIcon;
  tone?: OneCapabilityTone | null;
  /** Stable launcher-order color slot; repeats after the canonical palette. */
  paletteIndex?: number;
  size?: AgentSectionIconSize;
  /** Profile-style rows need one full-bleed icon well, not an inset glass chip. */
  treatment?: "default" | "profile";
  /** Use only when a route intentionally reverses the Profile glyph ink. */
  glyphContrast?: "default" | "inverted";
  className?: string;
  isActive?: boolean;
}) {
  const classes = ICON_SIZE_CLASS[size];

  const toneClassName = tone
    ? ONE_CAPABILITY_ICON_CLASS_BY_TONE[tone]
    : AGENT_ICON_SURFACE_FALLBACK_CLASSNAME;
  const toneStyle =
    icon.kind === "lucide" && tone
      ? AGENT_THEME_BY_TONE[tone]?.iconStyle
      : undefined;
  const Icon = icon.kind === "lucide" ? icon.icon : null;

  if (treatment === "profile" && Icon) {
    const active = isActive !== false;
    const profileToneStyle = resolveProfileIconStyle(tone, paletteIndex);

    return (
      <span
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center overflow-hidden",
          classes.surface,
          PROFILE_ICON_RADIUS_CLASS[size],
          active
            ? "bg-[var(--agent-icon-profile-bg)] text-[var(--agent-icon-profile-fg)] dark:bg-[var(--agent-icon-profile-bg-dark)] dark:text-[var(--agent-icon-profile-fg-dark)]"
            : AGENT_ICON_SURFACE_FALLBACK_CLASSNAME,
          className,
        )}
        style={active ? profileToneStyle : undefined}
        data-testid={`one-agent-icon-${id}`}
        data-agent-icon-palette-index={
          Number.isInteger(paletteIndex) ? paletteIndex : undefined
        }
        data-agent-icon-kind="lucide"
        aria-hidden
      >
        <Icon
          className={cn(
            classes.lucide,
            size === "roster" ? "[stroke-width:1.7]" : "[stroke-width:1.8]",
            active
              ? glyphContrast === "inverted"
                ? "!text-white dark:!text-[#1d1d1f]"
                : "text-current"
              : "text-muted-foreground/60 dark:text-muted-foreground/50",
          )}
        />
      </span>
    );
  }

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
            tone ? "!text-white" : "text-current",
          )}
          aria-hidden
        />
      ) : null}
    </span>
  );
}
