import type { CSSProperties } from "react";
import type { LucideIcon } from "lucide-react";

import {
  ONE_CAPABILITY_ICON_CLASS_BY_TONE,
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
  launcher: {
    surface:
      "h-16 w-16 rounded-[20px] shadow-[0_10px_24px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
    lucide: "h-7 w-7",
    gmail: "h-8 w-8",
  },
  topbar: {
    surface:
      "h-8 w-8 rounded-[10px] shadow-[0_5px_13px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
    lucide: "h-4 w-4",
    gmail: "h-5 w-5",
  },
  menu: {
    surface:
      "h-8 w-8 rounded-[10px] shadow-[0_5px_13px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
    lucide: "h-4 w-4",
    gmail: "h-5 w-5",
  },
} as const;

type AgentSectionIconSize = keyof typeof ICON_SIZE_CLASS;

// One color guidelines - soft premium palette. This inline style is what
// actually paints the dashboard/launcher tiles (it overrides the class), so it
// is the source of truth for the Agents grid colors.
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

function GmailBrandIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 256 193"
      className={className}
      aria-hidden
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M58.182 192.05V93.14L27.507 65.077 0 49.504v125.091c0 9.658 7.826 17.455 17.455 17.455h40.727z"
      />
      <path
        fill="#34A853"
        d="M197.818 192.05h40.727c9.659 0 17.455-7.826 17.455-17.455V49.505l-31.156 17.837-27.026 25.798v98.91z"
      />
      <path
        fill="#EA4335"
        d="m58.182 93.14-4.174-38.647 4.174-36.989L128 69.868l69.818-52.364 4.669 34.992-4.669 40.644L128 145.504 58.182 93.14z"
      />
      <path
        fill="#FBBC04"
        d="M197.818 17.504V93.14L256 49.505V26.231c0-21.585-24.64-33.89-41.89-20.945l-16.292 12.218z"
      />
      <path
        fill="#C5221F"
        d="m0 49.505 26.759 20.065 31.423 23.57V17.504L41.89 5.286C24.61-7.66 0 4.646 0 26.231v23.274z"
      />
    </svg>
  );
}

export function AgentSectionIcon({
  id,
  icon: Icon,
  tone,
  size = "launcher",
  className,
}: {
  id: string;
  icon: LucideIcon;
  tone?: OneCapabilityTone | null;
  size?: AgentSectionIconSize;
  className?: string;
}) {
  const classes = ICON_SIZE_CLASS[size];
  const toneClassName = tone
    ? ONE_CAPABILITY_ICON_CLASS_BY_TONE[tone]
    : AGENT_ICON_SURFACE_FALLBACK_CLASSNAME;
  const toneStyle = tone ? CAPABILITY_ICON_STYLE_BY_TONE[tone] : undefined;

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center",
        classes.surface,
        toneClassName,
        className,
      )}
      style={toneStyle}
      aria-hidden
    >
      {id === "gmail" ? (
        <GmailBrandIcon className={classes.gmail} />
      ) : (
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
      )}
    </span>
  );
}
