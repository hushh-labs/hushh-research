import type { CSSProperties } from "react";

import type { OneCapabilityTone } from "@/lib/onboarding/one-capabilities";

export type AgentProfileIconStyle = CSSProperties &
  Record<`--agent-icon-profile-${string}`, string>;

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
    accent: "#ffffff",
    softTint: "#dfd4ff",
    onAccent: "#1d1d1f",
    iconBackground: "#ffffff",
    iconForeground: "#1d1d1f",
    iconBackgroundDark: "#514a68",
    iconForegroundDark: "#dfd4ff",
    iconClassName: "bg-white text-[#1d1d1f]",
    iconStyle: { backgroundColor: "#ffffff" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#dfd4ff",
      "--agent-icon-profile-fg": "#37304d",
      "--agent-icon-profile-bg-dark": "#514a68",
      "--agent-icon-profile-fg-dark": "#dfd4ff",
    },
  },
  email: {
    accent: "#FF9500",
    softTint: "#FFE6BF",
    onAccent: "#ffffff",
    iconBackground: "#FF9500",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#FF9500",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#FF9500] text-white",
    iconStyle: { backgroundColor: "#FF9500" },
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
    iconStyle: { backgroundColor: "var(--app-accent)" },
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
    iconBackground: "#30B0C7",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#30B0C7",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#30B0C7] text-white",
    iconStyle: { backgroundColor: "#30B0C7" },
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
    iconBackground: "#32ADE6",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#32ADE6",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#32ADE6] text-white",
    iconStyle: { backgroundColor: "#32ADE6" },
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
