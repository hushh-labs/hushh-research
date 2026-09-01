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
    expect(ONE_SETUP_CAPABILITIES).toHaveLength(6);
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
    ]);
    const visibleSetupActionIds = new Set([
      "setup.open_connections",
      ...ONE_SETUP_CAPABILITIES.map((capability) => capability.setupActionId),
    ]);
    expect(
      hubContract.actions
        .filter((action) => visibleSetupActionIds.has(action.action_id))
        .map((action) => action.label),
    ).toEqual([
      "Set up your cloud",
      "Choose your AI",
      ...CAPABILITY_SETUP_COPY.map((capability) => capability.setupTitle),
    ]);
    expect(
      hubContract.actions.some(
        (action) => action.action_id === "setup.open_connected_systems",
      ),
    ).toBe(true);
    expect(
      actions.get("setup.open_connections")?.execution_target,
    ).toMatchObject({
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
      "setup.open_cloud",
      "setup.open_connections",
      ...orderedActionIds,
    ];
    expect(
      hubContract.actions
        .map((action) => action.action_id)
        .filter((actionId) => orderedHubActionIds.includes(actionId)),
    ).toEqual(orderedHubActionIds);

    const setupRoute = routeLayoutContract.find(
      (entry) => entry.route === "/one/setup",
    );
    // The hub's primary action leads with the cloud, because that is the first step
    // a person must take. Broken on purpose: point it back at AI access and this fails.
    expect(setupRoute?.voicePlaybook?.primaryActionId).toBe("setup.open_cloud");
    expect(setupRoute?.voicePlaybook?.happyPathActionIds).toEqual([
      ...orderedHubActionIds,
      "setup.hub_master_ack",
    ]);

    const gmailConnectAction = gmailSetupContract.actions.find(
      (action) => action.action_id === "setup.connect_gmail",
    );
    expect(gmailConnectAction?.reachability.routes).toEqual([
      "/one/setup/gmail",
    ]);
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
