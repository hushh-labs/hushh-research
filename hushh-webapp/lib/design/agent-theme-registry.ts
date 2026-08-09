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
    accent: "#B85CF6",
    softTint: "#dfd4ff",
    onAccent: "#1d1d1f",
    iconBackground: "#B85CF6",
    iconForeground: "#1d1d1f",
    iconBackgroundDark: "#334f62",
    iconForegroundDark: "#b9ecff",
    iconClassName: "bg-[#B85CF6] text-[#1d1d1f] dark:text-white",
    iconStyle: { backgroundColor: "#B85CF6" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#b9ecff",
      "--agent-icon-profile-fg": "#153d52",
      "--agent-icon-profile-bg-dark": "#334f62",
      "--agent-icon-profile-fg-dark": "#b9ecff",
    },
  },
  ria: {
    accent: "#60A5FA",
    softTint: "#dfd4ff",
    onAccent: "#1d1d1f",
    iconBackground: "#60A5FA",
    iconForeground: "#1d1d1f",
    iconBackgroundDark: "#514a68",
    iconForegroundDark: "#dfd4ff",
    iconClassName: "bg-[#60A5FA] text-[#1d1d1f] dark:text-white",
    iconStyle: { backgroundColor: "#60A5FA" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#dfd4ff",
      "--agent-icon-profile-fg": "#37304d",
      "--agent-icon-profile-bg-dark": "#514a68",
      "--agent-icon-profile-fg-dark": "#dfd4ff",
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
    accent: "#14B8A6",
    softTint: "#c0f5dd",
    onAccent: "#1d1d1f",
    iconBackground: "#14B8A6",
    iconForeground: "#1d1d1f",
    iconBackgroundDark: "#28594a",
    iconForegroundDark: "#c0f5dd",
    iconClassName: "bg-[#14B8A6] text-[#1d1d1f] dark:text-white",
    iconStyle: { backgroundColor: "#14B8A6" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#c0f5dd",
      "--agent-icon-profile-fg": "#164536",
      "--agent-icon-profile-bg-dark": "#28594a",
      "--agent-icon-profile-fg-dark": "#c0f5dd",
    },
  },
  location: {
    accent: "#A7D7A1",
    softTint: "#c0f5dd",
    onAccent: "#1d1d1f",
    iconBackground: "#A7D7A1",
    iconForeground: "#1d1d1f",
    iconBackgroundDark: "#28594a",
    iconForegroundDark: "#c0f5dd",
    iconClassName: "bg-[#A7D7A1] text-[#1d1d1f] dark:text-white",
    iconStyle: { backgroundColor: "#A7D7A1" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#c0f5dd",
      "--agent-icon-profile-fg": "#164536",
      "--agent-icon-profile-bg-dark": "#28594a",
      "--agent-icon-profile-fg-dark": "#c0f5dd",
    },
  },
  pkm: {
    accent: "#B85CF6",
    softTint: "#dfd4ff",
    onAccent: "#1d1d1f",
    iconBackground: "#B85CF6",
    iconForeground: "#1d1d1f",
    iconBackgroundDark: "#514a68",
    iconForegroundDark: "#dfd4ff",
    iconClassName: "bg-[#B85CF6] text-[#1d1d1f] dark:text-white",
    iconStyle: { backgroundColor: "#B85CF6" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#dfd4ff",
      "--agent-icon-profile-fg": "#37304d",
      "--agent-icon-profile-bg-dark": "#514a68",
      "--agent-icon-profile-fg-dark": "#dfd4ff",
    },
  },
  consent: {
    accent: "#C8923A",
    softTint: "#ffe0b8",
    onAccent: "#1d1d1f",
    iconBackground: "#C8923A",
    iconForeground: "#1d1d1f",
    iconBackgroundDark: "#694a31",
    iconForegroundDark: "#ffe0b8",
    iconClassName: "bg-[#C8923A] text-[#1d1d1f] dark:text-white",
    iconStyle: { backgroundColor: "#C8923A" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#ffe0b8",
      "--agent-icon-profile-fg": "#4d2f1a",
      "--agent-icon-profile-bg-dark": "#694a31",
      "--agent-icon-profile-fg-dark": "#ffe0b8",
    },
  },
  connected: {
    accent: "#94A3B8",
    softTint: "#c5e6f2",
    onAccent: "#1d1d1f",
    iconBackground: "#94A3B8",
    iconForeground: "#1d1d1f",
    iconBackgroundDark: "#3d5360",
    iconForegroundDark: "#c5e6f2",
    iconClassName: "bg-[#94A3B8] text-[#1d1d1f] dark:text-white",
    iconStyle: { backgroundColor: "#94A3B8" },
    profileIconStyle: {
      "--agent-icon-profile-bg": "#c5e6f2",
      "--agent-icon-profile-fg": "#284451",
      "--agent-icon-profile-bg-dark": "#3d5360",
      "--agent-icon-profile-fg-dark": "#c5e6f2",
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
