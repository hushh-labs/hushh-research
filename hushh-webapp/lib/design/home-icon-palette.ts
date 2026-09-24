import type { AgentProfileIconStyle } from "./agent-theme-registry";

/** The home launcher palette, shared by home icons and Connect circle ideas. */
export const DASHBOARD_AGENT_ICON_STYLE_BY_ID = {
  finance: {
    "--agent-icon-profile-bg": "#D1FAE5",
    "--agent-icon-profile-fg": "#065F46",
    "--agent-icon-profile-bg-dark": "#064E3B",
    "--agent-icon-profile-fg-dark": "#6EE7B7",
  },
  wallet: {
    "--agent-icon-profile-bg": "#FEF3C7",
    "--agent-icon-profile-fg": "#92400E",
    "--agent-icon-profile-bg-dark": "#78350F",
    "--agent-icon-profile-fg-dark": "#FDE68A",
  },
  location: {
    "--agent-icon-profile-bg": "#E0F2FE",
    "--agent-icon-profile-fg": "#075985",
    "--agent-icon-profile-bg-dark": "#0C4A6E",
    "--agent-icon-profile-fg-dark": "#7DD3FC",
  },
  ria: {
    "--agent-icon-profile-bg": "#EDE9FE",
    "--agent-icon-profile-fg": "#4C1D95",
    "--agent-icon-profile-bg-dark": "#3B0764",
    "--agent-icon-profile-fg-dark": "#C4B5FD",
  },
  gmail: {
    "--agent-icon-profile-bg": "#FFE4E6",
    "--agent-icon-profile-fg": "#9F1239",
    "--agent-icon-profile-bg-dark": "#881337",
    "--agent-icon-profile-fg-dark": "#FDA4AF",
  },
  calendar: {
    "--agent-icon-profile-bg": "#E0F7FA",
    "--agent-icon-profile-fg": "#0E7490",
    "--agent-icon-profile-bg-dark": "#155E75",
    "--agent-icon-profile-fg-dark": "#67E8F9",
  },
  email: {
    "--agent-icon-profile-bg": "#FCE7F3",
    "--agent-icon-profile-fg": "#831843",
    "--agent-icon-profile-bg-dark": "#701A75",
    "--agent-icon-profile-fg-dark": "#F472B6",
  },
  pkm: {
    "--agent-icon-profile-bg": "#F1F5F9",
    "--agent-icon-profile-fg": "#0F172A",
    "--agent-icon-profile-bg-dark": "#1E293B",
    "--agent-icon-profile-fg-dark": "#F8FAFC",
  },
  consent: {
    "--agent-icon-profile-bg": "#FFEDD5",
    "--agent-icon-profile-fg": "#9A3412",
    "--agent-icon-profile-bg-dark": "#7C2D12",
    "--agent-icon-profile-fg-dark": "#FDBA74",
  },
  marketplace: {
    "--agent-icon-profile-bg": "#DCFCE7",
    "--agent-icon-profile-fg": "#14532D",
    "--agent-icon-profile-bg-dark": "#064E3B",
    "--agent-icon-profile-fg-dark": "#86EFAC",
  },
  "connected-systems": {
    "--agent-icon-profile-bg": "#CFFAFE",
    "--agent-icon-profile-fg": "#115E59",
    "--agent-icon-profile-bg-dark": "#134E4A",
    "--agent-icon-profile-fg-dark": "#5EEAD4",
  },
} satisfies Record<string, AgentProfileIconStyle>;

export const DEFAULT_DASHBOARD_AGENT_ICON_STYLE: AgentProfileIconStyle = {
  "--agent-icon-profile-bg": "transparent",
  "--agent-icon-profile-fg": "#00E5FF",
  "--agent-icon-profile-bg-dark": "transparent",
  "--agent-icon-profile-fg-dark": "#00E5FF",
};
