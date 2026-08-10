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
    softTint: "#efd9fb",
    onAccent: "#ffffff",
    iconBackground: "#AF52DE",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#5d2f77",
    iconForegroundDark: "#f3dcff",
    iconClassName: "bg-[#AF52DE] text-white",
    iconStyle: { backgroundColor: "#AF52DE" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#efd9fb",
      "--agent-icon-profile-fg": "#56206f",
      "--agent-icon-profile-bg-dark": "#5d2f77",
      "--agent-icon-profile-fg-dark": "#f3dcff",
    },
  },
  ria: {
    accent: "#5856D6",
    softTint: "#e2e1ff",
    onAccent: "#ffffff",
    iconBackground: "#5856D6",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#37358a",
    iconForegroundDark: "#e2e1ff",
    iconClassName: "bg-[#5856D6] text-white",
    iconStyle: { backgroundColor: "#5856D6" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#e2e1ff",
      "--agent-icon-profile-fg": "#28268a",
      "--agent-icon-profile-bg-dark": "#37358a",
      "--agent-icon-profile-fg-dark": "#e2e1ff",
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
    accent: "#00C7BE",
    softTint: "#d7f8f5",
    onAccent: "#ffffff",
    iconBackground: "#00C7BE",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#1f6d68",
    iconForegroundDark: "#d7f8f5",
    iconClassName: "bg-[#00C7BE] text-white",
    iconStyle: { backgroundColor: "#00C7BE" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#d7f8f5",
      "--agent-icon-profile-fg": "#045d58",
      "--agent-icon-profile-bg-dark": "#1f6d68",
      "--agent-icon-profile-fg-dark": "#d7f8f5",
    },
  },
  location: {
    accent: "#FF9500",
    softTint: "#ffe4bd",
    onAccent: "#ffffff",
    iconBackground: "#FF9500",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#7a4700",
    iconForegroundDark: "#ffe4bd",
    iconClassName: "bg-[#FF9500] text-white",
    iconStyle: { backgroundColor: "#FF9500" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#ffe4bd",
      "--agent-icon-profile-fg": "#6b3a00",
      "--agent-icon-profile-bg-dark": "#7a4700",
      "--agent-icon-profile-fg-dark": "#ffe4bd",
    },
  },
  pkm: {
    accent: "#5856D6",
    softTint: "#e1e5ff",
    onAccent: "#ffffff",
    iconBackground: "#5856D6",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#38418b",
    iconForegroundDark: "#e1e5ff",
    iconClassName: "bg-[#5856D6] text-white",
    iconStyle: { backgroundColor: "#5856D6" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#e1e5ff",
      "--agent-icon-profile-fg": "#29327e",
      "--agent-icon-profile-bg-dark": "#38418b",
      "--agent-icon-profile-fg-dark": "#e1e5ff",
    },
  },
  consent: {
    accent: "#FF2D55",
    softTint: "#ffe0e8",
    onAccent: "#ffffff",
    iconBackground: "#FF2D55",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#7b243b",
    iconForegroundDark: "#ffe0e8",
    iconClassName: "bg-[#FF2D55] text-white",
    iconStyle: { backgroundColor: "#FF2D55" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#ffe0e8",
      "--agent-icon-profile-fg": "#78172d",
      "--agent-icon-profile-bg-dark": "#7b243b",
      "--agent-icon-profile-fg-dark": "#ffe0e8",
    },
  },
  connected: {
    accent: "#32ADE6",
    softTint: "#d8f1ff",
    onAccent: "#ffffff",
    iconBackground: "#32ADE6",
    iconForeground: "#ffffff",
    iconBackgroundDark: "#1d5d7d",
    iconForegroundDark: "#d8f1ff",
    iconClassName: "bg-[#32ADE6] text-white",
    iconStyle: { backgroundColor: "#32ADE6" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#d8f1ff",
      "--agent-icon-profile-fg": "#15506e",
      "--agent-icon-profile-bg-dark": "#1d5d7d",
      "--agent-icon-profile-fg-dark": "#d8f1ff",
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
    AGENT_THEME_BY_TONE.location.profileIconStyle,
    AGENT_THEME_BY_TONE.consent.profileIconStyle,
    {
      "--agent-icon-profile-bg": "#d7f8f5",
      "--agent-icon-profile-fg": "#045d58",
      "--agent-icon-profile-bg-dark": "#1f6d68",
      "--agent-icon-profile-fg-dark": "#d7f8f5",
    },
    {
      "--agent-icon-profile-bg": "#ffd7e2",
      "--agent-icon-profile-fg": "#78172d",
      "--agent-icon-profile-bg-dark": "#7b243b",
      "--agent-icon-profile-fg-dark": "#ffd7e2",
    },
    {
      "--agent-icon-profile-bg": "#d8f1ff",
      "--agent-icon-profile-fg": "#15506e",
      "--agent-icon-profile-bg-dark": "#1d5d7d",
      "--agent-icon-profile-fg-dark": "#d8f1ff",
    },
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
