import gateway from "@/contracts/kai/kai-action-gateway.vnext.json";
import capabilityStepContract from "@/app/one/setup/[capability]/one-onboarding-capability-step.voice-action-contract.json";
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
      "Set up location",
      "Let One draft for you",
      "Set up your finances",
      "Set up RIA",
      "Link your tools",
    ]);
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
    expect(
      hubContract.actions
        .map((action) => action.action_id)
        .filter((actionId) => actionId.startsWith("setup.open_")),
    ).toEqual(orderedActionIds);

    const setupRoute = routeLayoutContract.find(
      (entry) => entry.route === "/one/setup",
    );
    expect(setupRoute?.voicePlaybook?.primaryActionId).toBe("setup.open_gmail");
    expect(setupRoute?.voicePlaybook?.happyPathActionIds).toEqual([
      ...orderedActionIds,
      "setup.hub_master_ack",
    ]);

    const capabilityAction = capabilityStepContract.actions.find(
      (action) => action.action_id === "setup.capability_continue",
    );
    expect(capabilityAction?.reachability.routes).toEqual(
      ONE_SETUP_CAPABILITY_IDS.map(buildOneSetupCapabilityRoute),
    );
    expect(capabilityAction?.reachability.routes).not.toContain(
      "/one/setup/pkm",
    );
    expect(capabilityAction?.reachability.routes).not.toContain(
      "/one/setup/consent",
    );
    expect(capabilityAction?.reachability.routes).not.toContain(
      "/one/setup/marketplace",
    );
  });
});
