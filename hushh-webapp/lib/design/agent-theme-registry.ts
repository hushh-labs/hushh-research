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
    accent: "#34C759",
    softTint: "#DFF7E7",
    onAccent: "#ffffff",
    iconBackground: "#34C759",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#34C759",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#34C759] text-white",
    iconStyle: { backgroundColor: "#34C759" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#DFF7E7",
      "--agent-icon-profile-fg": "#1D7F3A",
      "--agent-icon-profile-bg-dark": "#1E5230",
      "--agent-icon-profile-fg-dark": "#DFF7E7",
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
    accent: "#FF3B30",
    softTint: "#FFE1DF",
    onAccent: "#ffffff",
    iconBackground: "#FF3B30",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#FF3B30",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#FF3B30] text-white",
    iconStyle: { backgroundColor: "#FF3B30" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#FFE1DF",
      "--agent-icon-profile-fg": "#B71912",
      "--agent-icon-profile-bg-dark": "#64211E",
      "--agent-icon-profile-fg-dark": "#FFE1DF",
    },
  },
  calendar: {
    accent: "#5AC8FA",
    softTint: "#D8F4FF",
    onAccent: "#ffffff",
    iconBackground: "#5AC8FA",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#5AC8FA",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#5AC8FA] text-white",
    iconStyle: { backgroundColor: "#5AC8FA" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#D8F4FF",
      "--agent-icon-profile-fg": "#126C8C",
      "--agent-icon-profile-bg-dark": "#1D5268",
      "--agent-icon-profile-fg-dark": "#D8F4FF",
    },
  },
  email: {
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
    accent: "#636366",
    softTint: "#E5E5EA",
    onAccent: "#ffffff",
    iconBackground: "#636366",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#636366",
    iconForegroundDark: "#ffffff",
    iconClassName: "bg-[#636366] text-white",
    iconStyle: { backgroundColor: "#636366" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#E5E5EA",
      "--agent-icon-profile-fg": "#3A3A3C",
      "--agent-icon-profile-bg-dark": "#48484A",
      "--agent-icon-profile-fg-dark": "#F2F2F7",
    },
  },
  consent: {
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
  connected: {
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
    AGENT_THEME_BY_TONE.location.profileIconStyle,
    AGENT_THEME_BY_TONE.ria.profileIconStyle,
    AGENT_THEME_BY_TONE.gmail.profileIconStyle,
    AGENT_THEME_BY_TONE.calendar.profileIconStyle,
    AGENT_THEME_BY_TONE.email.profileIconStyle,
    AGENT_THEME_BY_TONE.pkm.profileIconStyle,
    AGENT_THEME_BY_TONE.consent.profileIconStyle,
    AGENT_THEME_BY_TONE.connected.profileIconStyle,
  ] as const;
