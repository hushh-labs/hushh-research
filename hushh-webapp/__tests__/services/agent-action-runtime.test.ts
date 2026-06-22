import { describe, expect, it, vi } from "vitest";

import { executeAgentGatewayAction } from "@/lib/agent/agent-action-runtime";
import { ROUTES } from "@/lib/navigation/routes";

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

    expect(input.router.push).toHaveBeenCalledWith(ROUTES.CONNECTED_SYSTEMS);
    expect(result.status).toBe("started");
    expect(result.screenAfter).toBe("connected_systems");
  });

  it("blocks CRM deletes in Agent v1", async () => {
    const input = baseInput("connected_system.crm.delete");

    const result = await executeAgentGatewayAction(input);

    expect(input.router.push).not.toHaveBeenCalled();
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("crm_delete_manual_only");
  });
});
