import { describe, expect, it, vi } from "vitest";

import { executeAgentGatewayAction } from "@/lib/agent/agent-action-runtime";

function baseInput(actionId: string) {
  return {
    actionId,
    slots: { systemId: "salesforce-fsc-customer0" },
    userId: "user_123",
    router: { push: vi.fn() },
    appRuntimeState: {
      route: {
        pathname: "/kai/home",
        search: "",
        href: "/kai/home",
        screen: "kai_market",
      },
    },
    surfaceMetadata: null,
    hasPortfolioData: false,
    busyOperations: {},
    setAnalysisParams: vi.fn(),
  };
}

describe("executeAgentGatewayAction connected systems", () => {
  it("opens Connected Systems for CRM update proposals", async () => {
    const input = baseInput("connected_system.crm.update.propose");

    const result = await executeAgentGatewayAction(input);

    expect(input.router.push).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/one\/connected-systems\/salesforce-fsc-customer0\?agentActionId=crm_/,
      ),
    );
    expect(result.status).toBe("started");
    expect(result.screenAfter).toBe("connected_systems");
    expect(result.data?.target).toEqual(input.router.push.mock.calls[0]?.[0]);
    const actionId = String(input.router.push.mock.calls[0]?.[0] || "").split(
      "agentActionId=",
    )[1];
    expect(
      window.sessionStorage.getItem(
        `hushh:connected-system-agent-action:${actionId}`,
      ),
    ).toContain("connected_system.crm.update.propose");
  });

  it("blocks CRM deletes in Agent v1", async () => {
    const input = baseInput("connected_system.crm.delete");

    const result = await executeAgentGatewayAction(input);

    expect(input.router.push).not.toHaveBeenCalled();
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("crm_delete_manual_only");
  });

  it("requires an explicitly selected CRM instead of defaulting to Salesforce", async () => {
    const input = baseInput("connected_system.crm.read");
    input.slots = {};

    const result = await executeAgentGatewayAction(input);

    expect(input.router.push).not.toHaveBeenCalled();
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("connected_system_selection_required");
  });
});
