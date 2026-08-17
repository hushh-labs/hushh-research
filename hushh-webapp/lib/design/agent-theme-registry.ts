import type { CSSProperties } from "react";

import type { OneCapabilityTone } from "@/lib/onboarding/one-capabilities";

export type AgentProfileIconStyle = CSSProperties &
  Record<`--agent-icon-profile-${string}`, string>;

/*
 * SATURATED CHIP CONTRAST
 *
 * `iconBackground` is the solid fill behind a WHITE glyph, so its own
 * luminance is the glyph's contrast. Four of the Apple system colours are
 * too light to carry white at the 3:1 floor WCAG 2.2 SC 1.4.11 sets for a
 * graphical object, and shipping them that way is what made the agent
 * dashboard read as dull:
 *
 *   orange  #FF9500 -> 2.20:1     cyan  #5AC8FA -> 1.90:1
 *   teal    #30B0C7 -> 2.57:1     blue  #32ADE6 -> 2.54:1
 *
 * Each is deepened along its own hue until white clears 3:1 AND the chip
 * still separates from the dark card (#1C1C1E) by 3:1 — one palette that
 * holds in both themes rather than two that drift apart:
 *
 *   #C96A00 -> 3.79 light / 4.49 dark      #0E86B5 -> 4.12 / 4.13
 *   #0E8296 -> 4.51 / 3.77                 #0D7EB4 -> 4.51 / 3.78
 *
 * Purple (#AF52DE, 4.13), indigo (#5856D6, 5.65) and pink (#FF2D55, 3.65)
 * already cleared it and are untouched. `accent`, `softTint` and
 * `profileIconStyle` are untouched too — this is only the solid chip.
 */

export interface AgentTheme {
  accent: string;
  softTint: string;
  onAccent: string;
  iconBackground: string;
  iconForeground: string;
  iconBackgroundDark: string;
  iconForegroundDark: string;
  iconClassName: string;
  iconStyle: CSSProperties;
  profileIconStyle: AgentProfileIconStyle;
}

export const AGENT_THEME_BY_TONE: Record<OneCapabilityTone, AgentTheme> = {
  finance: {
    accent: "#AF52DE",
    softTint: "#F4D9FF",
    onAccent: "#ffffff",
    iconBackground: "#AF52DE",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#AF52DE",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#AF52DE] text-white",
    iconStyle: { backgroundColor: "#AF52DE" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#F4D9FF",
      "--agent-icon-profile-fg": "#7A1FA2",
      "--agent-icon-profile-bg-dark": "#4A255E",
      "--agent-icon-profile-fg-dark": "#F4D9FF",
    },
  },
  ria: {
    accent: "#5856D6",
    softTint: "#E7E5FF",
    onAccent: "#ffffff",
    iconBackground: "#5856D6",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#5856D6",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#5856D6] text-white",
    iconStyle: { backgroundColor: "#5856D6" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#E7E5FF",
      "--agent-icon-profile-fg": "#3F3BAE",
      "--agent-icon-profile-bg-dark": "#302F72",
      "--agent-icon-profile-fg-dark": "#E7E5FF",
    },
  },
  gmail: {
    accent: "#FF9500",
    softTint: "#FFE6BF",
    onAccent: "#ffffff",
    iconBackground: "#C96A00",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#C96A00",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#C96A00] text-white",
    iconStyle: { backgroundColor: "#C96A00" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#FFE6BF",
      "--agent-icon-profile-fg": "#9A5A00",
      "--agent-icon-profile-bg-dark": "#5C390C",
      "--agent-icon-profile-fg-dark": "#FFE6BF",
    },
  },
  calendar: {
    accent: "#5AC8FA",
    softTint: "#D8F4FF",
    onAccent: "#ffffff",
    iconBackground: "#0E86B5",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#0E86B5",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#0E86B5] text-white",
    iconStyle: { backgroundColor: "#0E86B5" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#D8F4FF",
      "--agent-icon-profile-fg": "#126C8C",
      "--agent-icon-profile-bg-dark": "#1D5268",
      "--agent-icon-profile-fg-dark": "#D8F4FF",
    },
  },
  email: {
    accent: "#FF9500",
    softTint: "#FFE6BF",
    onAccent: "#ffffff",
    iconBackground: "#C96A00",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#C96A00",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#C96A00] text-white",
    iconStyle: { backgroundColor: "#C96A00" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#FFE6BF",
      "--agent-icon-profile-fg": "#9A5A00",
      "--agent-icon-profile-bg-dark": "#5C390C",
      "--agent-icon-profile-fg-dark": "#FFE6BF",
    },
  },
  location: {
    accent: "var(--app-accent)",
    softTint: "color-mix(in oklab, var(--app-accent) 16%, white)",
    onAccent: "#ffffff",
    iconBackground: "var(--app-accent)",
    iconForeground: "#ffffff",
    iconBackgroundDark: "var(--app-accent)",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[color:var(--app-accent)] text-white",
    // The only tone whose fill follows the accent preference, so it is also
    // the only one whose glyph cannot be a fixed white: under Molten Gold
    // white measures 2.23:1 on the accent while that palette's own on-accent
    // token measures 7.56:1. `--agent-icon-glyph` is read by AgentSectionIcon.
    iconStyle: {
      backgroundColor: "var(--app-accent)",
      "--agent-icon-glyph": "var(--app-accent-fg)",
    } as CSSProperties,
    profileIconStyle: {
      "--agent-icon-profile-bg": "color-mix(in oklab, var(--app-accent) 16%, white)",
      "--agent-icon-profile-fg": "color-mix(in oklab, var(--app-accent) 72%, black)",
      "--agent-icon-profile-bg-dark": "color-mix(in oklab, var(--app-accent) 34%, black)",
      "--agent-icon-profile-fg-dark": "color-mix(in oklab, var(--app-accent) 22%, white)",
    },
  },
  pkm: {
    accent: "#30B0C7",
    softTint: "#D8F6FA",
    onAccent: "#ffffff",
    iconBackground: "#0E8296",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#0E8296",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#0E8296] text-white",
    iconStyle: { backgroundColor: "#0E8296" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#D8F6FA",
      "--agent-icon-profile-fg": "#087282",
      "--agent-icon-profile-bg-dark": "#1E5962",
      "--agent-icon-profile-fg-dark": "#D8F6FA",
    },
  },
  consent: {
    accent: "#FF2D55",
    softTint: "#FFD7E2",
    onAccent: "#ffffff",
    iconBackground: "#FF2D55",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#FF2D55",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#FF2D55] text-white",
    iconStyle: { backgroundColor: "#FF2D55" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#FFD7E2",
      "--agent-icon-profile-fg": "#B01235",
      "--agent-icon-profile-bg-dark": "#642234",
      "--agent-icon-profile-fg-dark": "#FFD7E2",
    },
  },
  connected: {
    accent: "#32ADE6",
    softTint: "#D8F1FF",
    onAccent: "#ffffff",
    iconBackground: "#0D7EB4",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#0D7EB4",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#0D7EB4] text-white",
    iconStyle: { backgroundColor: "#0D7EB4" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#D8F1FF",
      "--agent-icon-profile-fg": "#15607F",
      "--agent-icon-profile-bg-dark": "#1E526D",
      "--agent-icon-profile-fg-dark": "#D8F1FF",
    },
  },
};

export const ONE_CAPABILITY_ICON_CLASS_BY_TONE: Record<
  OneCapabilityTone,
  string
> = {
  finance: AGENT_THEME_BY_TONE.finance.iconClassName,
  ria: AGENT_THEME_BY_TONE.ria.iconClassName,
  gmail: AGENT_THEME_BY_TONE.gmail.iconClassName,
  calendar: AGENT_THEME_BY_TONE.calendar.iconClassName,
  email: AGENT_THEME_BY_TONE.email.iconClassName,
  location: AGENT_THEME_BY_TONE.location.iconClassName,
  pkm: AGENT_THEME_BY_TONE.pkm.iconClassName,
  consent: AGENT_THEME_BY_TONE.consent.iconClassName,
  connected: AGENT_THEME_BY_TONE.connected.iconClassName,
};

export const AGENT_PROFILE_LAUNCHER_PALETTE: readonly AgentProfileIconStyle[] =
  [
    AGENT_THEME_BY_TONE.finance.profileIconStyle,
    AGENT_THEME_BY_TONE.ria.profileIconStyle,
    AGENT_THEME_BY_TONE.email.profileIconStyle,
    AGENT_THEME_BY_TONE.location.profileIconStyle,
    AGENT_THEME_BY_TONE.pkm.profileIconStyle,
    AGENT_THEME_BY_TONE.consent.profileIconStyle,
    AGENT_THEME_BY_TONE.connected.profileIconStyle,
    {
      "--agent-icon-profile-bg": "#fff0bd",
      "--agent-icon-profile-fg": "#6b5500",
      "--agent-icon-profile-bg-dark": "#745f00",
      "--agent-icon-profile-fg-dark": "#fff0bd",
    },
    {
      "--agent-icon-profile-bg": "#e5e5ea",
      "--agent-icon-profile-fg": "#3a3a3c",
      "--agent-icon-profile-bg-dark": "#48484a",
      "--agent-icon-profile-fg-dark": "#f2f2f7",
    },
  ] as const;
