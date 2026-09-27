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
    glyphSurface:
      "rounded-[18px] shadow-[0_8px_20px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
    imageSurface: "rounded-[18px]",
    glyph: "h-9 w-9",
    image: "h-full w-full object-contain",
    pixels: 72,
  },
  launcher: {
    surface: "h-14 w-14 sm:h-16 sm:w-16",
    glyphSurface:
      "h-16 w-16 rounded-[20px] shadow-[0_10px_24px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
    imageSurface: "rounded-[20px]",
    glyph: "h-9 w-9 sm:h-10 sm:w-10",
    image: "h-full w-full object-contain",
    pixels: 80,
  },
  topbar: {
    surface: "h-8 w-8",
    glyphSurface:
      "h-8 w-8 rounded-[10px] shadow-[0_5px_13px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
    imageSurface: "rounded-[10px]",
    glyph: "h-5 w-5",
    image: "h-full w-full object-contain",
    pixels: 40,
  },
  menu: {
    surface: "h-9 w-9",
    glyphSurface:
      "h-8 w-8 rounded-[10px] shadow-[0_5px_13px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
    imageSurface: "rounded-[11px]",
    glyph: "h-[22px] w-[22px]",
    image: "h-full w-full object-contain",
    pixels: 40,
  },
  setup: {
    surface: "h-9 w-9",
    glyphSurface: "h-9 w-9 rounded-[10px]",
    imageSurface: "rounded-[10px]",
    glyph: "h-[22px] w-[22px]",
    image: "h-full w-full object-contain",
    pixels: 40,
  },
  roster: {
    surface: "h-10 w-10",
    glyphSurface: "h-10 w-10 rounded-[12px]",
    imageSurface: "rounded-[12px]",
    glyph: "h-7 w-7",
    image: "h-full w-full object-contain",
    pixels: 40,
  },
  "roster-dashboard": {
    surface: "h-14 w-14",
    glyphSurface: "h-14 w-14 rounded-[16px]",
    imageSurface: "rounded-[16px]",
    glyph: "h-[34px] w-[34px]",
    image: "h-full w-full object-contain",
    pixels: 56,
  },
  // Larger rounded-square tile for the dashboard grid card (reference design).
  "roster-lg": {
    surface: "h-[68px] w-[68px]",
    glyphSurface: "h-[68px] w-[68px] rounded-[18px]",
    imageSurface: "rounded-[18px]",
    glyph: "h-12 w-12 sm:h-[50px] sm:w-[50px]",
    image: "h-full w-full object-contain",
    pixels: 72,
  },
} as const;

const PROFILE_ICON_RADIUS_CLASS: Record<AgentSectionIconSize, string> = {
  card: "rounded-[16px]",
  launcher: "rounded-[17px] sm:rounded-[20px]",
  topbar: "rounded-[10px]",
  menu: "rounded-[11px]",
  setup: "rounded-[10px]",
  roster: "rounded-[12px]",
  "roster-dashboard": "rounded-[16px]",
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
  profileStyle,
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
  profileStyle?: CSSProperties;
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
  const CustomIcon = icon.kind === "custom" ? icon.component : null;

  if (treatment === "profile" && (Icon || CustomIcon)) {
    const active = isActive !== false;
    const profileToneStyle = resolveProfileIconStyle(tone, paletteIndex);

    return (
      <span
        className={cn(
          "relative inline-flex shrink-0 items-center justify-center overflow-hidden",
          classes.surface,
          PROFILE_ICON_RADIUS_CLASS[size],
          active
            ? cn(
                "bg-[var(--agent-icon-profile-bg)] [background-image:var(--agent-icon-profile-bg)] text-[var(--agent-icon-profile-fg)] dark:bg-[var(--agent-icon-profile-bg-dark)] dark:[background-image:var(--agent-icon-profile-bg-dark)] dark:text-[var(--agent-icon-profile-fg-dark)] shadow-[0_6px_20px_-4px_rgba(0,0,0,0.16)] dark:shadow-[0_8px_24px_-4px_rgba(0,0,0,0.6)] ring-1 ring-inset ring-black/[0.08] dark:ring-white/[0.18]",
                CustomIcon &&
                  "!bg-transparent dark:!bg-transparent !bg-none dark:!bg-none !shadow-none !ring-0",
              )
            : CustomIcon
              ? "!bg-transparent dark:!bg-transparent !bg-none dark:!bg-none !shadow-none !ring-0"
              : AGENT_ICON_SURFACE_FALLBACK_CLASSNAME,
          className,
        )}
        style={active ? (profileStyle ?? profileToneStyle) : undefined}
        data-testid={`one-agent-icon-${id}`}
        data-agent-icon-palette-index={
          Number.isInteger(paletteIndex) ? paletteIndex : undefined
        }
        data-agent-icon-kind={icon.kind}
        aria-hidden
      >
        {CustomIcon ? (
          <CustomIcon
            className={cn(
              classes.glyph,
              active
                ? glyphContrast === "inverted"
                  ? "!text-white dark:!text-[#1d1d1f]"
                  : "text-current"
                : "text-muted-foreground/40 dark:text-muted-foreground/30 opacity-40 grayscale",
            )}
            color={active ? undefined : "currentColor"}
          />
        ) : Icon ? (
          <Icon
            weight="regular"
            className={cn(
              classes.glyph,
              size === "roster" || size === "roster-dashboard"
                ? "[stroke-width:1.7]"
                : "[stroke-width:1.8]",
              active
                ? glyphContrast === "inverted"
                  ? "!text-white dark:!text-[#1d1d1f]"
                  : "text-current"
                : "text-muted-foreground/40 dark:text-muted-foreground/30 opacity-40 grayscale",
            )}
          />
        ) : null}
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
          : cn(
              classes.glyphSurface,
              CustomIcon &&
                "!bg-transparent dark:!bg-transparent !bg-none dark:!bg-none !shadow-none !ring-0",
              toneClassName,
            ),
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
      ) : CustomIcon ? (
        <CustomIcon
          className={cn(
            classes.glyph,
            isActive === false &&
              "text-muted-foreground/40 dark:text-muted-foreground/30 opacity-40 grayscale",
          )}
          color={isActive === false ? "currentColor" : undefined}
        />
      ) : Icon ? (
        <Icon
          weight="regular"
          // cmdk applies a muted foreground to bare SVGs. Give this icon an
          // explicit, important theme-aware foreground so a command/menu
          // ancestor cannot override the requested contrast. Branded chips
          // use dark glyphs in light mode and light glyphs in dark mode; the
          // same primitive drives the dashboard grid and the top switcher.
          className={cn(
            classes.glyph,
            isActive === false
              ? "text-muted-foreground/40 dark:text-muted-foreground/30 opacity-40 grayscale"
              : tone
                ? "!text-white"
                : "text-current",
          )}
          aria-hidden
        />
      ) : null}
    </span>
  );
}
