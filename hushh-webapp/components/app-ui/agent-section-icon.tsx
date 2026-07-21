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
type ProfileIconStyle = CSSProperties & Record<`--${string}`, string>;

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

// Profile's settings wells are opaque, full-bleed squircles with a quiet tint
// and high-contrast outline glyph. One's home roster uses this same treatment
// so its launcher icons do not regress into inset glass chips.
const PROFILE_CAPABILITY_ICON_STYLE_BY_TONE: Partial<
  Record<OneCapabilityTone, CSSProperties>
> = {
  finance: {
    "--agent-icon-profile-bg": "#b9ecff",
    "--agent-icon-profile-fg": "#153d52",
    "--agent-icon-profile-bg-dark": "#334f62",
    "--agent-icon-profile-fg-dark": "#b9ecff",
  } as CSSProperties,
  ria: {
    "--agent-icon-profile-bg": "#dfd4ff",
    "--agent-icon-profile-fg": "#37304d",
    "--agent-icon-profile-bg-dark": "#514a68",
    "--agent-icon-profile-fg-dark": "#dfd4ff",
  } as CSSProperties,
  gmail: {
    "--agent-icon-profile-bg": "#dfd4ff",
    "--agent-icon-profile-fg": "#37304d",
    "--agent-icon-profile-bg-dark": "#514a68",
    "--agent-icon-profile-fg-dark": "#dfd4ff",
  } as CSSProperties,
  email: {
    "--agent-icon-profile-bg": "#c0f5dd",
    "--agent-icon-profile-fg": "#164536",
    "--agent-icon-profile-bg-dark": "#28594a",
    "--agent-icon-profile-fg-dark": "#c0f5dd",
  } as CSSProperties,
  location: {
    "--agent-icon-profile-bg": "#c0f5dd",
    "--agent-icon-profile-fg": "#164536",
    "--agent-icon-profile-bg-dark": "#28594a",
    "--agent-icon-profile-fg-dark": "#c0f5dd",
  } as CSSProperties,
  pkm: {
    "--agent-icon-profile-bg": "#dfd4ff",
    "--agent-icon-profile-fg": "#37304d",
    "--agent-icon-profile-bg-dark": "#514a68",
    "--agent-icon-profile-fg-dark": "#dfd4ff",
  } as CSSProperties,
  consent: {
    "--agent-icon-profile-bg": "#ffe0b8",
    "--agent-icon-profile-fg": "#4d2f1a",
    "--agent-icon-profile-bg-dark": "#694a31",
    "--agent-icon-profile-fg-dark": "#ffe0b8",
  } as CSSProperties,
  connected: {
    "--agent-icon-profile-bg": "#c5e6f2",
    "--agent-icon-profile-fg": "#284451",
    "--agent-icon-profile-bg-dark": "#3d5360",
    "--agent-icon-profile-fg-dark": "#c5e6f2",
  } as CSSProperties,
};

// One's roster is a launcher, not a status legend. Give its first nine cells
// a stable visual identity, then repeat that exact sequence as specialists are
// added. The roster passes its authored order, so filtering does not reshuffle
// an agent's icon color.
const PROFILE_LAUNCHER_PALETTE: readonly ProfileIconStyle[] = [
  {
    "--agent-icon-profile-bg": "#b9ecff",
    "--agent-icon-profile-fg": "#153d52",
    "--agent-icon-profile-bg-dark": "#334f62",
    "--agent-icon-profile-fg-dark": "#b9ecff",
  },
  {
    "--agent-icon-profile-bg": "#dfd4ff",
    "--agent-icon-profile-fg": "#37304d",
    "--agent-icon-profile-bg-dark": "#514a68",
    "--agent-icon-profile-fg-dark": "#dfd4ff",
  },
  {
    "--agent-icon-profile-bg": "#c0f5dd",
    "--agent-icon-profile-fg": "#164536",
    "--agent-icon-profile-bg-dark": "#28594a",
    "--agent-icon-profile-fg-dark": "#c0f5dd",
  },
  {
    "--agent-icon-profile-bg": "#ffe0b8",
    "--agent-icon-profile-fg": "#4d2f1a",
    "--agent-icon-profile-bg-dark": "#694a31",
    "--agent-icon-profile-fg-dark": "#ffe0b8",
  },
  {
    "--agent-icon-profile-bg": "#d7dfff",
    "--agent-icon-profile-fg": "#303a62",
    "--agent-icon-profile-bg-dark": "#46547c",
    "--agent-icon-profile-fg-dark": "#dce4ff",
  },
  {
    "--agent-icon-profile-bg": "#ffe0e8",
    "--agent-icon-profile-fg": "#642b42",
    "--agent-icon-profile-bg-dark": "#6c3c50",
    "--agent-icon-profile-fg-dark": "#ffe0e8",
  },
  {
    "--agent-icon-profile-bg": "#bdeee9",
    "--agent-icon-profile-fg": "#194a47",
    "--agent-icon-profile-bg-dark": "#2d5a58",
    "--agent-icon-profile-fg-dark": "#c4f2ed",
  },
  {
    "--agent-icon-profile-bg": "#f8edaf",
    "--agent-icon-profile-fg": "#504919",
    "--agent-icon-profile-bg-dark": "#5b5328",
    "--agent-icon-profile-fg-dark": "#fbf1bf",
  },
  {
    "--agent-icon-profile-bg": "#d7e7ee",
    "--agent-icon-profile-fg": "#294650",
    "--agent-icon-profile-bg-dark": "#405963",
    "--agent-icon-profile-fg-dark": "#e0eff6",
  },
] as const;

function resolveProfileIconStyle(
  tone: OneCapabilityTone | null | undefined,
  paletteIndex: number | undefined,
): CSSProperties | undefined {
  if (paletteIndex !== undefined && Number.isInteger(paletteIndex)) {
    return PROFILE_LAUNCHER_PALETTE[
      ((paletteIndex % PROFILE_LAUNCHER_PALETTE.length) +
        PROFILE_LAUNCHER_PALETTE.length) %
        PROFILE_LAUNCHER_PALETTE.length
    ];
  }
  return tone ? PROFILE_CAPABILITY_ICON_STYLE_BY_TONE[tone] : undefined;
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
      ? CAPABILITY_ICON_STYLE_BY_TONE[tone]
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
          "rounded-[20px]",
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
            "drop-shadow-[0_1px_2px_rgba(0,0,0,0.16)]",
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
            tone ? "!text-[#1d1d1f] dark:!text-white" : "text-current",
          )}
          aria-hidden
        />
      ) : null}
    </span>
  );
}
