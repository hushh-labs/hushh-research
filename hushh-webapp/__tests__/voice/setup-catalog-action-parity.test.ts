import gateway from "@/contracts/kai/kai-action-gateway.vnext.json";
import gmailSetupContract from "@/app/one/setup/gmail/page.voice-action-contract.json";
import calendarSetupContract from "@/app/one/setup/calendar/page.voice-action-contract.json";
import hubContract from "@/components/onboarding/setup/one-setup-hub.voice-action-contract.json";
import routeLayoutContract from "@/lib/navigation/app-route-layout.contract.json";
import {
  ONE_SETUP_CAPABILITIES,
  ONE_SETUP_CAPABILITY_IDS,
} from "@/lib/onboarding/one-capabilities";
import { CAPABILITY_SETUP_COPY } from "@/lib/onboarding/capability-setup-copy";
import {
  ONE_SETUP_CAPABILITY_IDS as ROUTE_SETUP_CAPABILITY_IDS,
  buildOneSetupCapabilityRoute,
} from "@/lib/navigation/routes";
import { describe, expect, it } from "vitest";

describe("setup catalog voice parity", () => {
  it("keeps every visible capability mapped to one wired route action", () => {
    const actions = new Map(
      gateway.actions.map((action) => [action.action_id, action]),
    );

    expect(ONE_SETUP_CAPABILITY_IDS).toEqual([
      "gmail",
      "calendar",
      "location",
      "email",
      "finance",
      "ria",
      "connected-systems",
    ]);
    expect(ONE_SETUP_CAPABILITIES).toHaveLength(7);
    expect(ROUTE_SETUP_CAPABILITY_IDS).toBe(ONE_SETUP_CAPABILITY_IDS);
    expect(
      CAPABILITY_SETUP_COPY.map((capability) => capability.setupTitle),
    ).toEqual([
      "Connect Gmail",
      "Connect your calendar",
      "Set up location",
      "Identity checks",
      "Set up your money",
      "Set up your advisor profile",
      "Connect your CRM",
    ]);
    expect(
      hubContract.actions
        .filter((action) => action.action_id.startsWith("setup.open_"))
        .map((action) => action.label),
    ).toEqual([
      "Choose your AI",
      ...CAPABILITY_SETUP_COPY.map((capability) => capability.setupTitle),
    ]);
    expect(actions.get("setup.open_connections")?.execution_target).toMatchObject({
      status: "wired",
      path: "route",
      target: "/one/setup/connections",
    });
    for (const capability of ONE_SETUP_CAPABILITIES) {
      const action = actions.get(capability.setupActionId);
      expect(action, capability.id).toBeDefined();
      expect(action?.execution_target).toMatchObject({
        status: "wired",
        path: "route",
        target: buildOneSetupCapabilityRoute(capability.id),
      });
      expect(action?.control_ids).toContain(capability.setupControlId);
    }
  });

  it("keeps authored route and voice contracts in the visible setup order", () => {
    const orderedActionIds = ONE_SETUP_CAPABILITIES.map(
      (capability) => capability.setupActionId,
    );
    const orderedHubActionIds = [
      "setup.open_connections",
      ...orderedActionIds,
    ];
    expect(
      hubContract.actions
        .map((action) => action.action_id)
        .filter((actionId) => actionId.startsWith("setup.open_")),
    ).toEqual(orderedHubActionIds);

    const setupRoute = routeLayoutContract.find(
      (entry) => entry.route === "/one/setup",
    );
    expect(setupRoute?.voicePlaybook?.primaryActionId).toBe("setup.open_connections");
    expect(setupRoute?.voicePlaybook?.happyPathActionIds).toEqual([
      ...orderedHubActionIds,
      "setup.hub_master_ack",
    ]);

    const gmailConnectAction = gmailSetupContract.actions.find(
      (action) => action.action_id === "setup.connect_gmail",
    );
    expect(gmailConnectAction?.reachability.routes).toEqual(["/one/setup/gmail"]);
    expect(gmailConnectAction?.execution_target).toMatchObject({
      status: "wired",
      path: "local_handler",
    });
    const calendarConnectAction = calendarSetupContract.actions.find(
      (action) => action.action_id === "setup.connect_calendar",
    );
    expect(calendarConnectAction?.reachability.routes).toEqual([
      "/one/setup/calendar",
    ]);
    expect(calendarConnectAction?.execution_target).toMatchObject({
      status: "wired",
      path: "local_handler",
    });
  });
});
