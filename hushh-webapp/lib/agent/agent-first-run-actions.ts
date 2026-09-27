/**
 * First-run action surface for the One chat, shown once right after setup.
 *
 * Every entry launches a flow that already exists; nothing here performs a
 * connection itself:
 * - `connector` opens the existing connectors drawer (or, for Calendar, the
 *   Calendar route) through the workspace's `openConnectorSurface`, the same
 *   path a chat turn's "Connect" affordance uses;
 * - `route` navigates to an existing setup or import route.
 *
 * `connected` is tri-state on purpose: `true` / `false` only when the live
 * status was actually read, `null` when this surface does not read it (the
 * destination shows the real status). Never render `null` as "Not connected".
 */
import { ROUTES } from "@/lib/navigation/routes";

export type FirstRunConnectorLogo = "gmail" | "drive" | "calendar" | "plaid";

export type FirstRunLaunch =
  | { kind: "connector"; provider: "gmail" | "drive" | "calendar" | null }
  | { kind: "route"; href: string };

export type FirstRunConnectorAction = {
  id: "gmail" | "google_drive" | "calendar" | "plaid" | "statement_import" | "custom_mcp";
  label: string;
  logo: FirstRunConnectorLogo | null;
  launch: FirstRunLaunch;
  connected: boolean | null;
};

export type FirstRunAgentAction = {
  /** Capability id in `ONE_CAPABILITIES`; its authored icon and tone are reused. */
  capabilityId: "finance" | "location" | "pkm";
  label: string;
  launch: FirstRunLaunch;
  ready: boolean | null;
};

export type FirstRunConnectionState = {
  gmail?: boolean | null;
  googleDrive?: boolean | null;
  calendar?: boolean | null;
};

function known(value: boolean | null | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function buildFirstRunConnectorActions(
  state: FirstRunConnectionState,
): FirstRunConnectorAction[] {
  return [
    {
      id: "gmail",
      label: "Gmail",
      logo: "gmail",
      launch: { kind: "connector", provider: "gmail" },
      connected: known(state.gmail),
    },
    {
      id: "google_drive",
      label: "Google Drive",
      logo: "drive",
      launch: { kind: "connector", provider: "drive" },
      connected: known(state.googleDrive),
    },
    {
      id: "calendar",
      label: "Google Calendar",
      logo: "calendar",
      launch: { kind: "connector", provider: "calendar" },
      connected: known(state.calendar),
    },
    {
      // Plaid Link lives on the portfolio sources page; the connectors
      // drawer's own "Connect a bank" goes to the same route.
      id: "plaid",
      label: "Bank accounts",
      logo: "plaid",
      launch: { kind: "route", href: ROUTES.KAI_PORTFOLIO_SOURCES },
      connected: null,
    },
    {
      id: "statement_import",
      label: "Import a statement",
      logo: null,
      launch: { kind: "route", href: ROUTES.KAI_IMPORT },
      connected: null,
    },
    {
      // The connectors catalog hosts custom MCP connectors below the list.
      id: "custom_mcp",
      label: "Custom MCP tool",
      logo: null,
      launch: { kind: "connector", provider: null },
      connected: null,
    },
  ];
}

export function buildFirstRunAgentActions(input: {
  hasPortfolioData: boolean;
  /** True only when the unlocked memory summary reported saved details. */
  memoryHasItems: boolean;
}): FirstRunAgentAction[] {
  return [
    {
      capabilityId: "finance",
      label: "Finance",
      launch: { kind: "route", href: ROUTES.ONE_SETUP_FINANCE },
      // Holdings exist only after Finance setup imported or linked a source.
      ready: input.hasPortfolioData ? true : null,
    },
    {
      capabilityId: "location",
      label: "Location",
      launch: { kind: "route", href: ROUTES.ONE_SETUP_LOCATION },
      ready: null,
    },
    {
      capabilityId: "pkm",
      label: "Memory",
      launch: { kind: "route", href: ROUTES.PKM },
      ready: input.memoryHasItems ? true : null,
    },
  ];
}
