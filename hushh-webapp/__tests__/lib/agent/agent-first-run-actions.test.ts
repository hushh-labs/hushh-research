import { describe, expect, it } from "vitest";

import {
  buildFirstRunAgentActions,
  buildFirstRunConnectorActions,
} from "@/lib/agent/agent-first-run-actions";
import { ROUTES } from "@/lib/navigation/routes";

describe("first-run action surface", () => {
  it("offers every shipped connector through its existing launch path", () => {
    const actions = buildFirstRunConnectorActions({});
    expect(actions.map((action) => [action.id, action.launch])).toEqual([
      ["gmail", { kind: "connector", provider: "gmail" }],
      ["google_drive", { kind: "connector", provider: "drive" }],
      ["calendar", { kind: "connector", provider: "calendar" }],
      ["plaid", { kind: "route", href: ROUTES.KAI_PORTFOLIO_SOURCES }],
      ["statement_import", { kind: "route", href: ROUTES.KAI_IMPORT }],
      ["custom_mcp", { kind: "connector", provider: null }],
    ]);
  });

  it("marks a connector connected only from a status that was actually read", () => {
    const unknown = buildFirstRunConnectorActions({});
    expect(unknown.every((action) => action.connected === null)).toBe(true);

    const read = buildFirstRunConnectorActions({ gmail: true, googleDrive: false, calendar: null });
    const byId = Object.fromEntries(read.map((action) => [action.id, action.connected]));
    expect(byId).toMatchObject({ gmail: true, google_drive: false, calendar: null, plaid: null });
  });

  it("launches agent setup through the existing setup routes", () => {
    const fresh = buildFirstRunAgentActions({ hasPortfolioData: false, memoryHasItems: false });
    expect(fresh.map((action) => [action.capabilityId, action.launch, action.ready])).toEqual([
      ["finance", { kind: "route", href: ROUTES.ONE_SETUP_FINANCE }, null],
      ["location", { kind: "route", href: ROUTES.ONE_SETUP_LOCATION }, null],
      ["pkm", { kind: "route", href: ROUTES.PKM }, null],
    ]);

    const returning = buildFirstRunAgentActions({ hasPortfolioData: true, memoryHasItems: true });
    expect(returning.map((action) => action.ready)).toEqual([true, null, true]);
  });
});
